//go:build integration

package state_test

import (
	"context"
	"errors"
	"os"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/trypando/pando/internal/core/authz"
	"github.com/trypando/pando/internal/core/spec"
	"github.com/trypando/pando/internal/core/state"
	"github.com/trypando/pando/internal/errs"
)

// runningApp creates an app owned by owner, pinned and meant to be running.
func runningApp(t *testing.T, db *state.DB, name, owner string) state.App {
	t.Helper()
	ctx := context.Background()
	apps := state.NewApps(db)
	app, err := apps.Create(ctx, name, name, owner, owner, spec.Source{Type: spec.SourceGit, URL: "https://example.test/" + name})
	require.NoError(t, err)
	rev, err := apps.CreateRevision(ctx, app.ID, minimalSpec(), spec.OriginManual, owner)
	require.NoError(t, err)
	require.NoError(t, apps.Pin(ctx, app.ID, rev.ID, state.StateRunning, owner))
	require.NoError(t, apps.SetDesiredState(ctx, app.ID, state.StateRunning))
	return app
}

func orphanIDs(t *testing.T, list []state.OrphanApp) []string {
	t.Helper()
	out := []string{}
	for _, a := range list {
		out = append(out, a.AppID)
	}
	return out
}

// TestR406_AnAppIsOrphanedWhenNoneOfItsOwnersIsActive asserts R-406 at the
// database: an app is orphaned when its owner of record and every account
// holding Owner on it are suspended or deleted; an active co-owner keeps it
// owned, and a group holding Owner keeps it owned whoever is in the group.
func TestR406_AnAppIsOrphanedWhenNoneOfItsOwnersIsActive(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	db := connected(t)
	users := state.NewUsers(db)
	grants := state.NewGrants(db)
	groups := state.NewGroups(db)
	orphans := state.NewOrphans(db)

	alice := seedUser(t, db, "orphan-alice")
	bob := seedUser(t, db, "orphan-bob")
	solo := runningApp(t, db, "solo", alice.ID)
	shared := runningApp(t, db, "shared", alice.ID)
	team := runningApp(t, db, "team", alice.ID)

	_, err := grants.Create(ctx, shared.ID, "control", "user", bob.ID, authz.RoleOwner, alice.ID)
	require.NoError(t, err)
	empty, err := groups.Create(ctx, "nobody")
	require.NoError(t, err)
	_, err = grants.Create(ctx, team.ID, "control", "group", empty.ID, authz.RoleOwner, alice.ID)
	require.NoError(t, err)

	list, err := orphans.NewlyOrphaned(ctx)
	require.NoError(t, err)
	assert.Empty(t, list, "every app has an active owner")

	require.NoError(t, users.SetStatusBy(ctx, alice.ID, "suspended", "test"))
	list, err = orphans.NewlyOrphaned(ctx)
	require.NoError(t, err)
	assert.Equal(t, []string{solo.ID}, orphanIDs(t, list),
		"an active co-owner keeps shared, and a group holding Owner keeps team, even with nobody in it")

	require.NoError(t, users.Delete(ctx, bob.ID))
	list, err = orphans.NewlyOrphaned(ctx)
	require.NoError(t, err)
	assert.ElementsMatch(t, []string{solo.ID, shared.ID}, orphanIDs(t, list), "a deleted co-owner is not an owner")
}

