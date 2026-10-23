package detect

import (
	"context"

	"github.com/trypando/pando/internal/adapter/api"
)

type trialEgressKey struct{}

// WithTrialEgress returns a context whose trial runs are held to rules: the
// egress the app would run with, resolved by core against host policy (R-097,
// R-182). A context and not a field on Job for the reason WithBuild is: one Job
// serves every app, and the rules are the app's own.
//
// A context without rules restricts nothing, and a trial runs as an
// unrestricted app does.
func WithTrialEgress(ctx context.Context, rules api.EgressRules) context.Context {
	return context.WithValue(ctx, trialEgressKey{}, rules)
}

// TrialEgressOf is the rules WithTrialEgress put in ctx; zero where it put none.
func TrialEgressOf(ctx context.Context) api.EgressRules {
	rules, _ := ctx.Value(trialEgressKey{}).(api.EgressRules)
	return rules
}
