package kubernetes

import (
	"context"
	"testing"

	"github.com/stretchr/testify/require"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// TestR240_AnAppsPodsCannotGainPrivilegesAndKeepOnlyTheCapabilitiesTheyNeed
// asserts the Docker adapter's hardening on Kubernetes (finding 8 of the
// 2026-10-16 security assessment): no privilege escalation through a setuid
// binary, every capability dropped but the set an ordinary image starts with,
// and never NET_RAW. A process limit is the kubelet's, per node.
func TestR240_AnAppsPodsCannotGainPrivilegesAndKeepOnlyTheCapabilitiesTheyNeed(t *testing.T) {
	ctx := context.Background()
	a, cs := testAdapter(t, nil)
	_, err := a.Apply(ctx, webPlan())
	require.NoError(t, err)

	pods, err := cs.CoreV1().Pods(testNS).List(ctx, metav1.ListOptions{})
	require.NoError(t, err)
	require.NotEmpty(t, pods.Items)
	for _, p := range pods.Items {
		for _, c := range p.Spec.Containers {
			sc := c.SecurityContext
			require.NotNil(t, sc, p.Name)
			require.False(t, *sc.AllowPrivilegeEscalation, p.Name)
			require.Equal(t, []corev1.Capability{"ALL"}, sc.Capabilities.Drop, p.Name)
			require.NotContains(t, sc.Capabilities.Add, corev1.Capability("NET_RAW"), p.Name)
			require.Contains(t, sc.Capabilities.Add, corev1.Capability("NET_BIND_SERVICE"), p.Name)
		}
	}
}
