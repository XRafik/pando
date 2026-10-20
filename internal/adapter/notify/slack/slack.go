// Package slack is the notify adapter for Slack (R-374): a channel adapter
// (R-373) that posts the events a subscription chooses to the Slack channel
// that subscription names.
//
// It posts as Pando's own Slack app, with the app's bot token. The app is not
// made by hand: connecting the adapter creates it from a manifest, gives it
// Pando's icon and installs it in the workspace (connect.go), so a person
// pastes one configuration token and chooses Allow. Where Slack cannot send
// the browser back — a Pando without an https address — the app is made from
// a prefilled link instead and its bot token pasted back.
//
// An adapter set up before that, with an incoming webhook URL, keeps posting
// through it, to the one channel the webhook names.
package slack

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/trypando/pando/internal/adapter/api"
	"github.com/trypando/pando/internal/adapter/checkkit"
	"github.com/trypando/pando/internal/adapter/notify/chat"
	"github.com/trypando/pando/internal/errs"
	"github.com/trypando/pando/internal/secret"
)

// Kind is the adapter's kind string.
const Kind = "slack"

// slackAPI is where Slack's Web API is.
const slackAPI = "https://slack.com/api/"

const (
	headerContentType = "Content-Type"
	bearer            = "Bearer "
	remedyReconnect   = "Connect the Slack adapter again under Adapters in the console."
)

// unreadable is Slack answering with something Pando cannot read.
func unreadable() error { return errs.New(errs.AdapterFailed, "Slack's answer could not be read.") }

// The credential fields the adapter keeps, all written by Pando when it
// connects except a webhook URL from before it did.
const (
	FieldBotToken     = "bot_token"
	FieldAppID        = "app_id"
	FieldTeamName     = "team_name"
	FieldClientID     = "client_id"
	FieldClientSecret = "client_secret"
	FieldIconSet      = "icon_set"
	FieldWebhookURL   = "webhook_url"
)

// Config is the adapter's configuration.
type Config struct {
	Credentials    map[string]secret.Value `json:"credentials,omitempty"`
	TimeoutSeconds int                     `json:"timeout_seconds,omitempty"`
}

func (c Config) credential(field string) secret.Value { return c.Credentials[field] }

// Adapter posts to Slack.
type Adapter struct {
	cfg    Config
	client *http.Client

	// webhook is the adapter of one set up with an incoming webhook URL,
	// which every call goes to.
	webhook *chat.Adapter

	// api is Slack's Web API, replaced in tests.
	api string
}

// New returns an unconfigured adapter.
func New() *Adapter { return &Adapter{api: slackAPI} }

func (a *Adapter) Kind() string           { return Kind }
func (a *Adapter) Category() api.Category { return api.CategoryNotify }

// Configure reads the configuration core assembled, credentials included. An
// adapter not connected yet is configured, and not authorized.
func (a *Adapter) Configure(ctx context.Context, raw json.RawMessage) error {
	var cfg Config
	if len(raw) > 0 {
		var top map[string]json.RawMessage
		if err := json.Unmarshal(raw, &top); err != nil {
			return fmt.Errorf("slack: reading configuration: %w", err)
		}
		for _, field := range []string{FieldBotToken, FieldWebhookURL, FieldClientSecret} {
			if _, inline := top[field]; inline {
				return fmt.Errorf("slack: %s is in this adapter's stored configuration, which is unencrypted; set it as a credential instead", field)
			}
		}
		if err := json.Unmarshal(raw, &cfg); err != nil {
			return fmt.Errorf("slack: reading configuration: %w", err)
		}
	}
	if cfg.TimeoutSeconds <= 0 {
		cfg.TimeoutSeconds = 10
	}
	if !cfg.credential(FieldWebhookURL).IsZero() {
		w := chat.New(chat.Slack)
		if err := w.Configure(ctx, raw); err != nil {
			return err
		}
		a.webhook = w
	}
	if tok := cfg.credential(FieldBotToken).Reveal(); tok != "" && !strings.HasPrefix(tok, "xoxb-") {
		return errors.New("slack: the bot token does not start with xoxb-. Copy the Bot User OAuth Token from the app's OAuth & Permissions page in Slack")
	}
	a.cfg = cfg
	a.client = &http.Client{Timeout: time.Duration(cfg.TimeoutSeconds) * time.Second}
	if a.api == "" {
		a.api = slackAPI
	}
	return nil
}

// HealthCheck succeeds once configured. It does not post: a message to a
// channel every few minutes would be the outage.
func (a *Adapter) HealthCheck(context.Context) error {
	if a.client == nil {
		return errors.New("slack: not configured")
	}
	return nil
}

func (a *Adapter) connected() bool { return !a.cfg.credential(FieldBotToken).IsZero() }

