# OSSM infrastructure namespace governance

The ordinary Namespace manifests define four shared OSSM infrastructure namespaces
for both managed clusters:

- [`istio-system`](../../../../../platform/openshift/ossm/namespaces/istio-system.yaml)
- [`istio-cni`](../../../../../platform/openshift/ossm/namespaces/istio-cni.yaml)
- [`istio-ingress`](../../../../../platform/openshift/ossm/namespaces/istio-ingress.yaml)
- [`istio-east-west`](../../../../../platform/openshift/ossm/namespaces/istio-east-west.yaml)

These definitions contain no labels or annotations. They do not enable sidecar
injection or Ambient mode. Adding network-specific labels, including labels on
`istio-system`, requires separate ownership and Placement selection; those labels
are excluded from this shared policy.

Render the ordinary [Namespace Kustomization](../../../../../platform/openshift/ossm/namespaces/kustomization.yaml) from
the repository root:

```sh
oc kustomize platform/openshift/ossm/namespaces
```

The [PolicyGenerator configuration](policy-generator.yaml) consumes `namespaces`
as a descendant input wrapper for the shared
[platform Namespace base](../../../../../platform/openshift/ossm/namespaces/kustomization.yaml). At build time, it creates one Hub Policy,
`intermesh-infra-ns-ingress`, containing one ConfigurationPolicy with four Namespace
object-templates. All templates use `musthave`.

PlacementBinding `binding-intermesh-infra-ns-ingress` references the existing
[`placement-all-clusters`](../../../placements/placement-all-clusters.yaml) in namespace
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
oc kustomize deploy/acm/policies/platform/namespaces --enable-alpha-plugins
```

Offline generation was validated with the locally installed upstream macOS
PolicyGenerator v0.19.0. Inspect the output for one Policy, one embedded
ConfigurationPolicy containing exactly the four Namespaces, and one PlacementBinding.
No Placement, OperatorPolicy or Secret is generated. Neither rendering command
contacts a cluster or creates cluster resources.

These offline checks do not establish compatibility with the Red Hat-distributed
ACM 2.17 executable or validate live ACM admission, Placement decisions or compliance
reporting.

The full ACM aggregate includes this generator group. The
[Operator governance entrypoint](../operator/kustomization.yaml) uses directly defined
Policy YAML and needs no plugin; this group and
[networking governance](../../service-mesh/kustomization.yaml) require PolicyGenerator.
Standalone profiles consume ordinary platform Namespace sources without generators.
Application-only overlays exclude infrastructure Namespaces. This group governs
Namespace existence; network labels and other platform resources have separate
Policies.

References: [ACM 2.17 PolicyGenerator configuration](https://docs.redhat.com/en/documentation/red_hat_advanced_cluster_management_for_kubernetes/2.17/html/governance/policy-deployment),
[Red Hat generator distribution and plugin integration](https://docs.redhat.com/en/documentation/red_hat_advanced_cluster_management_for_kubernetes/2.17/html/gitops/gitops-overview).
