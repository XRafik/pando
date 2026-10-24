package observe

import (
	"context"

	"github.com/trypando/pando/internal/core/state"
)

// Which dependency each service Pando runs for an app fills (R-131's
// provisioned services), so a reader is told it is the app's PostgreSQL where
// the runtime names a handle such as svc-01h….

// ServiceInstances lists the services Pando has provisioned for an app.
type ServiceInstances interface {
	ForApp(ctx context.Context, appID string) ([]state.ServiceInstance, error)
}

// Dependency is the slot a provisioned workload fills.
type Dependency struct {
	SlotKey string
	Type    string
}

// Provided says which of workloads — names the app's spec does not declare,
// so none of the app's own — are services Pando runs for it, and the
// dependency each fills. A workload is matched on the handle Pando recorded
// when it provisioned the service, not on any runtime's naming. A nil lookup,
// or one that fails, names nothing: the names are a label, and a status
// answers without them.
func Provided(ctx context.Context, lookup ServiceInstances, appID string, workloads []string) map[string]Dependency {
	if lookup == nil || len(workloads) == 0 {
		return nil
	}
	services, err := lookup.ForApp(ctx, appID)
	if err != nil {
		return nil
	}
	wanted := make(map[string]bool, len(workloads))
	for _, w := range workloads {
		wanted[w] = true
	}
	out := make(map[string]Dependency)
	for _, svc := range services {
		if wanted[svc.Handle] {
			out[svc.Handle] = Dependency{SlotKey: svc.SlotKey, Type: string(svc.SlotType)}
		}
	}
	return out
}
