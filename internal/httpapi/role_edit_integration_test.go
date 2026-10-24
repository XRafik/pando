//go:build integration

package httpapi_test

import (
	"net/http"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/trypando/pando/internal/core/authz"
)

type holdersPage struct {
	Role struct {
		ID   string `json:"id"`
		Name string `json:"name"`
	} `json:"role"`
	Holders []struct {
		Kind     string `json:"kind"`
		ID       string `json:"id"`
		Name     string `json:"name"`
		Username string `json:"username"`
		Via      string `json:"via"`
		GroupID  string `json:"group_id"`
	} `json:"holders"`
	NextCursor string `json:"next_cursor"`
	Total      int    `json:"total"`
	Groups     int    `json:"groups"`
}

func (i *install) holders(s *session, roleID, query string) holdersPage {
	i.t.Helper()
	got := i.do(s, http.MethodGet, "/roles/"+roleID+"/holders"+query, nil)
	require.Equal(i.t, http.StatusOK, got.Code, got.String())
	var page holdersPage
	got.JSON(i.t, &page)
	return page
}

func (i *install) group(s *session, name string) string {
	i.t.Helper()
	got := i.do(s, http.MethodPost, "/groups", map[string]any{"name": name})
	require.Equal(i.t, http.StatusCreated, got.Code, got.String())
	var g struct {
		ID string `json:"id"`
	}
	got.JSON(i.t, &g)
	return g.ID
}

// TestR082_ACustomRolesNameAndPermissionsCanBeChanged asserts that a custom
// role is edited in place, and its holders hold the new permissions at once:
// the role is read live, not copied into grants.
func TestR082_ACustomRolesNameAndPermissionsCanBeChanged(t *testing.T) {
	t.Parallel()
	i := newInstall(t)
	admin := i.admin()
	roleID := i.customRole(admin, "readers", "install", "install.audit.read")
	dana := i.user("dana")
	require.Equal(t, http.StatusOK,
		i.do(admin, http.MethodPut, "/users/"+i.userID(dana)+"/role", map[string]string{"role_id": roleID}).Code)
	require.Equal(t, http.StatusOK, i.do(dana, http.MethodGet, "/audit", nil).Code)

	got := i.do(admin, http.MethodPatch, "/roles/"+roleID, map[string]any{
		"name": "  Observers ", "verbs": []string{"install.view", "install.view"},
	})
	require.Equal(t, http.StatusOK, got.Code, got.String())
	var role struct {
		Name  string   `json:"name"`
		Scope string   `json:"scope"`
		Verbs []string `json:"verbs"`
	}
	got.JSON(t, &role)
	require.Equal(t, "Observers", role.Name)
	require.Equal(t, "install", role.Scope)
	require.Equal(t, []string{"install.view"}, role.Verbs)
	require.Equal(t, http.StatusForbidden, i.do(dana, http.MethodGet, "/audit", nil).Code, "the permission went with the edit")
	require.Equal(t, 1, i.auditCount(admin, "role.update"))

	// A rename alone keeps the permissions.
	got = i.do(admin, http.MethodPatch, "/roles/"+roleID, map[string]any{"name": "Watchers"})
	require.Equal(t, http.StatusOK, got.Code, got.String())
	got.JSON(t, &role)
	require.Equal(t, []string{"install.view"}, role.Verbs)

	for _, tc := range []struct {
		body map[string]any
		want string
	}{
		{map[string]any{"name": "Administrator"}, "built-in role"},
		{map[string]any{"name": " "}, "needs a name"},
		{map[string]any{"verbs": []string{}}, "at least one permission"},
		{map[string]any{"verbs": []string{"app.view"}}, "does not apply"},
		{map[string]any{"verbs": []string{"install.nothing"}}, "not a permission"},
		{map[string]any{}, "changes nothing"},
	} {
		refused := i.do(admin, http.MethodPatch, "/roles/"+roleID, tc.body)
		require.Equal(t, http.StatusBadRequest, refused.Code, refused.String())
		require.Contains(t, refused.String(), tc.want)
	}
	i.customRole(admin, "Others", "install", "install.view")
	refused := i.do(admin, http.MethodPatch, "/roles/"+roleID, map[string]any{"name": "others"})
	require.Equal(t, http.StatusBadRequest, refused.Code, refused.String())
	require.Contains(t, refused.String(), "already a role")

	require.Equal(t, http.StatusNotFound,
		i.do(admin, http.MethodPatch, "/roles/role_nothing", map[string]any{"name": "x"}).Code)
	require.Equal(t, http.StatusBadRequest, i.rawJSON(admin, http.MethodPatch, "/roles/"+roleID, "{").Code)
}

