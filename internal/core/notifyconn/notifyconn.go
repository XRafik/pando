// Package notifyconn is the install's notification adapters as core uses them
// (R-373, R-374): built from their rows each time one is used, connected to
// their provider when they need it, and asked which channels a subscription
// can post to.
//
// A stored notification adapter is built from its adapter_configs row and its
// sealed credentials on every use rather than once at startup, like a source
// connection (core/sourceconn) and an image registry (core/imageregistry). So
// adding one needs no restart, and connecting Slack — whose bot token arrives
// after the adapter is saved — takes effect on every replica at once. One the
// configuration file declares is built at startup and is read-only (R-271).
package notifyconn

import (
	"context"
	"encoding/json"
	"sort"

	"github.com/trypando/pando/internal/adapter/api"
	"github.com/trypando/pando/internal/core/clock"
	"github.com/trypando/pando/internal/core/state"
	"github.com/trypando/pando/internal/errs"
	"github.com/trypando/pando/internal/secret"
)

// ConfigLister reads configured adapters (state.Adapters).
type ConfigLister interface {
	List(ctx context.Context) ([]state.AdapterConfig, error)
}

// CredentialStore reads and writes sealed credentials
// (state.AdapterCredentials).
type CredentialStore interface {
	Resolve(ctx context.Context, adapterID string) (map[string]secret.Value, error)
	Put(ctx context.Context, adapterID, field string, v secret.Value) error
	Delete(ctx context.Context, adapterID, field string) error
}

// Service is the install's notification adapters.
type Service struct {
	Configs     ConfigLister
	Credentials CredentialStore

	// Authorizations holds connections in progress
	// (state.NewNotifyAuthorizations).
	Authorizations CredentialStore

	// New returns an unconfigured adapter of a kind, or nil.
	New func(kind string) api.NotifyAdapter

	// Declared are the adapters the configuration file declares, built at
	// startup. A row with the same ID is the declared one's record.
	Declared *api.Registry

	Clock clock.Clock
}

// Adapter is one notification adapter, built.
type Adapter struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	Kind string `json:"kind"`

	Capabilities api.NotifyCapabilities `json:"capabilities"`

	// Declared says the configuration file declares it, so it is changed
	// there and not connected from here.
	Declared bool `json:"declared,omitempty"`

	// Problem is why it cannot send — its settings or credentials were
	// refused — or empty.
	Problem string `json:"problem,omitempty"`

	adapter api.NotifyAdapter
}

// Usable says the adapter can send now: built, and connected when it is one
// that connects. One that takes no authorization is ready once configured.
func (a Adapter) Usable() bool {
	c := a.Capabilities
	connects := c.WebAuthorization || c.ManualAuthorization
	return a.adapter != nil && a.Problem == "" && (c.Authorized || !connects)
}

// List builds every enabled notification adapter, ordered by name. One that
// cannot be built is listed with its Problem rather than left out.
func (s *Service) List(ctx context.Context) ([]Adapter, error) {
	if s == nil {
		return nil, nil
	}
	declared := s.declared()
	out, err := s.stored(ctx, declared)
	if err != nil {
		return nil, err
	}
	for id, a := range declared {
		out = append(out, built(id, id, a.Kind(), a, "", true))
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Name != out[j].Name {
			return out[i].Name < out[j].Name
		}
		return out[i].ID < out[j].ID
	})
	return out, nil
}

// declared is the adapters the configuration file declares, by ID.
func (s *Service) declared() map[string]api.NotifyAdapter {
	out := map[string]api.NotifyAdapter{}
	if s.Declared == nil {
		return out
	}
	for _, ref := range s.Declared.ByCategory(api.CategoryNotify) {
		if a, ok := s.Declared.Notify(ref); ok {
			out[ref] = a
		}
	}
	return out
}

// stored builds the enabled rows. A row a declaration overrides is the
// declared adapter, under the row's name, and is taken out of declared.
func (s *Service) stored(ctx context.Context, declared map[string]api.NotifyAdapter) ([]Adapter, error) {
	if s.Configs == nil {
		return nil, nil
	}
	rows, err := s.Configs.List(ctx)
	if err != nil {
		return nil, err
	}
	var out []Adapter
	for _, row := range rows {
		if row.Category != string(api.CategoryNotify) || !row.Enabled {
			continue
		}
		if a, ok := declared[row.ID]; ok {
			out = append(out, built(row.ID, row.Name, row.Kind, a, "", true))
			delete(declared, row.ID)
			continue
		}
		out = append(out, s.build(ctx, row))
	}
	return out, nil
}

