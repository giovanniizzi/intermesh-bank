# Deployment architecture and resource placement

This document records the existing Sidecar demonstration baseline before adding
deployment overlays. It is not an installation procedure or proof of the former
runtime configuration. No concrete infrastructure addresses or credentials are
reproduced here.

## 1. Evidence and architectural context

- **User-provided context:** two OpenShift clusters form a multi-primary,
  multi-network service mesh. Both clusters use one shared external PostgreSQL
  database for Ledger workloads and one shared external Keycloak SSO service.
  The Channel Hub is not in the active request path. Additional experimental L7
  East-West Gateway configuration may exist outside the committed manifests.
- **Verified repository facts:** the resource definitions and application
  configuration referenced below are committed. Their presence establishes their
  declared behavior, not which cluster received them or which version was active.
- **Unknown deployment details:** physical cluster/network mappings, effective
  resource placement, external addresses and uncommitted Gateway configuration
  require confirmation. Do not infer these from filenames or recreate them by
  replacing every hostname-like string.

## 2. Active application and request flow

The logical API request path is:

```text
Intermesh UI -> Istio Ingress Gateway -> Intermesh Orchestrator
                                           |-> Intermesh Ledger -> shared PostgreSQL
                                           |-> Fraud Analytics

Intermesh UI <-> shared Keycloak SSO
```

The Orchestrator is the backend entry point. The UI uses its current browser
origin for API requests and Keycloak for frontend login. Committed ingress
routing sends `/api` directly to the Orchestrator and `/` to the UI.

The Channel Hub's source, Deployment, Service, service account, mesh definitions
and confidential Keycloak client remain in the repository for possible future
use. They do not establish an active dependency or authentication boundary.
Do not activate the Hub or insert it into this request path.

The diagram is logical, not a physical cross-cluster hop diagram. Application
sidecars and East-West Gateways may participate when traffic crosses networks.
Preserve the Sidecar baseline; do not substitute a different mesh data plane.

## 3. Shared dependencies and required Secrets

| Resource | Required contents and placement |
| --- | --- |
| One shared external PostgreSQL database | All Ledger workloads use the same database. Preserve database name, schema/search-path options, TLS settings and other connection semantics. No per-cluster databases, schemas, replication or synchronization are introduced. |
| Secret `intermesh-ledger-db` | Key `DATABASE_URL`, in namespace `intermesh-backend` in each cluster running Ledger. These are separate Kubernetes objects and may contain the identical complete connection string for the shared database. |
| One shared external Keycloak SSO service | Preserve realm `intermesh-bank`, frontend client `intermesh-frontend` and retained client `intermesh-channel-hub`. Its hosting cluster and provisioning are not established by the repository. |
| Secret `intermesh-keycloak-credentials` | In namespace `keycloak`, alongside the Keycloak CR and RealmImport in their hosting cluster. Required keys are `HUB_CLIENT_SECRET`, `DEMO_USER_1_PASSWORD`, `DEMO_USER_2_PASSWORD`, `DEMO_USER_3_PASSWORD` and `DEMO_ADMIN_PASSWORD`. This is a realm-provisioning input, not an active application runtime dependency. |

Do not replicate the Keycloak provisioning Secret into application clusters
merely because they consume shared SSO. If Keycloak provisioning runs in a
cluster, its namespace and referenced Keycloak CR must already exist there.

The Secret examples contain replacement markers, not deployable credentials:

- [PostgreSQL Secret example](../manifests/examples/postgres-secret.example.yaml)
- [Keycloak Secret example](../manifests/examples/keycloak-credentials.secret.example.yaml)
- [Local provisioning instructions](../manifests/examples/README.md)

Actual values belong in protected, ignored local files. RealmImport creates new
realms; updating its provisioning Secret does not rotate credentials in an
already imported realm. The selected Operator/CRD must support `spec.placeholders`;
the repository does not pin the Operator version or include that CRD.

## 4. Kubernetes and Keycloak inventory

Placement below is a requirement or qualification, not a verified deployment map.
Namespaces, service accounts and workload resources must exist locally wherever
their corresponding components run. Do not infer that every manifest belongs in
both clusters.