// TestR081_ABuiltInRoleCannotBeEdited asserts R-081 through the API: a
// built-in role refuses a rename and new permissions, and is unchanged.
func TestR081_ABuiltInRoleCannotBeEdited(t *testing.T) {
	t.Parallel()
	i := newInstall(t)
	admin := i.admin()
	for _, body := range []map[string]any{{"name": "Boss"}, {"verbs": []string{"app.view"}}} {
		refused := i.do(admin, http.MethodPatch, "/roles/"+authz.RoleViewer, body)
		require.Equal(t, http.StatusBadRequest, refused.Code, refused.String())
		require.Contains(t, refused.String(), "built-in roles cannot be changed")
	}
	var rows struct {
		Roles []struct {
			ID    string   `json:"id"`
			Name  string   `json:"name"`
			Verbs []string `json:"verbs"`
		} `json:"roles"`
	}
	i.do(admin, http.MethodGet, "/roles?scope=app", nil).JSON(t, &rows)
	for _, r := range rows.Roles {
		if r.ID == authz.RoleViewer {
			require.Equal(t, "viewer", r.Name)
			require.ElementsMatch(t, []string{"app.view", "app.logs.read"}, r.Verbs)
		}
	}
}

// TestR080a_EditingARoleHandsOnOnlyWhatTheEditorHolds asserts R-080a for an
// edit: an installation role is changed only by someone holding all its
// install verbs, before and after, and an app role gains a verb only from
// someone holding it on each app the role is granted on.
func TestR080a_EditingARoleHandsOnOnlyWhatTheEditorHolds(t *testing.T) {
	t.Parallel()
	i := newInstall(t)
	admin := i.admin()
	manager, _ := i.holding("manager", authz.InstallUsersManage, authz.InstallView)

	readers := i.customRole(admin, "readers", "install", "install.view")
	requireMissingVerbs(t, i.do(manager, http.MethodPatch, "/roles/"+readers,
		map[string]any{"verbs": []string{"install.view", "install.audit.read"}}))
	auditors := i.customRole(admin, "auditors", "install", "install.audit.read")
	requireMissingVerbs(t, i.do(manager, http.MethodPatch, "/roles/"+auditors, map[string]any{"name": "lookers"}))
	require.Equal(t, http.StatusOK,
		i.do(manager, http.MethodPatch, "/roles/"+readers, map[string]any{"name": "viewers"}).Code)

	// An app role granted nowhere hands nothing on; once granted on an app,
	// adding a verb is granting it there.
	appRole := i.customRole(admin, "app readers", "app", "app.view")
	require.Equal(t, http.StatusOK, i.do(manager, http.MethodPatch, "/roles/"+appRole,
		map[string]any{"verbs": []string{"app.view", "app.logs.read"}}).Code)
	appID := i.createApp(admin, "wiki")
	dana := i.user("dana")
	i.grantControl(appID, dana, appRole)
	requireMissingVerbs(t, i.do(manager, http.MethodPatch, "/roles/"+appRole,
		map[string]any{"verbs": []string{"app.view", "app.exec"}}))
	require.Equal(t, http.StatusOK, i.do(manager, http.MethodPatch, "/roles/"+appRole,
		map[string]any{"verbs": []string{"app.view"}}).Code, "taking an app verb away hands nothing on")
	require.Equal(t, http.StatusOK, i.do(admin, http.MethodPatch, "/roles/"+appRole,
		map[string]any{"verbs": []string{"app.view", "app.exec"}}).Code, "an administrator holds every app verb")
}

