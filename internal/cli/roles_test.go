package cli_test

import (
	"testing"

	"github.com/stretchr/testify/require"
)

// TestR082_RoleEditAndHoldersFromTheCLI asserts R-082 with R-261: a custom
// role is renamed and given new permissions, and its holders read, through the
// same endpoints as the console; a group is renamed the same way.
func TestR082_RoleEditAndHoldersFromTheCLI(t *testing.T) {
	api := newAPI(t).reply("PATCH /roles/role_01", map[string]any{"id": "role_01", "name": "Observers"})

	got := run(t, api, "", "role", "edit", "role_01", "--name", "Observers", "--verbs", "install.view,install.audit.read")
	require.NoError(t, got.err, got.errOut)
	require.Contains(t, got.out, "Observers")
	require.JSONEq(t, `{"name":"Observers","verbs":["install.view","install.audit.read"]}`, api.bodyFor("PATCH /roles/role_01"))

	api = newAPI(t).reply("PATCH /roles/role_01", map[string]any{"id": "role_01"})
	got = run(t, api, "", "role", "edit", "role_01", "--name", "Watchers")
	require.NoError(t, got.err, got.errOut)
	require.JSONEq(t, `{"name":"Watchers"}`, api.bodyFor("PATCH /roles/role_01"))

	got = run(t, api, "", "role", "edit", "role_01")
	require.Error(t, got.err, "nothing to change")

	api = newAPI(t).reply("GET /roles/role_01/holders", map[string]any{"holders": []map[string]any{
		{"kind": "user", "id": "usr_01", "name": "Dana", "via": "group"}}})
	got = run(t, api, "", "role", "holders", "role_01")
	require.NoError(t, got.err, got.errOut)
	require.Contains(t, got.out, `"usr_01"`)

	got = run(t, api, "", "group", "rename", "grp_01", "Platform")
	require.NoError(t, got.err, got.errOut)
	require.Contains(t, got.out, "Renamed.")
	require.JSONEq(t, `{"name":"Platform"}`, api.bodyFor("PATCH /groups/grp_01"))
}
