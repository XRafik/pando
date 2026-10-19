// Package notifykit is what notify adapters share. An adapter that posts to
// one place its configuration names, with nothing to connect and no channels
// to choose, embeds Unconnected for the methods it has no use for.
package notifykit

import (
	"context"

	"github.com/trypando/pando/internal/adapter/api"
	"github.com/trypando/pando/internal/errs"
)

// Unconnected answers Channels and authorization for an adapter that takes
// neither: its configuration names the one place it posts, and it has
// nothing to connect.
type Unconnected struct {
	// Name is the adapter's provider, for messages.
	Name string
}

func (u Unconnected) Channels(context.Context, string) ([]api.NotifyChannel, error) {
	return nil, errs.Newf(errs.ValidInvalid,
		"%s posts to the one place its settings name, so there are no channels to choose.", u.Name)
}

func (u Unconnected) BeginAuthorization(context.Context, api.AuthorizationRequest) (api.Authorization, error) {
	return api.Authorization{}, u.nothing()
}

func (u Unconnected) CompleteAuthorization(context.Context, api.AuthorizationCompletion) (api.AuthorizationResult, error) {
	return api.AuthorizationResult{}, u.nothing()
}

func (u Unconnected) nothing() error {
	return errs.Newf(errs.ValidInvalid,
		"%s is set up with its settings alone; there is nothing to authorize.", u.Name)
}
