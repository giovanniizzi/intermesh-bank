# East-West Gateway infrastructure

Each managed cluster has one East-West workload in `istio-east-west`. Both logical
East-West Gateways select it: L4 `AUTO_PASSTHROUGH` and Orchestrator L7
`ISTIO_MUTUAL`, on port 15443. There is no separate L7 Deployment. See the
[mesh routing guide](../../../../../../service-mesh/README.md#ingress-and-east-west-routing).

## Resources and runtime configuration

The shared [base](../../../../../../platform/openshift/ossm/gateways/eastwest/base/kustomization.yaml)
contains seven resources:

| Resource | Name and role |
| --- | --- |
| ServiceAccount | `istio-eastwestgateway-service-account`, used by Deployment and RoleBinding. |
| Deployment | `istio-eastwestgateway`, injected gateway proxy with `image: auto`. |
| LoadBalancer Service | `istio-eastwestgateway`, selecting the gateway Pods. |
| Role and RoleBinding | `istio-eastwestgateway-sds`, granting the ServiceAccount namespace-wide Secret `get/watch/list`. |
| HPA | `istio-eastwestgateway`, 1–5 replicas with CPU utilization target 80%. |
| PDB | `istio-eastwestgateway`, `minAvailable: 1` for the same Pods. |

The Service exposes TCP ports 15021 (status), 15443 (TLS), 15012 (Istiod TLS) and
15017 (webhook TLS), each mapped to the same targetPort. Exposure does not create
listeners or control-plane forwarding routes. Validate the intended reachability
of each port. The proxy declares metrics port 15090; Prometheus annotations use
15020 and `/stats/prometheus`, which also require runtime verification.

The Deployment has CPU/memory requests `100m`/`128Mi`, limits `2000m`/`1024Mi` and
rolling-update values `100%`/`25%`. It omits a replica count so the HPA controls
scaling. With one ready Pod, the PDB can block voluntary eviction. The source adds
no explicit readiness probe or Pod sysctl; inspect injector-supplied settings and
OpenShift admission on actual Pods.

Optional read-only mounts reference `istio-ingressgateway-certs` at
`/etc/istio/ingressgateway-certs` and `istio-ingressgateway-ca-certs` at
`/etc/istio/ingressgateway-ca-certs`, both in `istio-east-west`. No certificate
material is generated. Optional references alone do not require creating these
Secrets; mesh `ISTIO_MUTUAL` uses mesh credentials. Restrict access to the
ServiceAccount because its Role can read all namespace Secrets.

## Network-specific configuration

The [network1](../../../../../../platform/openshift/ossm/gateways/eastwest/network1/kustomization.yaml)
and [network2](../../../../../../platform/openshift/ossm/gateways/eastwest/network2/kustomization.yaml)
overlays set `topology.istio.io/network` labels/selectors on the corresponding
resources and `ISTIO_META_REQUESTED_NETWORK_VIEW`. Each network uses only its
matching overlay. Both retain `ISTIO_META_UNPRIVILEGED_POD: "true"`, gateway
injection metadata and the dedicated ServiceAccount.

Both logical Gateways select `istio: eastwestgateway`; authority rewriting,
DestinationRules and cookies are supplied by separate mesh resources. Standalone
profiles consume these platform overlays directly; ACM consumes them through
contained inputs and network-specific Policies. Application-only overlays do not
contain gateway infrastructure.

## Governance and rendering

From the repository root:

```sh
oc kustomize platform/openshift/ossm/gateways/eastwest/network1
oc kustomize platform/openshift/ossm/gateways/eastwest/network2
oc kustomize deploy/acm/policies/platform/gateways/eastwest --enable-alpha-plugins
```

Each ordinary overlay renders seven resources. Governance renders four Hub objects:

| Policy | Binding | Placement | Dependency |
| --- | --- | --- | --- |
| `intermesh-eastwest-network1` | `binding-intermesh-eastwest-network1` | `placement-intermesh-network1` | `intermesh-istio-network1` |
| `intermesh-eastwest-network2` | `binding-intermesh-eastwest-network2` | `placement-intermesh-network2` | `intermesh-istio-network2` |

Each ConfigurationPolicy contains seven object-templates. Parent and embedded
remediation are `enforce`, comparison is `musthave`, pruning and recreation are
`None`, and `ignorePending` defaults to false. Dependencies require same-cluster
`Compliant` Policies in `open-cluster-management-policies`. Placements use the
project-defined `ossm-enabled` and `ossm-network` labels. The full ACM aggregate
includes the Policies; no Placement or standalone workload is generated here.

## Operational checks

Follow the [runbook](../../../../../../docs/acm-deployment-readiness.md) for trust,
remote discovery, API readiness and gateway checkpoints. Inspect injection, SCC
admission, effective proxy settings, SDS access, optional volumes, metrics, HPA/PDB
behavior, endpoints and load-balancer reachability. Then validate L4 workload
identity, L7 Orchestrator routing, cookie affinity and the Fraud timeout scenario.
Policy compliance alone does not establish these behaviors.

The source configuration follows the Red Hat release-3.4
[network1](https://github.com/openshift-service-mesh/sail-operator/blob/release-3.4/docs/deployment-models/resources/east-west-gateway-net1.yaml)
and [network2](https://github.com/openshift-service-mesh/sail-operator/blob/release-3.4/docs/deployment-models/resources/east-west-gateway-net2.yaml)
examples with gateway namespace `istio-east-west`. Source similarity is not proof
of identical admitted Pods or live compatibility across Operator versions.
