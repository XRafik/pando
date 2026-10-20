// Package orphan stops apps none of whose owners is active, and tells
// administrators (R-406 – R-408).
//
// The pass runs on the leader. It is woken when who owns an app may have
// changed — migration 78's triggers notify state.AppOwnersChannel when an
// account is suspended or deleted, an Owner grant is added or removed — so an
// app stops when its last owner goes, and it also runs on a schedule in case a
// notification was lost.
//
// Each pass, in order:
//
//  1. Apps that have an active owner again are unmarked, so losing that owner
//     is a new orphaning. A stop it made stays until somebody starts the app.
//  2. Apps newly without an active owner are marked, and stopped in the same
//     write when host policy says to (stop_orphaned_apps, on by default).
//  3. Administrators are told of every marked app they have not been told of,
//     in one notice.
//
// Nothing here starts an app. Starting one clears the stop (migration 78) and
// leaves the mark, so an administrator who starts an orphaned app keeps it
// running.
package orphan

import (
	"context"
	"fmt"
	"strings"
	"time"

	"go.uber.org/zap"

	"github.com/trypando/pando/internal/adapter/api"
	"github.com/trypando/pando/internal/core/audit"
	"github.com/trypando/pando/internal/core/policy"
	"github.com/trypando/pando/internal/core/state"
)

// DefaultEvery is how often the pass runs when nothing wakes it. A
// notification is how an app is stopped at once; this is for one lost while
// the leader was not listening.
const DefaultEvery = 5 * time.Minute

// Store is the state the pass reads and writes. *state.Orphans is one.
type Store interface {
	ClearOwned(ctx context.Context) ([]string, error)
	NewlyOrphaned(ctx context.Context) ([]state.OrphanApp, error)
	MarkOrphaned(ctx context.Context, appID string, stop bool) (marked, stopped bool, err error)
	Unannounced(ctx context.Context) ([]state.OrphanApp, error)
	MarkAnnounced(ctx context.Context, appIDs []string) error
	Administrators(ctx context.Context) ([]string, error)
}

// PolicyLoader reads host policy.
type PolicyLoader interface {
	Load(ctx context.Context) (policy.Document, error)
}

// Notifier tells people things. subscription.Router is one.
type Notifier interface {
	Notify(ctx context.Context, n api.Notification) error
}

// Auditor writes audit events.
type Auditor interface {
	Write(ctx context.Context, e audit.Event) error
}

// Listener calls changed for each notification on a channel until ctx ends,
// and connected with whether it is listening. *state.DB is one.
type Listener interface {
	Listen(ctx context.Context, channel string, changed func(payload string), connected func(bool))
}

// Pass is the orphan job.
type Pass struct {
	Store  Store
	Policy PolicyLoader

	// Notifier, Auditor and Changes are optional. Production wires all
	// three: R-408 is a promise that administrators hear of every orphaned
	// app, and Changes is what makes a stop immediate.
	Notifier Notifier
	Auditor  Auditor
	Changes  Listener

	Logger *zap.Logger

	// Every is how often Run runs a pass with nothing to wake it. Zero is
	// DefaultEvery.
	Every time.Duration
}

// Run passes until ctx is canceled: at once, whenever who owns an app may
// have changed, whenever the listener connects again (anything could have
// changed while it was not listening), and every Every.
func (p *Pass) Run(ctx context.Context) {
	every := p.Every
	if every <= 0 {
		every = DefaultEvery
	}
	wake := make(chan struct{}, 1)
	poke := func() {
		select {
		case wake <- struct{}{}:
		default:
		}
	}
	if p.Changes != nil {
		go p.Changes.Listen(ctx, state.AppOwnersChannel, func(string) { poke() }, func(up bool) {
			if up {
				poke()
			}
		})
	}
	ticker := time.NewTicker(every)
	defer ticker.Stop()
	for {
		p.Once(ctx)
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		case <-wake:
		}
	}
}

// Once runs one pass.
func (p *Pass) Once(ctx context.Context) {
	doc, err := p.Policy.Load(ctx)
	if err != nil {
		p.logger().Warn("could not read host policy for the orphan pass", zap.Error(err))
		return
	}

	if owned, err := p.Store.ClearOwned(ctx); err != nil {
		p.logger().Warn("could not unmark apps that have an owner again", zap.Error(err))
	} else if len(owned) > 0 {
		p.logger().Info("apps have an owner again", zap.Strings("app_ids", owned))
	}

	apps, err := p.Store.NewlyOrphaned(ctx)
	if err != nil {
		p.logger().Warn("could not list apps with no active owner", zap.Error(err))
		return
	}
	stop := doc.StopsOrphanedApps()
	for _, app := range apps {
		if ctx.Err() != nil {
			return
		}
		p.mark(ctx, app, stop)
	}

	p.announce(ctx)
}

