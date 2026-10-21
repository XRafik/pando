package main

import (
	"context"
	"testing"

	"github.com/stretchr/testify/require"
	"go.uber.org/zap"

	corepolicy "github.com/trypando/pando/internal/core/policy"
	"github.com/trypando/pando/internal/core/state"
)

type defaultPolicy struct{}

func (defaultPolicy) Load(context.Context) (corepolicy.Document, error) {
	return corepolicy.Default(), nil
}

// TestR408_TheOrphanPassListensForOwnerChanges asserts the wiring the leader's
// orphan job runs with: the database store, and the database as the listener
// that makes a stop immediate.
func TestR408_TheOrphanPassListensForOwnerChanges(t *testing.T) {
	db := &state.DB{}
	p := orphanPass(db, defaultPolicy{}, nil, nil, zap.NewNop())
	require.IsType(t, &state.Orphans{}, p.Store)
	require.Same(t, db, p.Changes)
	require.NotNil(t, p.Policy)
}
