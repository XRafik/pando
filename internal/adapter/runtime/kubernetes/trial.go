package kubernetes

import (
	"bytes"
	"context"
	"io"
	"sort"
	"strconv"
	"strings"
	"time"

	corev1 "k8s.io/api/core/v1"
	networkingv1 "k8s.io/api/networking/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/tools/remotecommand"
	"k8s.io/utils/ptr"

	"github.com/trypando/pando/internal/adapter/api"
	"github.com/trypando/pando/internal/errs"
)

// Trial starts a workload once in a namespace of its own and reports what it
// did (R-097). An observer container in the same pod shares its network
// namespace — what the Docker adapter's sidecar joins — and reads the
// listening sockets from /proc/net/tcp, so any image is observed, one with no
// shell included. Writes are not observed: nothing like a container diff
// exists in the API (SupportsWriteObservation is false).
//
// The namespace denies every connection in, Pando's included: nothing needs to
// reach an app that is being watched. Where the rules the app would run with
// restrict anything, the trial is held to them as the app is (R-097, R-187):
// it reaches cluster DNS and its own namespace, and the outside only through
// an egress gateway in that namespace. It is removed at the end, on every path.
func (a *Adapter) Trial(ctx context.Context, req api.TrialRequest) (api.TrialResult, error) {
	if req.TrialID == "" {
		return api.TrialResult{}, errs.New(errs.Internal, "A trial run needs an identifier.")
	}
	restricted := req.Egress.Restricted()
	rules, err := a.trialEgressRules(req, restricted)
	if err != nil {
		return api.TrialResult{}, err
	}
	timeout := req.Timeout
	if timeout <= 0 {
		timeout = 60 * time.Second
	}
	ns := trialNamespace(req.TrialID)

	defer func() {
		cleanup, done := context.WithTimeout(context.WithoutCancel(ctx), 30*time.Second)
		defer done()
		_ = a.cs.CoreV1().Namespaces().Delete(cleanup, ns, metav1.DeleteOptions{})
	}()
	if err := a.prepareTrialNamespace(ctx, ns); err != nil {
		return api.TrialResult{}, err
	}

	if err := a.isolateTrial(ctx, ns, req.TrialID, restricted, rules); err != nil {
		return api.TrialResult{}, err
	}

	pullSecrets, err := a.trialSecrets(ctx, ns, req, restricted)
	if err != nil {
		return api.TrialResult{}, err
	}
	pod := a.trialPod(ns, req, pullSecrets)
	if _, err := a.cs.CoreV1().Pods(ns).Create(ctx, pod, metav1.CreateOptions{}); err != nil {
		return api.TrialResult{}, errs.Wrap(errs.AdapterFailed, "Could not start the app's trial run.", err)
	}

	result, err := a.watchTrial(ctx, ns, timeout, req.PullAuth != nil)
	if err != nil {
		return api.TrialResult{}, err
	}
	result.Log = a.trialLog(ctx, ns)
	if req.LogSink != nil && result.Log != "" {
		_, _ = io.WriteString(req.LogSink, result.Log)
	}
	return result, nil
}

// prepareTrialNamespace makes the namespace a trial runs in, binds the app
// role in it and waits for its service account.
func (a *Adapter) prepareTrialNamespace(ctx context.Context, ns string) error {
	if _, err := a.cs.CoreV1().Namespaces().Create(ctx, &corev1.Namespace{ObjectMeta: metav1.ObjectMeta{
		Name:   ns,
		Labels: map[string]string{labelManagedBy: managedBy, labelPSAEnforce: "baseline"},
	}}, metav1.CreateOptions{}); err != nil && !apierrors.IsAlreadyExists(err) {
		return errs.Wrap(errs.AdapterFailed, "Could not make a place in the cluster to try the app.", err)
	}
	if err := a.bindAppRole(ctx, ns); err != nil {
		return err
	}
	return a.awaitServiceAccount(ctx, ns)
}

