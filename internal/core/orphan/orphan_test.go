package orphan

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"go.uber.org/zap"
	"go.uber.org/zap/zaptest/observer"

	"github.com/trypando/pando/internal/adapter/api"
	"github.com/trypando/pando/internal/core/audit"
	"github.com/trypando/pando/internal/core/policy"
	"github.com/trypando/pando/internal/core/state"
)

var errDown = errors.New("down")

// fakeStore holds apps as the database would. orphaned are the apps with no
// active owner; marked and stopped what the pass has written.
type fakeStore struct {
	names     map[string]string
	orphaned  map[string]bool
	marked    map[string]bool
	stopped   map[string]bool
	announced map[string]bool
	admins    []string

	clearErr, listErr, markErr, unannouncedErr, announceErr, adminsErr error
	// markNothing is an app that has an owner again by the time the pass
	// marks it: the store writes nothing.
	markNothing bool
}

func newStore(apps ...string) *fakeStore {
	s := &fakeStore{
		names: map[string]string{}, orphaned: map[string]bool{}, marked: map[string]bool{},
		stopped: map[string]bool{}, announced: map[string]bool{}, admins: []string{"usr_admin"},
	}
	for _, name := range apps {
		s.names["app_"+name] = name
	}
	return s
}

func (s *fakeStore) ClearOwned(context.Context) ([]string, error) {
	if s.clearErr != nil {
		return nil, s.clearErr
	}
	var out []string
	for id := range s.marked {
		if !s.orphaned[id] {
			delete(s.marked, id)
			delete(s.announced, id)
			out = append(out, id)
		}
	}
	return out, nil
}

func (s *fakeStore) NewlyOrphaned(context.Context) ([]state.OrphanApp, error) {
	if s.listErr != nil {
		return nil, s.listErr
	}
	var out []state.OrphanApp
	for id := range s.orphaned {
		if s.orphaned[id] && !s.marked[id] {
			out = append(out, state.OrphanApp{AppID: id, Name: s.names[id]})
		}
	}
	return out, nil
}

func (s *fakeStore) MarkOrphaned(_ context.Context, appID string, stop bool) (bool, bool, error) {
	if s.markErr != nil {
		return false, false, s.markErr
	}
	if s.markNothing || s.marked[appID] || !s.orphaned[appID] {
		return false, false, nil
	}
	s.marked[appID] = true
	s.stopped[appID] = stop
	return true, stop, nil
}

func (s *fakeStore) Unannounced(context.Context) ([]state.OrphanApp, error) {
	if s.unannouncedErr != nil {
		return nil, s.unannouncedErr
	}
	var out []state.OrphanApp
	for id := range s.marked {
		if !s.announced[id] {
			out = append(out, state.OrphanApp{AppID: id, Name: s.names[id], Stopped: s.stopped[id]})
		}
	}
	return out, nil
}

func (s *fakeStore) MarkAnnounced(_ context.Context, ids []string) error {
	if s.announceErr != nil {
		return s.announceErr
	}
	for _, id := range ids {
		s.announced[id] = true
	}
	return nil
}

func (s *fakeStore) Administrators(context.Context) ([]string, error) {
	return s.admins, s.adminsErr
}

type fakePolicy struct {
	doc policy.Document
	err error
}

func (p fakePolicy) Load(context.Context) (policy.Document, error) { return p.doc, p.err }

func policyOff() fakePolicy {
	off := false
	return fakePolicy{doc: policy.Document{StopOrphanedApps: &off}}
}

type notes struct {
	sent []api.Notification
	err  error
}

func (n *notes) Notify(_ context.Context, msg api.Notification) error {
	if n.err != nil {
		return n.err
	}
	n.sent = append(n.sent, msg)
	return nil
}

type audits struct {
	events []audit.Event
	err    error
}

func (a *audits) Write(_ context.Context, e audit.Event) error {
	a.events = append(a.events, e)
	return a.err
}

func (a *audits) actions() []string {
	var out []string
	for _, e := range a.events {
		out = append(out, e.Action)
	}
	return out
}

// TestR407_AnAppWithNoActiveOwnerIsStopped asserts R-407 and R-408: with the
// policy unset, which is on, an app whose last owner went is stopped, each
// is an audit event, and administrators are told it was stopped and how to
// bring it back.
func TestR407_AnAppWithNoActiveOwnerIsStopped(t *testing.T) {
	store := newStore("notes")
	store.orphaned["app_notes"] = true
	n, a := &notes{}, &audits{}
	p := &Pass{Store: store, Policy: fakePolicy{}, Notifier: n, Auditor: a}

	p.Once(context.Background())

	require.True(t, store.stopped["app_notes"])
	assert.Equal(t, []string{"app.orphaned", "app.orphan.stopped"}, a.actions())
	assert.Equal(t, map[string]any{"stopped": true}, a.events[0].Detail)
	require.Len(t, n.sent, 1)
	msg := n.sent[0]
	assert.Equal(t, api.NotifyAppOrphaned, msg.Kind)
	assert.Equal(t, "app_notes", msg.AppID)
	assert.Equal(t, []api.Recipient{{UserID: "usr_admin"}}, msg.Recipients)
	assert.Equal(t, "notes was stopped: it has no active owner", msg.Subject)
	assert.Contains(t, msg.Body, "give somebody Owner on it in Pando, then start it")
	assert.True(t, store.announced["app_notes"])

	// The next pass has nothing to do: the app is marked and announced.
	p.Once(context.Background())
	assert.Len(t, n.sent, 1)
	assert.Len(t, a.events, 2)
}

