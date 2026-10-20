package notifyconn_test

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/trypando/pando/internal/adapter/api"
	"github.com/trypando/pando/internal/core/notifyconn"
	"github.com/trypando/pando/internal/core/state"
	"github.com/trypando/pando/internal/errs"
	"github.com/trypando/pando/internal/secret"
)

type failingConfigs struct{}

func (failingConfigs) List(context.Context) ([]state.AdapterConfig, error) {
	return nil, errs.New(errs.Internal, "the database is down")
}

// sealed is a credential store that cannot open what it holds.
type sealed struct{ *creds }

func (sealed) Resolve(context.Context, string) (map[string]secret.Value, error) {
	return nil, errs.New(errs.Internal, "the secrets adapter is down")
}

// plain is a notify adapter that connects to nothing and posts to one place.
type plain struct{ chatty }

func (*plain) Capabilities() api.NotifyCapabilities {
	return api.NotifyCapabilities{Audience: api.AudienceChannel}
}

// TestAnAdapterThatCannotBeBuiltSaysWhy asserts each reason an adapter
// cannot be built is kept as its problem, and that a failing store is an
// error rather than an empty list.
func TestAnAdapterThatCannotBeBuiltSaysWhy(t *testing.T) {
	var none *notifyconn.Service
	all, err := none.List(ctx())
	require.NoError(t, err)
	require.Empty(t, all)

	s, _ := service(configs{row("ntf_chat", "chatty", `{}`), row("ntf_off", "chatty", `{}`)}, newCreds())
	s.Configs = failingConfigs{}
	_, err = s.List(ctx())
	require.Error(t, err)
	_, err = s.Get(ctx(), "ntf_chat")
	require.Error(t, err)

	s, _ = service(configs{row("ntf_chat", "chatty", `{}`), row("ntf_json", "chatty", `[`)}, newCreds())
	s.Credentials = sealed{newCreds()}
	a, err := s.Get(ctx(), "ntf_chat")
	require.NoError(t, err)
	require.Contains(t, a.Problem, "could not be opened")

	s.Credentials = newCreds()
	a, err = s.Get(ctx(), "ntf_json")
	require.NoError(t, err)
	require.Contains(t, a.Problem, "could not be read")

	s.New = nil
	a, err = s.Get(ctx(), "ntf_chat")
	require.NoError(t, err)
	require.Contains(t, a.Problem, "cannot run notification adapters")
	require.False(t, a.Usable())
}

// TestWhatHasNothingToConnectIsRefused asserts connecting is refused for an
// adapter with nothing to connect, an install with nowhere to keep a
// connection in progress or its result, and a callback for nothing started.
func TestWhatHasNothingToConnectIsRefused(t *testing.T) {
	s, _ := service(configs{row("ntf_plain", "plain", `{}`), row("ntf_chat", "chatty", `{}`)}, newCreds())
	s.New = func(kind string) api.NotifyAdapter {
		if kind == "plain" {
			return &plain{}
		}
		return &chatty{}
	}

	p, err := s.Get(ctx(), "ntf_plain")
	require.NoError(t, err)
	require.True(t, p.Usable(), "an adapter that takes no authorization is ready once configured")
	_, err = s.BeginAuthorization(ctx(), "ntf_plain", api.AuthorizationWeb, "https://pando.example/cb", secret.Value{})
	require.ErrorContains(t, err, "none; it is set up with its settings alone")
	require.ErrorContains(t, s.CompleteManual(ctx(), "ntf_plain", secret.New("x")), "cannot be connected by hand")
	_, err = s.Channels(ctx(), "ntf_plain", "")
	require.ErrorContains(t, err, "no channels to choose")

	for _, state := range []string{"no-dot", "ntf_chat.", "ntf_chat.unstarted"} {
		_, err = s.CompleteWebAuthorization(ctx(), state, "good")
		require.ErrorContains(t, err, "not one Pando is waiting for", state)
	}
	require.NoError(t, s.Authorizations.Put(ctx(), "ntf_chat", "pending", secret.New("not json")))
	_, err = s.CompleteWebAuthorization(ctx(), "ntf_chat.x", "good")
	require.ErrorContains(t, err, "not one Pando is waiting for")

	_, err = s.BeginAuthorization(ctx(), "ntf_chat", api.AuthorizationWeb, "https://pando.example/cb", secret.New("refused"))
	require.ErrorContains(t, err, "needs its grant", "the adapter's own refusal")

	s.Authorizations = nil
	_, err = s.BeginAuthorization(ctx(), "ntf_chat", api.AuthorizationWeb, "https://pando.example/cb", secret.New("grant"))
	require.ErrorContains(t, err, "no secrets adapter")
	_, err = s.CompleteWebAuthorization(ctx(), "ntf_chat.x", "good")
	require.Error(t, err)

	s.Credentials = nil
	require.ErrorContains(t, s.CompleteManual(ctx(), "ntf_chat", secret.New("pasted")), "cannot store")
}

// TestAFailedStorePutsBackWhatWasThere asserts a reconnection that fails
// partway leaves the credentials the adapter had, not a mix.
func TestAFailedStorePutsBackWhatWasThere(t *testing.T) {
	store := newCreds()
	store.m["ntf_chat"] = map[string]secret.Value{"token": secret.New("old"), "app_id": secret.New("A0")}
	s, _ := service(configs{row("ntf_chat", "chatty", `{}`)}, store)
	a, err := s.BeginAuthorization(ctx(), "ntf_chat", api.AuthorizationWeb, "https://pando.example/cb", secret.New("grant"))
	require.NoError(t, err)
	store.fails = "app_id"
	_, err = s.CompleteWebAuthorization(ctx(), state0(t, a.AuthorizeURL), "good")
	require.Error(t, err)
	require.Equal(t, "old", store.m["ntf_chat"]["token"].Reveal())
	require.Equal(t, "A0", store.m["ntf_chat"]["app_id"].Reveal())

	// A declared adapter is found by Get too, and is not connected from here.
	reg := api.NewRegistry()
	require.NoError(t, reg.Register("ntf_file", &chatty{}))
	s.Declared = reg
	d, err := s.Get(ctx(), "ntf_file")
	require.NoError(t, err)
	require.True(t, d.Declared)
	raw, _ := json.Marshal(d)
	require.Contains(t, string(raw), `"declared":true`)
}