// trialNamespace is the namespace a trial runs in, within the 63 characters
// a name may have.
func trialNamespace(trialID string) string {
	ns := "pando-trial-" + toLabel(trialID)
	if len(ns) > 63 {
		ns = strings.TrimRight(ns[:63], "-")
	}
	return ns
}

// trialSecrets writes the trial's environment, with the proxy variables where
// its egress is restricted, and its pull secret where the image needs one.
func (a *Adapter) trialSecrets(ctx context.Context, ns string, req api.TrialRequest, restricted bool) ([]corev1.LocalObjectReference, error) {
	var proxy map[string]string
	if restricted {
		// One pod, so NO_PROXY names only the pod itself.
		proxy = proxyEnv(api.BundlePlan{})
	}
	env := workloadEnv(api.WorkloadPlan{Env: req.Env}, proxy)
	if err := a.putSecret(ctx, &corev1.Secret{
		ObjectMeta: metav1.ObjectMeta{Name: "trial-env", Namespace: ns},
		Data:       secretData(env),
	}, "the trial's environment"); err != nil {
		return nil, err
	}
	var pullSecrets []corev1.LocalObjectReference
	if req.PullAuth != nil {
		if err := a.ensurePullSecret(ctx, ns, []api.WorkloadPlan{{Image: req.Image, PullAuth: req.PullAuth}}); err != nil {
			return nil, err
		}
		pullSecrets = []corev1.LocalObjectReference{{Name: pullSecretName}}
	}
	return pullSecrets, nil
}

// trialPod is the trial's pod: the app, held to the trial's limits and the
// workload security context, and the observer beside it.
func (a *Adapter) trialPod(ns string, req api.TrialRequest, pullSecrets []corev1.LocalObjectReference) *corev1.Pod {
	var volumes []corev1.Volume
	var mounts []corev1.VolumeMount
	for i, p := range req.DeclaredPaths {
		name := "declared-" + strconv.Itoa(i)
		volumes = append(volumes, corev1.Volume{Name: name, VolumeSource: corev1.VolumeSource{
			EmptyDir: &corev1.EmptyDirVolumeSource{SizeLimit: ptr.To(resource.MustParse(trialStorageSize))},
		}})
		mounts = append(mounts, corev1.VolumeMount{Name: name, MountPath: p})
	}
	pod := &corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{Name: "trial", Namespace: ns, Labels: map[string]string{labelManagedBy: managedBy}},
		Spec: corev1.PodSpec{
			RestartPolicy:                 corev1.RestartPolicyNever,
			AutomountServiceAccountToken:  ptr.To(false),
			EnableServiceLinks:            ptr.To(false),
			TerminationGracePeriodSeconds: ptr.To(int64(1)),
			ImagePullSecrets:              pullSecrets,
			Volumes:                       volumes,
			Containers: []corev1.Container{
				{
					Name: appContainer, Image: req.Image,
					Command: req.Entrypoint, Args: req.Command, WorkingDir: req.WorkingDir,
					EnvFrom: []corev1.EnvFromSource{{SecretRef: &corev1.SecretEnvSource{
						LocalObjectReference: corev1.LocalObjectReference{Name: "trial-env"},
					}}},
					VolumeMounts:    mounts,
					Resources:       trialResources(),
					SecurityContext: workloadSecurity(),
				},
				{Name: "observer", Image: a.config.HelperImage, Command: []string{"sleep", "3600"}},
			},
		},
	}
	if a.config.RuntimeClass != "" {
		pod.Spec.RuntimeClassName = ptr.To(a.config.RuntimeClass)
	}
	return pod
}

// trialEgressRules returns the gateway's rules for a trial whose egress is
// restricted, and refuses one this cluster cannot hold to them (R-186).
func (a *Adapter) trialEgressRules(req api.TrialRequest, restricted bool) (string, error) {
	if !restricted {
		return "", nil
	}
	if !a.canaryPassed() {
		return "", errNotEnforced()
	}
	return a.egressRules(api.BundlePlan{Network: api.NetworkPlan{Egress: req.Egress}}, true)
}

