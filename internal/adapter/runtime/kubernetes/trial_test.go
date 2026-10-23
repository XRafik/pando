package kubernetes

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
	corev1 "k8s.io/api/core/v1"
	networkingv1 "k8s.io/api/networking/v1"
	nodev1 "k8s.io/api/node/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes/fake"
	"k8s.io/client-go/tools/remotecommand"

	"github.com/trypando/pando/internal/adapter/api"
	"github.com/trypando/pando/internal/egress"
	"github.com/trypando/pando/internal/errs"
	"github.com/trypando/pando/internal/secret"
)

// trialKubelet gives the trial pod in ns the status status, once, and
// records the pod as created.
func trialKubelet(t *testing.T, cs *fake.Clientset, ns string, status corev1.PodStatus) func() *corev1.Pod {
	t.Helper()
	var (
		mu  sync.Mutex
		got *corev1.Pod
	)
	stop := make(chan struct{})
	t.Cleanup(func() { close(stop) })
	go func() {
		ctx := context.Background()
		for {
			select {
			case <-stop:
				return
			case <-time.After(2 * time.Millisecond):
			}
			p, err := cs.CoreV1().Pods(ns).Get(ctx, "trial", metav1.GetOptions{})
			if err != nil || p.Status.Phase != "" {
				continue
			}
			mu.Lock()
			got = p.DeepCopy()
			mu.Unlock()
			p.Status = status
			_, _ = cs.CoreV1().Pods(ns).UpdateStatus(ctx, p, metav1.UpdateOptions{})
		}
	}()
	return func() *corev1.Pod {
		mu.Lock()
		defer mu.Unlock()
		return got
	}
}

// TestR097_ATrialThatExitsReportsItsCodeAndLog asserts the trial of an app
// that exits: its exit code and log are reported (the log to the sink too),
// its environment is a Secret rather than the pod spec, a private image is
// pulled with the credential given, declared storage paths are writable, the
// runtime class applies, and the namespace goes afterwards.
func TestR097_ATrialThatExitsReportsItsCodeAndLog(t *testing.T) {
	ctx := context.Background()
	gvisor := &nodev1.RuntimeClass{ObjectMeta: metav1.ObjectMeta{Name: "gvisor"}, Handler: "runsc"}
	a, cs := testAdapter(t, func(c *Config) { c.RuntimeClass = "gvisor" }, gvisor)
	id := "trl_" + strings.Repeat("x", 70)
	ns := strings.TrimRight(("pando-trial-" + toLabel(id))[:63], "-")
	created := trialKubelet(t, cs, ns, exited(1))

	var sink bytes.Buffer
	result, err := a.Trial(ctx, api.TrialRequest{
		TrialID: id, Image: "ghcr.io/example/private:1", Timeout: 5 * time.Second,
		Env:           map[string]secret.Value{"API_KEY": secret.New("hunter2")},
		PullAuth:      &api.RegistryAuth{Registry: "ghcr.io", Username: "bot", Password: secret.New("pat")},
		DeclaredPaths: []string{"/data", "/cache"},
		LogSink:       &sink,
	})
	require.NoError(t, err)
	require.NotNil(t, result.ExitCode)
	require.Equal(t, 1, *result.ExitCode)
	require.True(t, result.Started)
	require.Equal(t, "fake logs", result.Log, "the fake clientset's log body")
	require.Equal(t, "fake logs", sink.String())

	pod := created()
	require.NotNil(t, pod)
	require.LessOrEqual(t, len(pod.Namespace), 63, "a namespace name is a DNS label")
	require.Equal(t, []corev1.LocalObjectReference{{Name: pullSecretName}}, pod.Spec.ImagePullSecrets)
	require.Equal(t, "gvisor", *pod.Spec.RuntimeClassName)
	app := pod.Spec.Containers[0]
	require.Empty(t, app.Env, "R-194: no value in the pod spec")
	require.Equal(t, "trial-env", app.EnvFrom[0].SecretRef.Name)
	require.Equal(t, []string{"/data", "/cache"}, []string{app.VolumeMounts[0].MountPath, app.VolumeMounts[1].MountPath})

	_, err = cs.CoreV1().Namespaces().Get(ctx, ns, metav1.GetOptions{})
	require.Error(t, err, "the trial's namespace is removed")
}

