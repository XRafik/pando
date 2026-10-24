package state

import (
	"context"
	"errors"
	"strconv"
	"strings"

	"github.com/jackc/pgx/v5"

	"github.com/trypando/pando/internal/core/authz"
	"github.com/trypando/pando/internal/errs"
)

// Editing a custom role, renaming a group, and reading who holds a role.

// ByID returns one role, of either scope.
func (r *Roles) ByID(ctx context.Context, roleID string) (RoleRow, bool, error) {
	var row RoleRow
	err := r.db.QueryRow(ctx, `SELECT id, name, builtin, scope, verbs FROM roles WHERE id = $1`, roleID).
		Scan(&row.ID, &row.Name, &row.Builtin, &row.Scope, &row.Verbs)
	if errors.Is(err, pgx.ErrNoRows) {
		return RoleRow{}, false, nil
	}
	if err != nil {
		return RoleRow{}, false, errs.Wrap(errs.Internal, "Could not read the role.", err)
	}
	return row, true, nil
}

// RoleChange is an edit to a custom role. A nil field is left as it is.
type RoleChange struct {
	Name  *string
	Verbs []authz.Verb
	// SetVerbs says Verbs replaces the role's permissions; without it Verbs
	// is ignored, so an empty list cannot be sent by leaving the field out.
	SetVerbs bool
}

// The messages more than one failure here shares.
const (
	msgRoleNotChanged = "Could not change the role."
	msgHoldersNotRead = "Could not read who holds the role."
	remedyOtherName   = "Choose a different name."
)

// errRoleNotFound is the answer for a role ID that names nothing.
var errRoleNotFound = errs.New(errs.NotFound, "There is no role with that ID.")

// ErrBuiltinRole refuses a change to one of Pando's own roles (R-081). The
// trigger refuses it too; this says so in a sentence.
var ErrBuiltinRole = errs.New(errs.ValidInvalid, "Pando's built-in roles cannot be changed.").
	WithRemedy("Make a custom role with the permissions you want, and grant that.")

