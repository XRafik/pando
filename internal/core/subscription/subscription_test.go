package subscription

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/trypando/pando/internal/adapter/api"
	"github.com/trypando/pando/internal/core/notifyconn"
	"github.com/trypando/pando/internal/core/state"
	"github.com/trypando/pando/internal/errs"
	"github.com/trypando/pando/internal/secret"
)

func TestR369_SignAndVerifyAgree(t *testing.T) {
	key, err := NewKey()
	require.NoError(t, err)
	require.Contains(t, key.Reveal(), keyPrefix)

	body := []byte(`{"id":"evt_1"}`)
	now := time.Unix(1_800_000_000, 0)
	sig := Sign(key, now.Unix(), body)

	require.True(t, Verify(key, sig, now.Unix(), body, now, 5*time.Minute))
	require.False(t, Verify(key, sig, now.Unix(), []byte(`{"id":"evt_2"}`), now, 5*time.Minute), "a changed body fails")
	require.False(t, Verify(key, sig, now.Unix(), body, now.Add(10*time.Minute), 5*time.Minute), "an old timestamp fails")
	require.False(t, Verify(secret.New("whsec_other"), sig, now.Unix(), body, now, 5*time.Minute))
}

type fixedResolver map[string][]netip.Addr

func (r fixedResolver) LookupNetIP(_ context.Context, _, host string) ([]netip.Addr, error) {
	if a, ok := r[host]; ok {
		return a, nil
	}
	return nil, errors.New("no such host")
}

// TestR372_CheckURLRefusesPrivateTargets asserts R-372 at save time: a URL
// whose host is, or resolves to, a private, loopback, link-local or
// unspecified address is refused unless policy allows it.
func TestR372_CheckURLRefusesPrivateTargets(t *testing.T) {
	ctx := context.Background()
	r := fixedResolver{
		"hooks.example.com":  {netip.MustParseAddr("93.184.216.34")},
		"inside.example.com": {netip.MustParseAddr("192.168.1.10")},
		"mapped.example.com": {netip.MustParseAddr("::ffff:10.0.0.1")},
	}
	for _, raw := range []string{
		"http://127.0.0.1/x", "http://[::1]/x", "http://169.254.169.254/latest", "http://0.0.0.0/",
		"https://inside.example.com/hook", "https://mapped.example.com/hook",
	} {
		_, err := CheckURL(ctx, raw, false, r)
		require.Equal(t, errs.PolicyWebhookPrivateAddress, errs.CodeOf(err), raw)
	}
	got, err := CheckURL(ctx, "https://hooks.example.com/pando#frag", false, r)
	require.NoError(t, err)
	require.Equal(t, "https://hooks.example.com/pando", got)

	_, err = CheckURL(ctx, "http://127.0.0.1/x", true, r)
	require.NoError(t, err, "policy may allow it")

	for _, raw := range []string{"ftp://example.com", "not a url", "https://user:pw@hooks.example.com/"} {
		_, err := CheckURL(ctx, raw, true, r)
		require.Equal(t, errs.ValidInvalid, errs.CodeOf(err), raw)
	}
}

// TestR372_AZoneDoesNotGetAWebhookPastTheCheck asserts R-372 for an address
// written with an IPv6 zone: refused whatever it names, at save time and on
// the dial, including the metadata service behind NAT64 and the deprecated
// site-local range.
func TestR372_AZoneDoesNotGetAWebhookPastTheCheck(t *testing.T) {
	ctx := context.Background()
	r := fixedResolver{"zoned.example.com": {netip.MustParseAddr("2001:4860:4860::8888%eth0")}}
	for _, raw := range []string{
		"http://[64:ff9b::a9fe:a9fe%25x]/latest", "http://[fec0::1%25eth0]/", "http://[fe80::1%25eth0]/",
		"https://zoned.example.com/hook",
	} {
		_, err := CheckURL(ctx, raw, false, r)
		require.Equal(t, errs.PolicyWebhookPrivateAddress, errs.CodeOf(err), raw)
	}
	for _, s := range []string{"64:ff9b::a9fe:a9fe%x", "fec0::1%x", "2001:4860:4860::8888%x", "198.18.0.1", "240.0.0.1"} {
		require.True(t, forbidden(netip.MustParseAddr(s)), s)
	}
	require.False(t, forbidden(netip.MustParseAddr("2001:4860:4860::8888")))
}