// TestR407_AnOrphanedAppIsStoppedOnceAndStartedClear asserts R-407 at the
// database: marking an orphaned app stops it in the same write and records why;
// starting it clears the stop and keeps the mark, so it is not stopped again;
// an owner coming back unmarks it, and losing them again is a new orphaning.
func TestR407_AnOrphanedAppIsStoppedOnceAndStartedClear(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	db := connected(t)
	users := state.NewUsers(db)
	apps := state.NewApps(db)
	orphans := state.NewOrphans(db)

	alice := seedUser(t, db, "orphan-stop-alice")
	app := runningApp(t, db, "notes", alice.ID)

	marked, stopped, err := orphans.MarkOrphaned(ctx, app.ID, true)
	require.NoError(t, err)
	assert.False(t, marked, "an app with an active owner is not marked")
	assert.False(t, stopped)

	require.NoError(t, users.SetStatusBy(ctx, alice.ID, "suspended", "test"))
	marked, stopped, err = orphans.MarkOrphaned(ctx, app.ID, true)
	require.NoError(t, err)
	require.True(t, marked)
	require.True(t, stopped)
	got, _, err := apps.ByID(ctx, app.ID)
	require.NoError(t, err)
	assert.Equal(t, state.StateStopped, got.DesiredState)
	assert.True(t, got.StoppedForOrphan, "the stop says why")
	assert.True(t, got.Orphaned)

	marked, _, err = orphans.MarkOrphaned(ctx, app.ID, true)
	require.NoError(t, err)
	assert.False(t, marked, "an app is marked once per orphaning")

	unannounced, err := orphans.Unannounced(ctx)
	require.NoError(t, err)
	require.Len(t, unannounced, 1)
	assert.True(t, unannounced[0].Stopped)
	require.NoError(t, orphans.MarkAnnounced(ctx, []string{app.ID}))
	unannounced, err = orphans.Unannounced(ctx)
	require.NoError(t, err)
	assert.Empty(t, unannounced, "administrators are told once")

	// An administrator starts it while it is still orphaned: it keeps running.
	require.NoError(t, apps.SetDesiredState(ctx, app.ID, state.StateRunning))
	got, _, err = apps.ByID(ctx, app.ID)
	require.NoError(t, err)
	assert.False(t, got.StoppedForOrphan, "starting it ends the stop")
	assert.True(t, got.Orphaned, "and it still has no owner")
	list, err := orphans.NewlyOrphaned(ctx)
	require.NoError(t, err)
	assert.Empty(t, list, "so the pass does not stop it again")

	// Its owner comes back, and goes again.
	require.NoError(t, users.SetStatusBy(ctx, alice.ID, "active", "test"))
	cleared, err := orphans.ClearOwned(ctx)
	require.NoError(t, err)
	assert.Equal(t, []string{app.ID}, cleared)
	got, _, err = apps.ByID(ctx, app.ID)
	require.NoError(t, err)
	assert.False(t, got.Orphaned)

	require.NoError(t, users.SetStatusBy(ctx, alice.ID, "suspended", "test"))
	marked, stopped, err = orphans.MarkOrphaned(ctx, app.ID, false)
	require.NoError(t, err)
	assert.True(t, marked, "losing the owner again is a new orphaning")
	assert.False(t, stopped, "with the policy off it keeps running")
	got, _, err = apps.ByID(ctx, app.ID)
	require.NoError(t, err)
	assert.Equal(t, state.StateRunning, got.DesiredState)
	assert.False(t, got.StoppedForOrphan)
}

// TestR408_AdministratorsAreThoseHoldingTheBuiltInRole asserts R-408's
// recipients: active accounts holding the built-in Administrator role directly
// or through a group, and nobody holding another role.
func TestR408_AdministratorsAreThoseHoldingTheBuiltInRole(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	db := connected(t)
	grants := state.NewGrants(db)
	groups := state.NewGroups(db)
	users := state.NewUsers(db)

	direct := seedUser(t, db, "orphan-admin")
	member := seedUser(t, db, "orphan-member")
	suspended := seedUser(t, db, "orphan-suspended-admin")
	auditor := seedUser(t, db, "orphan-auditor")

	_, err := grants.GrantInstall(ctx, "user", direct.ID, authz.RoleAdministrator, "test")
	require.NoError(t, err)
	_, err = grants.GrantInstall(ctx, "user", suspended.ID, authz.RoleAdministrator, "test")
	require.NoError(t, err)
	_, err = grants.GrantInstall(ctx, "user", auditor.ID, authz.RoleAuditor, "test")
	require.NoError(t, err)
	admins, err := groups.Create(ctx, "admins")
	require.NoError(t, err)
	require.NoError(t, groups.AddMember(ctx, admins.ID, member.ID))
	_, err = grants.GrantInstall(ctx, "group", admins.ID, authz.RoleAdministrator, "test")
	require.NoError(t, err)
	require.NoError(t, users.SetStatusBy(ctx, suspended.ID, "suspended", "test"))

	got, err := state.NewOrphans(db).Administrators(ctx)
	require.NoError(t, err)
	assert.ElementsMatch(t, []string{direct.ID, member.ID}, got)
}