// TestR407_WithThePolicyOffAnOrphanedAppKeepsRunning asserts R-407 and R-408:
// stop_orphaned_apps false leaves the app running, and administrators are told
// all the same.
func TestR407_WithThePolicyOffAnOrphanedAppKeepsRunning(t *testing.T) {
	store := newStore("notes")
	store.orphaned["app_notes"] = true
	n, a := &notes{}, &audits{}
	p := &Pass{Store: store, Policy: policyOff(), Notifier: n, Auditor: a}

	p.Once(context.Background())

	assert.False(t, store.stopped["app_notes"])
	assert.Equal(t, []string{"app.orphaned"}, a.actions())
	assert.Equal(t, map[string]any{"stopped": false}, a.events[0].Detail)
	require.Len(t, n.sent, 1)
	assert.Equal(t, "notes has no active owner", n.sent[0].Subject)
	assert.Contains(t, n.sent[0].Body, "It is still running")
}

// TestR407_AnOwnerComingBackMakesTheNextLossANewOrphaning asserts that once an
// app has an active owner again it is unmarked, so losing them again is told
// again.
func TestR407_AnOwnerComingBackMakesTheNextLossANewOrphaning(t *testing.T) {
	store := newStore("notes")
	store.orphaned["app_notes"] = true
	n := &notes{}
	p := &Pass{Store: store, Policy: fakePolicy{}, Notifier: n}
	p.Once(context.Background())

	store.orphaned["app_notes"] = false
	p.Once(context.Background())
	assert.False(t, store.marked["app_notes"], "unmarked once it has an owner")

	store.orphaned["app_notes"] = true
	p.Once(context.Background())
	assert.Len(t, n.sent, 2, "a second orphaning is a second notice")
}

// TestR408_SeveralAppsAreOneNotice asserts administrators hear of the apps a
// pass found in one notice, saying which were stopped and which still run.
func TestR408_SeveralAppsAreOneNotice(t *testing.T) {
	n := Notice([]state.OrphanApp{
		{AppID: "app_a", Name: "wiki", Stopped: true},
		{AppID: "app_b", Name: "notes", Stopped: true},
		{AppID: "app_c", Name: "chat"},
	})
	assert.Equal(t, api.NotifyAppOrphaned, n.Kind)
	assert.Empty(t, n.AppID, "it is about more than one app")
	assert.Equal(t, "3 apps have no active owner", n.Subject)
	assert.Contains(t, n.Body, "Pando stopped wiki and notes; their data is kept.")
	assert.Contains(t, n.Body, "only an administrator can manage them: chat.")
	assert.Contains(t, n.Body, "Give somebody Owner on each in Pando.")

	n = Notice([]state.OrphanApp{{Name: "a"}, {Name: "b"}, {Name: "c"}})
	assert.NotContains(t, n.Body, "Pando stopped")
	assert.Contains(t, n.Body, "a, b and c.")
}

// TestR408_AFailedNoticeIsSentAgain asserts a notice that does not go out is
// not recorded as given, so the next pass sends it.
func TestR408_AFailedNoticeIsSentAgain(t *testing.T) {
	store := newStore("notes")
	store.orphaned["app_notes"] = true
	n := &notes{err: errDown}
	p := &Pass{Store: store, Policy: fakePolicy{}, Notifier: n}

	p.Once(context.Background())
	assert.False(t, store.announced["app_notes"])

	n.err = nil
	p.Once(context.Background())
	assert.Len(t, n.sent, 1)
	assert.True(t, store.announced["app_notes"])
}

// TestR408_NoAdministratorsStillRecordsTheNotice asserts an install with no
// administrator, or no notifier, does not hold apps unannounced forever.
func TestR408_NoAdministratorsStillRecordsTheNotice(t *testing.T) {
	store := newStore("notes")
	store.orphaned["app_notes"] = true
	store.admins = nil
	n := &notes{}
	(&Pass{Store: store, Policy: fakePolicy{}, Notifier: n}).Once(context.Background())
	assert.Empty(t, n.sent)
	assert.True(t, store.announced["app_notes"])

	store = newStore("wiki")
	store.orphaned["app_wiki"] = true
	(&Pass{Store: store, Policy: fakePolicy{}}).Once(context.Background())
	assert.True(t, store.stopped["app_wiki"], "nil notifier and auditor are optional")
	assert.True(t, store.announced["app_wiki"])
}

