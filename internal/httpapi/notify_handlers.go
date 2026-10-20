package httpapi

import (
	"encoding/json"
	"net/http"
	"net/url"
	"strings"

	"github.com/go-chi/chi/v5"

	"github.com/trypando/pando/internal/adapter/api"
	"github.com/trypando/pando/internal/core/audit"
	"github.com/trypando/pando/internal/core/authz"
	"github.com/trypando/pando/internal/core/notifyconn"
	"github.com/trypando/pando/internal/errs"
	"github.com/trypando/pando/internal/secret"
)

// Notification adapters (R-373, R-374). One is configured like any adapter,
// with POST /adapters and category "notify"; these routes are what is
// particular to one that connects to its provider — Slack, as Pando's own
// app — and posts to a channel each subscription chooses. Every decision is
// in notifyconn.Service.
//
// Connecting is install.adapters.manage, like changing any adapter. Listing an
// adapter's channels is for whoever may subscribe: anybody signed in, as the
// list of destinations in GET /events is.

func (s *Server) notifyConfigured(w http.ResponseWriter, r *http.Request) bool {
	if s.NotifyConnections == nil {
		Error(w, r, errs.New(errs.StateInvalid, "This installation cannot connect notification adapters."))
		return false
	}
	return true
}

func (s *Server) handleListNotifyChannels(w http.ResponseWriter, r *http.Request) {
	if p := PrincipalFrom(r.Context()); p.Kind == authz.KindAnonymous {
		Error(w, r, errs.New(errs.AuthRequired, "You need to sign in."))
		return
	}
	if !s.notifyConfigured(w, r) {
		return
	}
	channels, err := s.NotifyConnections.Channels(r.Context(), chi.URLParam(r, "adapterID"), r.URL.Query().Get("q"))
	if err != nil {
		Error(w, r, err)
		return
	}
	JSON(w, http.StatusOK, map[string]any{"channels": channels})
}

// handleAuthorizeNotify connects an adapter. mode web takes token, a
// credential the person gives once (a Slack configuration token), and
// answers with the provider's approval screen. mode manual without token
// answers with a link to set the integration up by hand; with token, the
// credential that gave (a Slack bot token), it finishes.
func (s *Server) handleAuthorizeNotify(w http.ResponseWriter, r *http.Request) {
	p, ok := s.requireInstall(w, r, authz.InstallAdaptersManage)
	if !ok {
		return
	}
	if !s.notifyConfigured(w, r) {
		return
	}
	var req struct {
		Mode  api.AuthorizationMode `json:"mode"`
		Token secret.Value          `json:"token"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		Error(w, r, errs.New(errs.ValidInvalid, "The request body could not be read.").
			WithRemedy(`Send {"mode": "web", "token": "<configuration token>"} or {"mode": "manual"}.`))
		return
	}
	if req.Mode == "" {
		req.Mode = api.AuthorizationWeb
	}
	id := chi.URLParam(r, "adapterID")
	event := audit.Event{
		PrincipalKind: audit.PrincipalKind(p.Kind), PrincipalID: p.ID, OnBehalfOf: p.UserID,
		Action: "notify.connection.authorize", TargetKind: "adapter", TargetID: id,
		Detail: map[string]any{"mode": string(req.Mode)},
	}

	if req.Mode == api.AuthorizationManual && !req.Token.IsZero() {
		// The attempt is recorded before it is made, and the connection
		// once the token is accepted.
		s.audit(r, event)
		if err := s.NotifyConnections.CompleteManual(r.Context(), id, req.Token); err != nil {
			Error(w, r, err)
			return
		}
		event.Action = "notify.connection.authorized"
		s.audit(r, event)
		JSON(w, http.StatusOK, map[string]any{"status": "authorized"})
		return
	}
	s.audit(r, event)
	a, err := s.NotifyConnections.BeginAuthorization(r.Context(), id, req.Mode,
		s.externalBase(r)+"/api/v1/notify/callback", req.Token)
	if err != nil {
		Error(w, r, err)
		return
	}
	JSON(w, http.StatusOK, a)
}

// handleNotifyCallback is where a provider sends the browser back after
// approving a connection. It answers with a redirect to the console either
// way, carrying the outcome, because a person is looking at it.
func (s *Server) handleNotifyCallback(w http.ResponseWriter, r *http.Request) {
	p, ok := s.requireInstall(w, r, authz.InstallAdaptersManage)
	if !ok {
		return
	}
	q := r.URL.Query()
	back := url.Values{}
	if denied := q.Get("error"); denied != "" {
		back.Set("error", "The provider did not connect the adapter ("+strings.ReplaceAll(denied, "_", " ")+"). Connect it again to retry.")
		http.Redirect(w, r, sourcesPage+"?"+back.Encode(), http.StatusFound)
		return
	}
	if !s.notifyConfigured(w, r) {
		return
	}
	id, err := s.NotifyConnections.CompleteWebAuthorization(r.Context(), q.Get("state"), q.Get("code"))
	if err != nil {
		back.Set("error", messageOr(err, "Connecting could not be finished."))
		http.Redirect(w, r, sourcesPage+"?"+back.Encode(), http.StatusFound)
		return
	}
	s.audit(r, audit.Event{
		PrincipalKind: audit.PrincipalKind(p.Kind), PrincipalID: p.ID, OnBehalfOf: p.UserID,
		Action: "notify.connection.authorized", TargetKind: "adapter", TargetID: id,
		Detail: map[string]any{"mode": string(api.AuthorizationWeb)},
	})
	back.Set("authorized", id)
	http.Redirect(w, r, sourcesPage+"?"+back.Encode(), http.StatusFound)
}

// handleListNotify lists the notification adapters with whether each can
// send — connected, or why not — for the Adapters screen.
func (s *Server) handleListNotify(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.requireInstall(w, r, authz.InstallView); !ok {
		return
	}
	if !s.notifyConfigured(w, r) {
		return
	}
	all, err := s.NotifyConnections.List(r.Context())
	if err != nil {
		Error(w, r, err)
		return
	}
	if all == nil {
		all = []notifyconn.Adapter{}
	}
	JSON(w, http.StatusOK, map[string]any{"adapters": all})
}
