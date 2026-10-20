package cli_test

import (
	"testing"

	"github.com/stretchr/testify/require"
)

// TestR374_SlackIsConnectedFromTheCLI asserts `pando notify`: the adapters
// and which still need connecting, connecting with a configuration token,
// by hand without https, and the channels a subscription can name.
func TestR374_SlackIsConnectedFromTheCLI(t *testing.T) {
	api := newAPI(t).
		reply("GET /notify", map[string]any{"adapters": []map[string]any{
			{"id": "ntf_console", "kind": "console", "capabilities": map[string]any{"audience": "people", "authorized": true}},
			{"id": "ntf_slack", "kind": "slack", "capabilities": map[string]any{"audience": "channel", "web_authorization": true}},
		}}).
		reply("POST /notify/ntf_slack/authorize", map[string]any{"authorize_url": "https://slack.com/oauth/v2/authorize?state=x"}).
		reply("GET /notify/ntf_slack/channels", map[string]any{"channels": []map[string]any{
			{"id": "C1", "name": "deploys"}, {"id": "G1", "name": "ops", "private": true}}})

	got := run(t, api, "", "notify", "list")
	require.NoError(t, got.err, got.errOut)
	require.Regexp(t, `ntf_console\s+console\s+people\s+ready`, got.out)
	require.Contains(t, got.out, "not connected: pando notify connect ntf_slack")

	got = run(t, api, "xoxe-1\n", "notify", "connect", "ntf_slack")
	require.NoError(t, got.err, got.errOut)
	require.JSONEq(t, `{"mode":"web","token":"xoxe-1"}`, api.bodyFor("POST /notify/ntf_slack/authorize"))
	require.Contains(t, got.out, "https://slack.com/oauth/v2/authorize?state=x")

	link := newAPI(t).reply("POST /notify/ntf_slack/authorize", map[string]any{"authorize_url": "https://api.slack.com/apps?new_app=1"})
	got = run(t, link, "", "notify", "connect", "ntf_slack", "--manual")
	require.NoError(t, got.err, got.errOut)
	require.JSONEq(t, `{"mode":"manual"}`, link.bodyFor("POST /notify/ntf_slack/authorize"))
	require.Contains(t, got.out, "--bot-token")

	done := newAPI(t).reply("POST /notify/ntf_slack/authorize", map[string]any{"status": "authorized"})
	got = run(t, done, "xoxb-1\n", "notify", "connect", "ntf_slack", "--bot-token")
	require.NoError(t, got.err, got.errOut)
	require.JSONEq(t, `{"mode":"manual","token":"xoxb-1"}`, done.bodyFor("POST /notify/ntf_slack/authorize"))
	require.Contains(t, got.out, "Connected.")

	require.ErrorContains(t, run(t, api, "\n", "notify", "connect", "ntf_slack").err, "configuration token is needed")

	got = run(t, api, "", "notify", "channels", "ntf_slack", "--query", "dep")
	require.NoError(t, got.err, got.errOut)
	require.Regexp(t, `C1\s+#deploys\s+no`, got.out)
	require.Regexp(t, `G1\s+#ops\s+yes`, got.out)
	require.True(t, api.sawPath("/notify/ntf_slack/channels?q=dep"))

	empty := newAPI(t).reply("GET /notify/ntf_slack/channels", map[string]any{"channels": []any{}})
	require.Contains(t, run(t, empty, "", "notify", "channels", "ntf_slack").out, "/invite @Pando")
}

// TestR367_ASubscriptionNamesItsChannelFromTheCLI asserts --channel goes to
// the API with a notify subscription, and is shown with it.
func TestR367_ASubscriptionNamesItsChannelFromTheCLI(t *testing.T) {
	api := newAPI(t).
		reply("POST /subscriptions", map[string]any{"id": "sub_1", "destination": "notify", "adapter_id": "ntf_slack",
			"channel": "C1", "events": []string{"deploy.*"}}).
		reply("PATCH /subscriptions/sub_1", map[string]any{"id": "sub_1"})
	got := run(t, api, "", "subscriptions", "create", "--events", "deploy.*", "--adapter", "ntf_slack", "--channel", "C1")
	require.NoError(t, got.err, got.errOut)
	require.Contains(t, api.bodyFor("POST /subscriptions"), `"channel":"C1"`)
	require.Contains(t, got.out, "notify:ntf_slack C1")

	got = run(t, api, "", "subscriptions", "update", "sub_1", "--channel", "C2")
	require.NoError(t, got.err, got.errOut)
	require.JSONEq(t, `{"channel":"C2"}`, api.bodyFor("PATCH /subscriptions/sub_1"))
}
