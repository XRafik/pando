package notifyconn

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"strings"
	"time"

	"github.com/trypando/pando/internal/adapter/api"
	"github.com/trypando/pando/internal/errs"
	"github.com/trypando/pando/internal/secret"
)

// pendingField is the one field a connection in progress is kept under: the
// adapter's flow, the hash of the state the callback must present, the
// callback address, and when it expires, together.
const pendingField = "pending"

// pendingFor is how long a connection waits for the provider's callback.
const pendingFor = 15 * time.Minute

type pending struct {
	Flow      string    `json:"flow"`
	StateHash string    `json:"state_hash"`
	Redirect  string    `json:"redirect"`
	ExpiresAt time.Time `json:"expires_at"`
}

// Authorization is a connection started, as a person is shown it: where to
// send the browser — the provider's approval screen, or its page for setting
// the integration up by hand.
type Authorization struct {
	Mode         api.AuthorizationMode `json:"mode"`
	AuthorizeURL string                `json:"authorize_url"`
}

// BeginAuthorization starts connecting an adapter. In web mode grant is the
// credential the person gave (a Slack configuration token), used for this
// call only, and callback is where the provider returns the browser; in
// manual mode the answer is a link to set the integration up by hand.
func (s *Service) BeginAuthorization(ctx context.Context, id string, mode api.AuthorizationMode, callback string, grant secret.Value) (Authorization, error) {
	a, err := s.connectable(ctx, id)
	if err != nil {
		return Authorization{}, err
	}
	switch {
	case mode == api.AuthorizationWeb && a.Capabilities.WebAuthorization:
	case mode == api.AuthorizationManual && a.Capabilities.ManualAuthorization:
	default:
		return Authorization{}, errs.Newf(errs.ValidInvalid,
			"%s cannot be connected that way. Valid answers: %s.", a.Name, modes(a.Capabilities))
	}
	if mode == api.AuthorizationWeb && s.Authorizations == nil {
		return Authorization{}, errs.New(errs.StateInvalid,
			"Pando has no secrets adapter configured, so it cannot keep a connection while it is in progress.").
			WithRemedy("Configure a secrets adapter, restart Pando, and try again.")
	}

	raw := randomState()
	begun, err := a.adapter.BeginAuthorization(ctx, api.AuthorizationRequest{
		Mode: mode, RedirectURL: callback, State: id + "." + raw, Grant: grant,
	})
	if err != nil {
		return Authorization{}, err
	}
	if mode == api.AuthorizationWeb {
		sum := sha256.Sum256([]byte(raw))
		p, err := json.Marshal(pending{Flow: begun.Flow.Reveal(), StateHash: hex.EncodeToString(sum[:]),
			Redirect: callback, ExpiresAt: s.now().Now().Add(pendingFor)})
		if err != nil {
			return Authorization{}, err
		}
		if err := s.Authorizations.Put(ctx, id, pendingField, secret.New(string(p))); err != nil {
			return Authorization{}, err
		}
	}
	return Authorization{Mode: mode, AuthorizeURL: begun.AuthorizeURL}, nil
}

// CompleteWebAuthorization finishes a connection from the provider's
// callback. state names the adapter and must match the one it was started
// with; the provider's answer is stored as the adapter's credentials.
func (s *Service) CompleteWebAuthorization(ctx context.Context, state, code string) (string, error) {
	id, raw, ok := strings.Cut(state, ".")
	if !ok || id == "" || raw == "" || s.Authorizations == nil {
		return "", notStarted()
	}
	a, err := s.connectable(ctx, id)
	if err != nil {
		return "", err
	}
	stored, err := s.Authorizations.Resolve(ctx, id)
	if err != nil {
		return "", err
	}
	var p pending
	if v := stored[pendingField]; v.IsZero() || json.Unmarshal([]byte(v.Reveal()), &p) != nil {
		return "", notStarted()
	}
	sum := sha256.Sum256([]byte(raw))
	if subtle.ConstantTimeCompare([]byte(hex.EncodeToString(sum[:])), []byte(p.StateHash)) != 1 {
		return "", notStarted()
	}
	// Used once, whatever happens next.
	_ = s.Authorizations.Delete(ctx, id, pendingField)
	if s.now().Now().After(p.ExpiresAt) {
		return "", errs.Newf(errs.StateInvalid, "Connecting %s took too long and expired.", a.Name).
			WithRemedy("Connect it again under Adapters in the console.")
	}
	res, err := a.adapter.CompleteAuthorization(ctx, api.AuthorizationCompletion{
		Mode: api.AuthorizationWeb, Flow: secret.New(p.Flow), Code: code, RedirectURL: p.Redirect,
	})
	if err != nil {
		return "", err
	}
	return id, s.store(ctx, id, res.Credentials)
}

