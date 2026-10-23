package docker

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"

	"github.com/moby/moby/api/types/container"
	"github.com/stretchr/testify/require"

	"github.com/trypando/pando/internal/adapter/api"
	"github.com/trypando/pando/internal/egress"
	"github.com/trypando/pando/internal/errs"
	"github.com/trypando/pando/internal/secret"
)

// TestR097_ATrialUnderRestrictedEgressLeavesOnlyThroughAGateway asserts that a
// trial run is held to the egress rules its app would run with (R-097, R-187):
// a network with no route out, a gateway on it enforcing exactly those rules,
// and the proxy variables naming it. Everything is the trial's, so it is
// removed with it.
func TestR097_ATrialUnderRestrictedEgressLeavesOnlyThroughAGateway(t *testing.T) {
	ctx := context.Background()
	w, a := newWorld(t, map[string]any{"egress_gateway_image": "pando:test", "network_pool": "off"})

	networkID, env, cleanup, err := a.trialNetwork(ctx, api.TrialRequest{
		TrialID: "t1",
		Env:     map[string]secret.Value{"NO_PROXY": secret.New("internal.example"), "MODE": secret.New("x")},
		Egress:  allowStripe,
	})
	require.NoError(t, err)

	trialNet := w.network("pando-trial-t1")
	require.NotNil(t, trialNet)
	require.Equal(t, trialNet.ID, networkID)
	require.True(t, trialNet.Internal, "no route out of the trial's network")
	require.Equal(t, "t1", trialNet.Labels[labelTrial])
	outbound := w.network("pando-trial-t1-outbound")
	require.NotNil(t, outbound)
	require.False(t, outbound.Internal)
	require.Equal(t, "t1", outbound.Labels[labelTrial], "CleanupTrials finds it")

	gw := w.container("pando-trial-t1-egress")
	require.NotNil(t, gw)
	require.True(t, gw.Running)
	require.Equal(t, "pando:test", gw.Req.Image)
	require.Equal(t, []string{gatewayAlias}, gw.Networks["pando-trial-t1"])
	require.Contains(t, gw.Networks, "pando-trial-t1-outbound")
	require.Equal(t, "t1", gw.Req.Labels[labelTrial])
	require.Empty(t, gw.Req.Labels[labelBundle], "not taken for an app's gateway")
	require.Equal(t, container.RestartPolicyDisabled, gw.Req.HostConfig.RestartPolicy.Name)
	require.True(t, gw.Req.HostConfig.ReadonlyRootfs)
	var carried egress.Rules
	require.NoError(t, json.Unmarshal([]byte(envOf(gw)["PANDO_EGRESS_RULES"]), &carried))
	require.Equal(t, allowStripe, carried, "the gateway enforces exactly the rules the trial was given")

	require.Equal(t, gatewayProxyURL, env["HTTP_PROXY"])
	require.Equal(t, gatewayProxyURL, env["https_proxy"])
	require.Equal(t, "localhost,127.0.0.1,::1,internal.example", env["NO_PROXY"])
	require.Equal(t, "x", env["MODE"])

	cleanup()
	require.Empty(t, w.networkNames(), "the trial's networks go with it")
	require.Empty(t, w.containerNames(), "and its gateway")
}

// TestR186_ATrialWithNoRestrictionRunsAsItAlwaysHas asserts that open egress,
// the default, leaves the trial as it was: the ordinary network with a route
// out, no gateway, and no proxy variables.
func TestR186_ATrialWithNoRestrictionRunsAsItAlwaysHas(t *testing.T) {
	ctx := context.Background()
	w, a := newWorld(t, map[string]any{"egress_gateway_image": "pando:test", "network_pool": "off"})

	_, env, cleanup, err := a.trialNetwork(ctx, api.TrialRequest{
		TrialID: "t2", Env: map[string]secret.Value{"PORT": secret.New("3000")},
	})
	require.NoError(t, err)
	require.Equal(t, []string{"pando-trial-t2"}, w.networkNames())
	require.False(t, w.network("pando-trial-t2").Internal)
	require.Empty(t, w.containerNames())
	require.Equal(t, map[string]string{"PORT": "3000"}, env)

	cleanup()
	require.Empty(t, w.networkNames())
}

