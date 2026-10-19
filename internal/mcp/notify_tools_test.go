package mcp_test

import "testing"

// TestR374_NotifyToolsMapToTheirEndpoints asserts an agent connects Slack
// and finds its channels through the same API as every other surface
// (R-261), and names a subscription's channel the same way.
func TestR374_NotifyToolsMapToTheirEndpoints(t *testing.T) {
	requireToolCalls(t, []toolCase{
		{"pando_list_notify_adapters", `{}`, "GET", "/notify", ""},
		{"pando_connect_notify", `{"adapter_id":"ntf_slack","token":"xoxe-1"}`, "POST", "/notify/ntf_slack/authorize",
			`{"mode":"web","token":"xoxe-1"}`},
		{"pando_connect_notify", `{"adapter_id":"ntf_slack","mode":"manual"}`, "POST", "/notify/ntf_slack/authorize", `{"mode":"manual"}`},
		{"pando_list_notify_channels", `{"adapter_id":"ntf_slack","q":"dep loys"}`, "GET", "/notify/ntf_slack/channels?q=dep+loys", ""},
		{"pando_list_notify_channels", `{"adapter_id":"ntf_slack"}`, "GET", "/notify/ntf_slack/channels", ""},
		{"pando_create_subscription", `{"events":"deploy.*","adapter_id":"ntf_slack","channel":"C1"}`, "POST", "/subscriptions",
			`{"events":["deploy.*"],"app_id":"","description":"","destination":"notify","adapter_id":"ntf_slack","channel":"C1"}`},
		{"pando_update_subscription", `{"subscription_id":"sub_1","channel":"C2"}`, "PATCH", "/subscriptions/sub_1", `{"channel":"C2"}`},
	})
}
