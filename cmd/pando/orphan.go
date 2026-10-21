package main

import (
	"go.uber.org/zap"

	"github.com/trypando/pando/internal/core/audit"
	"github.com/trypando/pando/internal/core/orphan"
	"github.com/trypando/pando/internal/core/state"
)

// orphanPass is the leader's job for apps none of whose owners is active
// (R-407 – R-409). It listens for changes to who owns an app, so an app stops
// when its last owner goes.
func orphanPass(db *state.DB, policy orphan.PolicyLoader, notifier orphan.Notifier, auditor *audit.Writer, logger *zap.Logger) *orphan.Pass {
	return &orphan.Pass{
		Store:    state.NewOrphans(db),
		Policy:   policy,
		Notifier: notifier,
		Auditor:  auditor,
		Changes:  db,
		Logger:   logger,
	}
}