| File | Declared resources and placement |
| --- | --- |
| [namespaces.yaml](../manifests/namespaces.yaml) | `intermesh-frontend` and `intermesh-backend`, both requesting sidecar injection. Local to applicable application clusters; actual injection also requires the mesh installation. |
| [intermesh-frontend-sa.yaml](../manifests/intermesh-frontend-sa.yaml) | UI service account in `intermesh-frontend`; local where UI runs. |
| [intermesh-backend-sa.yaml](../manifests/intermesh-backend-sa.yaml) | Orchestrator, Ledger, Analytics and retained Hub service accounts in `intermesh-backend`; retain the identities needed by local workloads and mesh policy. |
| [intermesh-ui.yaml](../manifests/intermesh-ui.yaml) | UI Deployment and Service in `intermesh-frontend`; exact cluster placement is unverified. |
| [intermesh-orchestrator.yaml](../manifests/intermesh-orchestrator.yaml) | Orchestrator Deployment and Service in `intermesh-backend`; exact placement is unverified. |
| [intermesh-ledger.yaml](../manifests/intermesh-ledger.yaml) | Ledger Deployment and Service in `intermesh-backend`; each participating cluster needs its local database Secret. |
| [fraud-analytics.yaml](../manifests/fraud-analytics.yaml) | Analytics Deployment and Service in `intermesh-backend`; exact placement is unverified. |
| [intermesh-channel-hub.yaml](../manifests/intermesh-channel-hub.yaml) | Retained Hub Deployment and Service; not part of the active deployment path. |
| [realmimport.yaml](../manifests/keycloak/realmimport.yaml) | `KeycloakRealmImport`, API `k8s.keycloak.org/v2alpha1`, namespace `keycloak`, referencing Keycloak CR `keycloak`. Provision on the Keycloak host, not independently for each application cluster. |

The three banking usernames in the realm match the PostgreSQL fixtures in
[sql/001.sql](../sql/001.sql). Preserve those relationships, all four realm users,
their profiles, roles, groups and credential flags. Do not automatically
anonymize or rename users when changing deployment configuration.

## 5. Istio and ACM inventory

Shared policy intent does not mean Kubernetes objects are shared across clusters.
Direct mesh resources belong in the relevant managed cluster; ACM Policy,
Placement and PlacementBinding resources belong on the ACM hub. The physical hub
and managed-cluster membership are unverified.

| File | Declared resources and placement constraints |
| --- | --- |
| [istio-gateway.yaml](../manifests/ossm/istio-gateway.yaml) | ACM Policy embedding Gateway definitions for `istio-east-west` and `istio-ingress`, plus Placement `placement-all-clusters` and a PlacementBinding. The placement selects `ossm-enabled: "true"`. Policy objects and generated Gateway objects have different owners and locations. |
| [acm-fraud-analytics-vs.yaml](../manifests/ossm/acm-fraud-analytics-vs.yaml) | ACM Policy embedding `fraud-analytics-chaos` VirtualService in `intermesh-backend`, with a binding to `placement-all-clusters`. Requires that placement to exist on the hub. |
| [virtual-service.yaml](../manifests/ossm/virtual-service.yaml) | Ingress VirtualService in `istio-ingress`; routes API traffic to Orchestrator and other traffic to UI. Preserve wildcard host, paths and destinations. |
| [virtual-service-east-west.yaml](../manifests/ossm/virtual-service-east-west.yaml) | East-West VirtualService in `istio-east-west`; routes `/api`, `/v2/fraud`, `/v1/ledger` and `/` to the corresponding service identities. Effective placement and additional L7 configuration are unverified. |
| [fraud-analytics-vs.yaml](../manifests/ossm/fraud-analytics-vs.yaml) | Direct definition of `fraud-analytics-chaos`. Both this file and the ACM policy describe that resource; do not assume both are authoritative simultaneously. Their header matching differs, so effective ownership must be confirmed. |
| [jwt-request-authentication.yaml](../manifests/ossm/jwt-request-authentication.yaml) | RequestAuthentication selecting Orchestrator in `intermesh-backend`; contains issuer/JWKS references and forwards the original token. |
| [jwt-authorization-policy.yaml](../manifests/ossm/jwt-authorization-policy.yaml) | AuthorizationPolicy selecting Orchestrator, containing the issuer principal prefix. This inventory does not establish the effective enforcement of combined policies. |
| [allow-hub-to-orchestrator.yaml](../manifests/ossm/policies/allow-hub-to-orchestrator.yaml) | Despite its filename, declares `allow-ingress-to-orchestrator`, allowing ingress/east-west namespaces. Do not reinterpret it as an active Hub dependency. |
| [allow-ingress-to-ui-api.yaml](../manifests/ossm/policies/allow-ingress-to-ui-api.yaml) | Policies for UI and retained Hub selectors, using ingress/east-west namespace identities. |
| [allow-orchestrator-to-ledger.yaml](../manifests/ossm/policies/allow-orchestrator-to-ledger.yaml) | Ledger policy referencing Orchestrator and East-West Gateway principals. |
| [allow-orchestrator-to-analytics.yaml](../manifests/ossm/policies/allow-orchestrator-to-analytics.yaml) | Analytics policy referencing the corresponding principals. |
| [allow-ledger-to-db.yaml](../manifests/ossm/policies/allow-ledger-to-db.yaml) | Policy referencing the external database hostname and Ledger principal. Its presence is not proof of effective outbound database enforcement. |
| [wasmplugin.yaml](../manifests/ossm/wasmplugin.yaml) | WasmPlugin in `intermesh-backend`, selecting `app: intermesh-orchestrator`; see section 8. |

