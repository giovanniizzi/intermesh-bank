# Networking observation

## Ingress routing

The application Kustomize workflow deploys
[`istio-ingress/ingress-routing-mesh`](virtual-service.yaml) through the
[shared application base](../kustomization.yaml). The same VirtualService file
is the single source for two network-specific ACM compliance checks:

| Policy | Existing Placement | Required ingress Policy |
|---|---|---|
| [`intermesh-routing-network1`](policy-generator-ingress-network1.yaml) | `placement-intermesh-network1` | `intermesh-ingress-network1` |
| [`intermesh-routing-network2`](policy-generator-ingress-network2.yaml) | `placement-intermesh-network2` | `intermesh-ingress-network2` |

Each Policy also requires the shared [`istio-gateway`](istio-gateway.yaml) Policy
to be `Compliant`. Dependencies are evaluated on the same managed cluster.
An unresolved prerequisite, including a dependency-pending `istio-gateway`, can
leave the routing Policy pending; enabling enforcement is not a workaround.

Each generated Policy contains one ConfigurationPolicy with one VirtualService
object-template. All Policies and ConfigurationPolicies in this entrypoint use
`inform`. The new checks use `musthave`, with pruning and automatic recreation
set to `None`. ACM observes the VirtualService without creating, updating or
removing it. Application Kustomize retains deployment ownership; an enforcing
ownership cutover is outside this configuration.

## Session affinity

The [network1](destination-rules/network1/kustomization.yaml) and
[network2](destination-rules/network2/kustomization.yaml) DestinationRules remain
deployed by their corresponding application Kustomize overlays. ACM observes
each rule through one network-specific Policy:

| Policy | Existing Placement | Required control-plane Policy |
|---|---|---|
| [`intermesh-affinity-network1`](policy-generator-affinity-network1.yaml) | `placement-intermesh-network1` | `intermesh-istio-network1` |
| [`intermesh-affinity-network2`](policy-generator-affinity-network2.yaml) | `placement-intermesh-network2` | `intermesh-istio-network2` |

The original rules retain cookie-based consistent hashing with `network1.session`
and `network2.session`, respectively, and cookie TTL `0s`. Each observer contains
one DestinationRule template, uses `inform` and `musthave`, and sets pruning and
automatic recreation to `None`. ACM does not create, update or delete the rules;
deployment ownership is unchanged. Enforcement requires a separate ownership
review.

Control-plane dependency compliance does not establish Orchestrator Service
availability or working session affinity. Validate local and cross-network
cookie affinity, the L7 East-West route and workload-unavailability scenarios
on the deployed mesh.

## Static security

The [`intermesh-security-static`](policy-generator-security-static.yaml) Policy
observes [`deny-orchestrator-without-jwt`](policies/deny-orchestrator-without-jwt.yaml)
through the shared `placement-all-clusters` Placement. The AuthorizationPolicy
selects Orchestrator and denies requests without an authenticated request principal
on workload port `8080`.

The observer references the original manifest directly and requires the shared
`intermesh-ossm-operator` Policy to be `Compliant`. Its parent Policy and embedded
ConfigurationPolicy use `inform`, with `musthave` comparison, pruning and
automatic recreation set to `None`, and `ignorePending: false`. ACM does not
create, update or delete the AuthorizationPolicy; the
[shared application base](../kustomization.yaml) retains deployment ownership.
Compliance reports configuration agreement, not runtime authentication enforcement.

## Rendering and validation

From the repository root, render Hub governance with the installed trusted
PolicyGenerator plugin:

```sh
oc kustomize manifests/ossm --enable-alpha-plugins
```

The entrypoint renders eight Policies, eight PlacementBindings and one shared
Placement. It emits no standalone VirtualService, DestinationRule or AuthorizationPolicy. The
generator inputs are local files or Kustomize directories beneath this
Kustomization directory. Application rendering does not require the plugin and
continues to include the VirtualService and each network's DestinationRule directly.

Compliance of the [ingress workload Policy](../infrastructure/mesh/gateways/ingress/README.md)
does not prove the gateway Deployment is Ready or its LoadBalancer is reachable.
Validate gateway readiness, TLS, browser `/` and `/api` routing, authority rewriting
and cross-network session affinity on the deployed mesh. Offline rendering and
Policy compliance do not establish runtime readiness.
