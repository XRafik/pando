package kubernetes

import (
	"context"
	"errors"
	"io"
	"maps"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"cel.dev/cel-go/cel"
	"github.com/stretchr/testify/require"
	admissionv1 "k8s.io/api/admissionregistration/v1"
	corev1 "k8s.io/api/core/v1"
	rbacv1 "k8s.io/api/rbac/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/client-go/kubernetes/fake"
	k8stesting "k8s.io/client-go/testing"
	"k8s.io/client-go/tools/remotecommand"
	"k8s.io/utils/ptr"

	"github.com/trypando/pando/internal/adapter/api"
	"github.com/trypando/pando/internal/egress"
)

// The ValidatingAdmissionPolicies in deploy/kubernetes/admission-policy.yaml,
// evaluated here with CEL the way the API server evaluates them, so the
// policies are checked against what the runtime actually creates without a
// cluster.

const pandoUser = "system:serviceaccount:" + defaultPandoNamespace + ":" + defaultServiceAccount

// celReserved are the property names Kubernetes escapes as __name__ in CEL.
var celReserved = map[string]bool{
	"as": true, "break": true, "const": true, "continue": true, "else": true, "false": true, "for": true,
	"function": true, "if": true, "import": true, "in": true, "let": true, "loop": true, "package": true,
	"namespace": true, "null": true, "return": true, "true": true, "var": true, "void": true, "while": true,
}

type admission struct {
	env      *cel.Env
	policies []*admissionv1.ValidatingAdmissionPolicy
}

// shippedAdmission reads the policies the manifests ship, requiring each one
// bound with Deny: a policy without a binding is never evaluated.
func shippedAdmission(t *testing.T) *admission {
	t.Helper()
	var policies []*admissionv1.ValidatingAdmissionPolicy
	denied := map[string]bool{}
	for _, obj := range manifests(t) {
		switch o := obj.(type) {
		case *admissionv1.ValidatingAdmissionPolicy:
			policies = append(policies, o)
		case *admissionv1.ValidatingAdmissionPolicyBinding:
			if slices.Contains(o.Spec.ValidationActions, admissionv1.Deny) {
				denied[o.Spec.PolicyName] = true
			}
		}
	}
	require.NotEmpty(t, policies)
	for _, p := range policies {
		require.True(t, denied[p.Name], "%s is bound with Deny", p.Name)
		require.Equal(t, admissionv1.Fail, *p.Spec.FailurePolicy, p.Name)
	}
	env, err := cel.NewEnv(
		cel.Variable("object", cel.DynType),
		cel.Variable("oldObject", cel.DynType),
		cel.Variable("request", cel.DynType),
		cel.Variable("namespaceObject", cel.DynType),
		cel.Variable("variables", cel.MapType(cel.StringType, cel.DynType)),
	)
	require.NoError(t, err)
	return &admission{env: env, policies: policies}
}

// request is one API call as admission sees it.
type request struct {
	op        admissionv1.OperationType
	group     string
	resource  string
	namespace string
	user      string
	object    runtime.Object
	nsObject  *corev1.Namespace
}

// denials is every message the shipped policies refuse r with.
func (ad *admission) denials(t *testing.T, r request) []string {
	t.Helper()
	if r.user == "" {
		r.user = pandoUser
	}
	var nsObject any
	if r.nsObject != nil {
		nsObject = toCEL(t, r.nsObject)
	}
	vars := map[string]any{
		"object":          toCEL(t, r.object),
		"oldObject":       nil,
		"namespaceObject": nsObject,
		"request": map[string]any{
			"operation": string(r.op), "namespace": r.namespace,
			"userInfo": map[string]any{"username": r.user},
		},
	}
	var out []string
	for _, p := range ad.policies {
		if !matches(p, r) {
			continue
		}
		applies := true
		for _, c := range p.Spec.MatchConditions {
			applies = applies && ad.eval(t, c.Expression, vars) == true
		}
		if !applies {
			continue
		}
		values := map[string]any{}
		vars["variables"] = values
		for _, v := range p.Spec.Variables {
			values[v.Name] = ad.eval(t, v.Expression, vars)
		}
		for _, v := range p.Spec.Validations {
			if ad.eval(t, v.Expression, vars) != true {
				out = append(out, p.Name+": "+v.Message)
			}
		}
	}
	return out
}