// TestR097_ATrialStillRunningAtTheDeadlineIsTheAppWorking asserts that an app
// that starts and is still up when time runs out is reported started with no
// exit code, and that an observer that cannot be reached leaves the ports
// unknown rather than reported as none.
func TestR097_ATrialStillRunningAtTheDeadlineIsTheAppWorking(t *testing.T) {
	a, cs := testAdapter(t, nil)
	trialKubelet(t, cs, "pando-trial-trl-2", running(true))
	a.stream = func(context.Context, string, string, string, []string, remotecommand.StreamOptions) error {
		return errors.New("the observer is not running")
	}
	result, err := a.Trial(context.Background(), api.TrialRequest{TrialID: "trl_2", Image: "example/app", Timeout: 100 * time.Millisecond})
	require.NoError(t, err)
	require.True(t, result.Started)
	require.Nil(t, result.ExitCode)
	require.Nil(t, result.ObservedPorts)
	require.Nil(t, result.LoopbackPorts)
}

// TestR097_ATrialNeedsAnIdentifier asserts the one refusal made before the
// cluster is asked.
func TestR097_ATrialNeedsAnIdentifier(t *testing.T) {
	a, cs := testAdapter(t, nil)
	_, err := a.Trial(context.Background(), api.TrialRequest{Image: "example/app"})
	require.Equal(t, errs.Internal, errs.CodeOf(err))
	namespaces, err := cs.CoreV1().Namespaces().List(context.Background(), metav1.ListOptions{})
	require.NoError(t, err)
	for _, n := range namespaces.Items {
		require.NotContains(t, n.Name, "pando-trial-")
	}
}

var trialAllowlist = egress.Rules{Layers: []egress.Layer{{Mode: egress.Allowlist, From: "install", List: []string{"api.stripe.com:443"}}}}

// TestR097_ATrialIsHeldToTheAppsSecurityAndLimits asserts that the trial's
// container gets what an app's does — no privilege escalation, the reduced
// capability set — and a memory and CPU limit with sized throwaway storage,
// and that open egress leaves its network as it was.
func TestR097_ATrialIsHeldToTheAppsSecurityAndLimits(t *testing.T) {
	ctx := context.Background()
	a, cs := testAdapter(t, nil)
	ns := "pando-trial-trl-3"
	created := trialKubelet(t, cs, ns, exited(0))

	_, err := a.Trial(ctx, api.TrialRequest{TrialID: "trl_3", Image: "example/app", Timeout: time.Second,
		DeclaredPaths: []string{"/data"}, Env: map[string]secret.Value{"PORT": secret.New("3000")}})
	require.NoError(t, err)

	pod := created()
	require.NotNil(t, pod)
	app := pod.Spec.Containers[0]
	require.Equal(t, workloadSecurity(), app.SecurityContext)
	require.Equal(t, trialResources(), app.Resources)
	require.Equal(t, "4Gi", app.Resources.Limits.Memory().String())
	require.Equal(t, "1Gi", pod.Spec.Volumes[0].EmptyDir.SizeLimit.String())

	policy, err := cs.NetworkingV1().NetworkPolicies(ns).Get(ctx, "deny-in", metav1.GetOptions{})
	require.NoError(t, err)
	require.Equal(t, []networkingv1.PolicyType{networkingv1.PolicyTypeIngress}, policy.Spec.PolicyTypes, "open egress is not restricted")
	require.Empty(t, policy.Spec.Ingress)
	_, err = cs.CoreV1().Pods(ns).Get(ctx, gatewayName, metav1.GetOptions{})
	require.Error(t, err, "no gateway")
	stored, err := cs.CoreV1().Secrets(ns).Get(ctx, "trial-env", metav1.GetOptions{})
	require.NoError(t, err)
	require.Equal(t, map[string][]byte{"PORT": []byte("3000")}, stored.Data)
}

