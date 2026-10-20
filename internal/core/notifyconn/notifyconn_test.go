package notifyconn_test

import (
	"context"
	"encoding/json"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/trypando/pando/internal/adapter/api"
	"github.com/trypando/pando/internal/core/clock"
	"github.com/trypando/pando/internal/core/notifyconn"
	"github.com/trypando/pando/internal/core/state"
	"github.com/trypando/pando/internal/errs"
	"github.com/trypando/pando/internal/secret"
)

func ctx() context.Context { return context.Background() }

type configs []state.AdapterConfig

func (c configs) List(context.Context) ([]state.AdapterConfig, error) { return c, nil }

// creds is a credential store in memory, whose writes of field fail.
type creds struct {
	m     map[string]map[string]secret.Value
	fails string
}

func newCreds() *creds { return &creds{m: map[string]map[string]secret.Value{}} }

func (c *creds) Resolve(_ context.Context, id string) (map[string]secret.Value, error) {
	out := map[string]secret.Value{}
	for k, v := range c.m[id] {
		out[k] = v
	}
	return out, nil
}

func (c *creds) Put(_ context.Context, id, field string, v secret.Value) error {
	if field == c.fails {
		return errs.New(errs.Internal, "the store is down")
	}
	if c.m[id] == nil {
		c.m[id] = map[string]secret.Value{}
	}
	c.m[id][field] = v
	return nil
}

func (c *creds) Delete(_ context.Context, id, field string) error {
	delete(c.m[id], field)
	return nil
}

// chatty is a notify adapter that connects: it is authorized once it holds a
// token, sends its browser to the provider with the state it was given, and
// lists two channels.
type chatty struct {
	cfg struct {
		Credentials map[string]string `json:"credentials"`
		Refuse      bool              `json:"refuse"`
	}
	sent []api.Notification
}

func (c *chatty) Kind() string                      { return "chatty" }
func (c *chatty) Category() api.Category            { return api.CategoryNotify }
func (c *chatty) HealthCheck(context.Context) error { return nil }
func (c *chatty) Configure(_ context.Context, raw json.RawMessage) error {
	if err := json.Unmarshal(raw, &c.cfg); err != nil {
		return err
	}
	if c.cfg.Refuse {
		return errs.New(errs.ValidInvalid, "chatty refuses these settings.")
	}
	return nil
}
func (c *chatty) Capabilities() api.NotifyCapabilities {
	return api.NotifyCapabilities{Audience: api.AudienceChannel, Channels: true, WebAuthorization: true,
		ManualAuthorization: true, Authorized: c.cfg.Credentials["token"] != ""}
}
func (c *chatty) Notify(_ context.Context, n api.Notification) error {
	c.sent = append(c.sent, n)
	return nil
}
func (c *chatty) Channels(_ context.Context, q string) ([]api.NotifyChannel, error) {
	all := []api.NotifyChannel{{ID: "C1", Name: "deploys"}, {ID: "C2", Name: "general"}}
	var out []api.NotifyChannel
	for _, ch := range all {
		if strings.Contains(ch.Name, q) {
			out = append(out, ch)
		}
	}
	return out, nil
}
func (c *chatty) BeginAuthorization(_ context.Context, req api.AuthorizationRequest) (api.Authorization, error) {
	if req.Mode == api.AuthorizationManual {
		return api.Authorization{Mode: req.Mode, AuthorizeURL: "https://chat.example/new"}, nil
	}
	if req.Grant.Reveal() != "grant" {
		return api.Authorization{}, errs.New(errs.ValidInvalid, "chatty needs its grant.")
	}
	return api.Authorization{Mode: req.Mode, Flow: secret.New("client-secret"),
		AuthorizeURL: "https://chat.example/authorize?" + url.Values{"state": {req.State}, "redirect_uri": {req.RedirectURL}}.Encode()}, nil
}
func (c *chatty) CompleteAuthorization(_ context.Context, req api.AuthorizationCompletion) (api.AuthorizationResult, error) {
	switch {
	case req.Mode == api.AuthorizationManual && req.Code == "pasted":
		return api.AuthorizationResult{Credentials: map[string]secret.Value{"token": secret.New("pasted")}}, nil
	case req.Mode == api.AuthorizationWeb && req.Flow.Reveal() == "client-secret" && req.Code == "good":
		return api.AuthorizationResult{Credentials: map[string]secret.Value{"token": secret.New("t1"), "app_id": secret.New("A1")}}, nil
	}
	return api.AuthorizationResult{}, errs.New(errs.ValidInvalid, "chatty refuses that.")
}

