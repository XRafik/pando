package cli_test

import (
	"testing"

	"github.com/stretchr/testify/require"
)

// TestR143a_TheCLIChecksForANewerImage asserts R-143a from the CLI: the check
// says what it found and writes nothing.
func TestR143a_TheCLIChecksForANewerImage(t *testing.T) {
	api := newAPI(t).reply("GET /apps/app_1/image-update", map[string]any{
		"image": "ghcr.io/acme/web:latest", "current_digest": "sha256:" + "a1a1a1a1a1a1a1a1",
		"latest_digest": "sha256:" + "b2b2b2b2b2b2b2b2", "update_available": true, "revision": 3,
	})

	got := run(t, api, "", "app", "image-update", "app_1")
	require.NoError(t, got.err, got.errOut)
	require.Contains(t, got.out, "A newer build of ghcr.io/acme/web:latest is available (b2b2b2b2b2b2).")
	require.Len(t, api.calls, 1, "a check writes nothing")
}

// The upgrade sends the digest the check found, so it ships that build and no later one.
func TestR143a_TheCLIUpgradesToTheBuildItChecked(t *testing.T) {
	api := newAPI(t).
		reply("GET /apps/app_1/image-update", map[string]any{
			"image": "ghcr.io/acme/web:latest", "latest_digest": "sha256:b2", "update_available": true,
		}).
		reply("POST /apps/app_1/image-update", map[string]any{"id": "dep_1", "status": "pending"})

	got := run(t, api, "", "app", "image-update", "app_1", "--upgrade")
	require.NoError(t, got.err, got.errOut)
	require.JSONEq(t, `{"digest":"sha256:b2"}`, api.bodyFor("POST /apps/app_1/image-update"))
	require.Contains(t, got.out, "Upgrading")
}

// With nothing newer, --upgrade says so and sends nothing.
func TestR143a_TheCLIHasNothingToUpgradeTo(t *testing.T) {
	api := newAPI(t).reply("GET /apps/app_1/image-update", map[string]any{
		"image": "ghcr.io/acme/web:latest", "latest_digest": "sha256:a1", "current_digest": "sha256:a1",
	})

	got := run(t, api, "", "app", "image-update", "app_1", "--upgrade")
	require.NoError(t, got.err, got.errOut)
	require.Contains(t, got.out, "ghcr.io/acme/web:latest is up to date.")
	require.Len(t, api.calls, 1, "nothing is upgraded")
}
