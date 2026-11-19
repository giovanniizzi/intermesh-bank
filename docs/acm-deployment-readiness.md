# ACM deployment readiness and runbook

This runbook starts with an operational ACM 2.17 Hub and two registered managed
OpenShift clusters. It covers OSSM 3.4 Sidecar deployment through ACM, not cluster
provisioning. The Hub also hosts the shared Red Hat build of Keycloak service;
both managed clusters use one external PostgreSQL database. See
[deployment architecture](deployment-architecture.md) for traffic flow and placement.

Offline rendering checks validate source composition and configuration
equivalence. Cluster deployment, API admission, registry access and external
connectivity require runtime validation. Keep private renderings, credentials
and runtime evidence out of Git and public logs.

## Source composition

The [ACM entrypoint](../deploy/acm/kustomization.yaml) renders 55 Hub objects:
26 Policies, 26 PlacementBindings and three Placements. All parent Policies and
their 25 embedded ConfigurationPolicies and one OperatorPolicy use `enforce`.
ConfigurationPolicies retain `musthave` and disabled pruning/recreation. See the
[Hub deployment guide](../deploy/acm/README.md).

Public and private standalone profiles contain 50 resources each: seven
application prerequisites, eight workloads, 17 platform resources and 18 Istio
resources. ACM governs the same source definitions through its Policies and
Placements. Channel Hub has no deployed workload or AuthorizationPolicy; its
ServiceAccount and Keycloak client are retained.

The 81 Kustomize/Component directories render offline, including two private
configuration libraries with no deployment output. The two application network
overlays are shared by standalone rendering and ACM inputs. Use explicit
`deploy/acm` or `deploy/standalone/network1` / `network2` entrypoints; there is no
default repository-root deployment profile. Complete standalone profiles include
platform and mesh infrastructure rather than only application references.

The local toolchain is `oc` 4.22.19, Kustomize 5.7.1 and the installed
PolicyGenerator reporting v0.19.0. This establishes local rendering compatibility,
not certification of that binary as the ACM 2.17 distribution or live compatibility.

## Deployment gates

Resolve these requirements before the corresponding stage. Offline composition
checks are not substitutes for live admission or readiness checks.

| Requirement | Required checkpoint |
| --- | --- |
| Hub and selection | Registered clusters, governance add-ons, ClusterSet access and correct PlacementDecisions. |
| Environment configuration | Real DNS endpoints, published images/Wasm artifact and pull access. Public examples are nonfunctional. |
| Platform | Supported versions, installed Operator, established CRDs/webhooks, healthy CNI and control planes. |
| Multicluster trust and discovery | Shared root, per-cluster signing material, reciprocal discovery and reachable APIs/gateways. |
| HTTPS and cookies | Approved termination, certificates, redirects, proxy trust and effective custom session-cookie attributes before public exposure. |
| External dependencies | Prepared shared database/schema, database Secret in each cluster, Keycloak realm/client/credentials and required access-token claims. |
| Application behavior | Live routing, mTLS identity, JWT/ownership rejection, affinity, Wasm/Fraud and recovery checks from the functional matrix. |

The aggregate is not an unattended cold-start installer: Policy dependencies do
not gate on every external Secret or runtime controller condition. Use the staged
procedure below rather than applying all 55 objects before prerequisites exist.

## Configuration and bootstrap inputs

The classification below separates deployable source from operator-supplied
inputs. Ignored files are private configuration, not encrypted credential storage.

