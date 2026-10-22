package docker

import (
	"context"
	"net/http"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/trypando/pando/internal/adapter/api"
)

// TestR193_AVariableThePlanDroppedRecreatesTheContainer asserts that a
// container must carry exactly the variables its plan sets: one the plan no
// longer has, a removed secret among them, is a recreate rather than a value
// left running. Variables the image itself sets do not count.
func TestR193_AVariableThePlanDroppedRecreatesTheContainer(t *testing.T) {
	w := api.WorkloadPlan{Name: "web", Image: "nginx:1"}
	matches := func(created, planned map[string]string) bool {
		t.Helper()
		labels := map[string]string{labelHardening: hardeningLevel, labelEnv: envNamesDigest(created)}
		env := []string{"PATH=/usr/bin", "NGINX_VERSION=1"}
		for k, v := range created {
			env = append(env, k+"="+v)
		}
		f, a := newFakeDaemon(t, nil)
		f.on("GET /containers/c1/json", respond(http.StatusOK, map[string]any{
			"Id": "c1", "HostConfig": map[string]any{"PidsLimit": DefaultPidsLimit},
			"Config": map[string]any{"Image": "nginx:1", "Labels": labels, "Env": env},
		}))
		ok, err := a.matchesPlan(context.Background(), "c1", w, "pando-app", planned)
		require.NoError(t, err)
		return ok
	}
	both := map[string]string{"TOKEN": "t", "DATABASE_URL": "postgres://db"}

	require.True(t, matches(both, both), "unchanged")
	require.True(t, matches(nil, nil), "no variables either way")
	require.False(t, matches(both, map[string]string{"DATABASE_URL": "postgres://db"}), "a secret removed from the plan")
	require.False(t, matches(both, nil), "every variable removed")
	require.False(t, matches(map[string]string{"TOKEN": "t"}, both), "a variable added")
	require.False(t, matches(both, map[string]string{"TOKEN": "u", "DATABASE_URL": "postgres://db"}), "a value rotated")
}

// TestR193_AContainerFromBeforeTheEnvLabelIsComparedWithItsImage asserts
// that a container created before Pando recorded which variables it set is
// judged against its image: an unchanged app is not restarted by an upgrade,
// and one holding a variable its plan has dropped is still recreated.
func TestR193_AContainerFromBeforeTheEnvLabelIsComparedWithItsImage(t *testing.T) {
	matches := func(containerEnv []string, image any, planned map[string]string) bool {
		t.Helper()
		f, a := newFakeDaemon(t, nil)
		f.on("GET /containers/c1/json", respond(http.StatusOK, map[string]any{
			"Id": "c1", "HostConfig": map[string]any{"PidsLimit": DefaultPidsLimit},
			"Config": map[string]any{
				"Image": "nginx:1", "Labels": map[string]string{labelHardening: hardeningLevel}, "Env": containerEnv,
			},
		}))
		if image == nil {
			f.on("GET /images/nginx:1/json", respond(http.StatusNotFound, map[string]string{"message": "no such image"}))
		} else {
			f.on("GET /images/nginx:1/json", respond(http.StatusOK, image))
		}
		ok, err := a.matchesPlan(context.Background(), "c1", api.WorkloadPlan{Name: "web", Image: "nginx:1"}, "pando-app", planned)
		require.NoError(t, err)
		return ok
	}
	image := map[string]any{"Id": "sha256:n", "Config": map[string]any{"Env": []string{"NGINX_VERSION=1", "PORT=80"}}}
	plan := map[string]string{"TOKEN": "t"}

	require.True(t, matches([]string{"PATH=/bin", "NGINX_VERSION=1", "PORT=80", "TOKEN=t"}, image, plan),
		"unchanged: the image's variables and the plan's")
	require.False(t, matches([]string{"NGINX_VERSION=1", "PORT=80", "TOKEN=t", "OLD_SECRET=s"}, image, plan),
		"a variable neither the plan nor the image sets")
	require.False(t, matches([]string{"NGINX_VERSION=1", "PORT=8080", "TOKEN=t"}, image, plan),
		"the plan overrode an image variable and no longer does")
	require.False(t, matches([]string{"TOKEN=t"}, nil, plan), "the image cannot be read")
}

// TestR194_TheEnvLabelHoldsNoValue asserts that the label naming a
// container's variables is computed from names alone: anyone who can list
// containers can read it, and the values are resolved secrets.
func TestR194_TheEnvLabelHoldsNoValue(t *testing.T) {
	require.Equal(t,
		envNamesDigest(map[string]string{"TOKEN": "one"}),
		envNamesDigest(map[string]string{"TOKEN": "two"}))
	require.NotEqual(t,
		envNamesDigest(map[string]string{"TOKEN": "one"}),
		envNamesDigest(map[string]string{"TOKEN": "one", "OTHER": "x"}))
	require.Empty(t, envNamesDigest(nil))
}
