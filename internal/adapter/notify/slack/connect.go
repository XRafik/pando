package slack

import (
	"context"
	_ "embed" // the app icon
	"encoding/json"
	"net/http"
	"net/url"
	"strings"

	"github.com/trypando/pando/internal/adapter/api"
	"github.com/trypando/pando/internal/errs"
	"github.com/trypando/pando/internal/secret"
)

// Connecting creates Pando's Slack app and installs it, in one of two ways.
//
// With an https address (web): the person gives a configuration token, which
// Pando uses once, never stores, to create the app from its manifest
// (apps.manifest.create) and give it Pando's icon (apps.icon.set). Slack
// answers with the app's client ID and secret; the browser goes to Slack's
// approval screen, and returns to Pando's callback with a code that
// oauth.v2.access exchanges for the bot token.
//
// Without one (manual): Slack sends a browser back only to https, so Pando
// gives a link that opens Slack's "create app" screen with the manifest
// filled in, and the person pastes back the bot token Slack shows once the
// app is installed. The icon is theirs to upload.
//
// The adapter keeps nothing between the two calls (R-027): what the callback
// needs travels in Authorization.Flow, which core keeps sealed.

// icon is Pando's app icon: the ink tile with "p." in it, 1024 pixels square
// and full-bleed, since Slack rounds it itself. Slack takes 512 to 2,000.
//
//go:embed icon.png
var icon []byte

// botScopes are what Pando's app asks for: to post (to public channels without
// being invited, too), and to list channels for a subscription to choose from.
var botScopes = []string{"chat:write", "chat:write.public", "channels:read", "groups:read"}

// manifest is the app's manifest. redirect is Pando's callback, or "" for an
// app made by hand, which is installed from Slack's own pages.
func manifest(redirect string) map[string]any {
	oauth := map[string]any{"scopes": map[string]any{"bot": botScopes}}
	if redirect != "" {
		oauth["redirect_urls"] = []string{redirect}
	}
	return map[string]any{
		"display_information": map[string]any{
			"name":             "Pando",
			"description":      "Posts the events Pando subscriptions choose.",
			"background_color": "#1a1c1b",
		},
		"features": map[string]any{
			"bot_user": map[string]any{"display_name": "pando", "always_online": false},
		},
		"oauth_config": oauth,
		"settings": map[string]any{
			"org_deploy_enabled":     false,
			"socket_mode_enabled":    false,
			"token_rotation_enabled": false,
		},
	}
}

// flow is what the callback needs from BeginAuthorization.
type flow struct {
	AppID        string `json:"app_id"`
	ClientID     string `json:"client_id"`
	ClientSecret string `json:"client_secret"`
	IconSet      bool   `json:"icon_set"`
}

// BeginAuthorization creates the app and returns Slack's approval screen
// (web), or the link to create it by hand (manual).
func (a *Adapter) BeginAuthorization(ctx context.Context, req api.AuthorizationRequest) (api.Authorization, error) {
	if a.webhook != nil {
		return api.Authorization{}, errs.New(errs.ValidInvalid,
			"This Slack adapter posts through an incoming webhook, so there is nothing to connect.").
			WithRemedy("Add a new Slack adapter to connect Pando's Slack app.")
	}
	switch req.Mode {
	case api.AuthorizationManual:
		b, err := json.Marshal(manifest(""))
		if err != nil {
			return api.Authorization{}, err
		}
		return api.Authorization{
			Mode:         api.AuthorizationManual,
			AuthorizeURL: "https://api.slack.com/apps?new_app=1&manifest_json=" + url.QueryEscape(string(b)),
			Flow:         secret.New("manual"),
		}, nil
	case api.AuthorizationWeb:
		return a.createApp(ctx, req)
	}
	return api.Authorization{}, errs.Newf(errs.ValidInvalid,
		"%q is not a way to connect Slack. Use web, or manual on a Pando without an https address.", string(req.Mode))
}

