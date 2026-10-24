//go:build integration

package audit_test

import (
	"context"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/trypando/pando/internal/core/audit"
)

// TestR379_ANamedTargetIsKeptOverTheApp asserts R-379: an event that names
// its own target is recorded as about that target, with the app it happened
// in kept beside it rather than taking its place, and an outcome its action
// does not end in derived from the catalog's list.
func TestR379_ANamedTargetIsKeptOverTheApp(t *testing.T) {
	r := newRetention(t)
	ctx := context.Background()
	w := audit.New(r.app)
	require.NoError(t, w.Write(ctx, audit.Event{
		PrincipalKind: audit.KindUser, PrincipalID: "usr_ops", Action: "grant.create",
		AppID: "app_1", TargetKind: "user", TargetID: "usr_grantee", Detail: map[string]any{"role": "app.viewer"},
	}))
	require.NoError(t, w.Write(ctx, audit.Event{
		PrincipalKind: audit.KindSystem, PrincipalID: "system", Action: "app.delete.backup_failed", AppID: "app_1",
	}))

	recs, err := audit.NewReader(r.app).List(ctx, audit.Query{})
	require.NoError(t, err)
	require.Len(t, recs, 2)
	backup, grant := recs[0], recs[1]

	assert.Equal(t, "user", grant.TargetKind)
	assert.Equal(t, "usr_grantee", grant.TargetID)
	assert.Equal(t, "app_1", grant.AppID, "the app is kept beside a narrower target")
	assert.Equal(t, "success", grant.Outcome)
	assert.Equal(t, map[string]any{"role": "app.viewer"}, grant.Detail)

	assert.Equal(t, "failed", backup.Outcome, "a failure the action's last segment does not say")
	assert.Equal(t, "app", backup.TargetKind)
	assert.Equal(t, "app_1", backup.TargetID)
}

// TestR379_AReadNamesTheAppAndTargetAndSummarizes asserts R-379's summary as
// read: an event comes back with the names its app and target go by now and a
// sentence made from them, and the log narrows by outcome and by text found in
// the action, the actor or the app's name.
func TestR379_AReadNamesTheAppAndTargetAndSummarizes(t *testing.T) {
	r := newRetention(t)
	ctx := context.Background()
	_, err := r.owner.Exec(ctx, `INSERT INTO apps (id, name, slug) VALUES ('app_crew', 'crewmate', 'crewmate')`)
	require.NoError(t, err)
	_, err = r.owner.Exec(ctx, `INSERT INTO roles (id, name, verbs) VALUES ('rol_ops', 'operators', '{}')`)
	require.NoError(t, err)

	w := audit.New(r.app)
	require.NoError(t, w.Write(ctx, audit.Event{
		PrincipalKind: audit.KindUser, PrincipalID: "usr_ana", Action: "app.deploy", AppID: "app_crew",
	}))
	require.NoError(t, w.Write(ctx, audit.Event{
		PrincipalKind: audit.KindUser, PrincipalID: "usr_lee", Action: "role.create", TargetKind: "role", TargetID: "rol_ops",
	}))
	require.NoError(t, w.Write(ctx, audit.Event{
		PrincipalKind: audit.KindUser, PrincipalID: "usr_lee", Action: "app.use.denied", AppID: "app_crew",
	}))

	reader := audit.NewReader(r.app)
	recs, err := reader.List(ctx, audit.Query{})
	require.NoError(t, err)
	require.Len(t, recs, 3)
	denied, role, deploy := recs[0], recs[1], recs[2]
	assert.Equal(t, "crewmate", deploy.AppName)
	assert.Equal(t, "Deployed crewmate", deploy.Summary)
	assert.Equal(t, "operators", role.TargetName)
	assert.Equal(t, "Created role operators", role.Summary)
	assert.Equal(t, "Refused a visit to crewmate", denied.Summary)

	only, err := reader.List(ctx, audit.Query{Outcome: "denied"})
	require.NoError(t, err)
	require.Len(t, only, 1)
	assert.Equal(t, "app.use.denied", only[0].Action)

	byApp, err := reader.List(ctx, audit.Query{Search: "CREWMATE"})
	require.NoError(t, err)
	assert.Len(t, byApp, 2, "the app's name is searched, whatever its case")

	byActor, err := reader.List(ctx, audit.Query{Search: "USR_AN"})
	require.NoError(t, err)
	require.Len(t, byActor, 1)
	assert.Equal(t, "app.deploy", byActor[0].Action)

	wild, err := reader.List(ctx, audit.Query{Search: "%"})
	require.NoError(t, err)
	assert.Empty(t, wild, "a wildcard is searched for as itself")
}
