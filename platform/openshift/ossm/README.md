# OpenShift Service Mesh platform

These ordinary Kubernetes and Sail Operator manifests define the OSSM Sidecar
platform for the two managed clusters. They contain no ACM governance resources.

## Network overlays

Render a complete platform configuration from the repository root:

```sh
oc kustomize platform/openshift/ossm/overlays/network1
oc kustomize platform/openshift/ossm/overlays/network2
```

Each overlay renders 17 resources:

| Group | Resources per network |
| --- | --- |
| [Namespaces](namespaces/kustomization.yaml) | Four infrastructure Namespaces |
| [CNI](cni/kustomization.yaml) | One `IstioCNI/default` |
| Control plane: [network1](control-plane/network1/kustomization.yaml), [network2](control-plane/network2/kustomization.yaml) | One `Istio/default` |
| [Ingress Gateway](gateways/ingress/kustomization.yaml) | Service, Deployment, Role and RoleBinding |
| East-West Gateway: [network1](gateways/eastwest/network1/kustomization.yaml), [network2](gateways/eastwest/network2/kustomization.yaml) | ServiceAccount, Deployment, Service, Role, RoleBinding, HPA and PDB |

The shared control plane retains mesh ID `mesh1`, trust domain `cluster.local`,
the `openshift` profile and DNS capture. Network1 uses Istio cluster ID `cluster1`;
network2 uses `cluster2`. Istio and IstioCNI omit component versions, leaving
initial selection to the installed Operator/CRD defaults. The intended node OS
baseline is RHCOS 9.x on a supported OpenShift installation.

Each complete overlay renders exactly one `Namespace/istio-system`. A native
Kustomize replacement copies `Istio.spec.values.global.network` to its
`topology.istio.io/network` label. The shared Namespace base stays unlabeled.
The label-only [network1](namespaces/network1/network1.yaml) and
[network2](namespaces/network2/network2.yaml) fragments are separate inputs for
ACM's additive network-label expectations; they are not added as competing
Namespace resources to the complete overlays.

`ossm-enabled` and `ossm-network` are project-defined labels on ACM
ManagedClusters. They are separate from Istio's Namespace label and are not
included in platform rendering.

## Sources and deployment ownership

Common control-plane and East-West gateway `base/` directories support the
existing network-specific patches. The Ingress Gateway needs no network-specific
workload patches and uses one shared base directly.

ACM generators remain under
[deploy/acm/policies/platform](../../../deploy/acm/policies/platform/kustomization.yaml).
Contained Kustomize wrappers reference these shared platform sources. The
namespace-existence Policy retains four unlabeled Namespace expectations; the
network-identity Policies retain their separate label-only expectations. Both
use additive `musthave` comparison. Render ordinary platform resources from the
canonical directories listed above; the contained wrappers belong to ACM inputs.

Choose one deployment owner for each resource. Do not also apply these ordinary
overlays manually where ACM reconciles the same resources. The platform overlays
are independent of application profiles and contain no application workloads,
logical Istio Gateways, routing policies, remote-cluster Secrets or Operator
installation resources.

## Compatibility

The target is OSSM 3.5 Sidecar on supported OpenShift/RHCOS 9.x; ACM mode targets
ACM 2.17. No OpenShift minor or Istio component version is pinned. Both Istio and
IstioCNI omit `spec.version`; verify admission and record their selected versions.
An Operator upgrade does not replace a
version already defaulted and stored in an existing CR. Source omission is not a
continuous upgrade policy; plan subsequent component upgrades separately.
This is not a generic upstream Kubernetes installation or an Ambient profile.
RHEL/RHCOS 10 and native nftables configuration are outside the reference baseline.
Local rendering compatibility does not establish live product compatibility.

## Operational prerequisites

The OSSM Operator must be ready before applying platform custom resources.
ACM supplies its [OperatorPolicy](../../../deploy/acm/policies/platform/operator/README.md);
standalone requires separate Operator installation. Rendering does not order
resource readiness. Provision shared mesh trust, required certificates and remote
discovery separately, and
check CNI, control-plane and gateway readiness before serving traffic.

Gateway sources preserve the existing Red Hat workload configurations, including
RBAC, injection metadata, selectors, ports, volumes, HPA and PDB. Gateway injection
replaces `image: auto`; the admitted Pod also depends on Operator defaults and
OpenShift admission. See the [Ingress](../../../deploy/acm/policies/platform/gateways/ingress/README.md)
and [East-West](../../../deploy/acm/policies/platform/gateways/eastwest/README.md)
governance guides for RBAC, injection, listener and runtime checks. Ingress HTTPS,
load-balancer exposure, cross-network L4/L7 routing and session affinity require
validation on the deployed environment.
