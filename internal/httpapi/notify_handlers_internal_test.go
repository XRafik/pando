package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"

	"github.com/stretchr/testify/require"
	"go.uber.org/zap"

	"github.com/trypando/pando/internal/adapter/api"
	"github.com/trypando/pando/internal/core/authz"
	"github.com/trypando/pando/internal/core/notifyconn"
	"github.com/trypando/pando/internal/core/state"
	"github.com/trypando/pando/internal/errs"
	"github.com/trypando/pando/internal/secret"
)

// workspace is a notify adapter that connects as Slack does: authorized once
// it holds a token, created from a grant, and posting to channels it lists.
type workspace struct {
	cfg struct {
		Credentials map[string]string `json:"credentials"`
	}
}

func (w *workspace) Kind() string                      { return "workspace" }
func (w *workspace) Category() api.Category            { return api.CategoryNotify }
func (w *workspace) HealthCheck(context.Context) error { return nil }
func (w *workspace) Configure(_ context.Context, raw json.RawMessage) error {
	return json.Unmarshal(raw, &w.cfg)
}
func (w *workspace) Capabilities() api.NotifyCapabilities {
	return api.NotifyCapabilities{Audience: api.AudienceChannel, Channels: true, WebAuthorization: true,
		ManualAuthorization: true, Authorized: w.cfg.Credentials["bot_token"] != ""}
}
func (w *workspace) Notify(context.Context, api.Notification) error { return nil }
func (w *workspace) Channels(context.Context, string) ([]api.NotifyChannel, error) {
	return []api.NotifyChannel{{ID: "C1", Name: "deploys"}}, nil
}
func (w *workspace) BeginAuthorization(_ context.Context, req api.AuthorizationRequest) (api.Authorization, error) {
	if req.Mode == api.AuthorizationManual {
		return api.Authorization{Mode: req.Mode, AuthorizeURL: "https://chat.example/new"}, nil
	}
	if req.Grant.Reveal() != "xoxe-good" {
		return api.Authorization{}, errs.New(errs.ValidInvalid, "That configuration token was refused.")
	}
	return api.Authorization{Mode: req.Mode, Flow: secret.New("flow"),
		AuthorizeURL: "https://slack.com/oauth/v2/authorize?" + url.Values{"state": {req.State}, "redirect_uri": {req.RedirectURL}}.Encode()}, nil
}
func (w *workspace) CompleteAuthorization(_ context.Context, req api.AuthorizationCompletion) (api.AuthorizationResult, error) {
	if (req.Mode == api.AuthorizationWeb && req.Code == "good") || (req.Mode == api.AuthorizationManual && req.Code == "xoxb-1") {
		return api.AuthorizationResult{Credentials: map[string]secret.Value{"bot_token": secret.New("xoxb-1")}}, nil
	}
	return api.AuthorizationResult{}, errs.New(errs.ValidInvalid, "That code was refused.")
}

func notifyFixture() (*Server, srcCreds) {
	store := srcCreds{}
	conns := &notifyconn.Service{
		Configs:        srcConfigs{{ID: "ntf_slack", Category: string(api.CategoryNotify), Kind: "workspace", Name: "Slack", Config: json.RawMessage(`{}`), Enabled: true}},
		Credentials:    store,
		Authorizations: srcCreds{},
		New: func(kind string) api.NotifyAdapter {
			if kind == "workspace" {
				return &workspace{}
			}
			return nil
		},
	}
	srv := &Server{Logger: zap.NewNop(), Authz: authz.New(nil, nil, nil), NotifyConnections: conns,
		ExternalURL: &url.URL{Scheme: "https", Host: "pando.example"}}
	return srv, store
}

var slackID = map[string]string{"adapterID": "ntf_slack"}

// TestR374_SlackIsConnectedThroughTheAPI asserts the routes every client
// connects Slack through: the configuration token sends the browser to
// Slack's approval screen with Pando's callback, and the callback stores the
// bot token and lands on the console; by hand, a link, then the bot token.
func TestR374_SlackIsConnectedThroughTheAPI(t *testing.T) {
	srv, store := notifyFixture()

	w := asSystem(srv.handleListNotify, http.MethodGet, "/api/v1/notify", "", nil)
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	require.Contains(t, w.Body.String(), `"authorized":false`)

	w = asSystem(srv.handleAuthorizeNotify, http.MethodPost, "/api/v1/notify/ntf_slack/authorize", `{"token":"xoxe-bad"}`, slackID)
	requireCode(t, w, errs.ValidInvalid)

	w = asSystem(srv.handleAuthorizeNotify, http.MethodPost, "/api/v1/notify/ntf_slack/authorize", `{"mode":"web","token":"xoxe-good"}`, slackID)
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	authorize, err := url.Parse(body(t, w)["authorize_url"].(string))
	require.NoError(t, err)
	require.Equal(t, "https://pando.example/api/v1/notify/callback", authorize.Query().Get("redirect_uri"))
	state := authorize.Query().Get("state")

	back := func(w *httptest.ResponseRecorder) url.Values {
		t.Helper()
		require.Equal(t, http.StatusFound, w.Code, w.Body.String())
		u, err := url.Parse(w.Header().Get("Location"))
		require.NoError(t, err)
		require.Equal(t, sourcesPage, u.Path)
		return u.Query()
	}
	q := back(asSystem(srv.handleNotifyCallback, http.MethodGet, "/api/v1/notify/callback?error=access_denied", "", nil))
	require.Contains(t, q.Get("error"), "access denied")
	q = back(asSystem(srv.handleNotifyCallback, http.MethodGet, "/api/v1/notify/callback?state=forged&code=good", "", nil))
	require.Contains(t, q.Get("error"), "not one Pando is waiting for")
	q = back(asSystem(srv.handleNotifyCallback, http.MethodGet,
		"/api/v1/notify/callback?"+url.Values{"state": {state}, "code": {"good"}}.Encode(), "", nil))
	require.Equal(t, "ntf_slack", q.Get("authorized"))
	require.Equal(t, "xoxb-1", store["ntf_slack"]["bot_token"].Reveal())

	w = asSystem(srv.handleListNotifyChannels, http.MethodGet, "/api/v1/notify/ntf_slack/channels", "", slackID)
	require.JSONEq(t, `{"channels":[{"id":"C1","name":"deploys"}]}`, w.Body.String())

	// By hand: a link, then the bot token.
	delete(store, "ntf_slack")
	w = asSystem(srv.handleAuthorizeNotify, http.MethodPost, "/api/v1/notify/ntf_slack/authorize", `{"mode":"manual"}`, slackID)
	require.Equal(t, "https://chat.example/new", body(t, w)["authorize_url"])
	w = asSystem(srv.handleAuthorizeNotify, http.MethodPost, "/api/v1/notify/ntf_slack/authorize", `{"mode":"manual","token":"xoxb-1"}`, slackID)
	require.JSONEq(t, `{"status":"authorized"}`, w.Body.String())
	require.Equal(t, "xoxb-1", store["ntf_slack"]["bot_token"].Reveal())
}