| Input | Classification and source | Deployment requirement |
| --- | --- | --- |
| Governance namespace and ACM access | Environment-supplied: `open-cluster-management-policies`, registered clusters, governance add-ons and ManagedClusterSetBindings. | Establish namespace, permissions and ClusterSet visibility outside this bundle. |
| Placement labels | Tracked source: [network selectors](../deploy/acm/policies/platform/network-identity/README.md). | Label only the intended clusters `ossm-enabled: "true"` and `ossm-network: network1` or `network2`. Both labels are project-defined. |
| Mesh identities | Tracked source: [control-plane overlays](../deploy/acm/policies/platform/control-plane/README.md). | `mesh1`, `cluster.local`, Istio cluster IDs `cluster1`/`cluster2` and networks `network1`/`network2` must agree with discovery and trust. Cluster IDs are not necessarily ACM registration names or kubeconfig contexts. |
| Platform and catalog | Environment-supplied: supported OpenShift/OSSM combination, RHCOS 9.x nodes and Red Hat Operator catalog. | No specific OpenShift minor is assumed. RHEL/RHCOS 10 and native nftables configuration are outside this baseline. |
| Application images | Configured through private values; the shared application base uses `example.invalid/<component>:1.0`. | Configure all four published images once in `.local/configuration/values/values.yaml`; verify source provenance and pull access. |
| Wasm OCI URL | Configured through private values; public URL is `oci://example.invalid/security-headers-wasmplugin:1.0`. | Configure the tested OCI artifact once as `wasmUrl` in the shared private values. Normal Kustomize `images` does not replace this field. |
| Keycloak endpoints | Configured through private values; public host is `keycloak.example.invalid`. | UI base HTTPS URL, issuer, derived JWKS URI, principal pattern and ServiceEntry host must describe the same shared realm. |
| Browser redirects | Demo login redirects and Web Origins use wildcards; logout uses `+` to inherit the login redirect allowlist. | No frontend origin configuration is required for the demo. Coordinate frontend DNS and certificates; use explicit login, logout and Web Origin allowlists for production. No global load balancer is required. |
| PostgreSQL host | Configured through private values; public host is `postgres.example.invalid`. | Use one shared endpoint in both networks; match the host in each separately supplied `DATABASE_URL`. |
| Database/schema and RHBK service | External dependencies. | Provision separately; the Hub aggregate creates neither PostgreSQL nor the RHBK Operator/Keycloak instance. |
| Credentials and trust material | Secrets that must be provisioned securely: database, realm provisioning, signing CA and remote discovery; registry credentials if required. | Use approved local provisioning and restricted storage, never Policy objectDefinitions or tracked examples. |
| Load balancers, DNS and public TLS | Environment-supplied. | Supply addresses, routing/firewall rules, certificate management and an approved termination/proxy design. The Services do not declare an AWS load balancer implementation. |
| Runtime service discovery | Tracked source: [REST client configuration](../src/intermesh-orchestrator/src/main/resources/application.properties). | Effective `ledger-service` and `fraud-service` URLs use Kubernetes Service DNS on HTTP port 80. The Deployment's separate `QUARKUS_REST_CLIENT_LEDGER_API_URL` and `FRAUD_ANALYTICS_URL` declarations do not configure these client keys; do not rely on their `:8080` values. |

