# Ingress Gateway workload governance

This entrypoint governs the public ingress workload in `istio-ingress` on both
managed clusters. The shared ordinary base reproduces the four-resource ingress
configuration from the original "Sidecar with Istio API", Step 11:

- [LoadBalancer Service](base/service.yaml) `istio-ingressgateway`.
- [Deployment](base/deployment.yaml) `istio-ingressgateway`.
- [Role](base/role.yaml) `istio-ingressgateway-sds`.
- [RoleBinding](base/role-binding.yaml) `istio-ingressgateway-sds`.

Both network overlays render identical workload resources. Their Policies use
different Placements and control-plane dependencies; no network-specific workload
patch is needed. Existing application overlays do not include this entrypoint.

## Injection, selectors and ports

The Deployment follows the [OSSM 3.4 gateway-injection pattern](https://docs.redhat.com/en/documentation/red_hat_openshift_service_mesh/3.4/html/gateways/ossm-about-gateways):
Pod annotation `inject.istio.io/templates: gateway`, Pod label
`sidecar.istio.io/inject: "true"`, and container `istio-proxy` with `image: auto`.
The default Istio control plane replaces `auto` during Pod admission. A working
injection webhook is required; `auto` is not a published image reference.

The Deployment selector, Pod label, Service selector and existing
[Istio Gateway selector](../../../../ossm/istio-gateway.yaml) all use
`istio: ingressgateway`. The Deployment omits `serviceAccountName`, so its Pods
use the namespace's `default` ServiceAccount. No ServiceAccount resource is created.

The Role grants `get`, `watch` and `list` on core API `secrets` throughout
`istio-ingress`. The RoleBinding grants those permissions to that namespace's
`default` ServiceAccount, preserving the historical TLS/SDS authorization model.
This preserves a capability; it does not prove which credentials a deployment
uses or that HTTPS is functional.

These permissions expose namespace-wide Secret contents to other workloads using
the same ServiceAccount. Treat `istio-ingress` as a restricted gateway namespace
and avoid unrelated workloads or Secrets there. Dedicated identity migration,
permission reduction and explicit security/resource hardening are deferred to a
separate, explicitly reviewed change because they can affect SDS authorization,
SCC admission and runtime behavior. They are not part of this fidelity baseline.

| Service port | Gateway server port | Intended Envoy listener / Service targetPort |
|---|---|---|
| TCP 80 | HTTP 80 | 8080 |
| TCP 443 | HTTPS 443 | 8443 |

These mappings preserve the tested ingress Service configuration. Istio
[resolves each Gateway server port through the matching Service targetPort](https://github.com/openshift-service-mesh/istio/blob/release-1.30/pilot/pkg/model/gateway.go),
producing listeners on 8080 and 8443 without changing the Gateway's ports 80 and
443. High-port binding needs no low-port sysctl, additional capabilities or
`ISTIO_META_UNPRIVILEGED_POD` setting. The Deployment declares no Pod sysctl.
No container ports are declared; accepted Gateway configuration and Service port
resolution supply Envoy listeners.

The [Red Hat gateway injection template](https://github.com/openshift-service-mesh/istio/blob/release-1.30/manifests/charts/istio-control/istio-discovery/files/gateway-injection-template.yaml)
supplies proxy arguments, certificate plumbing and the readiness probe
`/healthz/ready` on port 15021. No duplicate probes or certificate mounts are
defined here. Port 15021 is not exposed through the LoadBalancer Service.
The template can also inject `net.ipv4.ip_unprivileged_port_start: "0"` by default;
removing it from the Deployment does not guarantee its absence from admitted
Pods. The high-port model does not depend on that default. Suppressing it in
injected Pods requires a separate injector configuration change.
Source fidelity does not imply identical admitted Pods across Operator versions.
Injection, Kubernetes defaults and OpenShift SCC admission determine effective
security settings, resource defaults and other Pod fields. The source declares
no replicas, container security context or resource requests/limits. Validate the
effective Pod configuration on the selected supported RHCOS 9.x deployment.

## Hub governance

Render locally from the repository root:

```sh
oc kustomize manifests/infrastructure/mesh/gateways/ingress/network1
oc kustomize manifests/infrastructure/mesh/gateways/ingress/network2
oc kustomize manifests/infrastructure/mesh/gateways/ingress --enable-alpha-plugins
```

Each ordinary overlay emits the four historical resources. The generator emits
only two Policies and two PlacementBindings in `open-cluster-management-policies`:

| Policy | PlacementBinding | Existing Placement | Required Policy |
|---|---|---|---|
| `intermesh-ingress-network1` | `binding-intermesh-ingress-network1` | `placement-intermesh-network1` | `intermesh-istio-network1` |
| `intermesh-ingress-network2` | `binding-intermesh-ingress-network2` | `placement-intermesh-network2` | `intermesh-istio-network2` |

The [existing Placements](../../../network-identity/README.md) select
`ossm-enabled: "true"` and the respective project-defined `ossm-network` label.
Each Policy contains one ConfigurationPolicy with four object-templates.
Parent and embedded remediation settings are `enforce`, comparison is `musthave`, and
pruning and forced recreation are disabled. No Placement, Secret or standalone
workload is generated for Hub deployment.

Each root dependency uses `policy.open-cluster-management.io/v1`, kind `Policy`,
namespace `open-cluster-management-policies`, and compliance `Compliant`.
`ignorePending` is false; the generator can omit the default false value.
The [control-plane Policies](../../control-plane/README.md) already depend on
Operator, Namespace, network identity and CNI governance. Compliance does not
establish control-plane readiness or injection webhook availability.

Local generation uses upstream PolicyGenerator v0.19.0. It does not establish
equivalence with the Red Hat ACM 2.17 distribution or validate live admission.

## Exposure and deployment checks

The Service declares ports matching both existing Gateway servers. Declaring
443 does not provision certificates or establish working HTTPS. The existing
`OPTIONAL_MUTUAL` setting is preserved; its compatibility and certificate
requirements must be reviewed against the selected installation. The original
laboratory configuration was tested on OpenShift; these new workload sources
have only offline rendering validation.

No AWS annotations, load-balancer class or addresses are specified. The cluster's
configured load-balancer integration determines exposure when separately
provisioned. This entrypoint neither selects nor proves allocation of an AWS NLB.
NLB TCP passthrough, public TLS, redirects and Keycloak origin changes are outside
this workload configuration.

Before provisioning, verify ManagedCluster identities and PlacementDecision
membership, the installed Operator and healthy CNI, a Ready Istio control plane,
the `istio-ingress` Namespace, and an operational gateway injection webhook.
After provisioning, verify the default ServiceAccount's RBAC, SCC admission,
the injected proxy image and readiness probe, actual Envoy listeners, Ready Pods,
Service endpoints and external LoadBalancer allocation. Exercise `/` to UI and `/api` to Orchestrator
through the [existing ingress routes](../../../../ossm/virtual-service.yaml),
including their authority rewrite and session-affinity behavior.

Review HTTPS admission and runtime compatibility separately; revalidate Keycloak
redirects when the TLS design is applied. Networking Policies use source-defined
enforcement and require staged API and runtime readiness checks before propagation.
Workload enforcement can create resources, but compliance does not prove that
ingress is operational.