func (a *Adapter) createApp(ctx context.Context, req api.AuthorizationRequest) (api.Authorization, error) {
	if u, err := url.Parse(req.RedirectURL); err != nil || u.Scheme != "https" {
		return api.Authorization{}, errs.New(errs.ValidInvalid,
			"Slack sends the browser back only to an https address, and this Pando is not reached at one.").
			WithRemedy("Set Pando's external address to an https one, or connect Slack by hand: create the app from the link Pando gives and paste its bot token.")
	}
	if req.Grant.IsZero() {
		return api.Authorization{}, errs.New(errs.ValidInvalid, "Connecting Slack needs a configuration token, to create Pando's app.").
			WithRemedy("In Slack's app settings, under Your App Configuration Tokens, choose Generate Token, pick the workspace, and paste the access token.")
	}
	b, err := json.Marshal(manifest(req.RedirectURL))
	if err != nil {
		return api.Authorization{}, err
	}
	var created struct {
		AppID       string `json:"app_id"`
		Credentials struct {
			ClientID     string `json:"client_id"`
			ClientSecret string `json:"client_secret"`
		} `json:"credentials"`
		AuthorizeURL string `json:"oauth_authorize_url"`
	}
	if err := a.form(ctx, "apps.manifest.create", secret.Value{},
		url.Values{"token": {req.Grant.Reveal()}, "manifest": {string(b)}}, &created); err != nil {
		return api.Authorization{}, grantErr(err)
	}
	if created.AppID == "" || created.Credentials.ClientID == "" || created.AuthorizeURL == "" {
		return api.Authorization{}, errs.New(errs.AdapterFailed, "Slack answered without the app it created.")
	}
	// The icon is worth trying and not worth failing for: an app with
	// Slack's own icon still posts, and the person can upload Pando's.
	iconSet := a.upload(ctx, "apps.icon.set", req.Grant, map[string]string{"app_id": created.AppID}, "pando.png", icon) == nil

	authorize, err := url.Parse(created.AuthorizeURL)
	if err != nil || authorize.Host != "slack.com" {
		return api.Authorization{}, errs.New(errs.AdapterFailed, "Slack answered with an approval address Pando does not recognize.")
	}
	q := authorize.Query()
	q.Set("redirect_uri", req.RedirectURL)
	q.Set("state", req.State)
	authorize.RawQuery = q.Encode()

	// The flow carries the client secret to the callback: core seals it in
	// notify_authorizations and hands it back, and it is never logged.
	f, err := json.Marshal(flow{AppID: created.AppID, ClientID: created.Credentials.ClientID, //nolint:gosec // G117: sealed by core, see above
		ClientSecret: created.Credentials.ClientSecret, IconSet: iconSet})
	if err != nil {
		return api.Authorization{}, err
	}
	return api.Authorization{Mode: api.AuthorizationWeb, AuthorizeURL: authorize.String(), Flow: secret.New(string(f))}, nil
}

// CompleteAuthorization exchanges the code Slack returned for the bot token
// (web), or checks a bot token pasted by hand (manual, Code).
func (a *Adapter) CompleteAuthorization(ctx context.Context, req api.AuthorizationCompletion) (api.AuthorizationResult, error) {
	switch req.Mode {
	case api.AuthorizationManual:
		return a.checkToken(ctx, strings.TrimSpace(req.Code))
	case api.AuthorizationWeb:
		return a.exchange(ctx, req)
	}
	return api.AuthorizationResult{}, errs.Newf(errs.ValidInvalid,
		"%q is not a way to connect Slack.", string(req.Mode))
}