// TestR088_EditingARoleCannotLeaveNobodyToManageAccounts asserts R-088 for an
// edit: taking install.users.manage out of the role the only administrators
// hold it through is refused.
func TestR088_EditingARoleCannotLeaveNobodyToManageAccounts(t *testing.T) {
	t.Parallel()
	i := newInstall(t)
	admin := i.admin()
	ada, _ := i.holding("ada", authz.InstallUsersManage, authz.InstallView)
	var role struct {
		InstallRoleID string `json:"install_role_id"`
	}
	i.do(admin, http.MethodGet, "/users/"+i.idOf(ada), nil).JSON(t, &role)
	require.Equal(t, http.StatusNoContent, i.do(admin, http.MethodDelete, "/users/"+i.AdminID+"/role", nil).Code)

	refused := i.do(ada, http.MethodPatch, "/roles/"+role.InstallRoleID, map[string]any{"verbs": []string{"install.view"}})
	require.Equal(t, http.StatusBadRequest, refused.Code, refused.String())
	require.Contains(t, refused.String(), "only administrators manage accounts")
}

// TestR078_APandoGroupIsRenamedHereAndASyncedOneAtItsProvider asserts the
// split R-078 draws: Pando owns a native group, the provider a synced one's
// name as well as its members.
func TestR078_APandoGroupIsRenamedHereAndASyncedOneAtItsProvider(t *testing.T) {
	t.Parallel()
	i := newInstall(t)
	admin := i.admin()
	team := i.group(admin, "Team")
	i.group(admin, "Ops")

	got := i.do(admin, http.MethodPatch, "/groups/"+team, map[string]any{"name": " Platform "})
	require.Equal(t, http.StatusOK, got.Code, got.String())
	var g struct {
		Name string `json:"name"`
	}
	got.JSON(t, &g)
	require.Equal(t, "Platform", g.Name)
	require.Equal(t, 1, i.auditCount(admin, "group.rename"))

	for _, tc := range []struct {
		name, want string
		code       int
	}{
		{"Ops", "already a group", http.StatusBadRequest},
		{"", "needs a name", http.StatusBadRequest},
	} {
		refused := i.do(admin, http.MethodPatch, "/groups/"+team, map[string]any{"name": tc.name})
		require.Equal(t, tc.code, refused.Code, refused.String())
		require.Contains(t, refused.String(), tc.want)
	}
	require.Equal(t, http.StatusNotFound,
		i.do(admin, http.MethodPatch, "/groups/grp_nothing", map[string]any{"name": "x"}).Code)
	require.Equal(t, http.StatusBadRequest, i.rawJSON(admin, http.MethodPatch, "/groups/"+team, "{").Code)

	_, err := i.db.Exec(t.Context(), `INSERT INTO identity_adapters (id, kind, name, config) VALUES ('idp_okta', 'oidc', 'Okta', '{}')`)
	require.NoError(t, err)
	_, err = i.db.Exec(t.Context(), `INSERT INTO groups (id, adapter_id, external_id, name) VALUES ('grp_synced', 'idp_okta', 'eng', 'engineering')`)
	require.NoError(t, err)
	refused := i.do(admin, http.MethodPatch, "/groups/grp_synced", map[string]any{"name": "Engineering"})
	require.Equal(t, http.StatusBadRequest, refused.Code, refused.String())
	require.Contains(t, refused.String(), "renamed there")

	dana := i.user("dana")
	require.Equal(t, http.StatusForbidden,
		i.do(dana, http.MethodPatch, "/groups/"+team, map[string]any{"name": "Mine"}).Code)
}

