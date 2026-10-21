package state

import (
	"context"
	"errors"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/trypando/pando/internal/errs"
)

// Apps with no active owner (R-407 – R-409).
//
// An app is orphaned when its owner of record (R-031) and every account
// holding Owner on it are suspended or deleted, and no group holds Owner on
// it. A group's grant always counts, whoever is in the group (R-407). An app
// that never had an owner — none of record and no Owner grant to an account —
// is not orphaned: nobody left it.

// AppOwnersChannel is the channel migration 79's triggers notify when who owns
// an app may have changed.
const AppOwnersChannel = "pando_app_owners"

// ownerGrant selects a's Owner grants to the principal kind that follows it.
const ownerGrant = `SELECT 1 FROM grants g
	WHERE g.app_id = a.id AND g.plane = 'control' AND g.role_id = 'role_owner' AND g.principal_kind = `

// noActiveOwner is true of an app, aliased a, with no active owner other than
// the account in parameter $1 (” for none). Migration 79 writes the same
// predicate with no exclusion.
const noActiveOwner = `
	NOT EXISTS (` + ownerGrant + `'group')
	AND NOT EXISTS (SELECT 1 FROM users u
	                WHERE u.status = 'active' AND u.deleted_at IS NULL AND u.id <> $1
	                  AND (u.id = a.owner_user_id
	                       OR u.id IN (SELECT g.principal_id FROM grants g
	                                   WHERE g.app_id = a.id AND g.plane = 'control'
	                                     AND g.role_id = 'role_owner' AND g.principal_kind = 'user')))
	AND (a.owner_user_id IS NOT NULL OR EXISTS (` + ownerGrant + `'user'))`

const msgListOrphans = "Could not list apps with no active owner."

// Orphans is the store half of the orphan pass.
type Orphans struct{ db *DB }

func NewOrphans(db *DB) *Orphans { return &Orphans{db: db} }

// OrphanApp is an app with no active owner.
type OrphanApp struct {
	AppID string
	Name  string
	// Stopped is whether Pando stopped it for having no owner and nobody has
	// started it since.
	Stopped    bool
	OrphanedAt time.Time
}

// NewlyOrphaned lists the apps with no active owner that are not yet marked.
func (o *Orphans) NewlyOrphaned(ctx context.Context) ([]OrphanApp, error) {
	return o.list(ctx, `a.orphaned_at IS NULL AND `+noActiveOwner, "")
}

// Unannounced lists the orphaned apps administrators have not been told of.
func (o *Orphans) Unannounced(ctx context.Context) ([]OrphanApp, error) {
	return o.list(ctx, `a.orphaned_at IS NOT NULL AND a.orphan_announced_at IS NULL`)
}

func (o *Orphans) list(ctx context.Context, where string, args ...any) ([]OrphanApp, error) {
	rows, err := o.db.Query(ctx, `
		SELECT a.id, a.name, a.stopped_for_orphan, coalesce(a.orphaned_at, now())
		FROM apps a
		WHERE a.deleted_at IS NULL AND `+where+`
		ORDER BY a.name, a.id`, args...)
	if err != nil {
		return nil, errs.Wrap(errs.Internal, msgListOrphans, err)
	}
	defer rows.Close()
	var out []OrphanApp
	for rows.Next() {
		var app OrphanApp
		if err := rows.Scan(&app.AppID, &app.Name, &app.Stopped, &app.OrphanedAt); err != nil {
			return nil, errs.Wrap(errs.Internal, msgListOrphans, err)
		}
		out = append(out, app)
	}
	if err := rows.Err(); err != nil {
		return nil, errs.Wrap(errs.Internal, msgListOrphans, err)
	}
	return out, nil
}

// MarkOrphaned marks an app orphaned and, with stop set, stops it in the same
// write, recording why: the visitor page says why in the same moment the app
// stops (R-408). Only an app still without an active owner and not already
// marked, so a pass that read it before an owner came back writes nothing.
// Only a running app that has not failed (R-151) is stopped.
func (o *Orphans) MarkOrphaned(ctx context.Context, appID string, stop bool) (marked, stopped bool, err error) {
	err = o.db.QueryRow(ctx, `
		WITH target AS (
		    SELECT a.id, ($2::boolean AND a.desired_state = 'running' AND a.state <> 'failed') AS stop
		    FROM apps a
		    WHERE a.id = $3 AND a.deleted_at IS NULL AND a.orphaned_at IS NULL AND `+noActiveOwner+`
		    FOR UPDATE OF a
		)
		UPDATE apps SET orphaned_at = now(), orphan_announced_at = NULL,
		       desired_state = CASE WHEN target.stop THEN 'stopped' ELSE apps.desired_state END,
		       stopped_for_orphan = apps.stopped_for_orphan OR target.stop,
		       updated_at = now(), `+dueAgain+`
		FROM target WHERE apps.id = target.id
		RETURNING target.stop`, "", stop, appID).Scan(&stopped)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, false, nil
	}
	if err != nil {
		return false, false, errs.Wrap(errs.Internal, "Could not mark the app as having no owner.", err)
	}
	return true, stopped, nil
}

