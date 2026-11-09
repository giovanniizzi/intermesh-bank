# OSSM infrastructure namespace governance

The ordinary Namespace manifests define four shared OSSM infrastructure namespaces
for both managed clusters:

- [`istio-system`](namespaces/istio-system.yaml)
- [`istio-cni`](namespaces/istio-cni.yaml)
- [`istio-ingress`](namespaces/istio-ingress.yaml)
- [`istio-east-west`](namespaces/istio-east-west.yaml)

These definitions contain no labels or annotations. They do not enable sidecar
injection or Ambient mode. Adding network-specific labels, including labels on
`istio-system`, requires separate ownership and Placement selection; those labels
are excluded from this shared policy.

Render the ordinary [Namespace Kustomization](namespaces/kustomization.yaml) from
the repository root:

```sh
oc kustomize manifests/infrastructure/namespaces
```

The [PolicyGenerator configuration](policy-generator.yaml) consumes `namespaces`
as a descendant Kustomize directory. At build time, it creates one Hub Policy,
`intermesh-infra-ns-ingress`, containing one ConfigurationPolicy with four Namespace
object-templates. All templates use `musthave`.

PlacementBinding `binding-intermesh-infra-ns-ingress` references the existing
[`placement-all-clusters`](../ossm/istio-gateway.yaml) in namespace
`open-cluster-management-policies`. That Placement selects managed clusters labeled
`ossm-enabled: "true"`, so the same definitions target both managed clusters. The
generator does not create another Placement.

Both the parent Policy and ConfigurationPolicy declare `remediationAction: enforce`.
ACM creates missing Namespaces and reconciles their declared fields when the
governance is deployed. Pruning and automatic recreation are disabled.

Policy generation requires an executable Kustomize plugin; `oc` does not bundle it.
Place the trusted executable at
`policy.open-cluster-management.io/v1/policygenerator/PolicyGenerator` under the
configured Kustomize plugin home, then render:

```sh
oc kustomize manifests/infrastructure --enable-alpha-plugins
```

Offline generation was validated with the locally installed upstream macOS
PolicyGenerator v0.19.0. Inspect the output for one Policy, one embedded
ConfigurationPolicy containing exactly the four Namespaces, and one PlacementBinding.
No Placement, OperatorPolicy or Secret is generated. Neither rendering command
contacts a cluster or creates cluster resources.

These offline checks do not establish compatibility with the Red Hat-distributed
ACM 2.17 executable or validate live ACM admission, Placement decisions or compliance
reporting.

This separate generator entrypoint leaves the
[static Operator governance entrypoint](../acm-infrastructure/kustomization.yaml) and the
[networking entrypoint](../ossm/kustomization.yaml) independent of plugin
availability. The managed-cluster application overlays also exclude these
Namespace sources and the generator. This entrypoint governs only Namespaces; it
does not define operators, control planes, gateway workloads or network configuration.

References: [ACM 2.17 PolicyGenerator configuration](https://docs.redhat.com/en/documentation/red_hat_advanced_cluster_management_for_kubernetes/2.17/html/governance/policy-deployment),
[Red Hat generator distribution and plugin integration](https://docs.redhat.com/en/documentation/red_hat_advanced_cluster_management_for_kubernetes/2.17/html/gitops/gitops-overview).