func matches(p *admissionv1.ValidatingAdmissionPolicy, r request) bool {
	for _, rule := range p.Spec.MatchConstraints.ResourceRules {
		if slices.Contains(rule.APIGroups, r.group) && slices.Contains(rule.Resources, r.resource) &&
			slices.Contains(rule.Operations, r.op) {
			return true
		}
	}
	return false
}

// eval runs one expression. One that errors would be refused too (every
// policy fails closed), but for the wrong reason, so it fails the test.
func (ad *admission) eval(t *testing.T, expr string, vars map[string]any) any {
	t.Helper()
	ast, iss := ad.env.Compile(expr)
	require.NoError(t, iss.Err(), expr)
	prg, err := ad.env.Program(ast)
	require.NoError(t, err)
	out, _, err := prg.Eval(vars)
	require.NoError(t, err, expr)
	return out.Value()
}

func toCEL(t *testing.T, obj runtime.Object) any {
	t.Helper()
	if obj == nil {
		return nil
	}
	m, err := runtime.DefaultUnstructuredConverter.ToUnstructured(obj)
	require.NoError(t, err)
	return escape(m)
}

func escape(v any) any {
	switch x := v.(type) {
	case map[string]any:
		out := make(map[string]any, len(x))
		for k, e := range x {
			if celReserved[k] {
				k = "__" + k + "__"
			}
			out[k] = escape(e)
		}
		return out
	case []any:
		for i, e := range x {
			x[i] = escape(e)
		}
		return x
	}
	return v
}

// enforce makes cs refuse, as the cluster would, every create by Pando that
// the shipped policies refuse, and counts what it admitted by resource.
func enforce(t *testing.T, ad *admission, cs *fake.Clientset) func() map[string]int {
	t.Helper()
	var mu sync.Mutex
	admitted := map[string]int{}
	cs.PrependReactor("create", "*", func(action k8stesting.Action) (bool, runtime.Object, error) {
		if action.GetSubresource() != "" {
			return false, nil, nil
		}
		res := action.GetResource()
		obj := action.(k8stesting.CreateAction).GetObject()
		r := request{op: admissionv1.Create, group: res.Group, resource: res.Resource, namespace: action.GetNamespace(), object: obj}
		if r.namespace != "" {
			if ns, err := cs.Tracker().Get(corev1.SchemeGroupVersion.WithResource("namespaces"), "", r.namespace); err == nil {
				r.nsObject = ns.(*corev1.Namespace)
			}
		}
		if denied := ad.denials(t, r); len(denied) > 0 {
			return true, nil, apierrors.NewForbidden(res.GroupResource(), "", errors.New(strings.Join(denied, "; ")))
		}
		mu.Lock()
		admitted[res.Resource]++
		mu.Unlock()
		return false, nil, nil
	})
	return func() map[string]int {
		mu.Lock()
		defer mu.Unlock()
		return maps.Clone(admitted)
	}
}

// anyKubelet starts every pod Pando creates, anywhere.
func anyKubelet(t *testing.T, cs *fake.Clientset) {
	t.Helper()
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
			list, err := cs.CoreV1().Pods("").List(ctx, metav1.ListOptions{})
			if err != nil {
				continue
			}
			for _, p := range list.Items {
				if p.Status.Phase == "" {
					p.Status = running(true)
					p.Status.PodIP = "10.244.0.9"
					_, _ = cs.CoreV1().Pods(p.Namespace).UpdateStatus(ctx, &p, metav1.UpdateOptions{})
				}
			}
		}
	}()
}

