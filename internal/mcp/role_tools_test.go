package mcp_test

import (
	"testing"

	"github.com/stretchr/testify/require"
)

// TestR082_RoleAndGroupEditsAsTools asserts R-082 with R-261: an agent edits a
// custom role, reads who holds it and renames a group through the console's
// endpoints.
func TestR082_RoleAndGroupEditsAsTools(t *testing.T) {
	srv, s := newSession()
	s.run(t, srv, call(1, "pando_edit_role", `{"role_id":"role_1","name":"Observers","verbs":["install.view"]}`))
	require.Len(t, s.calls, 1)
	require.Equal(t, "PATCH", s.calls[0].method)
	require.Equal(t, "/roles/role_1", s.calls[0].path)
	require.Equal(t, map[string]any{"name": "Observers", "verbs": []string{"install.view"}}, s.calls[0].body)

	srv, s = newSession()
	s.run(t, srv, call(1, "pando_edit_role", `{"role_id":"role_1","name":"Watchers"}`))
	require.Equal(t, map[string]any{"name": "Watchers"}, s.calls[0].body)

	srv, s = newSession()
	s.run(t, srv, call(1, "pando_list_role_holders", `{"role_id":"role_1"}`))
	require.Equal(t, "GET", s.calls[0].method)
	require.Equal(t, "/roles/role_1/holders", s.calls[0].path)

	srv, s = newSession()
	s.run(t, srv, call(1, "pando_rename_group", `{"group_id":"grp_1","name":"Platform"}`))
	require.Equal(t, "PATCH", s.calls[0].method)
	require.Equal(t, "/groups/grp_1", s.calls[0].path)
	require.Equal(t, map[string]any{"name": "Platform"}, s.calls[0].body)
}

// TestRoleToolsRefuseWhatTheyCannotSendWithoutCallingTheAPI: a missing or
// malformed argument is refused before the API, saying what was wanted.
func TestRoleToolsRefuseWhatTheyCannotSendWithoutCallingTheAPI(t *testing.T) {
	for _, tc := range []struct{ tool, args, want string }{
		{"pando_edit_role", `{}`, "role_id"},
		{"pando_edit_role", `{"role_id":"role_1"}`, "name, verbs, or both"},
		{"pando_edit_role", `{"role_id":"role_1","verbs":"install.view"}`, "verbs"},
		{"pando_edit_role", `{"role_id":"role_1","name":3}`, "name"},
		{"pando_list_role_holders", `{}`, "role_id"},
		{"pando_rename_group", `{}`, "group_id"},
		{"pando_rename_group", `{"group_id":"grp_1"}`, "name"},
	} {
		t.Run(tc.tool+" "+tc.args, func(t *testing.T) {
			srv, s := newSession()
			replies := s.run(t, srv, call(1, tc.tool, tc.args))
			require.Empty(t, s.calls, "nothing reaches the API")
			require.Equal(t, true, result(t, replies[0])["isError"])
			require.Contains(t, text(t, replies[0]), tc.want)
		})
	}
}