// TestR078_ARolesHoldersAreItsGroupsAndEveryoneInThem asserts the holders
// list: groups granted the role, accounts granted it, and accounts holding it
// only through a group — read live, each once.
func TestR078_ARolesHoldersAreItsGroupsAndEveryoneInThem(t *testing.T) {
	t.Parallel()
	i := newInstall(t)
	admin := i.admin()
	roleID := i.customRole(admin, "readers", "install", "install.audit.read")

	ada, bo := i.user("ada"), i.user("bo")
	adaID, boID := i.userID(ada), i.userID(bo)
	team := i.group(admin, "Team")
	require.Equal(t, http.StatusOK,
		i.do(admin, http.MethodPut, "/users/"+adaID+"/role", map[string]string{"role_id": roleID}).Code)
	require.Equal(t, http.StatusOK,
		i.do(admin, http.MethodPut, "/groups/"+team+"/role", map[string]string{"role_id": roleID}).Code)
	for _, id := range []string{adaID, boID} {
		require.Equal(t, http.StatusNoContent, i.do(admin, http.MethodPut, "/groups/"+team+"/members/"+id, nil).Code)
	}

	var one struct {
		InstallRoleID string `json:"install_role_id"`
	}
	i.do(admin, http.MethodGet, "/groups/"+team, nil).JSON(t, &one)
	require.Equal(t, roleID, one.InstallRoleID, "a group carries its installation role, as the list does")

	page := i.holders(admin, roleID, "")
	require.Equal(t, roleID, page.Role.ID)
	require.Equal(t, 3, page.Total)
	require.Equal(t, 1, page.Groups)
	require.Len(t, page.Holders, 3)
	require.Equal(t, "group", page.Holders[0].Kind)
	require.Equal(t, team, page.Holders[0].ID)
	require.Equal(t, "direct", page.Holders[0].Via)
	require.Equal(t, adaID, page.Holders[1].ID)
	require.Equal(t, "direct", page.Holders[1].Via, "a grant of its own wins over the group's")
	require.Equal(t, "ada", page.Holders[1].Username)
	require.Equal(t, boID, page.Holders[2].ID)
	require.Equal(t, "group", page.Holders[2].Via)
	require.Equal(t, team, page.Holders[2].GroupID)

	// A page at a time, in the same order.
	first := i.holders(admin, roleID, "?limit=2")
	require.Len(t, first.Holders, 2)
	require.NotEmpty(t, first.NextCursor)
	rest := i.holders(admin, roleID, "?limit=2&cursor="+first.NextCursor)
	require.Len(t, rest.Holders, 1)
	require.Equal(t, boID, rest.Holders[0].ID)
	require.Empty(t, rest.NextCursor)

	// Live: out of the group, out of the list.
	require.Equal(t, http.StatusNoContent, i.do(admin, http.MethodDelete, "/groups/"+team+"/members/"+boID, nil).Code)
	require.Equal(t, 2, i.holders(admin, roleID, "").Total)

	// An app role's holders are those holding it on any app, each once.
	appRole := i.customRole(admin, "app readers", "app", "app.view")
	for _, name := range []string{"one", "two"} {
		i.grantControl(i.createApp(admin, name), bo, appRole)
	}
	app := i.holders(admin, appRole, "")
	require.Equal(t, 1, app.Total)
	require.Equal(t, boID, app.Holders[0].ID)
	require.Equal(t, "direct", app.Holders[0].Via)

	require.Equal(t, http.StatusNotFound, i.do(admin, http.MethodGet, "/roles/role_nothing/holders", nil).Code)
	require.Equal(t, http.StatusBadRequest, i.do(admin, http.MethodGet, "/roles/"+roleID+"/holders?cursor=zz", nil).Code)
	require.Equal(t, http.StatusBadRequest, i.do(admin, http.MethodGet, "/roles/"+roleID+"/holders?limit=0", nil).Code)
	require.Equal(t, http.StatusForbidden, i.do(bo, http.MethodGet, "/roles/"+roleID+"/holders", nil).Code)
}