// TestR402_AdmissionAdmitsEverythingTheRuntimeCreates asserts the shipped
// policies refuse nothing the runtime makes for a normal app: its namespace,
// Pando's role binding there, every workload pod, a restricted app's egress
// gateway, a volume helper, a trial, and the NetworkPolicy canary. A policy
// that refused any of these would fail every deploy on the cluster.
func TestR402_AdmissionAdmitsEverythingTheRuntimeCreates(t *testing.T) {
	ctx := context.Background()
	ad := shippedAdmission(t)

	a, cs := testAdapter(t, nil)
	admitted := enforce(t, ad, cs)
	anyKubelet(t, cs)
	a.stream = func(_ context.Context, _, _, _ string, _ []string, opts remotecommand.StreamOptions) error {
		if opts.Stdout != nil {
			_, _ = io.WriteString(opts.Stdout, "TAR")
		}
		return nil
	}

	plan := webPlan()
	plan.Network.Egress = egress.Rules{BlockPrivate: true}
	_, err := a.Apply(ctx, plan)
	require.NoError(t, err)
	_, err = cs.CoreV1().Pods(testNS).Get(ctx, gatewayName, metav1.GetOptions{})
	require.NoError(t, err, "the egress gateway was admitted")

	h, err := a.CreateVolume(ctx, api.VolumeRequest{VolumeID: "vol_01DATA", BundleID: testBundle})
	require.NoError(t, err)
	require.NoError(t, a.SnapshotVolume(ctx, h, io.Discard))

	_, err = a.Trial(ctx, api.TrialRequest{TrialID: "trl_admit", Image: "example/app", Timeout: 100 * time.Millisecond})
	require.NoError(t, err)

	got := admitted()
	require.GreaterOrEqual(t, got["namespaces"], 2, "the app's and the trial's")
	require.GreaterOrEqual(t, got["rolebindings"], 2)
	require.GreaterOrEqual(t, got["pods"], 5, "two workloads, the gateway, the helper, the trial")

	// The canary, in a namespace of its own.
	cfg := Config{PodCIDR: "10.244.0.0/16", ServiceCIDR: "10.96.0.0/12"}
	require.NoError(t, cfg.validate())
	ccs := fakeClient()
	canaryAdmitted := enforce(t, ad, ccs)
	c := &Adapter{poll: 2 * time.Millisecond}
	c.use(ccs, cfg)
	stop := make(chan struct{})
	go kubelet(t, ccs, 0, 1, stop)
	defer close(stop)
	enforced, err := c.runCanary(ctx)
	require.NoError(t, err)
	require.True(t, enforced)
	require.Equal(t, 1, canaryAdmitted()["namespaces"])
	require.Equal(t, 1, canaryAdmitted()["rolebindings"])
	require.GreaterOrEqual(t, canaryAdmitted()["pods"], 3)
}

// appPod is a workload pod as the runtime makes it, and its namespace.
func appPod(t *testing.T) (*corev1.Pod, *corev1.Namespace) {
	t.Helper()
	ctx := context.Background()
	a, cs := testAdapter(t, nil)
	_, err := a.Apply(ctx, webPlan())
	require.NoError(t, err)
	pods := listPods(t, cs, testNS, "web")
	require.Len(t, pods, 1)
	ns, err := cs.CoreV1().Namespaces().Get(ctx, testNS, metav1.GetOptions{})
	require.NoError(t, err)
	return &pods[0], ns
}

