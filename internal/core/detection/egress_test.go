package detection

import (
	"context"
	"errors"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/trypando/pando/internal/adapter/api"
	"github.com/trypando/pando/internal/core/spec"
	"github.com/trypando/pando/internal/core/state"
	"github.com/trypando/pando/internal/detect"
	"github.com/trypando/pando/internal/egress"
)

type fakeTrialEgress struct {
	rules api.EgressRules
	err   error
	asked *spec.AppSpec
	calls int
}

func (f *fakeTrialEgress) TrialEgress(_ context.Context, s *spec.AppSpec) (api.EgressRules, error) {
	f.calls++
	f.asked = s
	return f.rules, f.err
}

// TestR097_DetectionHoldsTheTrialToTheAppsEgress asserts that detection
// resolves the rules the trial runs under before it runs anything, and that
// a rule set it cannot read stops the detection rather than run the app's
// code with no rules.
func TestR097_DetectionHoldsTheTrialToTheAppsEgress(t *testing.T) {
	allow := egress.Rules{Layers: []egress.Layer{{Mode: egress.Allowlist, From: "install", List: []string{"api.github.com"}}}}
	resolver := &fakeTrialEgress{rules: allow}
	r := &Runner{Egress: resolver}

	ctx, err := r.withTrialEgress(context.Background(), state.App{ID: "app_1"})
	require.NoError(t, err)
	require.Equal(t, allow, detect.TrialEgressOf(ctx))
	require.Equal(t, 1, resolver.calls)
	require.Nil(t, resolver.asked, "an app with no spec yet is tried under the installation's rules")

	resolver.err = errors.New("policy unreadable")
	_, err = r.withTrialEgress(context.Background(), state.App{ID: "app_1"})
	require.Error(t, err)

	// No resolver configured: nothing is restricted, as before.
	ctx, err = (&Runner{}).withTrialEgress(context.Background(), state.App{ID: "app_1"})
	require.NoError(t, err)
	require.False(t, detect.TrialEgressOf(ctx).Restricted())
}
