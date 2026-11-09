# Deployment architecture

Intermesh Bank runs across two OpenShift managed clusters in a multi-primary,
multi-network OpenShift Service Mesh 3 deployment. A third cluster hosts ACM
governance and shared Keycloak SSO. Sidecar is the reference data plane.

## Cluster roles

| Cluster | Network | Components |
| --- | --- | --- |
| ACM Hub | Outside the managed application meshes | Red Hat Advanced Cluster Management, Red Hat build of Keycloak (RHBK) and its Operator. |
| Managed Cluster 1 | `network1` | Intermesh UI, Orchestrator, Ledger and Fraud Analytics. |
| Managed Cluster 2 | `network2` | Intermesh UI, Orchestrator, Ledger and Fraud Analytics. |

These names identify deployment roles rather than kubeconfig contexts.
Both managed clusters use the same external PostgreSQL database. RHBK runs in
the Hub's `keycloak` namespace and serves both frontends from outside their meshes.

## Request flow

```mermaid
flowchart TB
  BROWSER["Browser / frontend JavaScript"]
  subgraph HUB["ACM Hub"]
    ACM["ACM"]
    SSO["RHBK: shared SSO"]
  end
  subgraph C1["Managed Cluster 1 / network1 / Sidecar"]
    IG1["Ingress Gateway"] -->|"/"| UI1["Intermesh UI"]
    IG1 -->|"/api"| O1["Orchestrator"]
    O1 --> L1["Ledger"]
    O1 --> F1["Fraud Analytics"]
    EW1["East-West Gateway"]
  end
  subgraph C2["Managed Cluster 2 / network2 / Sidecar"]
    IG2["Ingress Gateway"] -->|"/"| UI2["Intermesh UI"]
    IG2 -->|"/api"| O2["Orchestrator"]
    O2 --> L2["Ledger"]
    O2 --> F2["Fraud Analytics"]
    EW2["East-West Gateway"]
  end
  DB[("One external PostgreSQL database")]
  BROWSER -->|"/ and /api"| IG1
  BROWSER -->|"/ and /api"| IG2
  BROWSER <-->|"SSO"| SSO
  ACM -. "Owns Fraud VirtualService" .-> C1
  ACM -. "Owns Fraud VirtualService" .-> C2
  L1 --> DB
  L2 --> DB
  EW1 <-->|"Cross-network service routing"| EW2
```

The browser loads frontend assets through `/`. Frontend JavaScript sends API
requests to `/api` on the same origin; ingress routes them directly to
Orchestrator. The UI workload does not proxy API requests. Orchestrator is the
backend entry point and calls Ledger and Fraud Analytics.

Solid links show traffic or logical routing capability; dashed links show
management. Cross-network service traffic traverses the appropriate East-West
Gateways. The gateway link summarizes that capability, omitting individual
workload-to-gateway hops and L7 details. It does not imply direct cross-network
Pod connectivity or require every cross-cluster request to pass through
Orchestrator.

Both managed clusters normally run all four active workloads. Demonstrations
can stop selected workloads to exercise cross-network routing: an Orchestrator
in Cluster 2 can reach Ledger in Cluster 1 when the local Ledger is unavailable.
Both Ledger instances use the same database; this is service routing rather than
database replication.

Channel Hub is inactive. Its source, manifests, service account and Keycloak
client remain available for future use, but it is not a runtime dependency or an
authentication boundary in this architecture.

## Resources and ownership

### Application workloads

The following Deployment and Service pairs run in both managed clusters:

| Deployment and Service sources | Namespace |
| --- | --- |
| Intermesh UI: [Deployment](../manifests/workloads/intermesh-ui-deployment.yaml), [Service](../manifests/workloads/intermesh-ui-service.yaml) | `intermesh-frontend` |
| Orchestrator: [Deployment](../manifests/workloads/intermesh-orchestrator-deployment.yaml), [Service](../manifests/workloads/intermesh-orchestrator-service.yaml) | `intermesh-backend` |
| Ledger: [Deployment](../manifests/workloads/intermesh-ledger-deployment.yaml), [Service](../manifests/workloads/intermesh-ledger-service.yaml) | `intermesh-backend` |
| Fraud Analytics: [Deployment](../manifests/workloads/fraud-analytics-deployment.yaml), [Service](../manifests/workloads/fraud-analytics-service.yaml) | `intermesh-backend` |

[namespaces.yaml](../manifests/foundation/namespaces.yaml) requests sidecar injection.
The [frontend service account](../manifests/foundation/intermesh-frontend-sa.yaml) and
[backend service accounts](../manifests/foundation/intermesh-backend-sa.yaml) provide local
workload identities. Injection also requires a configured mesh installation.
[intermesh-channel-hub.yaml](../manifests/intermesh-channel-hub.yaml) is excluded
from the active deployment. Its dormant ServiceAccount remains in the canonical
application rendering and ACM application foundation; it does not activate a
Channel Hub workload.