// TestR408_LinkingAwayAnAppsLastOwnerNeedsConfirming asserts R-408: moving an
// identity suspends the account it leaves as an alias, and when that account
// is the last active owner of an app, linking is refused, naming the app,
// until it is confirmed.
func TestR408_LinkingAwayAnAppsLastOwnerNeedsConfirming(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	db := connected(t)
	identities := state.NewIdentities(db)
	_, err := db.Exec(ctx, `INSERT INTO identity_adapters (id, kind, name, config) VALUES ('idp_okta', 'oidc', 'Okta', '{}')`)
	require.NoError(t, err)

	old, err := identities.CreateExternal(ctx, state.NewExternal{AdapterID: "idp_okta", ExternalID: "00u1", CreatedBy: "test"})
	require.NoError(t, err)
	runningApp(t, db, "wiki", old.ID)
	target := seedUser(t, db, "orphan-link-target")

	_, err = identities.Link(ctx, target.ID, "idp_okta", "00u1", "test", true, false)
	var e *errs.Error
	require.True(t, errors.As(err, &e), "refused: %v", err)
	assert.Contains(t, e.Message, "last active owner of wiki")
	assert.Equal(t, []string{"wiki"}, e.Details["orphaned_apps"])
	assert.Contains(t, e.Remedy, "confirm")

	aliased, err := identities.Link(ctx, target.ID, "idp_okta", "00u1", "test", true, true)
	require.NoError(t, err)
	assert.Equal(t, old.ID, aliased, "confirmed, the identity moves and the account it left is an alias")
}

// TestR407_TheUpgradeMarksAppsAlreadyOrphanedWithoutStoppingThem asserts
// migration 78's upgrade step, run as written against apps made after the
// fact: an app already without an active owner is marked and left running,
// to be announced; one with an active owner, a group owner or no owner at all
// is left alone.
func TestR407_TheUpgradeMarksAppsAlreadyOrphanedWithoutStoppingThem(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	db := connected(t)
	users := state.NewUsers(db)
	grants := state.NewGrants(db)
	groups := state.NewGroups(db)
	apps := state.NewApps(db)

	gone := seedUser(t, db, "upgrade-gone")
	here := seedUser(t, db, "upgrade-here")
	orphaned := runningApp(t, db, "orphaned", gone.ID)
	coOwned := runningApp(t, db, "co-owned", gone.ID)
	_, err := grants.Create(ctx, coOwned.ID, "control", "user", here.ID, authz.RoleOwner, gone.ID)
	require.NoError(t, err)
	teamOwned := runningApp(t, db, "team-owned", gone.ID)
	team, err := groups.Create(ctx, "upgrade-team")
	require.NoError(t, err)
	_, err = grants.Create(ctx, teamOwned.ID, "control", "group", team.ID, authz.RoleOwner, gone.ID)
	require.NoError(t, err)
	require.NoError(t, users.SetStatusBy(ctx, gone.ID, "suspended", "test"))

	up, err := os.ReadFile("../../../migrations/000078_orphaned_apps.up.sql")
	require.NoError(t, err)
	sql := string(up)
	start := strings.Index(sql, "UPDATE apps SET orphaned_at = now()")
	require.GreaterOrEqual(t, start, 0)
	end := strings.Index(sql[start:], ";")
	_, err = db.Exec(ctx, sql[start:start+end])
	require.NoError(t, err)

	for _, c := range []struct {
		app      state.App
		orphaned bool
	}{{orphaned, true}, {coOwned, false}, {teamOwned, false}} {
		got, _, err := apps.ByID(ctx, c.app.ID)
		require.NoError(t, err)
		assert.Equal(t, c.orphaned, got.Orphaned, c.app.Name)
		assert.Equal(t, state.StateRunning, got.DesiredState, "%s is not stopped by the upgrade", c.app.Name)
		assert.False(t, got.StoppedForOrphan, c.app.Name)
	}
	unannounced, err := state.NewOrphans(db).Unannounced(ctx)
	require.NoError(t, err)
	assert.Equal(t, []string{orphaned.ID}, orphanIDs(t, unannounced), "and administrators are told of it")
}