Keep complete ServiceEntry/OIDC definitions equal across both private standalone
renderings and the shared Hub expectations. Match network-specific workload
templates to their corresponding private standalone rendering, including scalar
types and array ordering. The private Hub layer uses guards followed by shared-value
replacements; preserve their identity, placeholder and ordering tests. See the
[private configuration conventions](examples/README.md#hub-governance-overlay).

The authority `intermesh-orchestrator.session.intermesh.com` is an intentional
routing identifier, not a former external infrastructure endpoint. Preserve it,
the Service names, workload identities, `network1.session`, `network2.session`
and `JSESSIONID` when replacing environment inputs.

### Credentials and external services

- **PostgreSQL:** prepare the schema represented by [accounts](../applications/prerequisites/dependencies/postgresql/001.sql),
  [transactions](../applications/prerequisites/dependencies/postgresql/002.sql) and [transfer requests](../applications/prerequisites/dependencies/postgresql/003-transfer-requests.sql)
  through an approved database procedure. Verify schema/search-path compatibility,
  database TLS and network access. Do not blindly rerun fixtures on an existing
  database. Each managed cluster needs `intermesh-backend/intermesh-ledger-db`,
  key `DATABASE_URL`, pointing to the same database. Use the
  [secure from-file procedure](examples/README.md#create-the-secret-without-putting-credentials-in-command-arguments);
  never pass a connection string in command arguments or print Secret contents.
  ServiceEntry does not establish PostgreSQL egress isolation. Rotating an
  environment-backed Secret also requires a controlled workload restart.
- **Keycloak:** the Hub needs the RHBK 26.6 Operator, namespace `rhbk`,
  Keycloak CR `keycloak`, and Secret `intermesh-keycloak-credentials`. Its four
  keys are `DEMO_USER_1_PASSWORD`, `DEMO_USER_2_PASSWORD`,
  `DEMO_USER_3_PASSWORD` and `DEMO_ADMIN_PASSWORD`. Follow the
  [credential instructions](examples/README.md#keycloak-realm-provisioning-credentials)
  and render `.local/prerequisites/keycloak` separately. It contains one RealmImport and
  is not part of the 55-object governance aggregate. Realm `intermesh-bank`,
  public client `intermesh-frontend` and browser PKCE S256 are preserved. The client
  requires S256 and disables direct access grants. Verify
  `preferred_username` in effective access-token scopes/mappers; the import alone
  does not establish the deployed default-scope contract. Match fictional account
  owner keys without silently substituting `sub` or email.
- **Browser redirects:** demo login redirects and Web Origins use wildcards;
  logout uses `+` to inherit the login redirect allowlist. No frontend origin
  configuration is required. See the
  [demo security note](examples/README.md#hub-keycloak-provisioning-overlay).
  RealmImport does not reconcile changes into an existing realm; later client
  changes need an administrative operation. The legacy Channel Hub client is
  excluded from the import.
- **Mesh trust:** prepare `istio-system/cacerts` before first control-plane
  installation, with the approved shared root and appropriate per-cluster signing
  material. Reciprocal discovery credentials, remote API reachability and
  East-West gateway addresses are separate bootstrap inputs. Use the
  [control-plane prerequisites](../deploy/acm/policies/platform/control-plane/README.md)
  and an approved version-matched PKI/discovery procedure; this repository does
  not generate that material.
- **Image access:** no active image-pull Secret references are supplied. If a
  registry requires authentication, approve the appropriate Pod/Wasm pull
  configuration before deployment. Never embed registry credentials in Policies.
  A resolvable image tag is not evidence that it contains this source revision.

For OIDC, verify JWKS reachability and TLS trust from both the receiving proxies
and Quarkus, canonical issuer equality, clock synchronization and signing-key
rotation. Quarkus derives its JWKS URL from the issuer; Istio has a separately
configured URI. The public client ID is not evidence of an enforced API audience.
Do not add tokens or static signing keys to the configuration to bypass failures.

### Public HTTPS and cookies

The [Ingress Gateway](../service-mesh/networking/gateways/ingress/ingress-gateway.yaml) declares HTTP 80 and
HTTPS 443 with `OPTIONAL_MUTUAL`, wildcard hosts, no explicit TLS credential
reference and no HTTP redirect. The [Service](../platform/openshift/ossm/gateways/ingress/service.yaml)
maps `80 → 8080` and `443 → 8443`; it does not select AWS termination behavior.
Approve the external TLS design and validate admission of the Gateway before
public exposure. Verify certificate names/chains, HTTP-to-HTTPS redirects for
both `/` and `/api`, and any trusted forwarded-header boundary. TLS termination
at a load balancer does not itself make the upstream connection HTTPS.

[VertxSessionConfig](../src/intermesh-orchestrator/src/main/java/it/intermesh/bank/util/VertxSessionConfig.java)
constructs a custom SessionHandler and reads cookie name and timeout. It does not
explicitly wire Secure, HttpOnly or SameSite setters from the similarly named
Quarkus properties. Those properties therefore do not prove the resulting cookie
attributes; defaults must not be mistaken for verified configuration. Validate
`JSESSIONID` Secure, HttpOnly, the approved SameSite behavior, scope and expiration
on the final HTTPS path. Configure and validate the custom handler
before public exposure. The Envoy affinity cookies are
separate from the application session cookie, and none of these three cookies
needs to be readable by frontend JavaScript.

## Policy dependencies and runtime gates

All listed dependencies require a same-cluster Policy status of `Compliant` in
`open-cluster-management-policies`. `N` below means the matching network, not both
network Policies on each cluster.

| Policies | Existing parent dependencies |
| --- | --- |
| `intermesh-ossm-operator`, `intermesh-infra-ns-ingress`, `intermesh-app-foundation`, `intermesh-network1-identity`, `intermesh-network2-identity` | None |
| `intermesh-istio-cni` | Operator + infrastructure namespaces |
| `intermesh-istio-networkN` | Operator + infrastructure namespaces + CNI + matching network identity |
| `intermesh-ingress-networkN`, `intermesh-eastwest-networkN` | Matching control plane |
| `istio-gateway`, `orchestrator-session` | Operator + infrastructure namespaces |
| `intermesh-routing-networkN` | Matching ingress workload + `istio-gateway` |
| `intermesh-affinity-networkN` | Matching control plane + application foundation |
| `intermesh-discovery-internal`, `intermesh-discovery-external`, `intermesh-security-static`, `intermesh-security-oidc`, `istio-fraud-analytics-chaos` | Operator + application foundation |
| `intermesh-app-networkN` | Application foundation + matching control plane |
| `intermesh-wasm` | Application foundation + Operator |

The graph has no cycles. Namespace existence and network-label Policies overlap
on `istio-system` compatibly through `musthave` metadata comparison. Shared Policies
cannot require both network-specific control planes: their Placements are mutually
exclusive. Workload Policies have no gate for database Secrets, working OIDC,
security-rule propagation, Wasm execution or gateway readiness.

Treat these as separate checkpoints: Policy compliance → resource existence →
controller readiness → network reachability → application behavior. Resource
creation is not proof of injection, mTLS, endpoint discovery or business health.
The application Deployments define no Kubernetes readiness/liveness/startup
probes. A SessionHandler bypass for health paths does not create health endpoints;
do not use an assumed `/healthz` or `/q/health` response as a readiness gate.

## Staged deployment from the private Hub rendering

Start only after the readiness blockers have been resolved and two target
clusters are registered. Assign local context variables `IM_HUB_CONTEXT`,
`IM_NET1_CONTEXT`, `IM_NET2_CONTEXT` and actual ManagedCluster names `IM_MC1`,
`IM_MC2`; do not infer them from Istio's `cluster1`/`cluster2` IDs.

**LOCAL FILE WRITE — no cluster mutation:** render with the trusted installed
PolicyGenerator and protect the output. Do not publish it or substitute the public
aggregate. This creates a protected local artifact for operator review.

```sh
umask 077
mkdir -p .local/deployment
oc kustomize .local/deploy/acm --enable-alpha-plugins > .local/deployment/hub-approved.yaml
```

Revalidate all identities, modes, dependencies and private/source comparisons.
Create reviewed local stage files by selecting whole objects from that one
approved rendering; do not edit their embedded desired resources. Each Policy
travels with its PlacementBinding. The stage files must have disjoint identities
and their union must equal the approved 55 objects exactly. They are temporary
operator artifacts, not new versioned sources or an implemented deployment tool.

| Stage | Objects selected from the approved private aggregate | Checkpoint before advancing |
| --- | --- | --- |
| 0 — scope | Three Placements | Shared Placement selects exactly the two intended clusters; each network Placement selects exactly its one cluster. Verify PlacementDecisions, ClusterSetBindings and governance add-ons. |
| 1 — bootstrap | Operator, infrastructure namespaces, application foundation and both network-identity Policies, each with its binding: 10 objects | Operator installed; required APIs established; namespaces and labels correct. Prepare shared trust and database Secrets before their consumers. |
| 2 — CNI | `intermesh-istio-cni` and binding: 2 objects | IstioCNI reconciles successfully and its DaemonSet is ready on all required nodes; control-plane API/webhook ready. |
| 3 — control planes | Both `intermesh-istio-networkN` Policies and bindings: 4 objects | Signing material already present; both Istio CRs and istiod workloads ready with matching mesh/trust/network identities. |
| 4 — gateway workloads | Both ingress and both eastwest Policies and bindings: 8 objects | Injected proxies, admission, Services and load balancers ready. Complete reciprocal discovery and trust checks. |
| 5 — networking/security | `istio-gateway`, `orchestrator-session`, both routing and both affinity Policies, both discovery Policies, both security Policies and `istio-fraud-analytics-chaos`, each with binding: 22 objects | Istio APIs admit the resources; routes, principals, issuer/JWKS, certificates and listener configuration are valid on both networks. Resolve the public TLS design before propagating/exposing ingress. |
| 6 — application | `intermesh-wasm` and both `intermesh-app-networkN` Policies with bindings: 6 objects | Propagate Wasm first, then applications after external dependencies, Secrets, pull access and security configuration are ready. Verify plugin execution and application behavior after Pods start. |

Counts sum to 55; stages 1–6 contain all 26 Policies and 26 bindings. For each
reviewed stage, the deployment command is:

```sh
# MUTATING — creates/updates Hub governance and may change managed clusters.
oc --context "$IM_HUB_CONTEXT" apply -f "$IM_STAGE_FILE"
```

Set `IM_STAGE_FILE` to the approved stage artifact only after the preceding gate
passes. Do not apply all 55 objects first and rely on later checks to hold them
back. If Intermesh enforcing Policies already exist, stop and review activation
state: withholding stage files does not suspend previously active Policies.
Never apply standalone profiles or ordinary resource bases alongside ACM as
competing owners.

Provision external Secrets through the approved secure procedure, and initially
provision the realm through the validated `.local/prerequisites/keycloak` rendering. These
are separate **MUTATING** administrative operations, not ACM aggregate resources.
Do not create empty Secrets or expose connection strings in command arguments.

### Read-only checkpoint commands

These are read-only runtime checks. Run managed-cluster commands on
both contexts; save sanitized conditions/counts rather than raw tokens, cookies,
session identifiers or Secret data.

```sh
# Hub: membership, access, selection and governance status.
oc --context "$IM_HUB_CONTEXT" get managedclusters
oc --context "$IM_HUB_CONTEXT" -n open-cluster-management-policies get managedclustersetbindings
oc --context "$IM_HUB_CONTEXT" -n open-cluster-management-policies get placements,placementdecisions
oc --context "$IM_HUB_CONTEXT" -n open-cluster-management-policies get policies
oc --context "$IM_HUB_CONTEXT" -n open-cluster-management-policies describe policy "$IM_POLICY"

# Managed cluster: discover propagated child namespaces; do not assume Hub namespace.
oc --context "$IM_NET1_CONTEXT" get configurationpolicies -A
oc --context "$IM_NET1_CONTEXT" get operatorpolicies -A
oc --context "$IM_NET1_CONTEXT" -n openshift-operators get subscriptions,csv,installplans
oc --context "$IM_NET1_CONTEXT" get crd istiocnis.sailoperator.io istios.sailoperator.io
oc --context "$IM_NET1_CONTEXT" get istiocnis.sailoperator.io default
oc --context "$IM_NET1_CONTEXT" get istios.sailoperator.io default
oc --context "$IM_NET1_CONTEXT" -n istio-cni get daemonsets,pods
oc --context "$IM_NET1_CONTEXT" -n istio-system get deployments,pods
oc --context "$IM_NET1_CONTEXT" -n istio-ingress get deployments,pods,services
oc --context "$IM_NET1_CONTEXT" -n istio-east-west get deployments,pods,services,hpa,pdb
oc --context "$IM_NET1_CONTEXT" -n intermesh-backend get deployments,pods,services,endpointslices
oc --context "$IM_NET1_CONTEXT" -n intermesh-frontend get deployments,pods,services,endpointslices

# Secret existence and key names only; no values, YAML dumps or decoding.
oc --context "$IM_NET1_CONTEXT" -n intermesh-backend get secret intermesh-ledger-db \
  -o go-template='{{range $key, $value := .data}}{{printf "%s\n" $key}}{{end}}'
```

Inspect OLM Subscription/CSV conditions and InstallPlans; `upgradeApproval: None`
is not proof that every installation/upgrade approval is automatic. Require
successful CSV installation, Established CRDs, working admission webhooks and
current-generation readiness conditions on IstioCNI/Istio. Failures include
pending approvals, missing APIs, webhook errors, CNI scheduling failures,
CrashLoopBackOff, uninjected `image: auto` containers and unavailable endpoints.
Use targeted events and sanitized logs to diagnose them.

Check actual injected Pod ServiceAccounts, proxy images, listener ports and
OpenShift admission, rather than comparing source Deployment fields alone.
Ingress uses the default ServiceAccount; its retained Role grants namespace-wide
Secret `get/watch/list`. Limit namespace writers and review that permission before
general-purpose use. East-West uses a dedicated ServiceAccount. Its optional
legacy certificate volumes do not establish a requirement to create those Secrets;
`ISTIO_MUTUAL` uses mesh credentials. See the [Ingress](../deploy/acm/policies/platform/gateways/ingress/README.md)
and [East-West](../deploy/acm/policies/platform/gateways/eastwest/README.md) baselines.

With an approved version-matched mesh diagnostic client, inspect proxy sync,
remote-cluster discovery, listeners, clusters and endpoints. Require healthy
remote discovery, expected gateway addresses and reachable API endpoints. The
East-West Service exposes 15021, 15443, 15012 and 15017; validate the approved
network exposure for each rather than inferring it from Pod port declarations.
Confirm effective workload mTLS; the repository supplies no PeerAuthentication
establishing a namespace-wide STRICT policy.

## Functional verification matrix

Use fictional test accounts and controlled data. Browser login, account creation
and transfer tests **MUTATE runtime state**; route inspection and ordinary GET
checks are read-only apart from session allocation. Capture redacted request
correlation IDs, status codes, Pod/network identity and conditions. Do not export
bearer tokens, cookies, raw session IDs or financial/customer payloads.

| Test and preconditions | Method and expected observable result | Failure signal / required runtime evidence |
| --- | --- | --- |
| Shared SSO; RHBK/allowlists/TLS ready | Log in and out from both frontend origins using authorization code + PKCE S256. Served JavaScript must contain the configured URL, not `PLACEHOLDER_KEYCLOAK_URL`. | Redirect/CORS/TLS errors or absent required access-token claims; record sanitized login outcome and effective client scopes/mappers. |
| Ingress and UI/backend split; both workloads ready | Browser `/` serves UI; browser JavaScript sends authenticated `/api` to Orchestrator directly. Inspect proxy routing and upstream evidence. | UI forwarding API traffic, wrong upstream, redirect loops or exposed HTTP. `/hello` is not an ingress-routed diagnostic path. |
| Workload availability; all resources reconciled | Check all four Deployments and their endpoints in each network, then exercise authenticated APIs. | PodReady without working APIs/DB is insufficient; record replica/endpoint counts and application results. |
| Ledger/database integration; schema and Secrets ready | Use authenticated same-owner account lookup and a controlled transfer; compare request status and database records through an authorized operator. | Connection/TLS/schema errors, inexact amounts or divergent state. Both Ledger instances must use the same database; never print connection strings. |
| L4 cross-network; trust/discovery ready | Through an Orchestrator, make Ledger/Fraud available only remotely using the reviewed outage procedure. Confirm remote upstream, workload mTLS and original source principal. | Requests traversing the Orchestrator L7 route, failed discovery or gateway identity replacing the required caller; retain sanitized mesh telemetry. |
| Dedicated L7 and authority rewrite | Send `/api` through ingress and exercise remote Orchestrator routing. Verify authority `intermesh-orchestrator.session.intermesh.com` and the dedicated `ISTIO_MUTUAL` listener/route. | Wrong authority/listener, direct cross-network Pod assumptions or Ledger/Fraud captured by L7; retain route and upstream evidence. |
| Session affinity and failover | Repeat requests with one browser, then test another subject and loss of a local Pod. Observe the network-specific affinity cookie and application session separately. | Wrong-network DestinationRule, cross-user state reuse or persistent failure after unavailable local state. Record Pod selection; redact cookie values. |
| JWT validation and ownership | Test missing, malformed, expired, wrong-issuer/signature JWTs and cross-user access, then valid same-user requests. | Any unauthorized downstream financial call. Missing principal must be denied by mesh; Quarkus independently rejects unusable identity. Record status and zero downstream effects; verify exact codes at runtime. |
| Ledger/Fraud caller restriction | Test local and remote Orchestrator calls, then calls from an unauthorized workload/gateway identity under a controlled test plan. | Any non-Orchestrator success. Both ALLOW policies require `cluster.local/ns/intermesh-backend/sa/intermesh-orchestrator-sa`; verify mTLS identity survives the L4 path. |
| Wasm execution; OCI artifact loaded | Verify Orchestrator proxy plugin load and outbound Fraud headers `x-intermesh-channel` and `x-intermesh-route-class`, plus controlled requests without the expected marker. | Plugin pull/load failure or missing expected behavior. `FAIL_OPEN` means plugin presence is not proof of execution. Its route marker is not cryptographic identity. |
| Fraud timeout/fault scenario | Controlled normal destination versus the existing `DE`-prefixed slow destination: Fraud sleeps four seconds while the ACM-owned route times out after three. Test the missing route-header fault separately. | Lost timeout behavior, unexpected route or automatic financial POST retry; retain sanitized timing, status and request correlation evidence. |
| Recovery and duplicate handling | Reuse the same transfer request ID through the existing UI recovery/duplicate-confirmation flow; query `/api/v1/transfer-requests/{transfer_request_id}`. | Duplicate financial mutation or a claim of restored funds after an unknown result. Verify terminal/pending state without inventing a new request ID or automatic POST retry. |

The L4 Gateway's host list covers Ledger, Fraud and UI, excluding Orchestrator;
the dedicated L7 route handles Orchestrator `/api`. Both use the East-West gateway
workload. Inspect effective filters/listeners to establish that split. See
[networking governance](../deploy/acm/policies/service-mesh/README.md) for the authoritative sources.
Istio ALLOW rules compose with OR; the workload-scoped missing-JWT DENY takes
precedence on port 8080. This does not establish audience validation, ownership
from mesh policy, or protection for traffic bypassing the receiving Sidecar.

## Workload unavailability and restoration

To demonstrate workload unavailability under ACM, temporarily change the selected
Deployment's desired replicas in its Hub Policy and restore them after the test.
Application Deployments declare `replicas: 1`; ACM can reverse a direct managed-cluster
scale-to-zero. The repository does not automate this procedure. Do not weaken
remediation or suspend unrelated Policies to sustain an outage.

1. Record the approved private rendering, image digests, readiness and transfer
   request states. Avoid changing availability during an unresolved financial
   operation; retain its request ID for status recovery.
2. Prepare a narrowly scoped **private Hub desired-state change** for exactly one
   selected application Deployment's replicas, `1 → 0`, in its matching network
   Policy. Review the rendered diff: only that embedded replica field may change;
   all 55 identities, dependencies, security settings and other workloads remain.
3. After approval, apply the changed Hub desired state (**MUTATING**). Wait for
   ACM convergence, zero target Pods/endpoints and a healthy counterpart in the
   other network before testing cross-network routing. Do not rely on Pod deletion
   or a direct scale command as the desired outage state.
4. Exercise the controlled L4/L7 scenario, correlating upstream network and
   request status. An interrupted financial request has an unknown outcome until
   resolved; never retry a financial POST automatically.
5. Restore the exact original Hub desired replica value, `0 → 1`, apply it
   (**MUTATING**), and verify reconciliation, endpoints, session behavior and
   authenticated functional tests on both networks.
6. If routing fails, restore the original desired state before diagnosis. Restoring
   replicas/configuration is not a financial rollback. Resolve transfer requests
   by their recorded status; do not assume compensation acknowledgments prove
   balance restoration or that recipient settlement is implemented.

## Release evidence

Before deployment, retain a private approval record containing source revision,
tool/plugin provenance, rendered identity/hash comparisons, all replaced
placeholders, stage membership and external bootstrap approvals. After each
runtime gate, add redacted Policy/condition results, image IDs, placement decisions
and functional outcomes from both networks. Protect logs and configuration exports.

Offline regression checks cover all rendering entrypoints, Components through
their consumers, duplicate identities, enforcing modes, dependency references and
cycles, private guard rejection, and exact private Hub/application equivalence.
Documentation-only changes must leave every source/private configuration hash and
rendered resource unchanged. Run `git diff --check` and validate local Markdown
links when updating documentation. Source validation does not replace the deployment
prerequisites and runtime gates above.
