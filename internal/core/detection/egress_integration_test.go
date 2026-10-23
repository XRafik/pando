//go:build integration

package detection_test

import (
	"context"
	"testing"

	"github.com/stretchr/testify/require"

	adapterapi "github.com/trypando/pando/internal/adapter/api"
	corepolicy "github.com/trypando/pando/internal/core/policy"
	"github.com/trypando/pando/internal/core/spec"
	"github.com/trypando/pando/internal/core/state"
)

// recordingEgress records the spec detection resolved the trial's rules from.
type recordingEgress struct{ asked *spec.AppSpec }

func (r *recordingEgress) TrialEgress(_ context.Context, s *spec.AppSpec) (adapterapi.EgressRules, error) {
	r.asked = s
	return adapterapi.EgressRules{}, nil
}

// TestR097_ReDetectionResolvesTheTrialsEgressFromTheCurrentSpec asserts that
// an app that already has a spec is tried under that spec's egress, not only
// the installation's: a tightening its owner made still holds (R-097).
func TestR097_ReDetectionResolvesTheTrialsEgressFromTheCurrentSpec(t *testing.T) {
	t.Parallel()
	db := connected(t)
	ctx := context.Background()

	repo := repoWith(t, map[string]string{"Dockerfile": "FROM nginx:alpine\nEXPOSE 8080\n"})
	src := spec.Source{Type: spec.SourceGit, URL: repo}
	appID := appFrom(t, db, src)

	apps := state.NewApps(db)
	current := &spec.AppSpec{
		SchemaVersion: spec.SchemaVersion,
		Source:        src,
		Build:         spec.Build{Strategy: spec.BuildDockerfile, AdapterRef: "bld_buildkit"},
		Workloads:     []spec.Workload{{Name: "web", Primary: true, Exposed: true}},
		Routing:       spec.Routing{AdapterRef: "rte_loopback", Mode: spec.RoutingPort, Port: 8080},
		Runtime:       spec.RuntimeRef{AdapterRef: "rt_docker", IsolationFloor: spec.IsolationContainer},
		Deploy:        spec.Deploy{Strategy: spec.DeployRecreate},
		Egress:        spec.Egress{Remove: []string{"api.github.com"}},
	}
	app, found, err := apps.ByID(ctx, appID)
	require.NoError(t, err)
	require.True(t, found)
	rev, err := apps.CreateRevision(ctx, appID, current, spec.OriginManual, app.OwnerUserID)
	require.NoError(t, err)
	require.NoError(t, apps.Pin(ctx, appID, rev.ID, state.StateProposed, app.OwnerUserID))

	resolver := &recordingEgress{}
	r := runnerOver(t, db, corepolicy.Static(corepolicy.Default()))
	r.Egress = resolver
	_, err = r.Detect(ctx, appID)
	require.NoError(t, err)
	require.NotNil(t, resolver.asked, "the pinned spec was read")
	require.Equal(t, current.Egress, resolver.asked.Egress)
}
