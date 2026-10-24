package observe

import (
	"context"
	"errors"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/trypando/pando/internal/core/state"
)

// serviceRows is a ServiceInstances that answers with rows or an error.
type serviceRows struct {
	rows []state.ServiceInstance
	err  error
}

func (f serviceRows) ForApp(context.Context, string) ([]state.ServiceInstance, error) {
	return f.rows, f.err
}

// TestR261_ProvidedNamesTheServicesPandoRuns asserts that a service Pando runs
// for an app is named by the dependency it fills, matched on its recorded
// handle, and that only the workloads asked about are named.
func TestR261_ProvidedNamesTheServicesPandoRuns(t *testing.T) {
	ctx := context.Background()
	rows := serviceRows{rows: []state.ServiceInstance{
		{SlotKey: "DATABASE_URL", SlotType: "postgres", Handle: "svc-01HQ8"},
		// The app's own workload, which the caller does not ask about.
		{SlotKey: "CACHE_URL", SlotType: "redis", Handle: "app"},
	}}

	got := Provided(ctx, rows, "app_1", []string{"svc-01HQ8", "svc-gone"})
	require.Equal(t, map[string]Dependency{"svc-01HQ8": {SlotKey: "DATABASE_URL", Type: "postgres"}}, got)

	require.Nil(t, Provided(ctx, nil, "app_1", []string{"svc-01HQ8"}), "nothing wired, nothing named")
	require.Nil(t, Provided(ctx, rows, "app_1", nil), "nothing to name")
	require.Nil(t, Provided(ctx, serviceRows{err: errors.New("down")}, "app_1", []string{"svc-01HQ8"}),
		"a lookup that fails names nothing")
}