Internal ServiceEntries and their declared SPIFFE identities must remain aligned:

| File | Identity and namespace |
| --- | --- |
| [fraud-analytics-se.yaml](../manifests/ossm/serviceentry/fraud-analytics-se.yaml) | Analytics service, workload and East-West Gateway identities; `intermesh-backend`. |
| [intermesh-ledger-se.yaml](../manifests/ossm/serviceentry/intermesh-ledger-se.yaml) | Ledger service, workload and gateway identities; `intermesh-backend`. |
| [intermesh-orchestrator-se.yaml](../manifests/ossm/serviceentry/intermesh-orchestrator-se.yaml) | Orchestrator service, workload and gateway identities; `intermesh-backend`. |
| [intermesh-ui-se.yaml](../manifests/ossm/serviceentry/intermesh-ui-se.yaml) | UI service, workload and gateway identities; `intermesh-frontend`. |
| [intermesh-channel-hub-se.yaml](../manifests/ossm/serviceentry/intermesh-channel-hub-se.yaml) | Retained Hub identities; `intermesh-backend`. Does not activate Hub routing. |
| [serviceentry-db.yaml](../manifests/ossm/serviceentry/serviceentry-db.yaml) | External PostgreSQL DNS host, TCP/5432, `MESH_EXTERNAL`; `intermesh-backend`. |
| [serviceentry-keycloak.yaml](../manifests/ossm/serviceentry/serviceentry-keycloak.yaml) | External Keycloak DNS host, HTTPS/443, `MESH_EXTERNAL`; `intermesh-backend`. |

## 6. DestinationRules and session affinity

| File | Declared rule | Verified cluster/network mapping |
| --- | --- | --- |
| [orchestrator-network1-dr.yaml](../manifests/ossm/destination-rules/orchestrator-network1-dr.yaml) | `intermesh-orchestrator-dr-network1`; cookie `network1.session`, TTL `0s`. | **Not verified.** Filename and cookie name do not identify a physical cluster or configured network ID. |
| [orchestrator-network2-dr.yaml](../manifests/ossm/destination-rules/orchestrator-network2-dr.yaml) | `intermesh-orchestrator-dr-network2`; cookie `network2.session`, TTL `0s`. | **Not verified.** Do not infer placement from the suffix alone. |

Both target `intermesh-orchestrator.intermesh-backend.svc.cluster.local` in
`intermesh-backend`. Keep the two definitions separate until their intended
placement is confirmed; do not blindly combine them in one cluster bundle.

Preserve `network1.session`, `network2.session` and `JSESSIONID`, including cookie
forwarding across Gateway hops. [application.properties](../intermesh-orchestrator/src/main/resources/application.properties)
and [VertxSessionConfig.java](../intermesh-orchestrator/src/main/java/it/intermesh/bank/util/VertxSessionConfig.java)
configure the application session and local session store. Network affinity and
application session state are related contracts, not interchangeable cookies.

## 7. Coordinated external endpoint configuration

Change the shared Keycloak endpoint only as a coordinated set:

- UI `KEYCLOAK_URL` in [intermesh-ui.yaml](../manifests/intermesh-ui.yaml), consumed
  by the existing [startup substitution script](../intermesh-ui/src/00-substitute-env.sh).
- Issuer and JWKS URL in RequestAuthentication, issuer principal prefix in
  AuthorizationPolicy, and external Keycloak ServiceEntry host.
- Dormant Hub `KEYCLOAK_ISSUER`, if its retained example is updated, without
  adding it to active deployment composition.

Preserve the realm/client identifiers, URL path relationships and issued-token
issuer semantics. Do not change login flows or authorization rules as part of
host replacement.

For PostgreSQL, align the host inside the protected `DATABASE_URL` with the
database ServiceEntry and existing database policy host reference. Keep one
shared database and preserve all connection options. The committed Secret
example cannot verify actual provisioned values.

## 8. WasmPlugin placement and OCI artifact

The committed WasmPlugin selects Orchestrator-labelled workloads in
`intermesh-backend`, uses an OCI image reference and has `failStrategy: FAIL_OPEN`.
Its current artifact leaf is `security-headers-wasmplugin:1.0`; consult
[wasmplugin.yaml](../manifests/ossm/wasmplugin.yaml) for the configured image locator.
Registry ownership and artifact availability are not validated here.

Preserve [the Rust implementation](../security-headers-wasmplugin/src/lib.rs)
and [its image packaging](../security-headers-wasmplugin/Containerfile). The code
examines HTTP `:authority` for `fraud-analytics` and sets `x-intermesh-channel`
and `x-intermesh-route-class`. Its literal `Web-Channel-Hub` header value is a
routing marker, not evidence that the Channel Hub runs in the active path.
Do not rename those markers or change authorities to match new infrastructure
names without integration evidence. A relocated OCI image must carry the
intended plugin artifact; do not assume a generic image override rewrites the
custom resource's `spec.url`.

## 9. Routing and identity invariants

- Preserve the direct ingress-to-Orchestrator API path and Sidecar injection.
- Preserve service names, namespaces, ports, selectors, service accounts and
  `cluster.local`/SPIFFE identities unless a separately validated migration
  requires changes. Service FQDNs are not obsolete infrastructure endpoints.
- Preserve Gateway names, wildcard hosts, TLS modes and ports, VirtualService
  route ordering, HTTP authority/SNI semantics and session-affinity cookies.
  A virtual host or authority may be a routing identifier rather than a DNS
  address to replace.
- Preserve the fraud header/fault-injection demonstration and its timeout
  relationships. Do not silently reconcile direct and ACM-managed variants.
- Preserve existing internal REST client defaults. The Orchestrator manifest's
  environment-variable names differ from its REST client config keys; effective
  overrides and port selection require a separate integration check, not an
  opportunistic configuration cleanup.
- Keep ACM hub resources separate from managed-cluster resources. A recursive
  deployment of the entire manifests directory is not a placement strategy.

## 10. Missing provisioning information and validation boundary

The following are not established by committed repository evidence:

- Physical cluster/context names, mesh/network IDs and network-to-cluster mapping.
- Mesh control-plane installation, trust/certificate provisioning, remote
  discovery Secrets and inter-cluster connectivity prerequisites.
- External East-West Gateway addresses, public UI Routes, DNS and certificate
  configuration, and the full additional L7 Gateway/authority/SNI configuration.
- Which active workloads and direct mesh resources were installed in each cluster;
  which DestinationRule applied where; and which controller owned the fraud
  VirtualService. ACM managed-cluster membership is also unverified.
- The selected Keycloak Operator/CRD version, Keycloak hosting details, actual
  Secret contents, database provisioning and replacement image availability.

No concrete cluster names, network IDs, addresses or additional manifests are
inferred from those gaps. User context explicitly allows experimental Gateway
configuration that is not committed; the inventory is therefore not a complete
reconstruction of the former working environment.

Before introducing overlays, confirm the resource-placement matrix and identify
the authoritative Gateway and fraud-routing definitions. Offline comparisons can
preserve declared identities, routes and cookie names, but equivalent runtime
behavior requires a later authorized two-cluster test of SSO, direct API routing,
cross-network session affinity, shared Ledger data and fraud behavior. That test
must include any additional L7 Gateway configuration and the unchanged Wasm
artifact. No live deployment validation is claimed by this document.
