# Networking, discovery and security governance

ACM creates and reconciles the Istio resources covered by this entrypoint. All
twelve parent Policies and embedded ConfigurationPolicies declare `enforce` in
their source definitions. They use `musthave`, with pruning and automatic
recreation set to `None`; `ignorePending` defaults to `false`.

The application Kustomizations remain authoritative rendering and validation
references. Do not also apply ACM-owned resources manually to managed clusters.

## Logical gateways and Fraud routing

The three Policies below consume the ordinary
[Gateway base](../../../../service-mesh/networking/gateways/kustomization.yaml) and
[VirtualService base](../../../../service-mesh/traffic-management/virtual-services/kustomization.yaml)
through explicit local PolicyGenerator inputs. Each Istio resource has one shared
authoritative definition.

[`istio-gateway`](istio-gateway.yaml) reconciles the Ingress Gateway and L4
East-West `AUTO_PASSTHROUGH` Gateway. [`orchestrator-session`](orchestrator-session.yaml)
reconciles the dedicated L7 `ISTIO_MUTUAL` Gateway and Orchestrator VirtualService.
Both use the shared Placement and require the Operator and infrastructure
namespace Policies to be `Compliant`.

[`istio-fraud-analytics-chaos`](acm-fraud-analytics-vs.yaml) reconciles the Fraud
Analytics VirtualService through the shared Placement. It requires the Operator
and application foundation Policies to be `Compliant`, and preserves the existing
route-header check, fault response and three-second timeout.

Render the shared definitions without executable plugins:

```sh
oc kustomize service-mesh/networking/gateways
oc kustomize service-mesh/traffic-management/virtual-services
```

These entrypoints render three Gateways and three VirtualServices, including
the ingress routes governed by the network-specific routing Policies. Do not apply
them separately alongside ACM enforcement of the same resources.

## Ingress routing

The [standalone profiles](../../../standalone/README.md) render
[`istio-ingress/ingress-routing-mesh`](../../../../service-mesh/traffic-management/virtual-services/ingress/virtual-service.yaml)
through the shared VirtualService base. The same file is the single source for
two network-specific ACM routing Policies:

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

The [network1](../../../../service-mesh/traffic-management/destination-rules/network1/kustomization.yaml) and
[network2](../../../../service-mesh/traffic-management/destination-rules/network2/kustomization.yaml) DestinationRules are selected
by their corresponding standalone profiles. ACM reconciles
each rule through one network-specific Policy:

| Policy | Existing Placement | Required control-plane Policy |
|---|---|---|
| [`intermesh-affinity-network1`](policy-generator-affinity-network1.yaml) | `placement-intermesh-network1` | `intermesh-istio-network1` |
| [`intermesh-affinity-network2`](policy-generator-affinity-network2.yaml) | `placement-intermesh-network2` | `intermesh-istio-network2` |

The rules use cookie-based consistent hashing with `network1.session`
and `network2.session`, respectively, and cookie TTL `0s`. Each Policy contains
one DestinationRule template and also requires `intermesh-app-foundation` to be
`Compliant` before creating the rule in `intermesh-backend`.

Control-plane dependency compliance does not establish Orchestrator Service
availability or working session affinity. Validate local and cross-network
cookie affinity, the L7 East-West route and workload-unavailability scenarios
on the deployed mesh.

## Static security

The [`intermesh-security-static`](policy-generator-security-static.yaml) Policy
reconciles [`deny-orchestrator-without-jwt`](../../../../service-mesh/security/authorization-policies/static/deny-orchestrator-without-jwt.yaml)
through the shared `placement-all-clusters` Placement. The AuthorizationPolicy
selects Orchestrator and denies requests without an authenticated request principal
on workload port `8080`.

The same Policy includes four ALLOW AuthorizationPolicies, for five governed
resources in total:

- [`allow-ingress-to-orchestrator`](../../../../service-mesh/security/authorization-policies/static/allow-hub-to-orchestrator.yaml).
- [`allow-ingress-to-frontend`](../../../../service-mesh/security/authorization-policies/static/allow-ingress-to-ui-api.yaml).
- [`orchestrator-to-ledger`](../../../../service-mesh/security/authorization-policies/static/allow-orchestrator-to-ledger.yaml).
- [`rbac-fraud-analytics`](../../../../service-mesh/security/authorization-policies/static/allow-orchestrator-to-analytics.yaml).

The static-security source base contains exactly these five active policies.
Issuer-dependent RequestAuthentication and `require-jwt-policy` governance are
covered by the separate OIDC Policy.

The Policy consumes the shared static-security base through a local generator
input and requires the shared `intermesh-ossm-operator` and
`intermesh-app-foundation` Policies to be `Compliant`.
The foundation provides both application namespaces before resource creation.
Compliance reports configuration agreement, not runtime authentication enforcement.

## Internal service discovery

The [`intermesh-discovery-internal`](policy-generator-discovery-internal.yaml)
Policy reconciles the active internal
[`intermesh-backend/intermesh-orchestrator-se`](../../../../service-mesh/networking/service-entries/internal/intermesh-orchestrator-se.yaml)
ServiceEntry. It consumes the shared internal-discovery base through a local
generator input, uses the shared `placement-all-clusters` Placement and requires
`intermesh-ossm-operator` and
`intermesh-app-foundation` to be `Compliant`.

