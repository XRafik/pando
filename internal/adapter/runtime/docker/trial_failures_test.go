package docker

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"github.com/moby/moby/api/types/container"
	"github.com/moby/moby/api/types/network"
	"github.com/stretchr/testify/require"

	"github.com/trypando/pando/internal/adapter/api"
	"github.com/trypando/pando/internal/errs"
)

// failCreatingNetwork makes the world refuse to create a network whose name
// ends in suffix, and create every other one as before.
func failCreatingNetwork(w *world, suffix string) {
	w.f.on("POST /networks/create", func(rw http.ResponseWriter, r *http.Request) {
		var req network.CreateRequest
		require.NoError(w.t, json.NewDecoder(r.Body).Decode(&req))
		if strings.HasSuffix(req.Name, suffix) {
			writeJSON(rw, http.StatusInternalServerError, map[string]string{"message": "refused"})
			return
		}
		w.mu.Lock()
		defer w.mu.Unlock()
		n := &fakeNet{ID: w.id("net"), Name: req.Name, Internal: req.Internal, Labels: req.Labels, Members: map[string]bool{}}
		w.nets[n.ID] = n
		writeJSON(rw, http.StatusCreated, map[string]string{"Id": n.ID})
	})
}

// TestR097_ATrialWhoseContainmentCannotBeBuiltLeavesNothingBehind asserts
// that a restricted trial whose network or gateway the daemon refuses fails,
// and removes what it had made: a trial is never run without its rules.
func TestR097_ATrialWhoseContainmentCannotBeBuiltLeavesNothingBehind(t *testing.T) {
	cfg := map[string]any{"egress_gateway_image": "pando:test", "network_pool": "off"}
	req := api.TrialRequest{TrialID: "tf", Egress: allowStripe}

	t.Run("the trial's network", func(t *testing.T) {
		w, a := newWorld(t, cfg)
		failCreatingNetwork(w, "pando-trial-tf")
		_, _, _, err := a.trialNetwork(context.Background(), req)
		require.Equal(t, errs.AdapterFailed, errs.CodeOf(err))
		require.Empty(t, w.networkNames())
	})

	t.Run("the gateway's outbound network", func(t *testing.T) {
		w, a := newWorld(t, cfg)
		failCreatingNetwork(w, "-outbound")
		_, _, _, err := a.trialNetwork(context.Background(), req)
		require.Error(t, err)
		require.Empty(t, w.networkNames(), "the trial's network goes too")
		require.Empty(t, w.containerNames())
	})

	t.Run("the gateway", func(t *testing.T) {
		w, a := newWorld(t, cfg)
		w.f.on("POST /containers/create", respond(http.StatusInternalServerError, map[string]string{"message": "refused"}))
		_, _, _, err := a.trialNetwork(context.Background(), req)
		require.Equal(t, errs.AdapterFailed, errs.CodeOf(err))
		require.Empty(t, w.networkNames(), "both networks go")
	})
}

