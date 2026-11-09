# Networking, discovery and security governance

ACM creates and reconciles the Istio resources covered by this entrypoint. All
eleven parent Policies and embedded ConfigurationPolicies declare `enforce` in
their source definitions. They use `musthave`, with pruning and automatic
recreation set to `None`; `ignorePending` defaults to `false`.

The application Kustomizations remain authoritative rendering and validation
references. Do not also apply ACM-owned resources manually to managed clusters.

## Logical gateways and Fraud routing

[`istio-gateway`](istio-gateway.yaml) reconciles the Ingress Gateway and L4
East-West `AUTO_PASSTHROUGH` Gateway. [`orchestrator-session`](orchestrator-session.yaml)
reconciles the dedicated L7 `ISTIO_MUTUAL` Gateway and Orchestrator VirtualService.
Both use the shared Placement and require the Operator and infrastructure
namespace Policies to be `Compliant`.

[`istio-fraud-analytics-chaos`](acm-fraud-analytics-vs.yaml) reconciles the Fraud
Analytics VirtualService through the shared Placement. It requires the Operator
and application foundation Policies to be `Compliant`, and preserves the existing
route-header check, fault response and three-second timeout.

## Ingress routing

The application Kustomize workflow renders
[`istio-ingress/ingress-routing-mesh`](virtual-service.yaml) through the
[shared application base](../kustomization.yaml). The same VirtualService file
is the single source for two network-specific ACM routing Policies:

| Policy | Existing Placement | Required ingress Policy |
|---|---|---|
| [`intermesh-routing-network1`](policy-generator-ingress-network1.yaml) | `placement-intermesh-network1` | `intermesh-ingress-network1` |
| [`intermesh-routing-network2`](policy-generator-ingress-network2.yaml) | `placement-intermesh-network2` | `intermesh-ingress-network2` |

Each Policy also requires the shared [`istio-gateway`](istio-gateway.yaml) Policy
to be `Compliant`. Dependencies are evaluated on the same managed cluster.
An unresolved prerequisite, including a dependency-pending `istio-gateway`, can
leave the routing Policy pending; enabling enforcement is not a workaround.

Each generated Policy contains one ConfigurationPolicy with one VirtualService
object-template. Its infrastructure namespace prerequisite is covered by the
existing ingress and logical Gateway dependencies.

## Session affinity

The [network1](destination-rules/network1/kustomization.yaml) and
[network2](destination-rules/network2/kustomization.yaml) DestinationRules remain
rendered by their corresponding application Kustomize overlays. ACM reconciles
each rule through one network-specific Policy:

| Policy | Existing Placement | Required control-plane Policy |
|---|---|---|
| [`intermesh-affinity-network1`](policy-generator-affinity-network1.yaml) | `placement-intermesh-network1` | `intermesh-istio-network1` |
| [`intermesh-affinity-network2`](policy-generator-affinity-network2.yaml) | `placement-intermesh-network2` | `intermesh-istio-network2` |

The original rules retain cookie-based consistent hashing with `network1.session`
and `network2.session`, respectively, and cookie TTL `0s`. Each Policy contains
one DestinationRule template and also requires `intermesh-app-foundation` to be
`Compliant` before creating the rule in `intermesh-backend`.

Control-plane dependency compliance does not establish Orchestrator Service
availability or working session affinity. Validate local and cross-network
cookie affinity, the L7 East-West route and workload-unavailability scenarios
on the deployed mesh.

## Static security

The [`intermesh-security-static`](policy-generator-security-static.yaml) Policy
reconciles [`deny-orchestrator-without-jwt`](policies/deny-orchestrator-without-jwt.yaml)
through the shared `placement-all-clusters` Placement. The AuthorizationPolicy
selects Orchestrator and denies requests without an authenticated request principal
on workload port `8080`.

The same Policy includes four ALLOW AuthorizationPolicies, for five governed
resources in total:

- [`allow-ingress-to-orchestrator`](policies/allow-hub-to-orchestrator.yaml).
- [`allow-ingress-to-frontend`](policies/allow-ingress-to-ui-api.yaml).
- [`orchestrator-to-ledger`](policies/allow-orchestrator-to-ledger.yaml).
- [`rbac-fraud-analytics`](policies/allow-orchestrator-to-analytics.yaml).

The frontend source also contains `allow-ingress-to-intermesh-channel-hub`.
A targeted `$patch: delete` excludes that document only from PolicyGenerator
input; it does not remove it from application rendering or delete it from a
cluster. Issuer-dependent RequestAuthentication and `require-jwt-policy`
governance are covered by the separate OIDC Policy.

The Policy references the original manifests directly and requires the shared
`intermesh-ossm-operator` and `intermesh-app-foundation` Policies to be `Compliant`.
The foundation provides both application namespaces before resource creation.
Compliance reports configuration agreement, not runtime authentication enforcement.

## Internal service discovery

The [`intermesh-discovery-internal`](policy-generator-discovery-internal.yaml)
Policy reconciles the active internal
[`intermesh-backend/intermesh-orchestrator-se`](serviceentry/intermesh-orchestrator-se.yaml)
ServiceEntry. It references the original source directly, uses the shared
`placement-all-clusters` Placement and requires `intermesh-ossm-operator` and
`intermesh-app-foundation` to be `Compliant`.

The ServiceEntry retains its ordered subject alternative names:

- `spiffe://cluster.local/ns/intermesh-backend/sa/intermesh-orchestrator-sa`
- `spiffe://cluster.local/ns/istio-east-west/sa/istio-eastwestgateway-service-account`

Compliance does not establish Istio runtime readiness or working service discovery.