// TestR097_ATrialUnderRestrictedEgressLeavesOnlyThroughAGateway asserts that
// a trial whose rules restrict anything reaches only its own namespace and
// cluster DNS, with a gateway there enforcing the rules and the proxy
// variables naming it (R-187).
func TestR097_ATrialUnderRestrictedEgressLeavesOnlyThroughAGateway(t *testing.T) {
	ctx := context.Background()
	a, cs := testAdapter(t, nil)
	ns := "pando-trial-trl-4"
	trialKubelet(t, cs, ns, exited(0))

	_, err := a.Trial(ctx, api.TrialRequest{TrialID: "trl_4", Image: "example/app", Timeout: time.Second, Egress: trialAllowlist})
	require.NoError(t, err)

	policy, err := cs.NetworkingV1().NetworkPolicies(ns).Get(ctx, "deny-in", metav1.GetOptions{})
	require.NoError(t, err)
	require.Contains(t, policy.Spec.PolicyTypes, networkingv1.PolicyTypeEgress)
	require.Len(t, policy.Spec.Egress, 2, "its own namespace and cluster DNS, nothing outside")
	for _, rule := range policy.Spec.Egress {
		for _, peer := range rule.To {
			require.Nil(t, peer.IPBlock, "no address outside the cluster")
		}
	}
	gwPolicy, err := cs.NetworkingV1().NetworkPolicies(ns).Get(ctx, gatewayPolicy, metav1.GetOptions{})
	require.NoError(t, err)
	require.Equal(t, roleGateway, gwPolicy.Spec.PodSelector.MatchLabels[labelRole])

	gw, err := cs.CoreV1().Pods(ns).Get(ctx, gatewayName, metav1.GetOptions{})
	require.NoError(t, err)
	var carried egress.Rules
	for _, e := range gw.Spec.Containers[0].Env {
		if e.Name == "PANDO_EGRESS_RULES" {
			require.NoError(t, json.Unmarshal([]byte(e.Value), &carried))
		}
	}
	require.Equal(t, trialAllowlist, carried)

	env, err := cs.CoreV1().Secrets(ns).Get(ctx, "trial-env", metav1.GetOptions{})
	require.NoError(t, err)
	require.Equal(t, gatewayProxyURL, string(env.Data["HTTPS_PROXY"]))
	require.Equal(t, "localhost,127.0.0.1,::1", string(env.Data["NO_PROXY"]))
}

// TestR186_ATrialThisClusterCannotHoldToItsRulesIsRefused asserts that a
// restricted trial is refused, not run with its rules ignored, where there is
// no gateway image or NetworkPolicy is not enforced.
func TestR186_ATrialThisClusterCannotHoldToItsRulesIsRefused(t *testing.T) {
	ctx := context.Background()
	noImage, cs := testAdapter(t, func(c *Config) { c.EgressGatewayImage = "" })
	_, err := noImage.Trial(ctx, api.TrialRequest{TrialID: "trl_5", Image: "example/app", Egress: trialAllowlist})
	require.Equal(t, errs.PlanCapabilityUnsupported, errs.CodeOf(err))
	namespaces, err := cs.CoreV1().Namespaces().List(ctx, metav1.ListOptions{})
	require.NoError(t, err)
	require.Empty(t, namespaces.Items, "nothing was created")

	unenforced, _ := testAdapter(t, nil)
	unenforced.canaryMu.Lock()
	unenforced.canary = canaryResult{}
	unenforced.canaryMu.Unlock()
	_, err = unenforced.Trial(ctx, api.TrialRequest{TrialID: "trl_6", Image: "example/app", Egress: trialAllowlist})
	require.Equal(t, errs.AdapterUnavailable, errs.CodeOf(err))
}
