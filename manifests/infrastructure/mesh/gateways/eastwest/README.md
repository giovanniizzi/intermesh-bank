# East-West Gateway infrastructure

This entrypoint reproduces the two East-West workload configurations from
"Sidecar with Istio API", Steps 5 and 8, in the original
`OSSM3 - multicluster networking.docx` procedure. Each managed cluster receives
one shared gateway workload selected by both existing logical East-West Gateways:
L4 `AUTO_PASSTHROUGH` and Orchestrator L7 `ISTIO_MUTUAL`, on port 15443.
There is no separate L7 Deployment.

## Historical resource inventory

All seven resources belong to `istio-east-west` in each managed cluster.

| Source | API / kind | Name and relationships |
|---|---|---|
| [ServiceAccount](base/service-account.yaml) | `v1 / ServiceAccount` | `istio-eastwestgateway-service-account`; used by the Deployment and RoleBinding |
| [Deployment](base/deployment.yaml) | `apps/v1 / Deployment` | `istio-eastwestgateway`; gateway-injected `istio-proxy`, `image: auto` |
| [Service](base/service.yaml) | `v1 / Service` | `istio-eastwestgateway`; LoadBalancer selecting the gateway Pods |
| [Role](base/role.yaml) | `rbac.authorization.k8s.io/v1 / Role` | `istio-eastwestgateway-sds`; `get`, `watch`, `list` on namespace Secrets |
| [RoleBinding](base/role-binding.yaml) | `rbac.authorization.k8s.io/v1 / RoleBinding` | `istio-eastwestgateway-sds`; binds that Role to the historical ServiceAccount |
| [HPA](base/hpa.yaml) | `autoscaling/v2 / HorizontalPodAutoscaler` | `istio-eastwestgateway`; targets the Deployment, 1–5 replicas, CPU utilization target 80% |
| [PDB](base/pdb.yaml) | `policy/v1 / PodDisruptionBudget` | `istio-eastwestgateway`; selects the same Pods, `minAvailable: 1` |

The base retains all common historical labels, annotations, resource settings,
security settings, affinity fields and optional certificate mounts. Labels such
as `heritage: Tiller`, `istio.io/rev: default` and
`install.operator.istio.io/owning-resource: unknown` are preserved as source
fields; they do not establish a Helm release or an owner reference.

The original Service ports and targetPorts are identical:

| Name | TCP port / targetPort |
|---|---|
| `status-port` | 15021 |
| `tls` | 15443 |
| `tls-istiod` | 15012 |
| `tls-webhook` | 15017 |

The proxy also declares metrics port 15090. Historical Prometheus annotations
retain port `15020`, path `/stats/prometheus` and scraping enabled. Declaring
Service ports does not prove corresponding Envoy listeners or Istiod/webhook
forwarding exist; the existing networking resources are governed separately.

The Deployment retains CPU/memory requests `100m`/`128Mi`, limits
`2000m`/`1024Mi`, rolling-update values `100%`/`25%`, and its original container
security settings. No explicit replica count, probe or Pod sysctl is added.

Optional, read-only volume references remain unchanged:

- `ingressgateway-certs`: Secret `istio-ingressgateway-certs`, mounted at
  `/etc/istio/ingressgateway-certs`.
- `ingressgateway-ca-certs`: Secret `istio-ingressgateway-ca-certs`, mounted at
  `/etc/istio/ingressgateway-ca-certs`.

Both Secrets are referenced in `istio-east-west`, not `istio-ingress`.
No Secret or certificate material is generated. The namespace-wide Secret-reading
grant is preserved rather than narrowed; access to this ServiceAccount must be
restricted accordingly.

## Network-specific overlays

The ordinary [network1](network1/kustomization.yaml) and
[network2](network2/kustomization.yaml) overlays supply only the ten original
network-dependent fields:

- `metadata.labels["topology.istio.io/network"]` on the ServiceAccount,
  Deployment, Service, HPA and PDB.
- The same network label in the Deployment and PDB selectors, the Deployment
  Pod labels and the Service selector.
- Proxy environment variable `ISTIO_META_REQUESTED_NETWORK_VIEW`.

Every value is `network1` or `network2` in the corresponding overlay. Both retain
`ISTIO_META_UNPRIVILEGED_POD: "true"`, gateway injection annotations and labels,
and ServiceAccount `istio-eastwestgateway-service-account`. The existing
[L4 Gateway](../../../../ossm/istio-gateway.yaml) and
[L7 Gateway](../../../../ossm/orchestrator-session.yaml) both select
`istio: eastwestgateway`. Authority rewriting, DestinationRules and affinity
cookies remain outside this entrypoint.