The four retired internal ServiceEntry sources for UI, Ledger, Fraud Analytics
and Channel Hub remain commented out and excluded from application rendering
and governance. External PostgreSQL and Keycloak ServiceEntries are covered by
the separate external discovery Policy.

## External service discovery

The [`intermesh-discovery-external`](policy-generator-discovery-external.yaml)
Policy reconciles the original [PostgreSQL](serviceentry/serviceentry-db.yaml)
and [Keycloak](serviceentry/serviceentry-keycloak.yaml) ServiceEntries, in that
order, through one ConfigurationPolicy. It reuses `placement-all-clusters` and
requires `intermesh-ossm-operator` and `intermesh-app-foundation` to be `Compliant`.

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
nested-patch model also supports the separate OIDC Policy below; this external
discovery Policy does not include OIDC or WasmPlugin resources.

Deployment is blocked while private hostnames are nonfunctional test values.
Replace them with valid environment-specific DNS names in the application and
Hub overlays, re-render both private application overlays and the private Hub
overlay, and require exact ServiceEntry equality again before deployment.
Validate reachability and TLS behavior separately on real clusters; compliance
does not prove connectivity or establish egress isolation.

## OIDC security

The [`intermesh-security-oidc`](policy-generator-security-oidc.yaml) Policy
reconciles the original [RequestAuthentication](jwt-request-authentication.yaml)
and [AuthorizationPolicy](jwt-authorization-policy.yaml), in that order, through
one ConfigurationPolicy. It reuses `placement-all-clusters` and requires
`intermesh-ossm-operator` and `intermesh-app-foundation` to be `Compliant`.
The original selectors, token forwarding and ALLOW/DENY behavior are preserved.

The private Hub overlay adds identity-guarded JSON patches for the embedded JWT
issuer, JWKS URI and request-principal pattern. Use the effective private
application values and require complete equality of both security resources
across networks. Compare each Hub expectation against both private application
renderings, preserving scalar types and array order. Keep the ConfigurationPolicy,
template identity and original-placeholder tests intact so a mismatch stops
rendering. Revalidate these duplicated values after every configuration change.

Keep the UI Keycloak base URL, realm, Orchestrator verification issuer, Istio
issuer/JWKS/principal fields and Keycloak ServiceEntry host coherent. These are
different formats of related configuration, not interchangeable strings. The
configured URLs are visible to Policy readers and must not contain credentials.

Deployment remains blocked while private identity-provider and external endpoints
are nonfunctional test placeholders. Configure valid environment values and
repeat private equivalence checks before deployment. Then validate DNS, TLS,
JWKS retrieval, JWT validation, ALLOW/DENY composition and browser login/redirect
behavior across both networks on real clusters. Policy compliance alone does
not establish live authentication or authorization behavior.

## Rendering and validation

From the repository root, render Hub governance with the installed trusted
PolicyGenerator plugin:

```sh
oc kustomize manifests/ossm --enable-alpha-plugins
```

Render the complete private Hub governance aggregate:

```sh
oc kustomize .local/hub-governance --enable-alpha-plugins
```

Use the private output for environment-specific expectations after validation;
the public output retains non-deployable placeholders. The networking entrypoint
renders 23 Hub objects; the private Hub aggregate renders 55. Compared with the
[public Hub aggregate](../hub-governance/kustomization.yaml), the private output
also configures application images, UI and Orchestrator Keycloak settings and
the WasmPlugin OCI URL. Within networking governance it differs only in five
expected values: two ServiceEntry hosts, the JWT issuer, JWKS URI and
request-principal pattern. Hub Keycloak provisioning is separate.

The entrypoint renders eleven Policies, eleven PlacementBindings and one shared
Placement. It emits no standalone VirtualService, DestinationRule,
RequestAuthentication, AuthorizationPolicy or ServiceEntry. The generator inputs
are local files or Kustomize directories beneath this Kustomization directory.
Application rendering
does not require the plugin and
continues to include the VirtualService and each network's DestinationRule directly.

Compliance of the [ingress workload Policy](../infrastructure/mesh/gateways/ingress/README.md)
does not prove the gateway Deployment is Ready or its LoadBalancer is reachable.
Validate gateway readiness, TLS, browser `/` and `/api` routing, authority rewriting
and cross-network session affinity on the deployed mesh. Offline rendering and
Policy compliance do not establish runtime readiness.

## Deployment checkpoints

Shared Policies cannot depend on both network-specific control-plane or gateway
Policies: each of those prerequisites is propagated to only one network. Retain
the shared Operator dependency and verify the required Istio networking and
security APIs and admission webhooks on both clusters before enabling the
networking governance deployment. Namespace creation is ordered through
`intermesh-infra-ns-ingress` for logical Gateways and `intermesh-app-foundation`
for application-namespaced resources; ingress routing inherits its namespace
prerequisite through its existing dependencies.

Check Operator installation and CRDs, CNI readiness, both control planes, gateway
injection and LoadBalancer reachability, then shared trust and remote discovery.
`Compliant` is not a readiness signal. Use staged deployment checkpoints before
propagating enforcing Policies; this entrypoint adds no readiness-gating mechanism.
Configure and validate external endpoints, credentials, image availability and
Ingress HTTPS/TLS before application traffic. See the
[Hub deployment prerequisites](../../overlays/hub-deploy/README.md#prerequisites-and-runtime-checks).

Application Deployments, Services and WasmPlugin are governed through the separate
[application entrypoint](../../overlays/hub-applications/README.md). The dormant
Channel Hub AuthorizationPolicy remains outside ACM deployment coverage; Channel
Hub is not an active application dependency.