// isolateTrial writes the trial namespace's policies, and its gateway where
// egress is restricted.
//
// Unrestricted, one policy denies every connection in, as it always has.
// Restricted, that policy also admits connections from the namespace itself,
// which the trial needs to reach the gateway, and limits connections out to
// the namespace and cluster DNS; a second policy lets the gateway alone reach
// outside the cluster, as for an app (ensurePolicies).
func (a *Adapter) isolateTrial(ctx context.Context, ns, trialID string, restricted bool, rules string) error {
	deny := &networkingv1.NetworkPolicy{
		ObjectMeta: metav1.ObjectMeta{Name: "deny-in", Namespace: ns},
		Spec: networkingv1.NetworkPolicySpec{
			PodSelector: metav1.LabelSelector{},
			PolicyTypes: []networkingv1.PolicyType{networkingv1.PolicyTypeIngress},
		},
	}
	if restricted {
		sameNamespace := networkingv1.NetworkPolicyPeer{PodSelector: &metav1.LabelSelector{}}
		deny.Spec.PolicyTypes = append(deny.Spec.PolicyTypes, networkingv1.PolicyTypeEgress)
		deny.Spec.Ingress = []networkingv1.NetworkPolicyIngressRule{{From: []networkingv1.NetworkPolicyPeer{sameNamespace}}}
		deny.Spec.Egress = []networkingv1.NetworkPolicyEgressRule{{To: []networkingv1.NetworkPolicyPeer{sameNamespace}}, dnsRule()}
	}
	if _, err := a.cs.NetworkingV1().NetworkPolicies(ns).Create(ctx, deny, metav1.CreateOptions{}); err != nil && !apierrors.IsAlreadyExists(err) {
		return errs.Wrap(errs.AdapterFailed, "Could not isolate the app's trial run.", err)
	}
	if !restricted {
		return nil
	}
	gw := &networkingv1.NetworkPolicy{
		ObjectMeta: metav1.ObjectMeta{Name: gatewayPolicy, Namespace: ns, Labels: map[string]string{labelManagedBy: managedBy}},
		Spec: networkingv1.NetworkPolicySpec{
			PodSelector: metav1.LabelSelector{MatchLabels: map[string]string{labelRole: roleGateway}},
			PolicyTypes: []networkingv1.PolicyType{networkingv1.PolicyTypeEgress},
			Egress:      []networkingv1.NetworkPolicyEgressRule{a.outsideRule()},
		},
	}
	if err := a.putPolicy(ctx, gw); err != nil {
		return err
	}
	return a.ensureGateway(ctx, ns, "trial-"+trialID, rules)
}

// What a trial may use [P] (R-097), as on Docker (docker/trial.go): a trial
// has no spec yet and so no limits of its own, and one cut short reports an
// app that works as one that does not. Limits only: the request is small, so
// a trial is scheduled on any node with room for an ordinary app.
const (
	trialStorageSize   = "1Gi"
	trialMemoryLimit   = "4Gi"
	trialCPULimit      = "2"
	trialMemoryRequest = "256Mi"
	trialCPURequest    = "100m"
)

func trialResources() corev1.ResourceRequirements {
	return corev1.ResourceRequirements{
		Limits: corev1.ResourceList{
			corev1.ResourceMemory: resource.MustParse(trialMemoryLimit),
			corev1.ResourceCPU:    resource.MustParse(trialCPULimit),
		},
		Requests: corev1.ResourceList{
			corev1.ResourceMemory: resource.MustParse(trialMemoryRequest),
			corev1.ResourceCPU:    resource.MustParse(trialCPURequest),
		},
	}
}