// TestR372_TheDialerChecksTheAddressItConnectsTo asserts R-372 at send time:
// the check is on the dialed address, so a name that resolves somewhere
// private — however it was checked earlier — is not reached.
func TestR372_TheDialerChecksTheAddressItConnectsTo(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {}))
	defer srv.Close()

	key := secret.New("whsec_x")
	env := Envelope{ID: "evt_1", Type: "subscription.test"}
	refused := post(context.Background(), newClient(false), webhookRequest{URL: srv.URL, Key: key, DeliveryID: "dlv_1", Event: env.Type, EventID: env.ID}, time.Now())
	require.False(t, refused.OK())
	require.Contains(t, refused.Message(), "allow_private_webhooks")

	allowed := post(context.Background(), newClient(true), webhookRequest{URL: srv.URL, Key: key, DeliveryID: "dlv_1", Event: env.Type, EventID: env.ID}, time.Now())
	require.True(t, allowed.OK(), allowed.Message())
}

func TestARedirectIsNotFollowed(t *testing.T) {
	inner := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		t.Fatal("a redirect was followed")
	}))
	defer inner.Close()
	outer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, inner.URL, http.StatusTemporaryRedirect)
	}))
	defer outer.Close()

	res := post(context.Background(), newClient(true), webhookRequest{URL: outer.URL, Key: secret.New("k"), DeliveryID: "dlv_1"}, time.Now())
	require.Equal(t, http.StatusTemporaryRedirect, res.StatusCode)
	require.False(t, res.OK(), "a redirect is a failed delivery")
}

// TestR367_MatchingFollowsFilterScopeAndTime asserts R-367's routing rules.
func TestR367_MatchingFollowsFilterScopeAndTime(t *testing.T) {
	made := time.Date(2026, 10, 1, 0, 0, 0, 0, time.UTC)
	subs := []state.Subscription{
		{ID: "sub_install", Events: []string{"deploy.*"}, Enabled: true, CreatedAt: made},
		{ID: "sub_app", AppID: "app_1", Events: []string{"*"}, Enabled: true, CreatedAt: made},
		{ID: "sub_other_app", AppID: "app_2", Events: []string{"*"}, Enabled: true, CreatedAt: made},
		{ID: "sub_off", Events: []string{"*"}, Enabled: false, CreatedAt: made},
		{ID: "sub_late", Events: []string{"*"}, Enabled: true, CreatedAt: made.Add(time.Hour)},
	}
	at := made.Add(time.Minute)

	require.ElementsMatch(t, []string{"sub_install", "sub_app"},
		Matching(subs, state.Event{Name: "deploy.failed", AppID: "app_1", OccurredAt: at}))
	require.Empty(t, Matching(subs, state.Event{Name: "user.signed_in", OccurredAt: at}),
		"an install event reaches no app subscription, and the install one filters it out")
	require.Empty(t, Matching(subs, state.Event{Name: "subscription.test", AppID: "app_1", OccurredAt: at}),
		"a test is never routed")
	require.Contains(t, Matching(subs, state.Event{Name: "deploy.failed", OccurredAt: made.Add(2 * time.Hour)}), "sub_late")
}

type recorder struct {
	kind     string
	audience api.NotifyAudience
	got      []api.Notification
}

func (r *recorder) Kind() string                                     { return r.kind }
func (r *recorder) Category() api.Category                           { return api.CategoryNotify }
func (r *recorder) Configure(context.Context, json.RawMessage) error { return nil }
func (r *recorder) HealthCheck(context.Context) error                { return nil }
func (r *recorder) Capabilities() api.NotifyCapabilities {
	return api.NotifyCapabilities{Audience: r.audience}
}

func (*recorder) Channels(context.Context, string) ([]api.NotifyChannel, error) { return nil, nil }
func (*recorder) BeginAuthorization(context.Context, api.AuthorizationRequest) (api.Authorization, error) {
	return api.Authorization{}, nil
}
func (*recorder) CompleteAuthorization(context.Context, api.AuthorizationCompletion) (api.AuthorizationResult, error) {
	return api.AuthorizationResult{}, nil
}
func (r *recorder) Notify(_ context.Context, n api.Notification) error {
	r.got = append(r.got, n)
	return nil
}

type prefs map[string][]state.NotificationPreference

func (p prefs) List(_ context.Context, userID string) ([]state.NotificationPreference, error) {
	return p[userID], nil
}

