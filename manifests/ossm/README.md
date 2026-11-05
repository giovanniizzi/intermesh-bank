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

The same observer includes four ALLOW AuthorizationPolicies, for five observed
resources in total:

- [`allow-ingress-to-orchestrator`](policies/allow-hub-to-orchestrator.yaml).
- [`allow-ingress-to-frontend`](policies/allow-ingress-to-ui-api.yaml).
- [`orchestrator-to-ledger`](policies/allow-orchestrator-to-ledger.yaml).
- [`rbac-fraud-analytics`](policies/allow-orchestrator-to-analytics.yaml).

The frontend source also contains `allow-ingress-to-intermesh-channel-hub`.
A targeted `$patch: delete` excludes that document only from PolicyGenerator
input; it does not remove it from application rendering or delete it from a
cluster. Issuer-dependent RequestAuthentication and `require-jwt-policy`
governance are outside this observer's scope.

The observer references the original manifests directly and requires the shared
`intermesh-ossm-operator` Policy to be `Compliant`. Its parent Policy and embedded
ConfigurationPolicy use `inform`, with `musthave` comparison, pruning and
automatic recreation set to `None`, and `ignorePending: false`. ACM does not
create, update or delete the AuthorizationPolicies; the
[shared application base](../kustomization.yaml) retains deployment ownership.
Compliance reports configuration agreement, not runtime authentication enforcement.

## Internal service discovery

The [`intermesh-discovery-internal`](policy-generator-discovery-internal.yaml)
Policy observes the active internal
[`intermesh-backend/intermesh-orchestrator-se`](serviceentry/intermesh-orchestrator-se.yaml)
ServiceEntry. It references the original source directly, uses the shared
`placement-all-clusters` Placement and requires `intermesh-ossm-operator` to be
`Compliant`.

The ServiceEntry retains its ordered subject alternative names:

- `spiffe://cluster.local/ns/intermesh-backend/sa/intermesh-orchestrator-sa`
- `spiffe://cluster.local/ns/istio-east-west/sa/istio-eastwestgateway-service-account`

The parent Policy and embedded ConfigurationPolicy use `inform`. The observer
uses `musthave` comparison, with pruning and automatic recreation set to `None`
and `ignorePending: false`.
Application Kustomize retains deployment ownership; ACM only observes compliance.
Compliance does not establish Istio runtime readiness or working service discovery.

The four retired internal ServiceEntry sources for UI, Ledger, Fraud Analytics
and Channel Hub remain commented out and excluded from application rendering
and observation. External PostgreSQL and Keycloak ServiceEntries are outside
this observer's scope.

## External service discovery

The [`intermesh-discovery-external`](policy-generator-discovery-external.yaml)
Policy observes the original [PostgreSQL](serviceentry/serviceentry-db.yaml)
and [Keycloak](serviceentry/serviceentry-keycloak.yaml) ServiceEntries, in that
order, through one ConfigurationPolicy. It reuses `placement-all-clusters` and
requires `intermesh-ossm-operator` to be `Compliant`. Both remediation modes are
`inform`, comparison is `musthave`, pruning and recreation are `None`, and
`ignorePending` defaults to `false`. Application Kustomize remains the deployment
owner; ACM does not create, update or delete these ServiceEntries.

Public rendering retains the original placeholder hosts. The ignored private
Hub overlay patches only the two hostnames inside the generated Policy's
ServiceEntry expectations, after PolicyGenerator runs. JSON Patch identity and
placeholder tests guard both replacements. The complete expected definitions
must match the effective private application resources in both networks before
using a shared Policy. See the [private Hub overlay example](../examples/hub-governance.kustomization.example.yaml)
and [configuration instructions](../examples/README.md#hub-governance-overlay).

Keep environment-specific values under `.local/`. Configured hostnames are
visible to users authorized to read Hub and propagated Policy resources; never
store credentials in these patches or publish private rendered output. The same
nested-patch model can support OIDC expectations separately; this observer does
not include OIDC or WasmPlugin resources.

Deployment is blocked while private hostnames are nonfunctional test values.
Replace them with valid environment-specific DNS names in the application and
Hub overlays, re-render both private application overlays and the private Hub
overlay, and require exact ServiceEntry equality again before deployment.
Validate reachability and TLS behavior separately on real clusters; compliance
does not prove connectivity or establish egress isolation.

## Rendering and validation

From the repository root, render Hub governance with the installed trusted
PolicyGenerator plugin:

```sh
oc kustomize manifests/ossm --enable-alpha-plugins
```

Render private networking governance from the same public base:

```sh
oc kustomize .local/hub-governance --enable-alpha-plugins
```

Use the private output for environment-specific expectations after validation;
the public output retains non-deployable placeholders. Both entrypoints render
the same resource identities and differ only in the two expected hostnames.
Infrastructure governance and Hub Keycloak provisioning remain separate entrypoints.

The entrypoint renders ten Policies, ten PlacementBindings and one shared
Placement. It emits no standalone VirtualService, DestinationRule,
AuthorizationPolicy or ServiceEntry. The generator inputs are local files or
Kustomize directories beneath this Kustomization directory. Application rendering
does not require the plugin and
continues to include the VirtualService and each network's DestinationRule directly.

Compliance of the [ingress workload Policy](../infrastructure/mesh/gateways/ingress/README.md)
does not prove the gateway Deployment is Ready or its LoadBalancer is reachable.
Validate gateway readiness, TLS, browser `/` and `/api` routing, authority rewriting
and cross-network session affinity on the deployed mesh. Offline rendering and
Policy compliance do not establish runtime readiness.