// watchTrial polls the trial until it exits, binds a port, or time runs out.
// A node refusing the image for the registry's download limit is an error:
// the trial never ran, and waiting out the clock would report it as working.
func (a *Adapter) watchTrial(ctx context.Context, ns string, timeout time.Duration, signed bool) (api.TrialResult, error) {
	deadline, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	var result api.TrialResult
	for {
		p, err := a.cs.CoreV1().Pods(ns).Get(deadline, "trial", metav1.GetOptions{})
		if err == nil {
			if limited := pullLimited(p, signed); limited != nil {
				return result, limited
			}
			for _, s := range p.Status.ContainerStatuses {
				if s.Name != appContainer {
					continue
				}
				if s.State.Running != nil {
					result.Started = true
				}
				if t := s.State.Terminated; t != nil {
					code := int(t.ExitCode)
					result.ExitCode = &code
					result.Started = result.Started || !t.StartedAt.IsZero()
					return result, nil
				}
			}
			if result.Started {
				routable, loopback, ok := a.observePorts(deadline, ns)
				if ok {
					result.LoopbackPorts = loopback
					if len(routable) > 0 {
						result.ObservedPorts = routable
						return result, nil
					}
				}
			}
		}
		if sleep(deadline, a.poll) != nil {
			// Still up when the clock ran out, which is the app working.
			return result, nil
		}
	}
}

// observePorts reads the trial's listening sockets from the observer.
func (a *Adapter) observePorts(ctx context.Context, ns string) (routable, loopback []int, ok bool) {
	var out bytes.Buffer
	err := a.stream(ctx, ns, "trial", "observer", []string{"cat", "/proc/net/tcp", "/proc/net/tcp6"},
		remotecommand.StreamOptions{Stdout: &out, Stderr: io.Discard})
	if err != nil && out.Len() == 0 {
		return nil, nil, false
	}
	routable, loopback = listeningPorts(out.String())
	return routable, loopback, true
}

// trialLog is the app container's output, at most 64 KiB.
func (a *Adapter) trialLog(ctx context.Context, ns string) string {
	rc, err := a.cs.CoreV1().Pods(ns).GetLogs("trial", &corev1.PodLogOptions{
		Container: appContainer, LimitBytes: ptr.To(int64(64 << 10)),
	}).Stream(context.WithoutCancel(ctx))
	if err != nil {
		return ""
	}
	defer func() { _ = rc.Close() }()
	body, _ := io.ReadAll(rc)
	return string(body)
}

// listeningPorts reads LISTEN sockets from /proc/net/tcp and tcp6, split into
// those traffic can arrive on and those bound only to loopback — a common,
// quiet mistake worth naming rather than reporting no port at all.
func listeningPorts(procNetTCP string) (routable, loopback []int) {
	const listenState = "0A"
	seen := map[int]bool{}
	for _, line := range strings.Split(procNetTCP, "\n") {
		fields := strings.Fields(line)
		if len(fields) < 4 || fields[3] != listenState {
			continue
		}
		hexAddr, hexPort, found := strings.Cut(fields[1], ":")
		if !found {
			continue
		}
		port, err := strconv.ParseInt(hexPort, 16, 32)
		if err != nil || port <= 0 || port > 65535 || seen[int(port)] {
			continue
		}
		seen[int(port)] = true
		if isLoopback(hexAddr) {
			loopback = append(loopback, int(port))
		} else {
			routable = append(routable, int(port))
		}
	}
	sort.Ints(routable)
	sort.Ints(loopback)
	return routable, loopback
}

// isLoopback reads a /proc/net local address: 8 little-endian hex digits for
// IPv4, so 127.x.x.x ends in 7F; 32 for IPv6, where ::1 is the one that
// matters.
func isLoopback(hexAddr string) bool {
	switch len(hexAddr) {
	case 8:
		return strings.EqualFold(hexAddr[6:8], "7F")
	case 32:
		return strings.EqualFold(hexAddr, "00000000000000000000000001000000")
	}
	return false
}