### ACM governance and mesh routing

ACM Policy, Placement and PlacementBinding objects live on the Hub in
`open-cluster-management-policies`. Their generated Istio resources live in the
managed clusters. RHBK provisioning is separate and uses the Hub's `keycloak`
namespace.

The [Hub deployment overlay](../overlays/hub-deploy/README.md) aggregates the
infrastructure, application, networking and security governance. ACM reconciles
these resources on the selected managed clusters; the canonical application
overlays provide rendering and validation references rather than parallel
deployment ownership.

| Manifest | Role |
| --- | --- |
| [acm-fraud-analytics-vs.yaml](../manifests/ossm/acm-fraud-analytics-vs.yaml) | ACM owner of `intermesh-backend/fraud-analytics-chaos` VirtualService in both managed clusters; references `placement-all-clusters`. |
| [istio-gateway.yaml](../manifests/ossm/istio-gateway.yaml) | ACM Policy containing the Ingress Gateway and L4 East-West `AUTO_PASSTHROUGH` Gateway, plus `placement-all-clusters` and its binding. The Placement selects `ossm-enabled: "true"`. |
| [orchestrator-session.yaml](../manifests/ossm/orchestrator-session.yaml) | ACM Policy containing the dedicated L7 `ISTIO_MUTUAL` Gateway and `/api` VirtualService for Orchestrator. |
| [virtual-service.yaml](../manifests/ossm/virtual-service.yaml) | Ingress routes: `/api` to Orchestrator and `/` to UI, in `istio-ingress`. |
| [virtual-service-east-west.yaml](../manifests/ossm/virtual-service-east-west.yaml) | Fully commented reference; renders no VirtualService and supplies no active routes. |

The standalone [fraud-analytics-vs.yaml](../manifests/ossm/fraud-analytics-vs.yaml)
defines the same resource as the ACM policy with different header matching.
It is excluded from the active deployment to avoid competing ownership.
Keep the fraud header matching, fault injection and timeout relationships
together when changing this demonstration.

### Authentication and authorization

[RequestAuthentication](../manifests/ossm/jwt-request-authentication.yaml)
selects Orchestrator, configures the issuer and JWKS URL, and forwards the original
token. The [JWT AuthorizationPolicy](../manifests/ossm/jwt-authorization-policy.yaml)
uses the issuer principal prefix.

The [JWT requirement policy](../manifests/ossm/policies/deny-orchestrator-without-jwt.yaml)
requires an authenticated request principal for incoming traffic on Orchestrator's
HTTP port (`8080`) in both managed clusters. At the receiving Sidecar, requests
without a valid JWT are rejected regardless of caller or path, including
diagnostic routes. This requirement complements the service-to-service
authorization rules.

JWT validation authenticates requests at the service mesh layer; it does not
enforce access to individual banking resources.

The remaining policy files describe workload and gateway identities:

- [allow-hub-to-orchestrator.yaml](../manifests/ossm/policies/allow-hub-to-orchestrator.yaml)
  declares `allow-ingress-to-orchestrator` for ingress/East-West namespaces;
  its filename does not introduce a Channel Hub dependency.
- [allow-ingress-to-ui-api.yaml](../manifests/ossm/policies/allow-ingress-to-ui-api.yaml)
  contains UI and retained Channel Hub selectors.
- [allow-orchestrator-to-ledger.yaml](../manifests/ossm/policies/allow-orchestrator-to-ledger.yaml)
  and [allow-orchestrator-to-analytics.yaml](../manifests/ossm/policies/allow-orchestrator-to-analytics.yaml)
  allow only the Orchestrator workload principal,
  `cluster.local/ns/intermesh-backend/sa/intermesh-orchestrator-sa`, on their
  selected Ledger and Fraud Analytics workloads. Neither policy allows the
  East-West Gateway principal.

Effective authorization depends on workload selectors and the combined policies.

### Service identities

The active Orchestrator ServiceEntry describes service, workload and East-West
Gateway identities. Keep its SPIFFE identities aligned with service accounts and
authorization policies. The other internal ServiceEntry sources are fully
commented and render no resources.

| Namespace | ServiceEntry manifests |
| --- | --- |
| `intermesh-frontend` | [UI (commented)](../manifests/ossm/serviceentry/intermesh-ui-se.yaml) |
| `intermesh-backend` | [Orchestrator](../manifests/ossm/serviceentry/intermesh-orchestrator-se.yaml), [Ledger (commented)](../manifests/ossm/serviceentry/intermesh-ledger-se.yaml), [Fraud Analytics (commented)](../manifests/ossm/serviceentry/fraud-analytics-se.yaml) |
| `intermesh-backend` | [Channel Hub (inactive, commented)](../manifests/ossm/serviceentry/intermesh-channel-hub-se.yaml) |