// TestR373_PandosOwnNotificationsFollowEachPersonsChoices asserts R-373: a
// notification for people goes to every channel that reaches people, minus
// the choices each person made, and never to a channel adapter.
func TestR373_PandosOwnNotificationsFollowEachPersonsChoices(t *testing.T) {
	console := &recorder{kind: "console", audience: api.AudiencePeople}
	email := &recorder{kind: "smtp", audience: api.AudiencePeople}
	slack := &recorder{kind: "slack", audience: api.AudienceChannel}
	reg := api.NewRegistry()
	require.NoError(t, reg.Register("ntf_console", console))
	require.NoError(t, reg.Register("ntf_smtp", email))
	require.NoError(t, reg.Register("ntf_slack", slack))

	router := Router{Registry: reg, Preferences: prefs{
		"usr_quiet": {{Kind: string(api.NotifyAppFailed), Channel: "ntf_smtp", Enabled: false}},
	}}
	require.NoError(t, router.Notify(context.Background(), api.Notification{
		Kind:       api.NotifyAppFailed,
		Recipients: []api.Recipient{{UserID: "usr_quiet"}, {UserID: "usr_default"}},
	}))

	require.Len(t, console.got, 1)
	require.Len(t, console.got[0].Recipients, 2)
	require.Len(t, email.got, 1)
	require.Equal(t, []api.Recipient{{UserID: "usr_default"}}, email.got[0].Recipients)
	require.Empty(t, slack.got, "a channel never gets a notification meant for a person")

	// R-266: a share is off by default everywhere.
	require.NoError(t, router.Notify(context.Background(), api.Notification{
		Kind: api.NotifyAppShared, Recipients: []api.Recipient{{UserID: "usr_default"}},
	}))
	require.Len(t, console.got, 1)
	require.Len(t, email.got, 1)
}

func TestDescribeNamesTheAppAndWhatHappened(t *testing.T) {
	n := Describe(state.Event{
		ID: "evt_1", Name: "deploy.failed", AppID: "app_1",
		Data: map[string]any{"error_code": "BUILD_FAILED", "message": "The build exited with status 1."},
	}, &EnvelopeApp{ID: "app_1", Name: "billing"})
	require.Equal(t, "billing: a deploy failed", n.Subject)
	require.Equal(t, "The build exited with status 1.", n.Body)
	require.Equal(t, "evt_1", n.EventID)
	require.Contains(t, n.Fields, api.NotificationField{Label: "Error code", Value: "BUILD_FAILED"})
}

// channels is Notifiers over a fixed set of adapters, each usable.
type channels map[string]api.NotifyAdapter

func (c channels) Notify(_ context.Context, id string) (api.NotifyAdapter, bool) {
	a, ok := c[id]
	return a, ok
}

func (c channels) Usable(context.Context) ([]notifyconn.Adapter, error) {
	var out []notifyconn.Adapter
	for id, a := range c {
		out = append(out, notifyconn.Adapter{ID: id, Name: id, Kind: a.Kind(), Capabilities: a.Capabilities()})
	}
	return out, nil
}

// slackish is a channel adapter whose subscriptions each choose a channel.
type slackish struct{ recorder }

func (s *slackish) Capabilities() api.NotifyCapabilities {
	return api.NotifyCapabilities{Audience: api.AudienceChannel, Channels: true, Authorized: true}
}

// TestR367_ASubscriptionToSlackNamesItsChannel asserts the channel rule: an
// adapter that posts where each subscription chooses needs a channel, and one
// that posts to one place refuses any.
func TestR367_ASubscriptionToSlackNamesItsChannel(t *testing.T) {
	takes := api.NotifyCapabilities{Audience: api.AudienceChannel, Channels: true}
	fixed := api.NotifyCapabilities{Audience: api.AudienceChannel}

	got, err := checkChannel("ntf_slack", " C1 ", takes)
	require.NoError(t, err)
	require.Equal(t, "C1", got)
	_, err = checkChannel("ntf_slack", "", takes)
	require.ErrorContains(t, err, "chooses none")
	_, err = checkChannel("ntf_teams", "C1", fixed)
	require.ErrorContains(t, err, "cannot choose a channel")
	_, err = checkChannel("ntf_slack", strings.Repeat("c", 201), takes)
	require.Equal(t, errs.ValidInvalid, errs.CodeOf(err))
	got, err = checkChannel("ntf_teams", "", fixed)
	require.NoError(t, err)
	require.Empty(t, got)
}