func (p *Pass) mark(ctx context.Context, app state.OrphanApp, stop bool) {
	marked, stopped, err := p.Store.MarkOrphaned(ctx, app.AppID, stop)
	if err != nil {
		p.logger().Warn("could not mark an app as having no owner", zap.String("app_id", app.AppID), zap.Error(err))
		return
	}
	if !marked {
		// It has an owner again, or another pass marked it first.
		return
	}
	p.audit(ctx, "app.orphaned", app.AppID, map[string]any{"stopped": stopped})
	if stopped {
		p.audit(ctx, "app.orphan.stopped", app.AppID, nil)
	}
	p.logger().Info("an app has no active owner", zap.String("app_id", app.AppID), zap.Bool("stopped", stopped))
}

// announce tells administrators of every orphaned app they have not been told
// of, in one notice. Marked told only once the notice went out, so a notice
// that fails is sent again on the next pass.
func (p *Pass) announce(ctx context.Context) {
	apps, err := p.Store.Unannounced(ctx)
	if err != nil {
		p.logger().Warn("could not list apps administrators have not been told of", zap.Error(err))
		return
	}
	if len(apps) == 0 {
		return
	}
	ids := make([]string, len(apps))
	for i, app := range apps {
		ids[i] = app.AppID
	}

	if p.Notifier != nil {
		admins, err := p.Store.Administrators(ctx)
		if err != nil {
			p.logger().Warn("could not read who the administrators are", zap.Error(err))
			return
		}
		if len(admins) > 0 {
			n := Notice(apps)
			n.Recipients = make([]api.Recipient, len(admins))
			for i, id := range admins {
				n.Recipients[i] = api.Recipient{UserID: id}
			}
			if err := p.Notifier.Notify(ctx, n); err != nil {
				p.logger().Warn("could not tell administrators about apps with no owner",
					zap.Strings("app_ids", ids), zap.Error(err))
				return
			}
		}
	}
	if err := p.Store.MarkAnnounced(ctx, ids); err != nil {
		p.logger().Warn("could not record that administrators were told", zap.Strings("app_ids", ids), zap.Error(err))
	}
}

// Notice is what administrators are told of apps with no active owner: which
// were stopped, which are still running, and what gives an app an owner again
// (R-105, R-408). Recipients are left to the caller.
func Notice(apps []state.OrphanApp) api.Notification {
	var stopped, running []string
	for _, app := range apps {
		if app.Stopped {
			stopped = append(stopped, app.Name)
		} else {
			running = append(running, app.Name)
		}
	}

	if len(apps) == 1 {
		app := apps[0]
		n := api.Notification{Kind: api.NotifyAppOrphaned, AppID: app.AppID}
		if app.Stopped {
			n.Subject = app.Name + " was stopped: it has no active owner"
			n.Body = fmt.Sprintf("None of the owners of %s has an active Pando account, so Pando stopped it. Its data is kept. "+
				"To bring it back, give somebody Owner on it in Pando, then start it.", app.Name)
		} else {
			n.Subject = app.Name + " has no active owner"
			n.Body = fmt.Sprintf("None of the owners of %s has an active Pando account. It is still running, "+
				"and only an administrator can manage it. Give somebody Owner on it in Pando.", app.Name)
		}
		return n
	}

	var b strings.Builder
	fmt.Fprintf(&b, "None of the owners of these %d apps has an active Pando account.", len(apps))
	if len(stopped) > 0 {
		fmt.Fprintf(&b, " Pando stopped %s; their data is kept.", joinNames(stopped))
	}
	if len(running) > 0 {
		fmt.Fprintf(&b, " Still running, and only an administrator can manage them: %s.", joinNames(running))
	}
	b.WriteString(" Give somebody Owner on each in Pando. A stopped app stays stopped until somebody starts it.")
	return api.Notification{
		Kind:    api.NotifyAppOrphaned,
		Subject: fmt.Sprintf("%d apps have no active owner", len(apps)),
		Body:    b.String(),
	}
}

// joinNames is names as a sentence lists them: "A", "A and B", "A, B and C".
func joinNames(names []string) string {
	if len(names) < 2 {
		return strings.Join(names, "")
	}
	return strings.Join(names[:len(names)-1], ", ") + " and " + names[len(names)-1]
}

func (p *Pass) audit(ctx context.Context, action, appID string, detail map[string]any) {
	if p.Auditor == nil {
		return
	}
	if err := p.Auditor.Write(ctx, audit.Event{
		PrincipalKind: audit.KindSystem, PrincipalID: "orphan",
		Action: action, AppID: appID, TargetKind: "app", TargetID: appID, Detail: detail,
	}); err != nil {
		p.logger().Error("audit write failed", zap.String("action", action), zap.Error(err))
	}
}

func (p *Pass) logger() *zap.Logger {
	if p.Logger == nil {
		return zap.NewNop()
	}
	return p.Logger
}