The ServiceEntry retains its ordered subject alternative names:

- `spiffe://cluster.local/ns/intermesh-backend/sa/intermesh-orchestrator-sa`
- `spiffe://cluster.local/ns/istio-east-west/sa/istio-eastwestgateway-service-account`

Compliance does not establish Istio runtime readiness or working service discovery.

Only the Orchestrator internal ServiceEntry is included. External PostgreSQL and
Keycloak ServiceEntries are covered by the separate external discovery Policy.

## External service discovery

The [`intermesh-discovery-external`](policy-generator-discovery-external.yaml)
Policy reconciles the shared [PostgreSQL](../../../../service-mesh/networking/service-entries/external/serviceentry-db.yaml)
and [Keycloak](../../../../service-mesh/networking/service-entries/external/serviceentry-keycloak.yaml) ServiceEntries, in that
order, through one ConfigurationPolicy. It reuses `placement-all-clusters` and
requires `intermesh-ossm-operator` and `intermesh-app-foundation` to be `Compliant`.

Public rendering retains placeholder hosts. The private ACM overlay uses the
shared `postgresHost` and `keycloakUrl` values to replace only the embedded
ServiceEntry hosts after PolicyGenerator runs. Identity and public-placeholder
tests run first. These definitions must match the private standalone resources
in both networks. See the [private configuration instructions](../../../../docs/examples/README.md#hub-governance-overlay).

Configure actual DNS values in `.local/configuration/values/values.yaml` before
deployment. Hostnames remain visible to Policy readers; keep credentials separate
and private renderings out of public artifacts. Validate reachability and TLS on
the deployed mesh. A ServiceEntry does not establish PostgreSQL egress isolation.

## OIDC security

The [`intermesh-security-oidc`](policy-generator-security-oidc.yaml) Policy
reconciles the shared [RequestAuthentication](../../../../service-mesh/security/request-authentications/jwt-request-authentication.yaml)
and [AuthorizationPolicy](../../../../service-mesh/security/authorization-policies/oidc/jwt-authorization-policy.yaml), in that order, through
one ConfigurationPolicy. It reuses `placement-all-clusters` and requires
`intermesh-ossm-operator` and `intermesh-app-foundation` to be `Compliant`.
Selectors, token forwarding and ALLOW/DENY composition come from the shared resources.

The private ACM overlay derives the embedded JWT issuer, JWKS URI and
request-principal pattern from the shared `keycloakUrl`. Identity and
public-placeholder guards remain intact and execute before replacements.
Compare both security resources with private standalone output, preserving scalar
types and array ordering, after every configuration change.

Keep the UI Keycloak base URL, realm, Orchestrator verification issuer, Istio
issuer/JWKS/principal fields and Keycloak ServiceEntry host coherent. These are
different formats of related configuration, not interchangeable strings. The
configured URLs are visible to Policy readers and must not contain credentials.

Replace placeholder endpoints before deployment and repeat private/source
equivalence checks. Validate DNS, TLS, JWKS retrieval, JWT rejection and browser
login across both networks using the
[operational verification matrix](../../../../docs/acm-deployment-readiness.md#functional-verification-matrix).
For routing, session and application security behavior, see the
[Service Mesh guide](../../../../service-mesh/README.md).

## Rendering and validation

From the repository root, render Hub governance with the installed trusted
PolicyGenerator plugin:

```sh
oc kustomize deploy/acm/policies/service-mesh --enable-alpha-plugins
```

Render the complete private Hub governance aggregate:

```sh
oc kustomize .local/deploy/acm --enable-alpha-plugins
```

Use the private output for environment-specific expectations after validation;
the public output retains non-deployable placeholders. The service-mesh entrypoint
renders 24 Hub objects; the private Hub aggregate renders 55. Compared with the
[public Hub aggregate](../../kustomization.yaml), the private output
also configures application images, UI and Orchestrator Keycloak settings and
the WasmPlugin OCI URL. Within networking governance it differs only in five
expected values: two ServiceEntry hosts, the JWT issuer, JWKS URI and
request-principal pattern. Hub Keycloak provisioning is separate.

The entrypoint renders twelve Policies and twelve PlacementBindings. Placements
are defined only in the central placements group. The
[Wasm group](wasm/kustomization.yaml) supplies the plugin Policy and binding.
It emits no standalone VirtualService, DestinationRule,
RequestAuthentication, AuthorizationPolicy or ServiceEntry. The generator inputs
are local files or Kustomize directories beneath this Kustomization directory.
Standalone rendering does not require the plugin and includes the shared
VirtualServices and matching network's DestinationRule directly. Application-only
overlays contain eight workload resources and do not include mesh configuration.

Compliance of the [ingress workload Policy](../platform/gateways/ingress/README.md)
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
[Hub deployment prerequisites](../../README.md#prerequisites-and-runtime-checks).

Application Deployments, Services and WasmPlugin are governed through the separate
[application entrypoint](../applications/README.md). Channel Hub is not an active
application dependency.