// Capabilities: a channel adapter whose subscriptions each choose a channel —
// unless it posts through a webhook, which names the one channel it reaches.
func (a *Adapter) Capabilities() api.NotifyCapabilities {
	if a.webhook != nil {
		return api.NotifyCapabilities{Audience: api.AudienceChannel, Authorized: true}
	}
	c := api.NotifyCapabilities{
		Audience:            api.AudienceChannel,
		Channels:            true,
		WebAuthorization:    true,
		ManualAuthorization: true,
		Authorized:          a.connected(),
		IconSet:             a.cfg.credential(FieldIconSet).Reveal() == "true",
	}
	if c.Authorized {
		c.ManageURL = "https://api.slack.com/apps"
		if id := a.cfg.credential(FieldAppID).Reveal(); id != "" {
			c.ManageURL += "/" + url.PathEscape(id) + "/general"
		}
	}
	return c
}

// Notify posts one message to the channel the subscription chose.
func (a *Adapter) Notify(ctx context.Context, n api.Notification) error {
	if a.webhook != nil {
		return a.webhook.Notify(ctx, n)
	}
	if !a.connected() {
		return notConnected()
	}
	if n.Channel == "" {
		return errs.New(errs.ValidInvalid, "This Slack message names no channel.").
			WithRemedy("Choose a channel in the subscription's settings.")
	}
	msg := chat.SlackMessage(n)
	msg["channel"] = n.Channel
	msg["unfurl_links"] = false
	var resp struct{}
	if err := a.call(ctx, "chat.postMessage", a.cfg.credential(FieldBotToken), msg, &resp); err != nil {
		return postErr(err, n.Channel)
	}
	return nil
}

// Channels lists the workspace's public channels, and the private ones Pando
// was invited to, whose names contain query.
func (a *Adapter) Channels(ctx context.Context, query string) ([]api.NotifyChannel, error) {
	if a.webhook != nil {
		return nil, errs.New(errs.ValidInvalid,
			"This Slack adapter posts through an incoming webhook, to the one channel it was made for, so there are no channels to choose.").
			WithRemedy("Connect a new Slack adapter to choose a channel for each subscription.")
	}
	if !a.connected() {
		return nil, notConnected()
	}
	query = strings.ToLower(strings.TrimPrefix(strings.TrimSpace(query), "#"))
	var out []api.NotifyChannel
	cursor := ""
	for range 10 { // 2,000 channels; a query narrows the rest
		form := url.Values{"types": {"public_channel,private_channel"}, "exclude_archived": {"true"}, "limit": {"200"}}
		if cursor != "" {
			form.Set("cursor", cursor)
		}
		var page struct {
			Channels []struct {
				ID        string `json:"id"`
				Name      string `json:"name"`
				IsPrivate bool   `json:"is_private"`
			} `json:"channels"`
			Meta struct {
				NextCursor string `json:"next_cursor"`
			} `json:"response_metadata"`
		}
		if err := a.form(ctx, "conversations.list", a.cfg.credential(FieldBotToken), form, &page); err != nil {
			return nil, tokenErr(err)
		}
		for _, c := range page.Channels {
			if query == "" || strings.Contains(strings.ToLower(c.Name), query) {
				out = append(out, api.NotifyChannel{ID: c.ID, Name: c.Name, Private: c.IsPrivate})
			}
		}
		if cursor = page.Meta.NextCursor; cursor == "" {
			break
		}
	}
	return out, nil
}

// --- Slack's Web API -------------------------------------------------------

// apiError is Slack's answer when it says ok: false, by its error code.
type apiError struct{ code string }

func (e apiError) Error() string { return "Slack answered " + e.code }

// call posts a JSON body to a Web API method with a token.
func (a *Adapter) call(ctx context.Context, method string, token secret.Value, body any, out any) error {
	b, err := json.Marshal(body)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, a.api+method, bytes.NewReader(b))
	if err != nil {
		return err
	}
	req.Header.Set(headerContentType, "application/json; charset=utf-8")
	req.Header.Set("Authorization", bearer+token.Reveal())
	return a.do(req, out)
}

// form posts form fields to a Web API method, with a token unless it is zero.
func (a *Adapter) form(ctx context.Context, method string, token secret.Value, form url.Values, out any) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, a.api+method, strings.NewReader(form.Encode()))
	if err != nil {
		return err
	}
	req.Header.Set(headerContentType, "application/x-www-form-urlencoded")
	if !token.IsZero() {
		req.Header.Set("Authorization", bearer+token.Reveal())
	}
	return a.do(req, out)
}