// TestR402_AdmissionRefusesAPodWithHostAccessOrPrivilege asserts the second
// check behind the runtime's own code: a pod made with Pando's ServiceAccount
// that is privileged, shares a host namespace, mounts a host path or adds a
// capability beyond workloadSecurity's is refused, in any container. Anyone
// else's pod is not Pando's policies' business.
func TestR402_AdmissionRefusesAPodWithHostAccessOrPrivilege(t *testing.T) {
	ad := shippedAdmission(t)
	base, ns := appPod(t)
	check := func(p *corev1.Pod, user string) []string {
		return ad.denials(t, request{op: admissionv1.Create, resource: "pods", namespace: ns.Name, user: user, object: p, nsObject: ns})
	}
	require.Empty(t, check(base, ""), "the runtime's own pod is admitted")

	cases := map[string]func(*corev1.Pod){
		"privileged":   func(p *corev1.Pod) { p.Spec.Containers[0].SecurityContext.Privileged = ptr.To(true) },
		"host PID":     func(p *corev1.Pod) { p.Spec.HostPID = true },
		"host IPC":     func(p *corev1.Pod) { p.Spec.HostIPC = true },
		"host network": func(p *corev1.Pod) { p.Spec.HostNetwork = true },
		"host path": func(p *corev1.Pod) {
			p.Spec.Volumes = append(p.Spec.Volumes, corev1.Volume{Name: "root", VolumeSource: corev1.VolumeSource{
				HostPath: &corev1.HostPathVolumeSource{Path: "/"},
			}})
		},
		"added capability": func(p *corev1.Pod) {
			caps := p.Spec.Containers[0].SecurityContext.Capabilities
			caps.Add = append(caps.Add, "SYS_ADMIN")
		},
		"privileged init container": func(p *corev1.Pod) {
			p.Spec.InitContainers = []corev1.Container{{Name: "init", Image: "busybox",
				SecurityContext: &corev1.SecurityContext{Privileged: ptr.To(true)}}}
		},
		"capability on an ephemeral container": func(p *corev1.Pod) {
			p.Spec.EphemeralContainers = []corev1.EphemeralContainer{{EphemeralContainerCommon: corev1.EphemeralContainerCommon{
				Name: "debug", Image: "busybox",
				SecurityContext: &corev1.SecurityContext{Capabilities: &corev1.Capabilities{Add: []corev1.Capability{"NET_ADMIN"}}},
			}}}
		},
	}
	for name, mutate := range cases {
		t.Run(name, func(t *testing.T) {
			p := base.DeepCopy()
			mutate(p)
			require.NotEmpty(t, check(p, ""), "refused for Pando")
			require.Empty(t, check(p, "system:serviceaccount:kube-system:other"), "another account's pod is not matched")
		})
	}
}

// TestR402_PandoMakesOnlyNamespacesThatEnforcePodSecurity asserts a namespace
// created with Pando's ServiceAccount must be labeled as Pando's and enforce
// Pod Security baseline or restricted, so every pod in a namespace Pando can
// bind itself into is held to baseline by the cluster.
func TestR402_PandoMakesOnlyNamespacesThatEnforcePodSecurity(t *testing.T) {
	ad := shippedAdmission(t)
	_, made := appPod(t)
	check := func(labels map[string]string) []string {
		ns := made.DeepCopy()
		ns.Labels = labels
		return ad.denials(t, request{op: admissionv1.Create, resource: "namespaces", object: ns})
	}
	require.Empty(t, check(made.Labels), "the runtime's own namespace is admitted")
	restricted := maps.Clone(made.Labels)
	restricted[labelPSAEnforce] = "restricted"
	require.Empty(t, check(restricted))

	for name, labels := range map[string]map[string]string{
		"no labels":       nil,
		"privileged":      {labelManagedBy: managedBy, labelPSAEnforce: "privileged"},
		"no pod security": {labelManagedBy: managedBy},
		"not Pando's":     {labelPSAEnforce: "baseline"},
	} {
		require.NotEmpty(t, check(labels), name)
	}
}