// TestR374_AnEventIsPostedToTheSubscriptionsChannel asserts the dispatcher
// hands the adapter the channel the subscription chose, built through
// Notifiers rather than the startup registry, and says plainly when the
// adapter cannot send.
func TestR374_AnEventIsPostedToTheSubscriptionsChannel(t *testing.T) {
	slack := &slackish{recorder{kind: "slack", audience: api.AudienceChannel}}
	d := &Dispatcher{Notifiers: channels{"ntf_slack": slack}}
	sub := state.Subscription{ID: "sub_1", Destination: state.DestinationNotify, AdapterID: "ntf_slack", Channel: "C1"}
	res := d.notify(context.Background(), sub, state.Event{ID: "evt_1", Name: "deploy.finished"}, nil)
	require.NoError(t, res.Err)
	require.Len(t, slack.got, 1)
	require.Equal(t, "C1", slack.got[0].Channel)

	sub.AdapterID = "ntf_gone"
	res = d.notify(context.Background(), sub, state.Event{ID: "evt_2", Name: "deploy.finished"}, nil)
	require.ErrorContains(t, res.Err, "cannot send")

	res = (&Dispatcher{}).notify(context.Background(), sub, state.Event{ID: "evt_3"}, nil)
	require.ErrorContains(t, res.Err, "no notification adapters")
}

// TestR373_PandosOwnNotificationsNeverReachAChannelThroughNotifiers asserts
// the router reads the live adapters and still sends only to those that
// reach people.
func TestR373_PandosOwnNotificationsNeverReachAChannelThroughNotifiers(t *testing.T) {
	console := &recorder{kind: "console", audience: api.AudiencePeople}
	slack := &slackish{recorder{kind: "slack", audience: api.AudienceChannel}}
	router := Router{Notifiers: channels{"ntf_console": console, "ntf_slack": slack}, Preferences: prefs{}}
	require.NoError(t, router.Notify(context.Background(), api.Notification{
		Kind: api.NotifyAppFailed, Subject: "notes failed", Recipients: []api.Recipient{{UserID: "usr_1"}},
	}))
	require.Len(t, console.got, 1)
	require.Empty(t, slack.got)

	s := &Service{Notifiers: channels{"ntf_console": console, "ntf_slack": slack}}
	dests := s.Destinations(context.Background())
	require.Len(t, dests, 2)
	for _, d := range dests {
		require.Equal(t, d.ID == "ntf_slack", d.Channels, d.ID)
	}
	require.Equal(t, []Channel{{ID: "ntf_console", Kind: "console"}}, s.channels(context.Background()))
}

// TestAChannelBelongsToItsAdapter asserts changing a subscription's adapter
// drops the channel it had for the old one: a Slack channel means nothing to
// another adapter, and one that takes none would refuse it.
func TestAChannelBelongsToItsAdapter(t *testing.T) {
	slack := &slackish{recorder{kind: "slack", audience: api.AudienceChannel}}
	teams := &recorder{kind: "teams", audience: api.AudienceChannel}
	s := &Service{Notifiers: channels{"ntf_slack": slack, "ntf_other": &slackish{}, "ntf_teams": teams}}
	sub := state.Subscription{Destination: state.DestinationNotify, AdapterID: "ntf_slack", Channel: "C1"}
	move := func(req UpdateRequest) (state.SubscriptionPatch, error) {
		var patch state.SubscriptionPatch
		err := s.retarget(context.Background(), sub, req, &patch, map[string]any{})
		return patch, err
	}
	str := func(v string) *string { return &v }

	patch, err := move(UpdateRequest{AdapterID: str("ntf_teams")})
	require.NoError(t, err, "moving to an adapter that takes no channel leaves the old one behind")
	require.Empty(t, *patch.Channel)

	_, err = move(UpdateRequest{AdapterID: str("ntf_other")})
	require.ErrorContains(t, err, "chooses none", "another workspace starts with no channel")
	patch, err = move(UpdateRequest{AdapterID: str("ntf_other"), Channel: str("C9")})
	require.NoError(t, err)
	require.Equal(t, "C9", *patch.Channel)

	patch, err = move(UpdateRequest{Description: str("same adapter")})
	require.NoError(t, err)
	require.Equal(t, "C1", *patch.Channel, "the same adapter keeps its channel")

	err = s.retarget(context.Background(), state.Subscription{Destination: state.DestinationWebhook}, UpdateRequest{Channel: str("C1")},
		&state.SubscriptionPatch{}, map[string]any{})
	require.ErrorContains(t, err, "is a webhook")
}