// Get builds one adapter, and only that one: the dispatcher asks on every
// delivery.
func (s *Service) Get(ctx context.Context, id string) (Adapter, error) {
	if s != nil && s.Declared != nil {
		if a, ok := s.Declared.Notify(id); ok {
			return built(id, id, a.Kind(), a, "", true), nil
		}
	}
	if s != nil && s.Configs != nil {
		rows, err := s.Configs.List(ctx)
		if err != nil {
			return Adapter{}, err
		}
		for _, row := range rows {
			if row.ID == id && row.Category == string(api.CategoryNotify) && row.Enabled {
				return s.build(ctx, row), nil
			}
		}
	}
	return Adapter{}, errs.Newf(errs.NotFound,
		"There is no notification adapter %q on this installation.", id).
		WithRemedy("List them under Adapters in the console, or with pando adapter list.")
}

// Notify is the adapter to send through, if it exists and can send — what the
// subscription service and the dispatcher deliver with.
func (s *Service) Notify(ctx context.Context, id string) (api.NotifyAdapter, bool) {
	a, err := s.Get(ctx, id)
	if err != nil || !a.Usable() {
		return nil, false
	}
	return a.adapter, true
}

// Usable lists the adapters that can send now.
func (s *Service) Usable(ctx context.Context) ([]Adapter, error) {
	all, err := s.List(ctx)
	if err != nil {
		return nil, err
	}
	var out []Adapter
	for _, a := range all {
		if a.Usable() {
			out = append(out, a)
		}
	}
	return out, nil
}

// Channels lists the channels a subscription to the adapter can post to.
func (s *Service) Channels(ctx context.Context, id, query string) ([]api.NotifyChannel, error) {
	a, err := s.Get(ctx, id)
	if err != nil {
		return nil, err
	}
	if a.adapter == nil {
		return nil, errs.Newf(errs.StateInvalid, "The notification adapter %q cannot be used: %s", a.Name, a.Problem)
	}
	if !a.Capabilities.Channels {
		return nil, errs.Newf(errs.ValidInvalid,
			"%s posts to the one place its settings name, so there are no channels to choose.", a.Name)
	}
	channels, err := a.adapter.Channels(ctx, query)
	if channels == nil && err == nil {
		channels = []api.NotifyChannel{}
	}
	return channels, err
}

func built(id, name, kind string, a api.NotifyAdapter, problem string, declared bool) Adapter {
	out := Adapter{ID: id, Name: name, Kind: kind, Problem: problem, Declared: declared, adapter: a}
	if a != nil {
		out.Capabilities = a.Capabilities()
	}
	if out.Name == "" {
		out.Name = id
	}
	return out
}

// build configures an adapter from its row and its sealed credentials. Why
// one cannot be built is kept, never a credential.
func (s *Service) build(ctx context.Context, row state.AdapterConfig) Adapter {
	if s.New == nil {
		return built(row.ID, row.Name, row.Kind, nil, "This build of Pando cannot run notification adapters.", false)
	}
	a := s.New(row.Kind)
	if a == nil {
		return built(row.ID, row.Name, row.Kind, nil, "This build of Pando has no notification adapter of kind "+row.Kind+".", false)
	}
	var creds map[string]secret.Value
	if s.Credentials != nil {
		var err error
		if creds, err = s.Credentials.Resolve(ctx, row.ID); err != nil {
			return built(row.ID, row.Name, row.Kind, nil,
				"The adapter's credentials could not be opened. Enter them again in its settings.", false)
		}
	}
	raw, err := withCredentials(row.Config, creds)
	if err != nil {
		return built(row.ID, row.Name, row.Kind, nil, "The adapter's settings could not be read.", false)
	}
	if err := a.Configure(ctx, raw); err != nil {
		msg := err.Error()
		if e := errs.As(err); e != nil {
			msg = e.Message
		}
		return built(row.ID, row.Name, row.Kind, nil, msg, false)
	}
	return built(row.ID, row.Name, row.Kind, a, "", false)
}

// withCredentials puts credentials beside the settings, where Configure reads
// them, in memory only (O-20).
func withCredentials(raw json.RawMessage, creds map[string]secret.Value) (json.RawMessage, error) {
	cfg := map[string]any{}
	if len(raw) > 0 {
		if err := json.Unmarshal(raw, &cfg); err != nil {
			return nil, err
		}
	}
	if len(creds) > 0 {
		plain := make(map[string]string, len(creds))
		for k, v := range creds {
			plain[k] = v.Reveal()
		}
		cfg["credentials"] = plain
	}
	return json.Marshal(cfg)
}

func (s *Service) now() clock.Clock {
	if s.Clock != nil {
		return s.Clock
	}
	return clock.System{}
}