// UpdateCustom renames a custom role, replaces its permissions, or both, and
// returns it as it was and as it is. The rules are those of CreateCustom: a
// name unique ignoring case and spaces, at least one permission, every one a
// verb of the role's scope (R-080, R-082). The scope itself cannot change —
// every grant of the role is of that scope (grants_role_scope_fkey).
//
// Built-in roles are refused here and, whatever this code does, by the
// roles_builtin_immutable trigger (R-081).
//
// Refused when it would leave nobody who can manage accounts (R-088): taking
// install.users.manage out of a role is the same lockout as revoking it.
func (r *Roles) UpdateCustom(ctx context.Context, roleID string, change RoleChange) (RoleRow, RoleRow, error) {
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return RoleRow{}, RoleRow{}, errs.Wrap(errs.Internal, msgRoleNotChanged, err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var before RoleRow
	err = tx.QueryRow(ctx, `SELECT id, name, builtin, scope, verbs FROM roles WHERE id = $1 FOR UPDATE`, roleID).
		Scan(&before.ID, &before.Name, &before.Builtin, &before.Scope, &before.Verbs)
	if errors.Is(err, pgx.ErrNoRows) {
		return RoleRow{}, RoleRow{}, errRoleNotFound
	}
	if err != nil {
		return RoleRow{}, RoleRow{}, errs.Wrap(errs.Internal, "Could not read the role.", err)
	}
	if before.Builtin {
		return RoleRow{}, RoleRow{}, ErrBuiltinRole
	}

	after, err := applyRoleChange(ctx, tx, before, change)
	if err != nil {
		return RoleRow{}, RoleRow{}, err
	}

	before88, err := peopleWhoManage(ctx, tx)
	if err != nil {
		return RoleRow{}, RoleRow{}, errs.Wrap(errs.Internal, msgRoleNotChanged, err)
	}
	if _, err := tx.Exec(ctx, `UPDATE roles SET name = $2, verbs = $3 WHERE id = $1`,
		roleID, after.Name, after.Verbs); err != nil {
		if isUniqueViolation(err) {
			return RoleRow{}, RoleRow{}, errs.Newf(errs.ValidInvalid, "There is already a role called %q.", after.Name)
		}
		return RoleRow{}, RoleRow{}, errs.Wrap(errs.Internal, msgRoleNotChanged, err)
	}
	after88, err := peopleWhoManage(ctx, tx)
	if err != nil {
		return RoleRow{}, RoleRow{}, errs.Wrap(errs.Internal, msgRoleNotChanged, err)
	}
	if before88 > 0 && after88 == 0 {
		return RoleRow{}, RoleRow{}, errs.New(errs.ValidInvalid,
			"This role is how the installation's only administrators manage accounts, so Pando cannot take that permission out of it.").
			WithRemedy("Give someone the built-in administrator role first, then change this one.")
	}
	if err := tx.Commit(ctx); err != nil {
		return RoleRow{}, RoleRow{}, errs.Wrap(errs.Internal, msgRoleNotChanged, err)
	}
	return before, after, nil
}

// applyRoleChange returns the role as the change would leave it, refusing an
// empty or taken name and permissions outside the role's scope.
func applyRoleChange(ctx context.Context, tx pgx.Tx, before RoleRow, change RoleChange) (RoleRow, error) {
	after := before
	if change.Name != nil {
		name := strings.TrimSpace(*change.Name)
		if name == "" {
			return RoleRow{}, errs.New(errs.ValidInvalid, "A role needs a name.")
		}
		if err := nameFree(ctx, tx, before.ID, name); err != nil {
			return RoleRow{}, err
		}
		after.Name = name
	}
	if change.SetVerbs {
		names, err := checkVerbs(change.Verbs, before.Scope,
			"Choose permissions of the role's own scope, or make another role.")
		if err != nil {
			return RoleRow{}, err
		}
		after.Verbs = names
	}
	return after, nil
}

// nameFree refuses a role name another role already has, ignoring case and
// spaces, built-ins included (R-082).
func nameFree(ctx context.Context, tx pgx.Tx, roleID, name string) error {
	var taken string
	var builtin bool
	err := tx.QueryRow(ctx,
		`SELECT name, builtin FROM roles WHERE lower(btrim(name)) = lower($1) AND id <> $2`, name, roleID).
		Scan(&taken, &builtin)
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		return nil
	case err != nil:
		return errs.Wrap(errs.Internal, msgRoleNotChanged, err)
	case builtin:
		return errs.Newf(errs.ValidInvalid, "Pando already has a built-in role called %q.", taken).
			WithRemedy(remedyOtherName)
	}
	return errs.Newf(errs.ValidInvalid, "There is already a role called %q.", taken).
		WithRemedy(remedyOtherName)
}

// checkVerbs validates a role's permissions against the catalog and its
// scope, as CreateCustom does, and returns them as stored.
func checkVerbs(verbs []authz.Verb, scope, remedy string) ([]string, error) {
	if len(verbs) == 0 {
		return nil, errs.New(errs.ValidInvalid, "A role needs at least one permission.").
			WithRemedy("Choose from the list at GET /verbs.")
	}
	seen := map[authz.Verb]bool{}
	names := make([]string, 0, len(verbs))
	for _, v := range verbs {
		if !authz.IsVerb(v) {
			return nil, errs.Newf(errs.ValidInvalid, "%q is not a permission Pando has.", v).
				WithRemedy("Choose from the list at GET /verbs.")
		}
		// A role must not mix scopes (R-080, design 06 §2.1).
		if authz.InstallScoped(v) != (scope == "install") {
			return nil, errs.Newf(errs.ValidInvalid,
				"%q does not apply %s, so it cannot be part of a role that does.", v, scopeWord(scope)).
				WithRemedy(remedy)
		}
		if !seen[v] {
			seen[v] = true
			names = append(names, string(v))
		}
	}
	return names, nil
}

