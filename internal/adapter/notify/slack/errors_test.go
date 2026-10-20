package slack

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/trypando/pando/internal/adapter/api"
	"github.com/trypando/pando/internal/errs"
	"github.com/trypando/pando/internal/secret"
)

// answering is a Slack Web API that answers every method with status and
// body.
func answering(t *testing.T, status int, body string) string {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(status)
		_, _ = w.Write([]byte(body))
	}))
	t.Cleanup(srv.Close)
	return srv.URL + "/"
}

// TestWhatSlackAnswersIsSaidInWords asserts every way Slack can refuse or
// fail is a readable error naming what to do, and none carries the token.
func TestWhatSlackAnswersIsSaidInWords(t *testing.T) {
	ctx := context.Background()
	post := func(apiURL, channel string) error {
		a := configured(t, apiURL, map[string]string{FieldBotToken: "xoxb-secret"})
		return a.Notify(context.Background(), api.Notification{Subject: "x", Channel: channel})
	}
	for name, tc := range map[string]struct {
		status int
		body   string
		want   string
	}{
		"a server error":       {http.StatusBadGateway, `{}`, "Slack answered 502"},
		"not JSON":             {http.StatusOK, `<html>`, "could not be read"},
		"a missing permission": {http.StatusOK, `{"ok":false,"error":"missing_scope"}`, "missing a permission"},
		"a deleted channel":    {http.StatusOK, `{"ok":false,"error":"channel_not_found"}`, "no channel C9"},
		"an archived channel":  {http.StatusOK, `{"ok":false,"error":"is_archived"}`, "archived"},
		"anything else":        {http.StatusOK, `{"ok":false,"error":"ratelimited"}`, "refused the request: ratelimited"},
		"an expired token":     {http.StatusOK, `{"ok":false,"error":"invalid_auth"}`, "no longer accepts"},
	} {
		err := post(answering(t, tc.status, tc.body), "C9")
		require.ErrorContains(t, err, tc.want, name)
		require.NotContains(t, err.Error(), "xoxb-secret", name)
	}

	gone := httptest.NewServer(http.NotFoundHandler())
	gone.Close()
	err := post(gone.URL+"/", "C9")
	require.ErrorContains(t, err, "could not reach Slack")

	_, err = configured(t, answering(t, http.StatusOK, `{"ok":false,"error":"invalid_auth"}`), map[string]string{FieldBotToken: "xoxb-1"}).
		Channels(ctx, "")
	require.ErrorContains(t, err, "Connect the Slack adapter again")
	require.Equal(t, "Slack answered ratelimited", apiError{code: "ratelimited"}.Error())
	require.Empty(t, code(errs.New(errs.Internal, "not Slack's")))
}

// TestConnectingSaysWhatSlackGot asserts the refusals of connecting that
// Slack's answers decide: no app in the answer, an approval address not on
// Slack, a code exchanged for something that is not a bot token.
func TestConnectingSaysWhatSlackGot(t *testing.T) {
	ctx := context.Background()
	req := api.AuthorizationRequest{Mode: api.AuthorizationWeb, RedirectURL: "https://pando.example/cb", State: "s", Grant: secret.New("xoxe-1")}

	_, err := configured(t, answering(t, http.StatusOK, `{"ok":true}`), nil).BeginAuthorization(ctx, req)
	require.ErrorContains(t, err, "without the app it created")

	elsewhere := `{"ok":true,"app_id":"A1","credentials":{"client_id":"1","client_secret":"s"},"oauth_authorize_url":"https://evil.example/x"}`
	_, err = configured(t, answering(t, http.StatusOK, elsewhere), nil).BeginAuthorization(ctx, req)
	require.ErrorContains(t, err, "does not recognize")

	_, err = configured(t, answering(t, http.StatusOK, `{"ok":false,"error":"app_limit_reached"}`), nil).BeginAuthorization(ctx, req)
	require.ErrorContains(t, err, "did not create Pando's app: app_limit_reached")

	flow, _ := json.Marshal(flow{ClientID: "1", ClientSecret: "s"})
	done := api.AuthorizationCompletion{Mode: api.AuthorizationWeb, Flow: secret.New(string(flow)), Code: "c"}
	_, err = configured(t, answering(t, http.StatusOK, `{"ok":true,"access_token":"xoxp-user"}`), nil).CompleteAuthorization(ctx, done)
	require.ErrorContains(t, err, "without a bot token")
	_, err = configured(t, answering(t, http.StatusOK, `{"ok":false,"error":"invalid_client"}`), nil).CompleteAuthorization(ctx, done)
	require.ErrorContains(t, err, "refused the request: invalid_client")
	_, err = configured(t, answering(t, http.StatusOK, `{}`), nil).CompleteAuthorization(ctx,
		api.AuthorizationCompletion{Mode: "device"})
	require.Equal(t, errs.ValidInvalid, errs.CodeOf(err))

	webhook := New()
	require.NoError(t, webhook.Configure(ctx, json.RawMessage(`{"credentials":{"webhook_url":"https://hooks.slack.com/services/T/B/x"}}`)))
	_, err = webhook.CompleteAuthorization(ctx, api.AuthorizationCompletion{Mode: api.AuthorizationManual, Code: "xoxb-1"})
	require.Error(t, err)
}

func TestConfigurationThatCannotBeReadIsRefused(t *testing.T) {
	ctx := context.Background()
	require.ErrorContains(t, New().Configure(ctx, json.RawMessage(`[`)), "reading configuration")
	require.ErrorContains(t, New().Configure(ctx, json.RawMessage(`{"timeout_seconds":"ten"}`)), "reading configuration")
	require.Equal(t, Kind, New().Kind())
	require.Equal(t, api.CategoryNotify, New().Category())
	a := &Adapter{}
	require.NoError(t, a.Configure(ctx, nil), "nothing yet is an adapter not connected")
	require.NoError(t, a.HealthCheck(ctx))
}
