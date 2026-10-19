package cli

import (
	"bytes"
	"encoding/json"
	"strings"
	"testing"

	"github.com/spf13/cobra"
	"github.com/stretchr/testify/require"
)

// TestR261_TheCLIWalksAKindsSteps asserts R-261 for guided setup: `pando
// adapter add` at a terminal asks a kind's settings step by step, as the
// console does — skipping a step another answer rules out, following a
// suggestion from an earlier answer, and leaving alone what --set gave.
func TestR261_TheCLIWalksAKindsSteps(t *testing.T) {
	var info kindInfo
	require.NoError(t, json.Unmarshal([]byte(`{
		"category": "routing", "kind": "example", "name": "Example",
		"fields": [
			{"key": "method", "label": "Method", "type": "select", "default": "token",
			 "options": [{"value": "token", "label": "Token"}, {"value": "key", "label": "Key"}]},
			{"key": "token", "label": "Token", "type": "string", "credential": true,
			 "shown_when": {"key": "method", "values": ["token"]}},
			{"key": "ssh_key", "label": "SSH key", "type": "string", "credential": true,
			 "shown_when": {"key": "method", "values": ["key"]}},
			{"key": "zone", "label": "Zone", "type": "string"},
			{"key": "console", "label": "Console", "type": "string", "suggest": "pando.{zone}"},
			{"key": "account", "label": "Account", "type": "string"}
		],
		"steps": [
			{"id": "method", "label": "Method", "title": "Choose a method", "fields": ["method"]},
			{"id": "token", "label": "Token", "title": "Create a token", "fields": ["token"],
			 "shown_when": {"key": "method", "values": ["token"]},
			 "do": [{"text": "Open **Tokens** and run `+"`make-token`"+`."}],
			 "links": [{"label": "Open tokens", "url": "https://{zone}/tokens"}]},
			{"id": "key", "label": "Key", "title": "Add a key", "fields": ["ssh_key"],
			 "shown_when": {"key": "method", "values": ["key"]}},
			{"id": "zones", "label": "Zones", "title": "Choose zones", "fields": ["zone", "console", "account"]}
		]}`), &info))

	cmd := &cobra.Command{}
	var stderr bytes.Buffer
	cmd.SetErr(&stderr)
	// Method: Enter keeps Token. Token. Zone. Console: Enter keeps the suggestion.
	cmd.SetIn(strings.NewReader("\ns3cret\nexample.com\n\n"))
	values := map[string]string{"account": "given"}
	credentials := map[string]string{}

	asked, err := walkSteps(cmd, &info, values, credentials)
	require.NoError(t, err)

	require.Equal(t, map[string]string{"account": "given", "zone": "example.com", "console": "pando.example.com"}, values)
	require.Equal(t, map[string]string{"token": "s3cret"}, credentials)
	require.True(t, asked["token"])
	require.False(t, asked["ssh_key"], "the key step is for the other method")
	require.False(t, asked["account"], "--set gave it")

	out := stderr.String()
	require.Contains(t, out, "Create a token (step 2 of 4)")
	require.Contains(t, out, "1. Open Tokens and run make-token.")
	require.NotContains(t, out, "Add a key")
	require.Contains(t, out, "Console [pando.example.com]: ")
	// The link names a setting not yet answered when it is shown.
	require.NotContains(t, out, "Open tokens:")
}