// AppsGranted returns the apps a role is granted on: whose holders an edit
// to an app role reaches.
func (r *Roles) AppsGranted(ctx context.Context, roleID string) ([]string, error) {
	rows, err := r.db.Query(ctx,
		`SELECT DISTINCT app_id FROM grants WHERE role_id = $1 AND app_id IS NOT NULL ORDER BY app_id`, roleID)
	if err != nil {
		return nil, errs.Wrap(errs.Internal, "Could not read where the role is granted.", err)
	}
	defer rows.Close()
	out := make([]string, 0)
	for rows.Next() {
		var app string
		if err := rows.Scan(&app); err != nil {
			return nil, errs.Wrap(errs.Internal, "Could not read where the role is granted.", err)
		}
		out = append(out, app)
	}
	return out, rows.Err()
}

// RoleHolder is an account or a group holding a role: by a grant made to it
// ("direct"), or, for an account, through a group it is in ("group").
type RoleHolder struct {
	Kind string `json:"kind"` // user or group
	ID   string `json:"id"`
	Name string `json:"name"`
	// Username is an account's; Source and SourceName a synced group's
	// provider, as on a Group.
	Username   string `json:"username,omitempty"`
	Source     string `json:"source,omitempty"`
	SourceName string `json:"source_name,omitempty"`
	Via        string `json:"via"`
	// GroupID is, for an account holding the role through groups, the first
	// of them by name: where to go to take it away.
	GroupID string `json:"group_id,omitempty"`
}

// holdersSelect lists a role's holders ($1 the role): the groups granted it,
// then the accounts holding it, each once — directly when any grant names the
// account itself, otherwise through a group, read live through linked
// provider groups too (R-079). Either scope: an app role's holders are those
// holding it on any app.
const holdersSelect = `
	WITH held AS (
	    SELECT principal_kind AS kind, principal_id AS id
	    FROM grants
	    WHERE role_id = $1 AND plane = 'control' AND principal_kind IN ('user', 'group')
	),
	reach AS (
	    SELECT id AS user_id, true AS direct, ''::text AS group_id, ''::text AS group_name
	    FROM held WHERE kind = 'user'
	    UNION ALL
	    SELECT m.user_id, false, gr.id, gr.name
	    FROM held JOIN effective_group_members m ON m.group_id = held.id
	    JOIN groups gr ON gr.id = held.id
	    WHERE held.kind = 'group'
	),
	holders AS (
	    SELECT 0 AS rank, 'group' AS kind, gr.id, gr.name, ''::text AS username,
	           coalesce(gr.adapter_id, '') AS source, coalesce(a.name, '') AS source_name,
	           'direct' AS via, ''::text AS group_id
	    FROM groups gr LEFT JOIN identity_adapters a ON a.id = gr.adapter_id
	    WHERE gr.id IN (SELECT id FROM held WHERE kind = 'group')
	    UNION ALL
	    SELECT 1, 'user', u.id, coalesce(nullif(u.display_name, ''), u.external_id), u.external_id,
	           '', '',
	           CASE WHEN bool_or(reach.direct) THEN 'direct' ELSE 'group' END,
	           CASE WHEN bool_or(reach.direct) THEN ''
	                ELSE (array_agg(reach.group_id ORDER BY lower(reach.group_name), reach.group_id))[1] END
	    FROM reach JOIN users u ON u.id = reach.user_id AND u.deleted_at IS NULL
	    GROUP BY u.id, u.display_name, u.external_id
	)`

