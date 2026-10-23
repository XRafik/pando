package oci_test

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/trypando/pando/internal/core/oci"
	"github.com/trypando/pando/internal/errs"
)

// TestR092_ARegistryCannotRedirectARead asserts R-092 for a published image:
// its registry is read under the guard a repository fetch is, on every
// connection, so a registry that answers with a redirect to the cloud
// metadata service — directly, or written as NAT64 — gets nowhere, and the
// refusal says why.
func TestR092_ARegistryCannotRedirectARead(t *testing.T) {
	for _, to := range []string{"http://169.254.169.254/latest/meta-data", "http://[64:ff9b::a9fe:a9fe]/latest"} {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			http.Redirect(w, r, to, http.StatusTemporaryRedirect)
		}))
		t.Cleanup(srv.Close)
		host, in := strings.TrimPrefix(srv.URL, "http://"), oci.Inspector{Insecure: true}

		ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
		_, err := in.Inspect(ctx, host+"/acme/web:1.4", nil, amd64)
		cancel()
		require.Error(t, err, to)
		require.Equal(t, errs.ValidInvalid, errs.CodeOf(err), "%s: %v", to, err)
		require.Contains(t, err.Error(), "link-local", to)
		require.NotEmpty(t, errs.As(err).Remedy)
	}
}

// TestR092_ARegistryOnThisMachineIsStillRead asserts that the guard leaves a
// registry on the private network or this machine readable, as it leaves a
// repository there: the install's own registry is one.
func TestR092_ARegistryOnThisMachineIsStillRead(t *testing.T) {
	host, in := serve(t)
	push(t, host+"/acme/web:1.4", image(t, amd64))
	_, err := in.Inspect(context.Background(), host+"/acme/web:1.4", nil, amd64)
	require.NoError(t, err)
}
