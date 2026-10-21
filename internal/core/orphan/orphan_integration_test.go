//go:build integration

package orphan

import (
	"context"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/trypando/pando/internal/core/spec"
	"github.com/trypando/pando/internal/core/state"
	"github.com/trypando/pando/internal/core/state/statetest"
)

// TestR408_SuspendingTheLastOwnerStopsTheAppAtOnce asserts R-408 end to end
// on Postgres: suspending an app's only owner wakes the pass through migration
// 78's trigger, and the app is stopped within seconds, not at the next
// scheduled pass.
func TestR408_SuspendingTheLastOwnerStopsTheAppAtOnce(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	db, _ := statetest.Connect(t)
	users := state.NewUsers(db)
	apps := state.NewApps(db)
	require.NoError(t, users.EnsureLocalAdapter(ctx))
	alice, err := users.Create(ctx, state.LocalAdapterID, "alice", "alice@corp.com", "Alice", "", false)
	require.NoError(t, err)

	app, err := apps.Create(ctx, "notes", "notes", alice.ID, alice.ID, spec.Source{Type: spec.SourceGit, URL: "https://example.test/notes"})
	require.NoError(t, err)
	require.NoError(t, apps.SetDesiredState(ctx, app.ID, state.StateRunning))
	bob, err := users.Create(ctx, state.LocalAdapterID, "bob", "bob@corp.com", "Bob", "", false)
	require.NoError(t, err)
	wiki, err := apps.Create(ctx, "wiki", "wiki", bob.ID, bob.ID, spec.Source{Type: spec.SourceGit, URL: "https://example.test/wiki"})
	require.NoError(t, err)
	require.NoError(t, apps.SetDesiredState(ctx, wiki.ID, state.StateRunning))

	n := &notes{}
	p := &Pass{Store: state.NewOrphans(db), Policy: fakePolicy{}, Notifier: n, Changes: db, Every: time.Hour}
	done := make(chan struct{})
	go func() { p.Run(ctx); close(done) }()
	defer func() { cancel(); <-done }()

	// The schedule is an hour away, so only the trigger's notification, or
	// the listener connecting after it, can wake the pass in time.
	require.NoError(t, users.SetStatusBy(ctx, alice.ID, "suspended", "test"))

	require.Eventually(t, func() bool {
		got, _, err := apps.ByID(ctx, app.ID)
		return err == nil && got.StoppedForOrphan && got.DesiredState == state.StateStopped
	}, 10*time.Second, 50*time.Millisecond, "the app is stopped once its only owner is suspended")

	// The listener is connected now, so this one is the trigger's alone.
	require.NoError(t, users.SetStatusBy(ctx, bob.ID, "suspended", "test"))
	require.Eventually(t, func() bool {
		got, _, err := apps.ByID(ctx, wiki.ID)
		return err == nil && got.StoppedForOrphan
	}, 10*time.Second, 50*time.Millisecond, "a later suspension is heard through the trigger")
}
