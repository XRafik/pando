package cli_test

import (
	"encoding/json"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/trypando/pando/internal/cli"
)

// R-340, R-261: an agent sets an app's image through MCP, and what reaches the
// API is the file itself — not base64, not JSON — exactly as the CLI sends it.
func TestR340_MCPSendsAnImageAsTheFileItself(t *testing.T) {
	api := newAPI(t).reply("PUT /apps/app_1/icon", map[string]any{"id": "app_1", "icon_updated_at": "2026-09-21T09:00:00Z"})
	t.Setenv(cli.EnvServer, api.url)
	t.Setenv(cli.EnvToken, "tok_test")

	// "iVBORw==" is the four bytes \x89 P N G.
	stdin := `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"pando_set_app_icon","arguments":{"app_id":"app_1","image_base64":"iVBORw=="}}}` + "\n" +
		`{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"pando_list_my_apps","arguments":{}}}` + "\n"

	got := run(t, api, stdin, "mcp")
	require.NoError(t, got.err, got.errOut)
	require.Equal(t, "\x89PNG", api.bodyFor("PUT /apps/app_1/icon"))
	require.Contains(t, got.out, "icon_updated_at", "the API's answer comes back to the agent")
	require.True(t, api.sawPath("/me/apps"), "and ordinary JSON tools still go the JSON way")
}

// TestR262_MCPReturnsAnAppsPlainTextLogs asserts R-262 through the CLI's own
// client. The logs endpoint answers text/plain, and decoding it as JSON failed
// on the first line npm prints ("invalid character '>'") and kept only the first
// line of JSON-per-line logs.
func TestR262_MCPReturnsAnAppsPlainTextLogs(t *testing.T) {
	logs := "> notes@1.0.0 start\n> node server.js\n{\"level\":\"info\",\"msg\":\"listening\"}\n{\"level\":\"info\",\"msg\":\"ready\"}\n"
	api := newAPI(t).reply("GET /apps/app_1/logs", logs)
	t.Setenv(cli.EnvServer, api.url)
	t.Setenv(cli.EnvToken, "tok_test")

	stdin := `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"pando_get_logs","arguments":{"app_id":"app_1"}}}` + "\n"

	got := run(t, api, stdin, "mcp")
	require.NoError(t, got.err, got.errOut)

	var reply struct {
		Result struct {
			IsError bool `json:"isError"`
			Content []struct {
				Text string `json:"text"`
			} `json:"content"`
		} `json:"result"`
	}
	require.NoError(t, json.Unmarshal([]byte(got.out), &reply), got.out)
	require.False(t, reply.Result.IsError, got.out)
	require.Len(t, reply.Result.Content, 1)
	require.Equal(t, logs, reply.Result.Content[0].Text)
}
