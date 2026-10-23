package deploy

import (
	"context"
	"errors"
	"io"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/trypando/pando/internal/adapter/api"
	"github.com/trypando/pando/internal/core/planner"
	"github.com/trypando/pando/internal/core/policy"
	"github.com/trypando/pando/internal/core/spec"
	"github.com/trypando/pando/internal/egress"
)

// TestR097_TheDeploysPortCheckIsHeldToTheDeploysEgress asserts R-097 as
// amended: the trial a deploy runs to check its assumed port runs under the
// rules the deploy does, and is not run on a runtime that would ignore them
// (R-186) — the assumption stands instead.
func TestR097_TheDeploysPortCheckIsHeldToTheDeploysEgress(t *testing.T) {
	ctx := context.Background()
	allow := egress.Rules{Layers: []egress.Layer{{Mode: egress.Allowlist, From: "install", List: []string{"api.github.com"}}}}
	result := api.TrialResult{Started: true, ObservedPorts: []int{5000}}

	enforcing := &trialRuntime{result: result, egress: true}
	check := checkPort(ctx, enforcing, assumedPortApp(8000), "img", "t1", allow, io.Discard)
	require.Equal(t, 5000, check.Port)
	require.Equal(t, allow, enforcing.asked.Egress)

	cannot := &trialRuntime{result: result}
	require.Equal(t, portCheck{}, checkPort(ctx, cannot, assumedPortApp(8000), "img", "t1", allow, io.Discard))
	require.Empty(t, cannot.asked.TrialID, "not asked to run it")

	t.Run("the rules come from the planner", func(t *testing.T) {
		doc := policy.Default()
		doc.EgressMode = spec.EgressAllowlist
		doc.EgressList = []string{"api.github.com"}
		r := &Runner{planner: planner.New(nil, policy.Static(doc), nil)}
		rules, known := r.trialEgress(ctx, assumedPortApp(8000))
		require.True(t, known)
		require.True(t, rules.Restricted())

		rules, known = (&Runner{}).trialEgress(ctx, assumedPortApp(8000))
		require.True(t, known)
		require.False(t, rules.Restricted())

		failing := &Runner{planner: planner.New(nil, policy.New(func(context.Context) (policy.Document, error) {
			return policy.Document{}, errors.New("unreadable")
		}), nil)}
		_, known = failing.trialEgress(ctx, assumedPortApp(8000))
		require.False(t, known, "rules that cannot be read skip the check")
	})
}
