package slack

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/trypando/pando/internal/adapter/api"
	"github.com/trypando/pando/internal/errs"
	"github.com/trypando/pando/internal/secret"
)

// fakeSlack is Slack's Web API as far as Pando calls it: it creates app
// A123 from a manifest given configuration token "xoxe-good", takes an icon
// for it, exchanges code "good" for bot token xoxb-1, lists three channels
// over two pages, and posts to any channel but "private-one".
type fakeSlack struct {
	t        *testing.T
	mu       sync.Mutex
	manifest map[string]any
	icon     []byte
	posted   []map[string]any
	iconFail bool
}

func (f *fakeSlack) serve(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	w.Header().Set("Content-Type", "application/json")
	answer := func(v any) { _ = json.NewEncoder(w).Encode(v) }
	refuse := func(code string) { answer(map[string]any{"ok": false, "error": code}) }
	switch strings.TrimPrefix(r.URL.Path, "/") {
	case "apps.manifest.create":
		_ = r.ParseForm()
		if r.Form.Get("token") != "xoxe-good" {
			refuse("invalid_auth")
			return
		}
		require.NoError(f.t, json.Unmarshal([]byte(r.Form.Get("manifest")), &f.manifest))
		answer(map[string]any{"ok": true, "app_id": "A123",
			"credentials":         map[string]string{"client_id": "1.2", "client_secret": "shh", "signing_secret": "sig"},
			"oauth_authorize_url": "https://slack.com/oauth/v2/authorize?client_id=1.2&scope=chat:write"})
	case "apps.icon.set":
		if f.iconFail {
			refuse("not_allowed")
			return
		}
		require.Equal(f.t, "Bearer xoxe-good", r.Header.Get("Authorization"))
		require.NoError(f.t, r.ParseMultipartForm(4<<20))
		require.Equal(f.t, "A123", r.FormValue("app_id"))
		file, _, err := r.FormFile("file")
		require.NoError(f.t, err)
		f.icon, _ = io.ReadAll(file)
		answer(map[string]any{"ok": true})
	case "oauth.v2.access":
		id, secretPart, _ := r.BasicAuth()
		_ = r.ParseForm()
		if id != "1.2" || secretPart != "shh" || r.Form.Get("code") != "good" {
			refuse("invalid_code")
			return
		}
		require.Equal(f.t, "https://pando.example/api/v1/notify/callback", r.Form.Get("redirect_uri"))
		answer(map[string]any{"ok": true, "access_token": "xoxb-1", "token_type": "bot", "app_id": "A123",
			"team": map[string]string{"name": "Acme"}})
	case "auth.test":
		if r.Header.Get("Authorization") != "Bearer xoxb-1" {
			refuse("invalid_auth")
			return
		}
		answer(map[string]any{"ok": true, "team": "Acme"})
	case "conversations.list":
		_ = r.ParseForm()
		if r.Form.Get("cursor") == "" {
			answer(map[string]any{"ok": true,
				"channels":          []map[string]any{{"id": "C1", "name": "deploys"}, {"id": "C2", "name": "general"}},
				"response_metadata": map[string]string{"next_cursor": "page2"}})
			return
		}
		answer(map[string]any{"ok": true, "channels": []map[string]any{{"id": "G1", "name": "ops-deploys", "is_private": true}},
			"response_metadata": map[string]string{"next_cursor": ""}})
	case "chat.postMessage":
		var msg map[string]any
		require.NoError(f.t, json.NewDecoder(r.Body).Decode(&msg))
		if r.Header.Get("Authorization") == "Bearer xoxb-revoked" {
			refuse("token_revoked")
			return
		}
		if msg["channel"] == "private-one" {
			refuse("not_in_channel")
			return
		}
		f.posted = append(f.posted, msg)
		answer(map[string]any{"ok": true})
	default:
		w.WriteHeader(http.StatusNotFound)
	}
}

func newFake(t *testing.T) (*fakeSlack, string) {
	t.Helper()
	f := &fakeSlack{t: t}
	srv := httptest.NewServer(http.HandlerFunc(f.serve))
	t.Cleanup(srv.Close)
	return f, srv.URL + "/"
}

