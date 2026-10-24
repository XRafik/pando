package audit

import (
	"slices"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
)

// TestR379_AnEventReadsAsASentence asserts R-379's summary: an event reads as a
// plain sentence naming its app and target, and as its action when Pando has
// no wording for it or does not know a name the wording needs.
func TestR379_AnEventReadsAsASentence(t *testing.T) {
	for _, c := range []struct {
		name string
		rec  Record
		want string
	}{
		{"an app event names the app", Record{Action: "app.deploy", AppID: "app_1", AppName: "crewmate"}, "Deployed crewmate"},
		{"an app target names it too", Record{Action: "app.delete", TargetKind: "app", TargetID: "app_1", TargetName: "crewmate"}, "Deleted crewmate"},
		{"a named target", Record{Action: "adapter.configure", TargetKind: "adapter", TargetID: "slack", TargetName: "Slack"}, "Configured Slack"},
		{"a target without a name reads as its ID", Record{Action: "subscription.create", TargetKind: "subscription", TargetID: "sub_1"}, "Created subscription sub_1"},
		{"no name needed", Record{Action: "policy.update"}, "Changed policy"},
		{"an app no longer there", Record{Action: "app.deploy", AppID: "app_gone"}, "app.deploy"},
		{"an action with no wording", Record{Action: "something.new"}, "something.new"},
	} {
		t.Run(c.name, func(t *testing.T) {
			assert.Equal(t, c.want, Summarize(c.rec))
		})
	}
}

// Every worded action is one Pando writes, so a renamed action cannot leave its
// wording behind under the old name, and every sentence starts with a capital
// or with a name.
func TestEverySummaryIsACataloguedAction(t *testing.T) {
	for action, text := range summaries {
		assert.True(t, slices.Contains(Actions, action), "%s is worded but not in Actions", action)
		first := text[:1]
		assert.True(t, strings.HasPrefix(text, "{") || first == strings.ToUpper(first), "%s: %q", action, text)
		assert.False(t, strings.HasSuffix(text, "."), "%s: a summary is a phrase, without a full stop", action)
	}
}

func TestValidOutcome(t *testing.T) {
	for _, s := range []string{"", "success", "denied", "failed"} {
		assert.True(t, ValidOutcome(s), s)
	}
	assert.False(t, ValidOutcome("ok"))
}