// ClearOwned unmarks every marked app that has an active owner again, so
// losing that owner is a new orphaning. A stop it made stays until somebody
// starts the app (R-408). Returns the apps unmarked.
func (o *Orphans) ClearOwned(ctx context.Context) ([]string, error) {
	rows, err := o.db.Query(ctx, `
		UPDATE apps a SET orphaned_at = NULL, orphan_announced_at = NULL
		WHERE a.deleted_at IS NULL AND a.orphaned_at IS NOT NULL AND NOT (`+noActiveOwner+`)
		RETURNING a.id`, "")
	if err != nil {
		return nil, errs.Wrap(errs.Internal, "Could not unmark apps that have an owner again.", err)
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, errs.Wrap(errs.Internal, "Could not unmark apps that have an owner again.", err)
		}
		out = append(out, id)
	}
	return out, rows.Err()
}

// MarkAnnounced records that administrators were told of these apps.
func (o *Orphans) MarkAnnounced(ctx context.Context, appIDs []string) error {
	if len(appIDs) == 0 {
		return nil
	}
	if _, err := o.db.Exec(ctx, `
		UPDATE apps SET orphan_announced_at = now()
		WHERE id = ANY($1) AND orphaned_at IS NOT NULL`, appIDs); err != nil {
		return errs.Wrap(errs.Internal, "Could not record that administrators were told.", err)
	}
	return nil
}

// Administrators returns the active people holding the built-in Administrator
// role, directly or through a group (R-409). For telling them something, never
// for deciding what they may do.
func (o *Orphans) Administrators(ctx context.Context) ([]string, error) {
	rows, err := o.db.Query(ctx, `
		WITH holding AS (
		    SELECT principal_kind, principal_id FROM grants
		    WHERE plane = 'control' AND app_id IS NULL AND role_id = 'role_administrator'
		)
		SELECT u.id FROM users u
		WHERE u.status = 'active' AND u.deleted_at IS NULL
		  AND (u.id IN (SELECT principal_id FROM holding WHERE principal_kind = 'user')
		    OR u.id IN (SELECT m.user_id FROM effective_group_members m
		                JOIN holding h ON h.principal_kind = 'group' AND h.principal_id = m.group_id))
		ORDER BY u.id`)
	if err != nil {
		return nil, errs.Wrap(errs.Internal, "Could not read who the administrators are.", err)
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, errs.Wrap(errs.Internal, "Could not read who the administrators are.", err)
		}
		out = append(out, id)
	}
	return out, rows.Err()
}

// lastOwnerOf lists, by name, the apps that suspending userID would leave with
// no active owner: those it owns and that have an owner now. Linking asks
// before it suspends an account as an alias (R-409).
func lastOwnerOf(ctx context.Context, tx pgx.Tx, userID string) ([]string, error) {
	rows, err := tx.Query(ctx, `
		SELECT a.name FROM apps a
		WHERE a.deleted_at IS NULL AND a.orphaned_at IS NULL
		  AND (a.owner_user_id = $1 OR EXISTS (`+ownerGrant+`'user' AND g.principal_id = $1))
		  AND `+noActiveOwner+`
		ORDER BY a.name`, userID)
	if err != nil {
		return nil, errs.Wrap(errs.Internal, "Could not read which apps the account owns.", err)
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			return nil, errs.Wrap(errs.Internal, "Could not read which apps the account owns.", err)
		}
		out = append(out, name)
	}
	return out, rows.Err()
}

// joinNames is names as a sentence lists them: "A", "A and B", "A, B and C".
func joinNames(names []string) string {
	if len(names) < 2 {
		return strings.Join(names, "")
	}
	return strings.Join(names[:len(names)-1], ", ") + " and " + names[len(names)-1]
}