// CompleteManual finishes connecting an adapter by hand: the credential the
// provider gave (a Slack bot token) is checked by the adapter and stored.
func (s *Service) CompleteManual(ctx context.Context, id string, credential secret.Value) error {
	a, err := s.connectable(ctx, id)
	if err != nil {
		return err
	}
	if !a.Capabilities.ManualAuthorization {
		return errs.Newf(errs.ValidInvalid, "%s cannot be connected by hand.", a.Name)
	}
	res, err := a.adapter.CompleteAuthorization(ctx, api.AuthorizationCompletion{
		Mode: api.AuthorizationManual, Code: credential.Reveal(),
	})
	if err != nil {
		return err
	}
	return s.store(ctx, id, res.Credentials)
}

// connectable is an adapter Pando may connect: stored, not declared, and
// built.
func (s *Service) connectable(ctx context.Context, id string) (Adapter, error) {
	a, err := s.Get(ctx, id)
	if err != nil {
		return Adapter{}, err
	}
	if a.Declared {
		// What connecting returns is stored as the adapter's credentials,
		// and a declared adapter's are the file's (R-271).
		return Adapter{}, errs.Newf(errs.StateInvalid,
			"The notification adapter %q is declared in the configuration file, so Pando cannot store what connecting it returns.", a.Name).
			WithRemedy("Put its credentials in the configuration file, or add it under Adapters in the console instead.")
	}
	if a.adapter == nil {
		return Adapter{}, errs.Newf(errs.StateInvalid, "The notification adapter %q cannot be connected: %s", a.Name, a.Problem)
	}
	if s.Credentials == nil {
		return Adapter{}, errs.New(errs.StateInvalid, "This installation cannot store notification adapters' credentials.")
	}
	return a, nil
}

// store replaces the adapter's credentials with what connecting returned,
// all or none: a connection left with half of it could neither send nor be
// connected again, and one left with a field from before — the app a Slack
// adapter was connected to last time — would point at the wrong app. On a
// failure the fields already changed are put back, on a context of their own.
func (s *Service) store(ctx context.Context, id string, creds map[string]secret.Value) error {
	if len(creds) == 0 {
		return errs.New(errs.AdapterFailed, "The provider finished connecting without a credential.")
	}
	before, err := s.Credentials.Resolve(ctx, id)
	if err != nil {
		return err
	}
	var changed []string
	for field, v := range creds {
		if err := s.Credentials.Put(ctx, id, field, v); err != nil {
			s.putBack(ctx, id, before, changed)
			return err
		}
		changed = append(changed, field)
	}
	for field := range before {
		if _, kept := creds[field]; kept {
			continue
		}
		if err := s.Credentials.Delete(ctx, id, field); err != nil {
			s.putBack(ctx, id, before, changed)
			return err
		}
		changed = append(changed, field)
	}
	return nil
}

func (s *Service) putBack(ctx context.Context, id string, before map[string]secret.Value, fields []string) {
	ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 10*time.Second)
	defer cancel()
	for _, f := range fields {
		if old, had := before[f]; had {
			_ = s.Credentials.Put(ctx, id, f, old)
		} else {
			_ = s.Credentials.Delete(ctx, id, f)
		}
	}
}

func modes(c api.NotifyCapabilities) string {
	var m []string
	if c.WebAuthorization {
		m = append(m, string(api.AuthorizationWeb))
	}
	if c.ManualAuthorization {
		m = append(m, string(api.AuthorizationManual))
	}
	if len(m) == 0 {
		return "none; it is set up with its settings alone"
	}
	return strings.Join(m, ", ")
}

func notStarted() error {
	return errs.New(errs.ValidInvalid,
		"This connection is not one Pando is waiting for. Start it again from Adapters in the console.")
}

func randomState() string {
	b := make([]byte, 32)
	_, _ = rand.Read(b)
	return base64.RawURLEncoding.EncodeToString(b)
}
