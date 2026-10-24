package httpapi

import (
	"encoding/json"
	"net/http"

	"github.com/go-chi/chi/v5"

	"github.com/trypando/pando/internal/core/audit"
	"github.com/trypando/pando/internal/core/authz"
	"github.com/trypando/pando/internal/core/state"
	"github.com/trypando/pando/internal/errs"
)

// handleUpdateRole renames a custom role or replaces its permissions (R-082).
// Built-in roles are immutable (R-081).
//
// What an edit hands on is checked like creating the role (R-080a): an
// installation role's verbs, before and after, must all be the caller's, and
// an app role's new verbs must be the caller's on every app it is granted on —
// adding a verb to a role is granting it to everyone who holds the role.
func (s *Server) handleUpdateRole(w http.ResponseWriter, r *http.Request) {
	p, ok := s.requireInstall(w, r, authz.InstallUsersManage)
	if !ok {
		return
	}
	var req struct {
		Name  *string   `json:"name"`
		Verbs *[]string `json:"verbs"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		Error(w, r, errs.New(errs.ValidInvalid, "The request body could not be read."))
		return
	}
	if req.Name == nil && req.Verbs == nil {
		Error(w, r, errs.New(errs.ValidInvalid, "This changes nothing: give a new name, new verbs, or both."))
		return
	}

	roleID := chi.URLParam(r, "roleID")
	role, found, err := s.Roles.ByID(r.Context(), roleID)
	if err != nil {
		Error(w, r, err)
		return
	}
	if !found {
		Error(w, r, errs.New(errs.NotFound, "There is no role with that ID."))
		return
	}
	if role.Builtin {
		Error(w, r, state.ErrBuiltinRole)
		return
	}

	change := state.RoleChange{Name: req.Name}
	if req.Verbs != nil {
		change.SetVerbs = true
		for _, v := range *req.Verbs {
			change.Verbs = append(change.Verbs, authz.Verb(v))
		}
	}
	if err := s.confersRoleEdit(r, p, role, change); err != nil {
		Error(w, r, err)
		return
	}

	before, after, err := s.Roles.UpdateCustom(r.Context(), roleID, change)
	if err != nil {
		Error(w, r, err)
		return
	}
	s.audit(r, audit.Event{
		PrincipalKind: audit.PrincipalKind(p.Kind), PrincipalID: p.ID, OnBehalfOf: p.UserID,
		Action: "role.update", TargetKind: "role", TargetID: roleID,
		Detail: map[string]any{
			"name": after.Name, "previous_name": before.Name,
			"verbs": after.Verbs, "previous_verbs": before.Verbs,
		},
	})
	JSON(w, http.StatusOK, after)
}

// confersRoleEdit is R-080a for an edit: an installation role is changed
// only by someone holding every install verb it carries now and would carry;
// an app role's added verbs only by someone holding them on each app the role
// is granted on.
func (s *Server) confersRoleEdit(r *http.Request, p authz.Principal, role state.RoleRow, change state.RoleChange) error {
	ctx := r.Context()
	if role.Scope == "install" {
		verbs := make([]authz.Verb, 0, len(role.Verbs)+len(change.Verbs))
		for _, v := range role.Verbs {
			verbs = append(verbs, authz.Verb(v))
		}
		for _, v := range change.Verbs {
			if authz.InstallScoped(v) {
				verbs = append(verbs, v)
			}
		}
		return s.Authz.CheckConfers(ctx, p, verbs, "change the role "+role.Name)
	}
	had := map[string]bool{}
	for _, v := range role.Verbs {
		had[v] = true
	}
	var added []authz.Verb
	for _, v := range change.Verbs {
		if !had[string(v)] && !authz.InstallScoped(v) {
			added = append(added, v)
		}
	}
	if len(added) == 0 {
		return nil
	}
	apps, err := s.Roles.AppsGranted(ctx, role.ID)
	if err != nil {
		return err
	}
	for _, appID := range apps {
		if err := s.Authz.CheckConfersVerbsOnApp(ctx, p, appID, added,
			"add permissions to the role "+role.Name+" where it is granted"); err != nil {
			return err
		}
	}
	return nil
}

// handleRoleHolders lists who holds a role: the groups granted it and the
// accounts holding it, each marked direct or through a group. An app role's
// holders are those holding it on any app.
func (s *Server) handleRoleHolders(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.requireInstall(w, r, authz.InstallView); !ok {
		return
	}
	roleID := chi.URLParam(r, "roleID")
	role, found, err := s.Roles.ByID(r.Context(), roleID)
	if err != nil {
		Error(w, r, err)
		return
	}
	if !found {
		Error(w, r, errs.New(errs.NotFound, "There is no role with that ID."))
		return
	}
	page, err := pageFrom(r)
	if err != nil {
		Error(w, r, err)
		return
	}
	holders, next, total, groups, err := s.Roles.Holders(r.Context(), roleID, page)
	if err != nil {
		Error(w, r, err)
		return
	}
	JSON(w, http.StatusOK, withTotal(map[string]any{
		"role": role, "holders": holders, "next_cursor": next, "groups": groups,
	}, total))
}

// handleRenameGroup renames a group made in Pando. A synced group keeps its
// provider's name (R-078).
func (s *Server) handleRenameGroup(w http.ResponseWriter, r *http.Request) {
	p, ok := s.requireInstall(w, r, authz.InstallUsersManage)
	if !ok {
		return
	}
	var req struct {
		Name string `json:"name"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		Error(w, r, errs.New(errs.ValidInvalid, "The request body could not be read."))
		return
	}
	groupID := chi.URLParam(r, "groupID")
	old, err := s.Groups.Rename(r.Context(), groupID, req.Name)
	if err != nil {
		Error(w, r, err)
		return
	}
	group, _, err := s.Groups.ByID(r.Context(), groupID)
	if err != nil {
		Error(w, r, err)
		return
	}
	s.audit(r, audit.Event{
		PrincipalKind: audit.PrincipalKind(p.Kind), PrincipalID: p.ID, OnBehalfOf: p.UserID,
		Action: "group.rename", TargetKind: "group", TargetID: groupID,
		Detail: map[string]any{"name": group.Name, "previous_name": old},
	})
	JSON(w, http.StatusOK, group)
}