func configured(t *testing.T, apiURL string, creds map[string]string) *Adapter {
	t.Helper()
	raw, err := json.Marshal(map[string]any{"credentials": creds})
	require.NoError(t, err)
	a := New()
	a.api = apiURL
	require.NoError(t, a.Configure(context.Background(), raw))
	return a
}

// TestR374_SlackIsConnectedByCreatingPandosOwnApp asserts connecting Slack
// asks a person for one configuration token and an Allow: Pando creates its
// app from a manifest asking only to post and to list channels, gives it
// Pando's icon, sends the browser to Slack's approval screen with Pando's
// callback and state, and exchanges the code for a bot token, keeping the
// configuration token nowhere.
func TestR374_SlackIsConnectedByCreatingPandosOwnApp(t *testing.T) {
	f, apiURL := newFake(t)
	ctx := context.Background()
	a := configured(t, apiURL, nil)

	caps := a.Capabilities()
	require.Equal(t, api.AudienceChannel, caps.Audience)
	require.True(t, caps.Channels && caps.WebAuthorization && caps.ManualAuthorization)
	require.False(t, caps.Authorized, "not connected yet")
	require.Equal(t, errs.StateInvalid, errs.CodeOf(a.Notify(ctx, api.Notification{Channel: "C1"})))

	req := api.AuthorizationRequest{Mode: api.AuthorizationWeb, RedirectURL: "https://pando.example/api/v1/notify/callback",
		State: "ntf_slack.abc", Grant: secret.New("xoxe-good")}
	begun, err := a.BeginAuthorization(ctx, req)
	require.NoError(t, err)
	authorize, err := url.Parse(begun.AuthorizeURL)
	require.NoError(t, err)
	require.Equal(t, "slack.com", authorize.Host)
	require.Equal(t, "ntf_slack.abc", authorize.Query().Get("state"))
	require.Equal(t, req.RedirectURL, authorize.Query().Get("redirect_uri"))
	require.Equal(t, "1.2", authorize.Query().Get("client_id"))
	require.NotContains(t, begun.Flow.Reveal(), "xoxe-good", "the configuration token is used and not kept")

	oauth := f.manifest["oauth_config"].(map[string]any)
	require.Equal(t, []any{req.RedirectURL}, oauth["redirect_urls"])
	require.ElementsMatch(t, []any{"chat:write", "chat:write.public", "channels:read", "groups:read"},
		oauth["scopes"].(map[string]any)["bot"])
	require.Equal(t, false, f.manifest["settings"].(map[string]any)["token_rotation_enabled"])
	require.Equal(t, icon, f.icon, "Pando's icon is uploaded")

	res, err := a.CompleteAuthorization(ctx, api.AuthorizationCompletion{Mode: api.AuthorizationWeb,
		Flow: begun.Flow, Code: "good", RedirectURL: req.RedirectURL})
	require.NoError(t, err)
	require.Equal(t, "xoxb-1", res.Credentials[FieldBotToken].Reveal())
	require.Equal(t, "A123", res.Credentials[FieldAppID].Reveal())
	require.Equal(t, "true", res.Credentials[FieldIconSet].Reveal())
	require.Equal(t, "Acme", res.Credentials[FieldTeamName].Reveal())

	_, err = a.CompleteAuthorization(ctx, api.AuthorizationCompletion{Mode: api.AuthorizationWeb,
		Flow: begun.Flow, Code: "stale", RedirectURL: req.RedirectURL})
	require.ErrorContains(t, err, "no longer accepts the code")

	plain := map[string]string{}
	for k, v := range res.Credentials {
		plain[k] = v.Reveal()
	}
	connected := configured(t, apiURL, plain)
	caps = connected.Capabilities()
	require.True(t, caps.Authorized && caps.IconSet)
	require.Equal(t, "https://api.slack.com/apps/A123/general", caps.ManageURL)
}