// TestR186_ARuntimeThatCannotHoldATrialToItsRulesRefusesIt asserts that a
// trial whose rules restrict anything is refused, not run with the rules
// ignored, when the runtime has no gateway to enforce them with.
func TestR186_ARuntimeThatCannotHoldATrialToItsRulesRefusesIt(t *testing.T) {
	ctx := context.Background()
	w, a := newWorld(t, map[string]any{"proxy_container": "not-a-container", "network_pool": "off"})

	_, err := a.Trial(ctx, api.TrialRequest{TrialID: "t3", Image: "nginx:1", Egress: allowStripe})
	require.Equal(t, errs.PlanCapabilityUnsupported, errs.CodeOf(err))
	require.NotEmpty(t, errs.As(err).Remedy)
	require.Empty(t, w.networkNames(), "nothing was created")
	require.Empty(t, w.containerNames())

	t.Run("a rule the gateway could not read", func(t *testing.T) {
		w, a := newWorld(t, map[string]any{"egress_gateway_image": "pando:test", "network_pool": "off"})
		_, _, _, err := a.trialNetwork(ctx, api.TrialRequest{TrialID: "t4",
			Egress: egress.Rules{Layers: []egress.Layer{{Mode: egress.Denylist, List: []string{"not valid"}}}}})
		require.Equal(t, errs.ValidInvalid, errs.CodeOf(err))
		require.Empty(t, w.networkNames())
	})
}

// TestR097_ATrialIsHeldToMemoryAndCPULimits asserts that a trial gets a
// memory and CPU cap where the engine applies them, generous enough for a
// first start, and none where the engine would drop or refuse it.
func TestR097_ATrialIsHeldToMemoryAndCPULimits(t *testing.T) {
	both := limitSupport{known: true, cpu: true, memory: true}

	r := trialLimits(both, 8)
	require.Equal(t, int64(trialMemoryBytes), r.Memory)
	require.Equal(t, int64(4*nanoCPUsPerCPU), r.NanoCPUs, "half the host")

	require.Equal(t, int64(2*nanoCPUsPerCPU), trialLimits(both, 3).NanoCPUs, "never fewer than two")
	require.Equal(t, int64(nanoCPUsPerCPU), trialLimits(both, 1).NanoCPUs, "never more than the host has")
	require.Zero(t, trialLimits(both, 0).NanoCPUs, "a host that does not say")

	none := trialLimits(limitSupport{known: true}, 8)
	require.Zero(t, none.Memory, "an engine that would drop the limit is not given one")
	require.Zero(t, none.NanoCPUs)

	t.Run("on the trial's container", func(t *testing.T) {
		f, a := newFakeDaemon(t, nil)
		recordCreates(f, false) // the calls around a create; the create is answered below
		f.on("GET /info", respond(http.StatusOK, map[string]any{
			"NCPU": 8, "MemoryLimit": true, "CpuCfsQuota": true, "CpuCfsPeriod": true, "CgroupDriver": "systemd",
		}))
		var body struct{ HostConfig container.HostConfig }
		f.on("POST /containers/create", func(rw http.ResponseWriter, r *http.Request) {
			_ = json.NewDecoder(r.Body).Decode(&body)
			writeJSON(rw, http.StatusCreated, map[string]any{"Id": "c1"})
		})
		_, err := a.startTrialContainer(context.Background(), api.TrialRequest{TrialID: "t5", Image: "example:1"}, "net1", nil)
		require.NoError(t, err)
		require.Equal(t, int64(trialMemoryBytes), body.HostConfig.Memory)
		require.Equal(t, int64(4*nanoCPUsPerCPU), body.HostConfig.NanoCPUs)
	})

	t.Run("an engine that cannot say", func(t *testing.T) {
		f, a := newFakeDaemon(t, nil)
		f.on("GET /info", respond(http.StatusInternalServerError, map[string]string{"message": "down"}))
		require.Equal(t, container.Resources{}, a.trialResources(context.Background()))
	})
}