// TestConnectingANotificationAdapterIsRefusedWhereItShouldBe asserts the
// refusals: anybody signed out, a body that is not JSON, and an installation
// with no notification adapters to connect.
func TestConnectingANotificationAdapterIsRefusedWhereItShouldBe(t *testing.T) {
	srv, _ := notifyFixture()
	w := serve(srv.handleAuthorizeNotify, authz.Anonymous(), http.MethodPost, "/api/v1/notify/ntf_slack/authorize", `{}`, slackID)
	requireCode(t, w, errs.AuthRequired)
	w = serve(srv.handleListNotifyChannels, authz.Anonymous(), http.MethodGet, "/api/v1/notify/ntf_slack/channels", "", slackID)
	requireCode(t, w, errs.AuthRequired)
	w = serve(srv.handleNotifyCallback, authz.Anonymous(), http.MethodGet, "/api/v1/notify/callback?state=x", "", nil)
	requireCode(t, w, errs.AuthRequired)
	w = asSystem(srv.handleAuthorizeNotify, http.MethodPost, "/api/v1/notify/ntf_slack/authorize", `nope`, slackID)
	require.Contains(t, requireCode(t, w, errs.ValidInvalid)["remedy"], `"mode": "web"`)

	bare := &Server{Logger: zap.NewNop(), Authz: authz.New(nil, nil, nil)}
	for _, h := range []http.HandlerFunc{bare.handleListNotify, bare.handleListNotifyChannels, bare.handleNotifyCallback} {
		requireCode(t, asSystem(h, http.MethodGet, "/api/v1/notify", "", slackID), errs.StateInvalid)
	}
	requireCode(t, asSystem(bare.handleAuthorizeNotify, http.MethodPost, "/api/v1/notify/ntf_slack/authorize", `{}`, slackID), errs.StateInvalid)
}

// TestNotifyRoutesPassOnWhatTheServiceRefuses asserts a refusal from the
// adapter or the store reaches the caller as the error envelope, and a
// callback that cannot finish lands on the console saying why.
func TestNotifyRoutesPassOnWhatTheServiceRefuses(t *testing.T) {
	srv, _ := notifyFixture()
	gone := map[string]string{"adapterID": "ntf_gone"}

	w := asSystem(srv.handleListNotifyChannels, http.MethodGet, "/api/v1/notify/ntf_gone/channels", "", gone)
	requireCode(t, w, errs.NotFound)
	w = asSystem(srv.handleAuthorizeNotify, http.MethodPost, "/api/v1/notify/ntf_slack/authorize", `{"mode":"manual","token":"xoxb-wrong"}`, slackID)
	requireCode(t, w, errs.ValidInvalid)

	w = asSystem(srv.handleAuthorizeNotify, http.MethodPost, "/api/v1/notify/ntf_slack/authorize", `{"mode":"web","token":"xoxe-good"}`, slackID)
	authorize, err := url.Parse(body(t, w)["authorize_url"].(string))
	require.NoError(t, err)
	w = asSystem(srv.handleNotifyCallback, http.MethodGet,
		"/api/v1/notify/callback?"+url.Values{"state": {authorize.Query().Get("state")}, "code": {"bad"}}.Encode(), "", nil)
	require.Equal(t, http.StatusFound, w.Code)
	require.Contains(t, w.Header().Get("Location"), url.QueryEscape("That code was refused."))

	srv.NotifyConnections.Configs = failingSrcConfigs{}
	requireCode(t, asSystem(srv.handleListNotify, http.MethodGet, "/api/v1/notify", "", nil), errs.Internal)
}

type failingSrcConfigs struct{}

func (failingSrcConfigs) List(context.Context) ([]state.AdapterConfig, error) {
	return nil, errs.New(errs.Internal, "the database is down")
}