// TestR187_AGatewayThatCannotBeStartedIsAnError asserts that each step of
// starting an egress gateway that the daemon refuses is reported, never
// taken for a gateway that runs.
func TestR187_AGatewayThatCannotBeStartedIsAnError(t *testing.T) {
	launch := gatewayLaunch{
		name: "pando-trial-g-egress", img: gatewayImage{ref: "pando:test", binary: "/pando"}, rules: "{}",
		internalName: "pando-trial-g", internalID: "net-in", outboundID: "net-out",
		restart: container.RestartPolicyDisabled,
	}
	created := func(rw http.ResponseWriter, _ *http.Request) {
		writeJSON(rw, http.StatusCreated, map[string]string{"Id": "gw1"})
	}

	t.Run("create", func(t *testing.T) {
		f, a := newFakeDaemon(t, nil)
		f.on("GET /images/*", respond(http.StatusOK, map[string]any{"Id": "sha256:img"}))
		f.on("POST /containers/create", respond(http.StatusInternalServerError, map[string]string{"message": "refused"}))
		_, err := a.startGateway(context.Background(), launch)
		require.Equal(t, errs.AdapterFailed, errs.CodeOf(err))
	})

	t.Run("connect", func(t *testing.T) {
		f, a := newFakeDaemon(t, nil)
		f.on("GET /images/*", respond(http.StatusOK, map[string]any{"Id": "sha256:img"}))
		f.on("POST /containers/create", created)
		f.on("POST /networks/*", respond(http.StatusInternalServerError, map[string]string{"message": "refused"}))
		f.on("DELETE /containers/*", func(rw http.ResponseWriter, _ *http.Request) { rw.WriteHeader(http.StatusNoContent) })
		_, err := a.startGateway(context.Background(), launch)
		require.Equal(t, errs.AdapterFailed, errs.CodeOf(err))
		require.Equal(t, 1, f.called("DELETE /containers/gw1"), "the half-made gateway is removed")
	})

	t.Run("start", func(t *testing.T) {
		f, a := newFakeDaemon(t, nil)
		f.on("GET /images/*", respond(http.StatusOK, map[string]any{"Id": "sha256:img"}))
		f.on("POST /containers/create", created)
		f.on("POST /networks/*", func(rw http.ResponseWriter, _ *http.Request) { rw.WriteHeader(http.StatusOK) })
		f.on("POST /containers/gw1/start", respond(http.StatusInternalServerError, map[string]string{"message": "refused"}))
		id, err := a.startGateway(context.Background(), launch)
		require.Equal(t, errs.AdapterFailed, errs.CodeOf(err))
		require.Equal(t, "gw1", id, "returned so the caller removes it")
	})
}

// TestR187_AnExistingGatewayIsKeptOnlyWhenItMatches asserts that a gateway
// already there is started and kept when it enforces the same rules, and that
// one which cannot be read or started is an error.
func TestR187_AnExistingGatewayIsKeptOnlyWhenItMatches(t *testing.T) {
	inspect := respond(http.StatusOK, map[string]any{
		"Id": "gw1", "Config": map[string]any{"Labels": map[string]string{labelEgressDigest: "d1"}},
		"State": map[string]any{"Running": false},
	})
	ctx := context.Background()

	t.Run("running and matching", func(t *testing.T) {
		f, a := newFakeDaemon(t, nil)
		f.on("GET /containers/*", inspect)
		kept, err := a.keepGateway(ctx, "gw1", "running", "b1", "d1")
		require.NoError(t, err)
		require.True(t, kept)
		require.Zero(t, f.called("POST /containers/gw1/start"))
	})

	t.Run("stopped and matching", func(t *testing.T) {
		f, a := newFakeDaemon(t, nil)
		f.on("GET /containers/*", inspect)
		f.on("POST /containers/gw1/start", func(rw http.ResponseWriter, _ *http.Request) { rw.WriteHeader(http.StatusNoContent) })
		kept, err := a.keepGateway(ctx, "gw1", "exited", "b1", "d1")
		require.NoError(t, err)
		require.True(t, kept)
		require.Equal(t, 1, f.called("POST /containers/gw1/start"))
	})

	t.Run("cannot be started", func(t *testing.T) {
		f, a := newFakeDaemon(t, nil)
		f.on("GET /containers/*", inspect)
		f.on("POST /containers/gw1/start", respond(http.StatusInternalServerError, map[string]string{"message": "refused"}))
		_, err := a.keepGateway(ctx, "gw1", "exited", "b1", "d1")
		require.Equal(t, errs.AdapterFailed, errs.CodeOf(err))
	})

	t.Run("cannot be read", func(t *testing.T) {
		_, a := newFakeDaemon(t, nil)
		_, err := a.keepGateway(ctx, "gw1", "running", "b1", "d1")
		require.Error(t, err)
	})

	t.Run("stale", func(t *testing.T) {
		f, a := newFakeDaemon(t, nil)
		f.on("GET /containers/*", inspect)
		f.on("DELETE /containers/*", func(rw http.ResponseWriter, _ *http.Request) { rw.WriteHeader(http.StatusNoContent) })
		kept, err := a.keepGateway(ctx, "gw1", "running", "b1", "other")
		require.NoError(t, err)
		require.False(t, kept)
		require.Equal(t, 1, f.called("DELETE /containers/gw1"))
	})
}