func TestOnceSurvivesEveryFailure(t *testing.T) {
	ctx := context.Background()
	core, logs := observer.New(zap.WarnLevel)
	logger := zap.New(core)

	// Policy unreadable: nothing is done.
	store := newStore("notes")
	store.orphaned["app_notes"] = true
	(&Pass{Store: store, Policy: fakePolicy{err: errDown}, Logger: logger}).Once(ctx)
	assert.False(t, store.marked["app_notes"])

	// Clearing fails: the pass goes on.
	store.clearErr = errDown
	(&Pass{Store: store, Policy: fakePolicy{}, Logger: logger}).Once(ctx)
	assert.True(t, store.marked["app_notes"])

	// Listing fails: nothing is marked or announced.
	store = newStore("notes")
	store.orphaned["app_notes"] = true
	store.listErr = errDown
	(&Pass{Store: store, Policy: fakePolicy{}, Logger: logger}).Once(ctx)
	assert.False(t, store.marked["app_notes"])

	// Marking fails, or finds an owner came back: no audit event.
	for _, s := range []*fakeStore{{markErr: errDown}, {markNothing: true}} {
		store = newStore("notes")
		store.orphaned["app_notes"] = true
		store.markErr, store.markNothing = s.markErr, s.markNothing
		a := &audits{}
		(&Pass{Store: store, Policy: fakePolicy{}, Auditor: a, Logger: logger}).Once(ctx)
		assert.Empty(t, a.events)
	}

	// Reading what to announce, or who to, fails: nothing is recorded told.
	store = newStore("notes")
	store.orphaned["app_notes"] = true
	store.unannouncedErr = errDown
	(&Pass{Store: store, Policy: fakePolicy{}, Notifier: &notes{}, Logger: logger}).Once(ctx)
	assert.False(t, store.announced["app_notes"])
	store.unannouncedErr, store.adminsErr = nil, errDown
	(&Pass{Store: store, Policy: fakePolicy{}, Notifier: &notes{}, Logger: logger}).Once(ctx)
	assert.False(t, store.announced["app_notes"])

	// Recording it fails, and the audit write fails: logged.
	store.adminsErr, store.announceErr = nil, errDown
	(&Pass{Store: store, Policy: fakePolicy{}, Notifier: &notes{}, Auditor: &audits{err: errDown}, Logger: logger}).Once(ctx)

	assert.NotZero(t, logs.FilterMessage("could not read host policy for the orphan pass").Len())
	assert.NotZero(t, logs.FilterMessage("could not unmark apps that have an owner again").Len())
	assert.NotZero(t, logs.FilterMessage("could not list apps with no active owner").Len())
	assert.NotZero(t, logs.FilterMessage("could not mark an app as having no owner").Len())
	assert.NotZero(t, logs.FilterMessage("could not list apps administrators have not been told of").Len())
	assert.NotZero(t, logs.FilterMessage("could not read who the administrators are").Len())
	assert.NotZero(t, logs.FilterMessage("could not record that administrators were told").Len())
}

func TestOnceStopsWhenCanceled(t *testing.T) {
	store := newStore("a", "b")
	store.orphaned["app_a"], store.orphaned["app_b"] = true, true
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	(&Pass{Store: store, Policy: fakePolicy{}}).Once(ctx)
	assert.Empty(t, store.marked)
}

// fakeListener reports itself connected, then hands the test a way to notify.
type fakeListener struct{ notify chan func() }

func (l fakeListener) Listen(ctx context.Context, channel string, changed func(string), connected func(bool)) {
	if channel != state.AppOwnersChannel {
		panic("listening on " + channel)
	}
	connected(true)
	l.notify <- func() { changed("") }
	<-ctx.Done()
	connected(false)
}

// TestR407_ANotificationRunsAPassAtOnce asserts the pass runs when the
// database says who owns an app changed, not only on its schedule: that is
// what stops an app when its last owner goes.
func TestR407_ANotificationRunsAPassAtOnce(t *testing.T) {
	store := &countingStore{fakeStore: newStore(), passes: make(chan struct{}, 16)}
	l := fakeListener{notify: make(chan func(), 1)}
	p := &Pass{Store: store, Policy: fakePolicy{}, Changes: l, Every: time.Hour}

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { p.Run(ctx); close(done) }()

	notify := <-l.notify
	waitPasses(t, store.passes, 2) // at start, and on connecting
	notify()
	waitPasses(t, store.passes, 1)

	cancel()
	<-done
}

func TestRunUsesTheDefaultSchedule(t *testing.T) {
	store := &countingStore{fakeStore: newStore(), passes: make(chan struct{}, 16)}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { (&Pass{Store: store, Policy: fakePolicy{}}).Run(ctx); close(done) }()
	waitPasses(t, store.passes, 1)
	cancel()
	<-done
}

type countingStore struct {
	*fakeStore
	passes chan struct{}
}

func (s *countingStore) ClearOwned(ctx context.Context) ([]string, error) {
	s.passes <- struct{}{}
	return s.fakeStore.ClearOwned(ctx)
}

func waitPasses(t *testing.T, passes chan struct{}, n int) {
	t.Helper()
	for range n {
		select {
		case <-passes:
		case <-time.After(5 * time.Second):
			t.Fatal("the pass did not run")
		}
	}
}