External ServiceEntries in `intermesh-backend` declare
[PostgreSQL](../manifests/ossm/serviceentry/serviceentry-db.yaml) on TCP/5432 and
[Keycloak](../manifests/ossm/serviceentry/serviceentry-keycloak.yaml) on HTTPS/443
as `MESH_EXTERNAL` services.

## Configuration

### Shared PostgreSQL

Each managed cluster needs a Secret named `intermesh-ledger-db` in
`intermesh-backend`, with key `DATABASE_URL`. The two Secrets may contain the
same complete connection string for the single shared database. Preserve the
database name, schema/search-path options, TLS settings and connection semantics;
there are no per-cluster databases, schemas or synchronization mechanisms.

The hostname in `DATABASE_URL` must agree with the PostgreSQL ServiceEntry
hostname. Use the
[PostgreSQL Secret example](../manifests/examples/postgres-secret.example.yaml)
and keep actual values in protected local configuration.

PostgreSQL egress isolation is not configured. The ServiceEntry registers an
external destination; it does not restrict database access to Ledger.

### Keycloak SSO and realm provisioning

The Hub hosts [KeycloakRealmImport](../manifests/keycloak/realmimport.yaml)
and Secret `intermesh-keycloak-credentials` in namespace `keycloak`, alongside
Keycloak CR `keycloak`. The import uses API `k8s.keycloak.org/v2alpha1`.
The selected Operator/CRD must support `spec.placeholders`; its version is not
pinned in the repository.

The provisioning Secret supplies five keys: `HUB_CLIENT_SECRET`,
`DEMO_USER_1_PASSWORD`, `DEMO_USER_2_PASSWORD`, `DEMO_USER_3_PASSWORD` and
`DEMO_ADMIN_PASSWORD`. It is needed only on the Hub, not in the managed clusters.
Use the [Keycloak Secret example](../manifests/examples/keycloak-credentials.secret.example.yaml)
and [local provisioning instructions](../manifests/examples/README.md).
RealmImport creates new realms; changing its Secret does not rotate credentials
in an already imported realm.

The realm is `intermesh-bank`, with frontend client `intermesh-frontend` and
retained inactive client `intermesh-channel-hub`. The three banking usernames
match [SQL fixtures](../sql/001.sql). Keep all four realm users, profiles, roles,
groups, credential flags and their fixture relationships intact.

Changing the shared SSO endpoint requires coordinated updates to:

- UI `KEYCLOAK_URL`, consumed by the
  [startup substitution script](../intermesh-ui/src/00-substitute-env.sh).
- RequestAuthentication issuer and JWKS URL, AuthorizationPolicy principal prefix,
  and the Keycloak ServiceEntry host.
- Retained Channel Hub `KEYCLOAK_ISSUER` configuration, if maintained.

Realm/client identifiers, issuer semantics and login flows remain unchanged.

### Session affinity

Each managed cluster uses exactly one Orchestrator DestinationRule:

| Cluster | DestinationRule | Affinity cookie |
| --- | --- | --- |
| Cluster 1 / `network1` | [orchestrator-network1-dr.yaml](../manifests/ossm/destination-rules/network1/orchestrator-network1-dr.yaml): `intermesh-orchestrator-dr-network1` | `network1.session`, TTL `0s` |
| Cluster 2 / `network2` | [orchestrator-network2-dr.yaml](../manifests/ossm/destination-rules/network2/orchestrator-network2-dr.yaml): `intermesh-orchestrator-dr-network2` | `network2.session`, TTL `0s` |

Both target `intermesh-orchestrator.intermesh-backend.svc.cluster.local` in
`intermesh-backend`. They do not select themselves by network, so deploying both
to one cluster creates competing traffic policies.

`JSESSIONID` identifies the application session stored locally by Orchestrator and is separate from network affinity.
[application.properties](../intermesh-orchestrator/src/main/resources/application.properties)
and [VertxSessionConfig.java](../intermesh-orchestrator/src/main/java/it/intermesh/bank/util/VertxSessionConfig.java)
configure the session and local session store. Preserve all three cookies and
their forwarding across Gateway hops.

### WasmPlugin

[security-headers-wasmplugin.yaml](../manifests/ossm/wasm/security-headers-wasmplugin.yaml) selects
`app: intermesh-orchestrator` in `intermesh-backend` and uses
`failStrategy: FAIL_OPEN`. Its OCI artifact is
`security-headers-wasmplugin:1.0`; the manifest specifies the full image locator.
Deploy the plugin alongside Orchestrator in both managed clusters.

