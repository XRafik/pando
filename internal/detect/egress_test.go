package detect_test

import (
	"context"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/trypando/pando/internal/adapter/api"
	"github.com/trypando/pando/internal/core/spec"
	"github.com/trypando/pando/internal/detect"
	"github.com/trypando/pando/internal/egress"
)

// TestR097_ATrialCarriesTheAppsEgressRules asserts R-097 as amended: the
// trial is asked to run under the egress rules core resolved for the app, and
// with none in the context it runs as it always has, unrestricted.
func TestR097_ATrialCarriesTheAppsEgressRules(t *testing.T) {
	allow := egress.Rules{Layers: []egress.Layer{{Mode: egress.Allowlist, From: "install", List: []string{"api.github.com"}}}}
	caps := probing()
	caps.SupportsEgressRestriction = true

	var got []api.TrialRequest
	job := &detect.Job{Auction: detect.NewAuction(), Runtime: trialResults{caps: caps,
		results: func(req api.TrialRequest) api.TrialResult {
			got = append(got, req)
			return api.TrialResult{Started: true, ObservedPorts: []int{8080}}
		}}}
	src := spec.Source{Type: spec.SourceImage, Image: "example/web:1"}

	_, err := job.Run(detect.WithTrialEgress(context.Background(), allow), "app_1", src, nil)
	require.NoError(t, err)
	require.NotEmpty(t, got)
	require.Equal(t, allow, got[0].Egress)

	got = nil
	_, err = job.Run(context.Background(), "app_1", src, nil)
	require.NoError(t, err)
	require.NotEmpty(t, got)
	require.False(t, got[0].Egress.Restricted())
}

// TestR186_ATrialIsNotRunWhereTheRuntimeCannotHoldItToItsRules asserts that a
// runtime unable to enforce restricted egress is not asked to run the trial:
// it would run unreviewed code with the rules ignored. The deploy's plan
// refuses on that runtime, and says why.
func TestR186_ATrialIsNotRunWhereTheRuntimeCannotHoldItToItsRules(t *testing.T) {
	allow := egress.Rules{Layers: []egress.Layer{{Mode: egress.Allowlist, From: "install", List: []string{"api.github.com"}}}}
	ran := false
	job := &detect.Job{Auction: detect.NewAuction(), Runtime: trialResults{caps: probing(), // no egress restriction
		results: func(api.TrialRequest) api.TrialResult {
			ran = true
			return api.TrialResult{Started: true}
		}}}
	_, err := job.Run(detect.WithTrialEgress(context.Background(), allow), "app_1",
		spec.Source{Type: spec.SourceImage, Image: "example/web:1"}, nil)
	require.NoError(t, err)
	require.False(t, ran)
}