// upload posts a file to a Web API method as multipart form data.
func (a *Adapter) upload(ctx context.Context, method string, token secret.Value, fields map[string]string, name string, file []byte) error {
	var buf bytes.Buffer
	w := multipart.NewWriter(&buf)
	for k, v := range fields {
		if err := w.WriteField(k, v); err != nil {
			return err
		}
	}
	part, err := w.CreateFormFile("file", name)
	if err != nil {
		return err
	}
	if _, err := part.Write(file); err != nil {
		return err
	}
	if err := w.Close(); err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, a.api+method, &buf)
	if err != nil {
		return err
	}
	req.Header.Set(headerContentType, w.FormDataContentType())
	req.Header.Set("Authorization", bearer+token.Reveal())
	var out struct{}
	return a.do(req, &out)
}

// do sends a request and reads Slack's answer, which is 200 with ok: false
// for nearly every refusal.
func (a *Adapter) do(req *http.Request, out any) error {
	client := a.client
	if client == nil {
		client = &http.Client{Timeout: 10 * time.Second}
	}
	resp, err := client.Do(req)
	if err != nil {
		// The error can carry the request's address and nothing secret, but
		// is said in Pando's words: the cause is the network.
		return errs.New(errs.AdapterFailed, "Pando could not reach Slack. Check the Pando server can reach the internet.")
	}
	defer func() { _ = resp.Body.Close() }()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	if err != nil {
		return unreadable()
	}
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		return errs.Newf(errs.AdapterFailed, "Slack answered %d.", resp.StatusCode)
	}
	var status struct {
		OK    bool   `json:"ok"`
		Error string `json:"error"`
	}
	if err := json.Unmarshal(body, &status); err != nil {
		return unreadable()
	}
	if !status.OK {
		return apiError{code: status.Error}
	}
	if err := json.Unmarshal(body, out); err != nil {
		return unreadable()
	}
	return nil
}

func code(err error) string {
	var e apiError
	if errors.As(err, &e) {
		return e.code
	}
	return ""
}

// tokenErr is a refused bot token in words, or err.
func tokenErr(err error) error {
	switch code(err) {
	case "invalid_auth", "token_revoked", "account_inactive", "not_authed", "token_expired":
		return errs.New(errs.AdapterFailed, "Slack no longer accepts Pando's bot token: the app was removed from the workspace, or its token was revoked. Connect the Slack adapter again under Adapters.").
			WithRemedy(remedyReconnect)
	case "missing_scope":
		return errs.New(errs.AdapterFailed, "Pando's Slack app is missing a permission it needs. Connect the Slack adapter again under Adapters.").
			WithRemedy("Connect the Slack adapter again under Adapters in the console, so the app is installed with every permission.")
	case "":
		return err
	}
	return errs.Newf(errs.AdapterFailed, "Slack refused the request: %s.", code(err))
}

// postErr is a refused message in words.
func postErr(err error, channel string) error {
	switch code(err) {
	case "not_in_channel":
		return errs.Newf(errs.AdapterFailed, "Pando is not in the private Slack channel %s, so it cannot post there. Invite it with /invite @Pando.", channel).
			WithRemedy("In Slack, invite it to the channel with /invite @Pando.")
	case "channel_not_found":
		return errs.Newf(errs.AdapterFailed, "Slack has no channel %s that Pando can see: it was deleted, or is private and Pando is not in it. Choose another channel, or invite Pando with /invite @Pando.", channel).
			WithRemedy("Choose another channel in the subscription's settings, or invite Pando to the private channel with /invite @Pando.")
	case "is_archived":
		return errs.Newf(errs.AdapterFailed, "The Slack channel %s is archived. Choose another channel in the subscription.", channel).
			WithRemedy("Choose another channel in the subscription's settings.")
	}
	return tokenErr(err)
}

func notConnected() error {
	return errs.New(errs.StateInvalid, "This Slack adapter is not connected to a workspace yet.").
		WithRemedy("Connect it under Adapters in the console.")
}

// Info describes the kind for the console's and the CLI's forms. It asks for
// nothing before it is saved: saving opens the connection, which creates the
// app and fills in the rest.
func Info() api.KindInfo {
	return api.KindInfo{
		Check:       check,
		Category:    api.CategoryNotify,
		Kind:        Kind,
		Name:        "Slack",
		Description: "Posts the events a subscription chooses to the Slack channel it chooses, as Pando's own Slack app. Pando creates the app when you connect.",
		IDPrefix:    "ntf_",
		Fields: []api.Field{
			{Key: "timeout_seconds", Label: "Timeout", Type: "int", Help: "Seconds to wait for Slack to answer.", Default: "10", Advanced: true},
		},
	}
}

// check runs Configure on a configuration being saved (KindInfo.Check). A
// credential stored before and not sent again was checked when it was stored.
func check(config json.RawMessage, credentials map[string]secret.Value, _ []string) error {
	// Only what is sent is checked: a stored token or webhook URL would be a
	// stand-in here, which no Slack token looks like.
	merged, err := checkkit.Merge(config, credentials, nil)
	if err != nil {
		return err
	}
	return New().Configure(context.Background(), merged)
}

var _ api.NotifyAdapter = (*Adapter)(nil)