// TestSlackRefusesWhatCannotConnect asserts the readable refusals: no https
// address for Slack to return to, no configuration token, a token Slack
// refuses, and an icon Slack would not take, which does not fail connecting.
func TestSlackRefusesWhatCannotConnect(t *testing.T) {
	f, apiURL := newFake(t)
	ctx := context.Background()
	a := configured(t, apiURL, nil)
	base := api.AuthorizationRequest{Mode: api.AuthorizationWeb, RedirectURL: "https://pando.example/cb", State: "s", Grant: secret.New("xoxe-good")}

	plain := base
	plain.RedirectURL = "http://localhost:8080/api/v1/notify/callback"
	_, err := a.BeginAuthorization(ctx, plain)
	require.ErrorContains(t, err, "only to an https address")

	none := base
	none.Grant = secret.Value{}
	_, err = a.BeginAuthorization(ctx, none)
	require.ErrorContains(t, err, "needs a configuration token")

	wrong := base
	wrong.Grant = secret.New("xoxe-bad")
	_, err = a.BeginAuthorization(ctx, wrong)
	require.ErrorContains(t, err, "did not accept the configuration token")
	require.NotContains(t, err.Error(), "xoxe-bad")

	f.iconFail = true
	begun, err := a.BeginAuthorization(ctx, base)
	require.NoError(t, err, "an icon Slack refuses does not stop connecting")
	require.Contains(t, begun.Flow.Reveal(), `"icon_set":false`)

	_, err = a.BeginAuthorization(ctx, api.AuthorizationRequest{Mode: "device"})
	require.Equal(t, errs.ValidInvalid, errs.CodeOf(err))
	_, err = a.CompleteAuthorization(ctx, api.AuthorizationCompletion{Mode: api.AuthorizationWeb, Flow: secret.New("{}")})
	require.ErrorContains(t, err, "not a Slack connection Pando started")
	_, err = a.CompleteAuthorization(ctx, api.AuthorizationCompletion{Mode: api.AuthorizationWeb, Flow: begun.Flow})
	require.ErrorContains(t, err, "without a code")
}

// TestR374_SlackIsConnectedByHandWithoutHTTPS asserts the way for a Pando
// Slack cannot return to: a link opening Slack's create-app screen with
// Pando's app filled in and no redirect, and the bot token it shows checked
// and kept.
func TestR374_SlackIsConnectedByHandWithoutHTTPS(t *testing.T) {
	_, apiURL := newFake(t)
	ctx := context.Background()
	a := configured(t, apiURL, nil)

	begun, err := a.BeginAuthorization(ctx, api.AuthorizationRequest{Mode: api.AuthorizationManual})
	require.NoError(t, err)
	link, err := url.Parse(begun.AuthorizeURL)
	require.NoError(t, err)
	require.Equal(t, "api.slack.com", link.Host)
	require.Equal(t, "1", link.Query().Get("new_app"))
	var m map[string]any
	require.NoError(t, json.Unmarshal([]byte(link.Query().Get("manifest_json")), &m))
	require.NotContains(t, m["oauth_config"], "redirect_urls", "an app made by hand is installed from Slack's own pages")

	_, err = a.CompleteAuthorization(ctx, api.AuthorizationCompletion{Mode: api.AuthorizationManual, Code: "not-a-token"})
	require.ErrorContains(t, err, "starts with xoxb-")
	_, err = a.CompleteAuthorization(ctx, api.AuthorizationCompletion{Mode: api.AuthorizationManual, Code: "xoxb-revoked"})
	require.ErrorContains(t, err, "no longer accepts Pando's bot token")
	res, err := a.CompleteAuthorization(ctx, api.AuthorizationCompletion{Mode: api.AuthorizationManual, Code: " xoxb-1 "})
	require.NoError(t, err)
	require.Equal(t, "xoxb-1", res.Credentials[FieldBotToken].Reveal())
	require.Equal(t, "false", res.Credentials[FieldIconSet].Reveal(), "the icon is the person's to upload")

	byHand := configured(t, apiURL, map[string]string{FieldBotToken: "xoxb-1"})
	require.Equal(t, "https://api.slack.com/apps", byHand.Capabilities().ManageURL)
}