func row(id, kind, cfg string) state.AdapterConfig {
	return state.AdapterConfig{ID: id, Category: string(api.CategoryNotify), Kind: kind, Name: id,
		Config: json.RawMessage(cfg), Enabled: true}
}

func service(rows configs, store *creds) (*notifyconn.Service, *clock.Fake) {
	c := clock.NewFake(time.Date(2026, 10, 19, 12, 0, 0, 0, time.UTC))
	return &notifyconn.Service{
		Configs: rows, Credentials: store, Authorizations: newCreds(), Clock: c,
		New: func(kind string) api.NotifyAdapter {
			if kind == "chatty" {
				return &chatty{}
			}
			return nil
		},
	}, c
}

func state0(t *testing.T, authorizeURL string) string {
	t.Helper()
	u, err := url.Parse(authorizeURL)
	require.NoError(t, err)
	return u.Query().Get("state")
}

// TestR374_ANotificationAdapterIsConnectedWithoutARestart asserts a stored
// adapter is built from its row each time it is used: saved and not yet
// connected it cannot send, and connected — the provider's code exchanged at
// the callback — it sends at once, with no restart.
func TestR374_ANotificationAdapterIsConnectedWithoutARestart(t *testing.T) {
	store := newCreds()
	s, _ := service(configs{row("ntf_chat", "chatty", `{}`)}, store)

	_, ok := s.Notify(ctx(), "ntf_chat")
	require.False(t, ok, "not connected yet")

	a, err := s.BeginAuthorization(ctx(), "ntf_chat", api.AuthorizationWeb, "https://pando.example/api/v1/notify/callback", secret.New("grant"))
	require.NoError(t, err)
	require.Contains(t, a.AuthorizeURL, url.QueryEscape("https://pando.example/api/v1/notify/callback"))
	st := state0(t, a.AuthorizeURL)
	require.True(t, strings.HasPrefix(st, "ntf_chat."))

	_, err = s.CompleteWebAuthorization(ctx(), "ntf_chat.forged", "good")
	require.Equal(t, errs.ValidInvalid, errs.CodeOf(err))

	id, err := s.CompleteWebAuthorization(ctx(), st, "good")
	require.NoError(t, err)
	require.Equal(t, "ntf_chat", id)
	require.Equal(t, "t1", store.m["ntf_chat"]["token"].Reveal())

	n, ok := s.Notify(ctx(), "ntf_chat")
	require.True(t, ok, "connected, it sends at once")
	require.NoError(t, n.Notify(ctx(), api.Notification{Subject: "hi", Channel: "C1"}))

	_, err = s.CompleteWebAuthorization(ctx(), st, "good")
	require.Equal(t, errs.ValidInvalid, errs.CodeOf(err), "a state is good once")

	usable, err := s.Usable(ctx())
	require.NoError(t, err)
	require.Len(t, usable, 1)
	channels, err := s.Channels(ctx(), "ntf_chat", "dep")
	require.NoError(t, err)
	require.Equal(t, []api.NotifyChannel{{ID: "C1", Name: "deploys"}}, channels)
}

