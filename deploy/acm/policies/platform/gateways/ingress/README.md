# Ingress Gateway workload governance

This group governs the public gateway workload in `istio-ingress` on both managed
clusters. It consumes the shared [platform base](../../../../../../platform/openshift/ossm/gateways/ingress/kustomization.yaml):

- [Service](../../../../../../platform/openshift/ossm/gateways/ingress/service.yaml) `istio-ingressgateway`.
- [Deployment](../../../../../../platform/openshift/ossm/gateways/ingress/deployment.yaml) `istio-ingressgateway`.
- [Role](../../../../../../platform/openshift/ossm/gateways/ingress/role.yaml) `istio-ingressgateway-sds`.
- [RoleBinding](../../../../../../platform/openshift/ossm/gateways/ingress/role-binding.yaml) `istio-ingressgateway-sds`.

Both networks use identical workload definitions. Standalone profiles consume the
same base directly; ACM includes the two Policies in its aggregate. Application-only
overlays contain neither gateway workloads nor governance.

## Injection, identity and listeners

The Deployment requests the gateway injection template with annotation
`inject.istio.io/templates: gateway`, Pod label `sidecar.istio.io/inject: "true"`
and container `istio-proxy` with `image: auto`. The injection webhook replaces that
placeholder during admission. `auto` is not a published image. Deployment, Service
and the [logical Gateway](../../../../../../service-mesh/networking/gateways/ingress/ingress-gateway.yaml)
all select `istio: ingressgateway`.

No explicit `serviceAccountName` is set; Pods use namespace ServiceAccount
`default`. The RoleBinding grants it `get`, `watch` and `list` on all Secrets in
`istio-ingress`. Restrict namespace writers and avoid unrelated workloads/Secrets:
any workload using that identity receives the same access. Changes to the identity
or permissions must account for TLS/SDS authorization and OpenShift admission.
The grant alone does not establish which credentials the proxy actually uses.

| Service port | Logical Gateway port | Service targetPort / intended Envoy listener |
| --- | --- | --- |
| 80 | HTTP 80 | 8080 |
| 443 | HTTPS 443 | 8443 |

The high-port model does not require a Pod sysctl or low-port capabilities in the
Deployment. Gateway server ports are resolved through matching Service targetPorts.
The source declares no container ports, replicas, container security context or
resource requests/limits. Injection, Kubernetes defaults and OpenShift admission
determine the actual Pod configuration.

The gateway injection template supplies proxy setup and a readiness probe on
`/healthz/ready`, port 15021; that port is not exposed by this LoadBalancer Service.
Injector defaults can also add a low-port sysctl, so its absence in the Deployment
does not establish its absence in admitted Pods. Inspect the effective Pod and
Envoy listeners on the selected installation.

## Governance and rendering

From the repository root:

```sh
oc kustomize platform/openshift/ossm/gateways/ingress
oc kustomize deploy/acm/policies/platform/gateways/ingress --enable-alpha-plugins
```

The ordinary base renders four resources. Governance renders two Policies and two
PlacementBindings in `open-cluster-management-policies`; each ConfigurationPolicy
contains four object-templates.

| Policy | Binding | Placement | Dependency |
| --- | --- | --- | --- |
| `intermesh-ingress-network1` | `binding-intermesh-ingress-network1` | `placement-intermesh-network1` | `intermesh-istio-network1` |
| `intermesh-ingress-network2` | `binding-intermesh-ingress-network2` | `placement-intermesh-network2` | `intermesh-istio-network2` |

Dependencies require same-cluster `Compliant` Policies in the governance namespace.
Parent and embedded remediation are `enforce`, comparison is `musthave`, pruning
and recreation are disabled, and `ignorePending` defaults to false. Placement uses
the project-defined `ossm-enabled` and `ossm-network` labels. No Placement, Secret
or standalone gateway workload is emitted in Hub output.

## Operational checks

Use the [staged runbook](../../../../../../docs/acm-deployment-readiness.md) for
Operator, CNI, control-plane, injection and load-balancer checkpoints. Validate the
default ServiceAccount's permissions, SCC admission, injected image, readiness probe,
listeners and endpoints before testing browser `/` and `/api` routing.

The LoadBalancer Service does not select an AWS implementation or TLS termination
mode. Declaring port 443 does not provision certificates or establish HTTPS-only
access. The logical Gateway retains `OPTIONAL_MUTUAL`; its admission, certificate
requirements, redirects and proxy trust require validation against the chosen
[HTTPS design](../../../../../../docs/acm-deployment-readiness.md#public-https-and-cookies).
Policy compliance is not gateway readiness.

References: [OSSM 3.4 gateway injection](https://docs.redhat.com/en/documentation/red_hat_openshift_service_mesh/3.4/html/gateways/ossm-about-gateways),
[Red Hat port resolution](https://github.com/openshift-service-mesh/istio/blob/release-1.30/pilot/pkg/model/gateway.go),
[gateway injection template](https://github.com/openshift-service-mesh/istio/blob/release-1.30/manifests/charts/istio-control/istio-discovery/files/gateway-injection-template.yaml).