func (a *Adapter) exchange(ctx context.Context, req api.AuthorizationCompletion) (api.AuthorizationResult, error) {
	var f flow
	if err := json.Unmarshal([]byte(req.Flow.Reveal()), &f); err != nil || f.ClientID == "" {
		return api.AuthorizationResult{}, errs.New(errs.ValidInvalid, "This is not a Slack connection Pando started.").
			WithRemedy(remedyReconnect)
	}
	if req.Code == "" {
		return api.AuthorizationResult{}, errs.New(errs.ValidInvalid, "Slack returned without a code.").
			WithRemedy(remedyReconnect)
	}
	form := url.Values{"code": {req.Code}, "redirect_uri": {req.RedirectURL}}
	hreq, err := http.NewRequestWithContext(ctx, http.MethodPost, a.api+"oauth.v2.access", strings.NewReader(form.Encode()))
	if err != nil {
		return api.AuthorizationResult{}, err
	}
	hreq.Header.Set(headerContentType, "application/x-www-form-urlencoded")
	hreq.SetBasicAuth(f.ClientID, f.ClientSecret)
	var got struct {
		AccessToken string `json:"access_token"`
		TokenType   string `json:"token_type"`
		AppID       string `json:"app_id"`
		Team        struct {
			Name string `json:"name"`
		} `json:"team"`
	}
	if err := a.do(hreq, &got); err != nil {
		if code(err) == "invalid_code" || code(err) == "code_already_used" {
			return api.AuthorizationResult{}, errs.New(errs.ValidInvalid, "Slack no longer accepts the code it returned. A code is good for a few minutes, and once.").
				WithRemedy(remedyReconnect)
		}
		return api.AuthorizationResult{}, tokenErr(err)
	}
	if !strings.HasPrefix(got.AccessToken, "xoxb-") {
		return api.AuthorizationResult{}, errs.New(errs.AdapterFailed, "Slack answered without a bot token for Pando's app.")
	}
	creds := map[string]secret.Value{
		FieldBotToken:     secret.New(got.AccessToken),
		FieldAppID:        secret.New(firstNonEmpty(got.AppID, f.AppID)),
		FieldClientID:     secret.New(f.ClientID),
		FieldClientSecret: secret.New(f.ClientSecret),
		FieldIconSet:      secret.New(boolString(f.IconSet)),
	}
	if got.Team.Name != "" {
		creds[FieldTeamName] = secret.New(got.Team.Name)
	}
	return api.AuthorizationResult{Credentials: creds}, nil
}

// checkToken checks a bot token pasted by hand works, and names its workspace.
func (a *Adapter) checkToken(ctx context.Context, token string) (api.AuthorizationResult, error) {
	if !strings.HasPrefix(token, "xoxb-") {
		return api.AuthorizationResult{}, errs.New(errs.ValidInvalid, "That is not a Slack bot token. A bot token starts with xoxb-.").
			WithRemedy("In the app's settings in Slack, open OAuth & Permissions and copy the Bot User OAuth Token.")
	}
	var got struct {
		Team string `json:"team"`
	}
	if err := a.form(ctx, "auth.test", secret.New(token), url.Values{}, &got); err != nil {
		return api.AuthorizationResult{}, tokenErr(err)
	}
	creds := map[string]secret.Value{FieldBotToken: secret.New(token), FieldIconSet: secret.New("false")}
	if got.Team != "" {
		creds[FieldTeamName] = secret.New(got.Team)
	}
	return api.AuthorizationResult{Credentials: creds}, nil
}

// grantErr is a refused configuration token in words.
func grantErr(err error) error {
	switch code(err) {
	case "invalid_auth", "not_authed", "token_expired", "token_revoked":
		return errs.New(errs.ValidInvalid, "Slack did not accept the configuration token. It may have expired or been revoked.").
			WithRemedy("In Slack's app settings, under Your App Configuration Tokens, choose Generate Token and paste the new access token.")
	case "":
		return err
	}
	return errs.Newf(errs.AdapterFailed, "Slack did not create Pando's app: %s.", code(err)).
		WithRemedy("Check the configuration token is for the workspace you want, and try again.")
}

func boolString(b bool) string {
	if b {
		return "true"
	}
	return "false"
}

func firstNonEmpty(ss ...string) string {
	for _, s := range ss {
		if s != "" {
			return s
		}
	}
	return ""
}