// Holders is one page of a role's holders — its groups first, then its
// accounts, each by name — with the cursor for the next page, how many there
// are in all (capped, O-53), and how many of them are groups.
func (r *Roles) Holders(ctx context.Context, roleID string, page Page) ([]RoleHolder, string, int, int, error) {
	var (
		rank      int
		name, aid string
	)
	have, err := decodeCursor(page.Cursor, &rank, &name, &aid)
	if err != nil {
		return nil, "", 0, 0, err
	}
	args := []any{roleID, page.Size() + 1}
	after := ""
	if have {
		args = append(args, rank, name, aid)
		after = ` WHERE (rank, lower(name), id) > ($3, $4, $5)`
	}
	rows, err := r.db.Query(ctx, holdersSelect+`
		SELECT rank, lower(name), kind, id, name, username, source, source_name, via, group_id
		FROM holders`+after+`
		ORDER BY rank, lower(name), id
		LIMIT $2`, args...)
	if err != nil {
		return nil, "", 0, 0, errs.Wrap(errs.Internal, msgHoldersNotRead, err)
	}
	defer rows.Close()

	type keyed struct {
		RoleHolder
		rank int
		sort string
	}
	var got []keyed
	for rows.Next() {
		var h keyed
		if err := rows.Scan(&h.rank, &h.sort, &h.Kind, &h.ID, &h.Name, &h.Username, &h.Source, &h.SourceName,
			&h.Via, &h.GroupID); err != nil {
			return nil, "", 0, 0, errs.Wrap(errs.Internal, msgHoldersNotRead, err)
		}
		got = append(got, h)
	}
	if err := rows.Err(); err != nil {
		return nil, "", 0, 0, errs.Wrap(errs.Internal, msgHoldersNotRead, err)
	}
	var next string
	if len(got) > page.Size() {
		got = got[:page.Size()]
		last := got[len(got)-1]
		next = encodeCursor(last.rank, last.sort, last.ID)
	}
	out := make([]RoleHolder, 0, len(got))
	for _, h := range got {
		out = append(out, h.RoleHolder)
	}

	var total, groups int
	err = r.db.QueryRow(ctx, holdersSelect+`
		SELECT count(*), count(*) FILTER (WHERE kind = 'group')
		FROM (SELECT kind FROM holders LIMIT `+strconv.Itoa(TotalCap+1)+`) capped`, roleID).Scan(&total, &groups)
	if err != nil {
		return nil, "", 0, 0, errs.Wrap(errs.Internal, msgHoldersNotRead, err)
	}
	return out, next, total, groups, nil
}

// Rename changes the name of a group made in Pando, and returns the name it
// had. A group an identity provider syncs keeps the provider's name: the
// provider names it at every sign-in and push, and matches on it (R-078).
func (g *Groups) Rename(ctx context.Context, groupID, name string) (string, error) {
	name = strings.TrimSpace(name)
	if name == "" {
		return "", errs.New(errs.ValidInvalid, "A group needs a name.")
	}
	var old string
	var adapter *string
	err := g.db.QueryRow(ctx, `SELECT name, adapter_id FROM groups WHERE id = $1`, groupID).Scan(&old, &adapter)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", errs.New(errs.NotFound, "There is no group with that ID.")
	}
	if err != nil {
		return "", errs.Wrap(errs.Internal, "Could not read the group.", err)
	}
	if adapter != nil {
		return "", errs.New(errs.ValidInvalid, "This group comes from an identity provider, so it is renamed there.").
			WithRemedy("Rename it in the identity provider; Pando picks up the new name at the next sign-in, " +
				"or at once if the provider pushes changes through SCIM.")
	}
	if _, err := g.db.Exec(ctx, `UPDATE groups SET name = $2 WHERE id = $1`, groupID, name); err != nil {
		if isUniqueViolation(err) {
			return "", errs.Newf(errs.ValidInvalid, "There is already a group called %q.", name).
				WithRemedy(remedyOtherName)
		}
		return "", errs.Wrap(errs.Internal, "Could not rename the group.", err)
	}
	return old, nil
}