// TestR374_SlackPostsToTheChannelTheSubscriptionChose asserts a message goes
// to the channel the notification names, laid out as Slack blocks, and that
// what Slack refuses is said in words.
func TestR374_SlackPostsToTheChannelTheSubscriptionChose(t *testing.T) {
	f, apiURL := newFake(t)
	ctx := context.Background()
	a := configured(t, apiURL, map[string]string{FieldBotToken: "xoxb-1"})

	require.NoError(t, a.Notify(ctx, api.Notification{Subject: "Deployed notes", Channel: "C1",
		Fields: []api.NotificationField{{Label: "App", Value: "notes"}}}))
	require.Len(t, f.posted, 1)
	require.Equal(t, "C1", f.posted[0]["channel"])
	require.Equal(t, "Deployed notes", f.posted[0]["text"])
	require.NotEmpty(t, f.posted[0]["blocks"])

	require.ErrorContains(t, a.Notify(ctx, api.Notification{Subject: "x"}), "names no channel")
	err := a.Notify(ctx, api.Notification{Subject: "x", Channel: "private-one"})
	require.ErrorContains(t, err, "/invite @Pando")

	revoked := configured(t, apiURL, map[string]string{FieldBotToken: "xoxb-revoked"})
	require.ErrorContains(t, revoked.Notify(ctx, api.Notification{Subject: "x", Channel: "C1"}), "Connect the Slack adapter again")
}

func TestSlackListsChannelsAcrossPagesAndByName(t *testing.T) {
	_, apiURL := newFake(t)
	ctx := context.Background()
	a := configured(t, apiURL, map[string]string{FieldBotToken: "xoxb-1"})

	all, err := a.Channels(ctx, "")
	require.NoError(t, err)
	require.Equal(t, []api.NotifyChannel{{ID: "C1", Name: "deploys"}, {ID: "C2", Name: "general"},
		{ID: "G1", Name: "ops-deploys", Private: true}}, all)
	some, err := a.Channels(ctx, "#Deploys")
	require.NoError(t, err)
	require.Len(t, some, 2)

	_, err = configured(t, apiURL, nil).Channels(ctx, "")
	require.Equal(t, errs.StateInvalid, errs.CodeOf(err))
}

// TestASlackAdapterWithAWebhookKeepsPostingThroughIt asserts an adapter set
// up before Pando made its own app, with an incoming webhook URL, still posts
// there, to its one channel, and has nothing to connect.
func TestASlackAdapterWithAWebhookKeepsPostingThroughIt(t *testing.T) {
	a := New()
	raw := json.RawMessage(`{"credentials":{"webhook_url":"https://hooks.slack.com/services/T/B/x"}}`)
	require.NoError(t, a.Configure(context.Background(), raw))
	caps := a.Capabilities()
	require.True(t, caps.Authorized)
	require.False(t, caps.Channels || caps.WebAuthorization || caps.ManualAuthorization)
	_, err := a.Channels(context.Background(), "")
	require.ErrorContains(t, err, "incoming webhook")
	_, err = a.BeginAuthorization(context.Background(), api.AuthorizationRequest{Mode: api.AuthorizationWeb})
	require.ErrorContains(t, err, "nothing to connect")

	require.ErrorContains(t, New().Configure(context.Background(),
		json.RawMessage(`{"credentials":{"webhook_url":"https://discord.com/api/webhooks/1/x"}}`)), "not a Slack address")
}

func TestSlackConfigurationIsCheckedAsItIsSaved(t *testing.T) {
	require.NoError(t, check(json.RawMessage(`{}`), nil, nil), "nothing yet: connecting fills it in")
	require.NoError(t, check(json.RawMessage(`{}`), nil, []string{FieldBotToken}), "a stored token is not re-read")
	require.ErrorContains(t, check(json.RawMessage(`{}`), map[string]secret.Value{FieldBotToken: secret.New("xoxp-user")}, nil), "xoxb-")
	require.ErrorContains(t, New().Configure(context.Background(), json.RawMessage(`{"bot_token":"xoxb-1"}`)), "unencrypted")
	require.NoError(t, Info().Validate())
	require.Error(t, New().HealthCheck(context.Background()), "not configured")
}