## Hub governance and offline rendering

From the repository root:

```sh
oc kustomize manifests/infrastructure/mesh/gateways/eastwest/network1
oc kustomize manifests/infrastructure/mesh/gateways/eastwest/network2
oc kustomize manifests/infrastructure/mesh/gateways/eastwest --enable-alpha-plugins
```

Each ordinary overlay renders seven resources. The generator consumes descendant
directories and emits only these four Hub objects in
`open-cluster-management-policies`:

| Policy | PlacementBinding | Existing Placement | Required Policy |
|---|---|---|---|
| `intermesh-eastwest-network1` | `binding-intermesh-eastwest-network1` | `placement-intermesh-network1` | `intermesh-istio-network1` |
| `intermesh-eastwest-network2` | `binding-intermesh-eastwest-network2` | `placement-intermesh-network2` | `intermesh-istio-network2` |

Each Policy contains one ConfigurationPolicy with seven object-templates.
Dependencies require `Compliant` using API `policy.open-cluster-management.io/v1`,
kind `Policy`, and the governance namespace. Parent and embedded remediation settings are
`enforce`; comparison is `musthave`; pruning and recreation are `None`.
`ignorePending` is false, which the generator can omit as the default. The
existing [network Placements](../../../network-identity/README.md) select
`ossm-enabled: "true"` and the corresponding project-defined `ossm-network` label.

No Placement or standalone managed-cluster resource is emitted in the Hub output.
Existing application, ingress and networking entrypoints do not include this
entrypoint. ACM can create and reconcile the workload, but compliance does not prove
control-plane, injection webhook or gateway readiness.

Field-by-field comparison covers both extracted historical resource sets,
including labels, arrays, selectors, RBAC, environment variables, volumes, HPA
and PDB. The sole ordinary-render normalization is omission of the Service's
`metadata.annotations: null`: the base preserves that field, while Kustomize
omits the null optional map. Null and absent annotations represent the same
empty Kubernetes metadata value. No other field is normalized or removed.

## Provenance and runtime checks

The historical configurations match the Red Hat release-3.4 Sail Operator
[network1](https://github.com/openshift-service-mesh/sail-operator/blob/release-3.4/docs/deployment-models/resources/east-west-gateway-net1.yaml)
and [network2](https://github.com/openshift-service-mesh/sail-operator/blob/release-3.4/docs/deployment-models/resources/east-west-gateway-net2.yaml)
examples after changing only resource namespaces from `istio-system` to the
historical `istio-east-west`. The historical namespaces are preserved here.
Current examples and injector defaults are compatibility evidence, not authority
to replace the original fields.

Before separately authorized provisioning, verify namespace and PlacementDecision
membership, healthy CNI and control planes, shared mesh trust and operational
gateway injection. Check SCC admission, the effective injected image, metadata,
volumes, readiness probe and any injector-supplied sysctls against the selected
OSSM 3.4 installation on RHCOS 9.x. Source fidelity does not establish identical
admitted Pods across versions.

Verify Metrics API availability and HPA behavior. With one ready replica,
`minAvailable: 1` can block voluntary eviction; this original behavior is retained.
Validate Prometheus scraping, optional certificate handling, SDS permissions,
Service endpoints, LoadBalancer addresses and inter-cluster reachability.
Finally inspect the L4/L7 filter chains and test end-to-end mTLS identities,
Orchestrator HTTP routing, cookie affinity, failover and the ACM Fraud timeout
scenario. Ports 15012/15017 are preserved without adding control-plane exposure
routes. Networking Policies use source-defined enforcement and require staged API
and runtime readiness checks before propagation.

Local generation uses upstream PolicyGenerator v0.19.0 and does not establish
equivalence with the Red Hat ACM 2.17 distribution. Rendering is not a cluster
admission or runtime compatibility test. No historical field has been changed
to address an unverified compatibility concern.

References: [OSSM 3.4 multi-cluster installation](https://docs.redhat.com/en/documentation/red_hat_openshift_service_mesh/3.4/html/installing/ossm-multi-cluster-topologies),
[OSSM 3.4 gateway injection](https://docs.redhat.com/en/documentation/red_hat_openshift_service_mesh/3.4/html/gateways/ossm-about-gateways),
[Red Hat gateway injection template](https://github.com/openshift-service-mesh/istio/blob/release-1.30/manifests/charts/istio-control/istio-discovery/files/gateway-injection-template.yaml).
