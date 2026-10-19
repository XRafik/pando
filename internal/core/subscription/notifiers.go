package subscription

import (
	"context"

	"github.com/trypando/pando/internal/adapter/api"
	"github.com/trypando/pando/internal/core/notifyconn"
)

// Notifiers is the install's notification adapters (notifyconn.Service):
// built from their rows on each use, so one added or connected since startup
// is sent through at once.
type Notifiers interface {
	Notify(ctx context.Context, id string) (api.NotifyAdapter, bool)
	Usable(ctx context.Context) ([]notifyconn.Adapter, error)
}

// notifiersOf is n, or the adapters registered at startup in r when n is not
// set.
func notifiersOf(n Notifiers, r *api.Registry) Notifiers {
	if n != nil {
		return n
	}
	if r == nil {
		return nil
	}
	return &notifyconn.Service{Declared: r}
}