// TestR402_PandoBindsOnlyItsAppRoleToItselfInItsOwnNamespaces asserts the
// guard on Pando's cluster-wide right to create role bindings: only
// pando-app-manager, only to Pando's ServiceAccount, and only in a namespace
// Pando made for an app (labeled as Pando's, enforcing baseline or
// restricted), never Pando's own, the edge's or the builder's.
func TestR402_PandoBindsOnlyItsAppRoleToItselfInItsOwnNamespaces(t *testing.T) {
	ad := shippedAdmission(t)
	_, appNS := appPod(t)
	a, _ := testAdapter(t, nil)
	binding := &rbacv1.RoleBinding{
		ObjectMeta: metav1.ObjectMeta{Name: roleBindingName, Namespace: appNS.Name},
		RoleRef:    rbacv1.RoleRef{APIGroup: rbacv1.GroupName, Kind: "ClusterRole", Name: a.config.AppRole},
		Subjects: []rbacv1.Subject{{
			Kind: rbacv1.ServiceAccountKind, Name: a.config.ServiceAccount, Namespace: a.config.PandoNamespace,
		}},
	}
	check := func(rb *rbacv1.RoleBinding, ns *corev1.Namespace) []string {
		return ad.denials(t, request{op: admissionv1.Create, group: rbacv1.GroupName, resource: "rolebindings",
			namespace: ns.Name, object: rb, nsObject: ns})
	}
	require.Empty(t, check(binding, appNS), "the runtime's own binding is admitted")

	ours := func(name, enforce string) *corev1.Namespace {
		return &corev1.Namespace{ObjectMeta: metav1.ObjectMeta{Name: name,
			Labels: map[string]string{labelManagedBy: managedBy, labelPSAEnforce: enforce}}}
	}
	for name, ns := range map[string]*corev1.Namespace{
		"kube-system":        {ObjectMeta: metav1.ObjectMeta{Name: "kube-system"}},
		"pando":              ours(defaultPandoNamespace, "baseline"),
		"pando-edge":         ours(defaultEdgeNamespace, "baseline"),
		"pando-build":        ours("pando-build", "privileged"),
		"privileged of ours": ours("pando-x", "privileged"),
	} {
		rb := binding.DeepCopy()
		rb.Namespace = ns.Name
		require.NotEmpty(t, check(rb, ns), name)
	}

	for name, mutate := range map[string]func(*rbacv1.RoleBinding){
		"another role":      func(rb *rbacv1.RoleBinding) { rb.RoleRef.Name = "cluster-admin" },
		"a Role":            func(rb *rbacv1.RoleBinding) { rb.RoleRef.Kind = "Role" },
		"another account":   func(rb *rbacv1.RoleBinding) { rb.Subjects[0].Namespace = "attacker" },
		"a user":            func(rb *rbacv1.RoleBinding) { rb.Subjects[0] = rbacv1.Subject{Kind: rbacv1.UserKind, Name: "mallory"} },
		"a second subject":  func(rb *rbacv1.RoleBinding) { rb.Subjects = append(rb.Subjects, rb.Subjects[0]) },
		"no subject at all": func(rb *rbacv1.RoleBinding) { rb.Subjects = nil },
	} {
		rb := binding.DeepCopy()
		mutate(rb)
		require.NotEmpty(t, check(rb, appNS), name)
	}
}

// TestR402_PandoNeverDeletesTheBuildersNamespace asserts the delete guard
// covers pando-build, which is labeled as Pando's like an app namespace.
func TestR402_PandoNeverDeletesTheBuildersNamespace(t *testing.T) {
	ad := shippedAdmission(t)
	var p *admissionv1.ValidatingAdmissionPolicy
	for _, x := range ad.policies {
		if x.Name == "pando-namespace-delete" {
			p = x
		}
	}
	require.NotNil(t, p)
	for _, name := range []string{"pando", "pando-edge", "pando-build"} {
		old := &corev1.Namespace{ObjectMeta: metav1.ObjectMeta{Name: name, Labels: map[string]string{labelManagedBy: managedBy}}}
		vars := map[string]any{"oldObject": toCEL(t, old), "object": nil, "namespaceObject": nil, "request": map[string]any{}}
		require.NotEqual(t, true, ad.eval(t, p.Spec.Validations[0].Expression, vars), name)
	}
	old := &corev1.Namespace{ObjectMeta: metav1.ObjectMeta{Name: testNS, Labels: map[string]string{labelManagedBy: managedBy}}}
	vars := map[string]any{"oldObject": toCEL(t, old), "object": nil, "namespaceObject": nil, "request": map[string]any{}}
	require.Equal(t, true, ad.eval(t, p.Spec.Validations[0].Expression, vars))
}
