# Ingress namespace policy generation

The ordinary [Namespace manifest](namespaces/istio-ingress.yaml)
describes `istio-ingress`, a prerequisite for the Ingress Gateway in both managed
clusters. It has no injection or network labels. Its
[Kustomization](namespaces/kustomization.yaml) can be rendered
independently from the repository root:

```sh
oc kustomize manifests/infrastructure/namespaces
```

The [PolicyGenerator configuration](policy-generator.yaml) consumes the `namespaces`
Kustomize directory beneath this generator entrypoint. Manifest inputs stay within
the generator Kustomization directory, as required by PolicyGenerator. At build
time, it wraps the Namespace in a ConfigurationPolicy
inside Hub Policy `intermesh-infra-ns-ingress`. The requested PlacementBinding name
is `binding-intermesh-infra-ns-ingress`. It references the existing
[`placement-all-clusters`](../ossm/istio-gateway.yaml) in
`open-cluster-management-policies`; no new Placement is requested.

At runtime, ACM distributes the generated Policy to the OSSM-enabled managed
clusters and evaluates the Namespace object template. `musthave` checks that the
Namespace exists, while `inform` reports its absence without creating it.
Pruning and automatic recreation are explicitly disabled. Rendering either
entrypoint does not create resources or contact a cluster.

Full generation requires the trusted PolicyGenerator distribution documented for
ACM 2.17, configured as a Kustomize executable plugin. The plugin is not bundled
with this repository or automatically supplied by `oc`. Use the ACM 2.17
distribution and record its version; do not substitute an arbitrary upstream build.
Its executable must be discoverable at
`policy.open-cluster-management.io/v1/policygenerator/PolicyGenerator` under the
configured Kustomize plugin home. Enable the plugin when rendering:

```sh
oc kustomize manifests/infrastructure --enable-alpha-plugins
```

Inspect the actual output for one Hub Policy with an inform-only
ConfigurationPolicy containing only `Namespace/istio-ingress`, plus its
PlacementBinding. Confirm that no parent remediation setting enables enforcement,
the binding references `placement-all-clusters`, and no Placement or OperatorPolicy
is emitted. Confirm the emitted binding name with the selected generator version.
Generator execution and output validation require an available trusted plugin;
source inspection alone does not establish these results.

This separate generator entrypoint leaves the
[static Operator governance entrypoint](../acm-infrastructure/kustomization.yaml) and the
[networking entrypoint](../ossm/kustomization.yaml) independent of plugin
availability. Neither includes this source Namespace or generator.

The same source-to-policy pattern can be used for `Istio`, `IstioCNI` and gateway
workloads, with separately reviewed prerequisites and ownership. This example
does not define those resources. No active clusters exist; policy admission,
Placement decisions, compliance reporting and the absence of runtime mutations
must be validated on an ACM-managed cluster before operational use.

References: [ACM 2.17 PolicyGenerator configuration](https://docs.redhat.com/en/documentation/red_hat_advanced_cluster_management_for_kubernetes/2.17/html/governance/policy-deployment),
[Red Hat generator distribution and plugin integration](https://docs.redhat.com/en/documentation/red_hat_advanced_cluster_management_for_kubernetes/2.17/html/gitops/gitops-overview).