The [Rust implementation](../security-headers-wasmplugin/src/lib.rs) checks
HTTP `:authority` for `fraud-analytics` and sets `x-intermesh-channel` and
`x-intermesh-route-class`. Its `Web-Channel-Hub` value is a routing marker,
not an active Channel Hub dependency. Keep these markers and authority semantics
aligned with fraud routing.

Use the existing [image packaging](../security-headers-wasmplugin/Containerfile)
when publishing the artifact. Registry relocation requires updating the
WasmPlugin's `spec.url`; a workload image override does not update that field.

## Local Kustomize rendering

Render each target independently from the repository root:

```sh
# Complete public ACM Hub governance aggregate
oc kustomize overlays/hub-deploy --enable-alpha-plugins
# Public networking, discovery and security governance subset
oc kustomize manifests/ossm --enable-alpha-plugins
# ACM Hub Keycloak provisioning
oc kustomize manifests/keycloak
# Managed Cluster 1 / network1
oc kustomize overlays/managed-cluster-1
# Managed Cluster 2 / network2
oc kustomize overlays/managed-cluster-2
```

`kubectl kustomize` can be used in place of `oc kustomize`. These commands render
local manifests without contacting a cluster or deploying resources.
The managed-cluster overlays combine the shared base in
[manifests/kustomization.yaml](../manifests/kustomization.yaml) with exactly one
network-specific DestinationRule. The Hub governance and Keycloak entrypoints
are separate from one another. Governance rendering requires the trusted
PolicyGenerator plugin and `--enable-alpha-plugins`.

The managed-cluster application renderings exclude Secret examples, the inactive
Channel Hub Deployment, Service and ServiceEntry, and the standalone Fraud
Analytics VirtualService. The dormant Channel Hub ServiceAccount and
AuthorizationPolicy remain in canonical application rendering. ACM retains the
ServiceAccount through its foundation Policy but excludes the dormant
AuthorizationPolicy. None of these retained objects activates a workload.

For ACM deployment, use the validated `.local/hub-governance` overlay after
configuring private values and satisfying the deployment prerequisites. Do not
apply the public placeholder-bearing aggregate or separately deploy canonical
application overlays alongside ACM. Provision database Secrets in both managed
clusters and the Keycloak credential Secret on the Hub separately.

## Deployment prerequisites

ACM governs the OSSM Operator, IstioCNI, network-specific control planes, gateway
workloads, application foundation, application workloads, WasmPlugin and Istio
networking/security resources. The enforcing Policies reconcile desired
resources; Policy compliance does not establish controller readiness, network
reachability or application health. Use the staged checkpoints in the
[ACM deployment runbook](acm-deployment-readiness.md).

The deployment starts with an existing ACM Hub and two registered managed
clusters. Public application images, Wasm OCI URL and external endpoint values
use nonfunctional placeholders. Configure published artifacts and environment
values through ignored private overlays as described in the
[configuration examples](../manifests/examples/README.md).

A deployment also needs environment-specific configuration for:

- Cluster/context names, mesh and cluster IDs, network advertisements, and ACM
  ManagedCluster names and labels.
- Supported OpenShift/OSSM versions, trust certificates, remote discovery
  Secrets and inter-cluster connectivity.
- Ingress and East-West Gateway addresses, DNS, certificates and the approved
  public HTTPS/proxy configuration.
- RHBK server/Operator/CRD versions and installation resources, PostgreSQL
  provisioning, protected Secret values and available container/Wasm images.

The repository includes the L4 `AUTO_PASSTHROUGH` and dedicated Orchestrator L7
`ISTIO_MUTUAL` Gateway/VirtualService configuration, including the ingress
authority rewrite. Effective listeners, shared trust, discovery and network
reachability require verification in the deployed mesh. The diagrams summarize
these routing relationships rather than every configuration field.

Keep service names, namespaces, ports, selectors, service accounts and
`cluster.local`/SPIFFE identities consistent. Gateway names, wildcard hosts,
route ordering and HTTP authority/SNI values can be routing identities rather
than replaceable infrastructure addresses. Deploy resources by cluster and
controller ownership rather than applying the entire manifests directory
recursively.

The Orchestrator manifest's environment-variable names differ from its REST
client configuration keys. Effective overrides and port selection require
integration testing; keep existing internal defaults when configuring endpoints.

Validate the deployment across both managed clusters with Hub-hosted SSO and ACM
governance. Cover browser login, direct API routing, session affinity across
Gateway hops, shared Ledger data, fraud behavior and temporary workload
unavailability. Coordinate workload outages and restoration with ACM desired
state; application Deployments declare one replica. Offline manifest checks
cannot validate these runtime behaviors.