func TestAConnectionThatTakesTooLongExpires(t *testing.T) {
	s, c := service(configs{row("ntf_chat", "chatty", `{}`)}, newCreds())
	a, err := s.BeginAuthorization(ctx(), "ntf_chat", api.AuthorizationWeb, "https://pando.example/cb", secret.New("grant"))
	require.NoError(t, err)
	c.Advance(16 * time.Minute)
	_, err = s.CompleteWebAuthorization(ctx(), state0(t, a.AuthorizeURL), "good")
	require.ErrorContains(t, err, "took too long")
}

// TestR374_ANotificationAdapterIsConnectedByHand asserts the manual way: a
// link, then the credential the provider gave, checked by the adapter.
func TestR374_ANotificationAdapterIsConnectedByHand(t *testing.T) {
	store := newCreds()
	s, _ := service(configs{row("ntf_chat", "chatty", `{}`)}, store)
	a, err := s.BeginAuthorization(ctx(), "ntf_chat", api.AuthorizationManual, "", secret.Value{})
	require.NoError(t, err)
	require.Equal(t, "https://chat.example/new", a.AuthorizeURL)

	require.Error(t, s.CompleteManual(ctx(), "ntf_chat", secret.New("wrong")))
	require.Empty(t, store.m["ntf_chat"])
	require.NoError(t, s.CompleteManual(ctx(), "ntf_chat", secret.New("pasted")))
	require.Equal(t, "pasted", store.m["ntf_chat"]["token"].Reveal())
}

// TestWhatCannotBeConnectedSaysWhy asserts the refusals: an adapter the
// configuration file declares, one whose settings were refused, a mode it
// does not take, a kind this build lacks, and a store that fails partway.
func TestWhatCannotBeConnectedSaysWhy(t *testing.T) {
	declared := api.NewRegistry()
	require.NoError(t, declared.Register("ntf_file", &chatty{}))
	store := newCreds()
	s, _ := service(configs{
		row("ntf_chat", "chatty", `{}`),
		row("ntf_bad", "chatty", `{"refuse":true}`),
		row("ntf_gone", "nothing", `{}`),
	}, store)
	s.Declared = declared

	all, err := s.List(ctx())
	require.NoError(t, err)
	byID := map[string]notifyconn.Adapter{}
	for _, a := range all {
		byID[a.ID] = a
	}
	require.True(t, byID["ntf_file"].Declared)
	require.Equal(t, "chatty refuses these settings.", byID["ntf_bad"].Problem)
	require.Contains(t, byID["ntf_gone"].Problem, "no notification adapter of kind nothing")

	_, err = s.BeginAuthorization(ctx(), "ntf_file", api.AuthorizationWeb, "https://pando.example/cb", secret.New("grant"))
	require.ErrorContains(t, err, "declared in the configuration file")
	_, err = s.BeginAuthorization(ctx(), "ntf_bad", api.AuthorizationWeb, "https://pando.example/cb", secret.New("grant"))
	require.ErrorContains(t, err, "cannot be connected")
	_, err = s.BeginAuthorization(ctx(), "ntf_chat", "device", "", secret.Value{})
	require.ErrorContains(t, err, "Valid answers: web, manual")
	_, err = s.BeginAuthorization(ctx(), "ntf_none", api.AuthorizationWeb, "", secret.Value{})
	require.Equal(t, errs.NotFound, errs.CodeOf(err))
	_, err = s.Channels(ctx(), "ntf_bad", "")
	require.Equal(t, errs.StateInvalid, errs.CodeOf(err))

	store.fails = "app_id"
	a, err := s.BeginAuthorization(ctx(), "ntf_chat", api.AuthorizationWeb, "https://pando.example/cb", secret.New("grant"))
	require.NoError(t, err)
	_, err = s.CompleteWebAuthorization(ctx(), state0(t, a.AuthorizeURL), "good")
	require.Error(t, err)
	require.Empty(t, store.m["ntf_chat"], "what was written before the failure is put back")
}
