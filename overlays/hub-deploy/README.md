# Hub governance deployment

The [shared Hub governance base](../../manifests/hub-governance/kustomization.yaml)
aggregates 26 Policies, 26 PlacementBindings and three Placements. The
[repository root](../../kustomization.yaml) and this deployment overlay render the
same 55 objects. All 26 Policies declare parent and embedded remediation as
`enforce` in their authoritative governance sources. This overlay reuses the
shared base without remediation patches.

## Rendering layers

From the repository root, use the existing trusted PolicyGenerator plugin:

```bash
# Public governance: all 26 Policies enforce.
oc kustomize . --enable-alpha-plugins

# Public deployment entrypoint: identical governance and public values.
oc kustomize overlays/hub-deploy --enable-alpha-plugins

# Private deployment configuration: same modes, with private expected values.
oc kustomize .local/hub-governance --enable-alpha-plugins
```

All three outputs contain the same 55 resource identities. The two public outputs
are structurally identical; remediation comes from the original PolicyGenerator
configurations and hand-written Policy definitions. Both public outputs retain
placeholders and are not final environment-specific deployment artifacts.

The private overlay imports this deployment overlay and preserves five guarded
replacements: PostgreSQL and Keycloak ServiceEntry hosts, JWT issuer, JWKS URI and
request-principal pattern. Additional guarded patches configure four application
images, UI and Orchestrator Keycloak settings per network, and the shared Wasm OCI
URL. They preserve the effective private environment-array ordering. Its files
remain Git-ignored; keep private configuration and rendered output out of tracked
files. See the [application configuration](../hub-applications/README.md#private-configuration)
and [ServiceEntry/OIDC conventions](../../manifests/examples/README.md#hub-governance-overlay).

The private rendering command is the intended input for eventual Hub deployment,
after all environment values and prerequisites have been validated. Remaining test
values must be replaced before use. Do not apply enforcement output to unprepared
clusters.

## Enforcement and ownership

These Policies declare both parent and embedded remediation as `enforce` in their
authoritative governance sources:

- `intermesh-ossm-operator`
- `intermesh-infra-ns-ingress`
- `intermesh-network1-identity`
- `intermesh-network2-identity`
- `intermesh-istio-cni`
- `intermesh-app-foundation`
- `intermesh-istio-network1`
- `intermesh-istio-network2`
- `intermesh-ingress-network1`
- `intermesh-ingress-network2`
- `intermesh-eastwest-network1`
- `intermesh-eastwest-network2`
- `intermesh-affinity-network1`
- `intermesh-affinity-network2`
- `intermesh-routing-network1`
- `intermesh-routing-network2`
- `istio-gateway`
- `orchestrator-session`
- `istio-fraud-analytics-chaos`
- `intermesh-discovery-internal`
- `intermesh-discovery-external`
- `intermesh-security-static`
- `intermesh-security-oidc`
- `intermesh-app-network1`
- `intermesh-app-network2`
- `intermesh-wasm`

The network identity, control-plane and gateway workload Policies use matching,
separate Placements. Each managed cluster receives only its corresponding network
configuration:

| Control-plane Policy | Placement | Istio network |
| --- | --- | --- |
| `intermesh-istio-network1` | `placement-intermesh-network1` | `network1` |
| `intermesh-istio-network2` | `placement-intermesh-network2` | `network2` |

Each gateway workload Policy depends on its matching control-plane Policy and uses
the same network-specific Placement. Affinity Policies use the matching control
plane and the shared application foundation; routing Policies use the matching
ingress workload and shared logical Gateway Policy. Discovery, security and Fraud
Analytics routing require the shared Operator and application foundation Policies.

The foundation Policy covers the two application Namespaces and five ServiceAccounts.
The retained Channel Hub ServiceAccount does not activate the Channel Hub workload.
The [application and Wasm Policies](../hub-applications/README.md) cover four
Deployments and four Services per network and the shared WasmPlugin. Each
application Policy depends on the foundation and matching control-plane Policy;
the shared Wasm Policy depends on the foundation and Operator. The dormant
Channel Hub AuthorizationPolicy remains in canonical application rendering but
is intentionally excluded from ACM deployment.

Application Deployments retain `replicas: 1`. ACM may reconcile manual scaling
back to that value. Persistent scale-to-zero demonstrations require a separately
reviewed procedure that updates and later restores the Hub desired replica value;
this overlay does not add outage controls or suspend reconciliation.

The Ingress Policies preserve the historical four-resource Deployment, Service and
RBAC baseline: gateway injection, the implicit default ServiceAccount, namespace-scoped
Secret-reading permissions and LoadBalancer mappings `80 → 8080` and `443 → 8443`.
The default ServiceAccount's Secret access is a retained security consideration.

The East-West Policies preserve the seven-resource baseline, including the dedicated
ServiceAccount, network-specific proxy configuration, LoadBalancer ports, HPA and PDB.
The Deployment omits an explicit replica count so the HPA retains scale control.

These Policies reconcile Kubernetes gateway workloads, not Istio `Gateway` networking
resources. Creating gateway Pods does not create the separate L4/L7 Gateway or
VirtualService configuration. The separate networking Policies reconcile those
definitions, including the L4/L7 split, session affinity and Fraud timeout scenario.

Kustomize prepares governance manifests, and PolicyGenerator embeds desired resources
in ACM Policies. The user applies the final approved private rendering to the Hub.
ACM then creates and reconciles resources covered by the selected enforcing Policies;
OpenShift, OLM and Istio controllers reconcile their respective workloads.

The [application base](../../manifests/kustomization.yaml) and
[network1](../managed-cluster-1/kustomization.yaml) and
[network2](../managed-cluster-2/kustomization.yaml) overlays remain authoritative
reference and validation inputs, not parallel deployment entrypoints for ACM-owned
resources. Do not also apply those resources manually to a managed cluster.

## Prerequisites and runtime checks

Deployment requires an operational ACM Hub, its governance namespace and appropriate
permissions, and two registered managed OpenShift clusters with the correct
`ossm-enabled` and `ossm-network` labels. The Operator catalog must be available.

OperatorPolicy compliance, successful OLM installation, IstioCNI CRD registration,
IstioCNI resource creation and CNI runtime readiness are separate checkpoints. The
existing CNI dependencies on the Operator and infrastructure Namespace Policies do
not replace runtime verification. Verify the Operator installation and registered
IstioCNI API, then CNI readiness and the Istio CRD/webhook, before relying on
control-plane reconciliation.
A ConfigurationPolicy becoming Compliant does not prove workload readiness.

Shared root trust and appropriate per-cluster signing material must be in place
before initial control-plane installation. Prepare reciprocal remote-discovery
credentials and cross-cluster API reachability for multi-primary operation; this
overlay does not provision them.

Gateway workload Policies depend on the corresponding Istio Policy, but compliance
does not establish gateway readiness. The deployment process must verify:

1. OSSM Operator and required CRD/webhook readiness.
2. IstioCNI readiness.
3. Ready control planes and `istiod` workloads in both clusters.
4. Successful gateway proxy injection and OpenShift admission.
5. Ready Ingress and East-West Gateway Pods.
6. Provisioned LoadBalancer addresses and network reachability.
7. Shared trust and remote discovery before testing multicluster traffic.

Use staged runtime checkpoints; this overlay adds no readiness-gating resources.
Before propagating the enforcing networking and security Policies, verify that
their Istio APIs and admission webhooks are ready on both managed clusters.
Shared Policies cannot depend on both network-specific control-plane or gateway
Policies because those prerequisites have mutually exclusive Placements.
Namespace dependencies order resource creation; neither they nor Operator Policy
compliance establish runtime readiness.

PostgreSQL and Keycloak remain separately provisioned dependencies, including the
database schema, realm/client configuration and credentials. Before Ledger workloads
are deployed, each managed cluster needs `intermesh-backend/intermesh-ledger-db`
with key `DATABASE_URL`, pointing to the shared database. Credential bootstrap requires
a separately approved procedure; do not put credentials or placeholder Secrets into
public governance.

Container and Wasm images and any required pull credentials must be available.
Validate the Ingress HTTPS/TLS configuration and coordinated OIDC issuer, JWKS,
TLS trust and browser origins before serving application traffic. This overlay
does not provision external infrastructure or replace these operational checks.

**No actual managed-cluster deployment has been validated.** Offline rendering and
structural checks do not establish API admission, Operator or CNI readiness, or live
mesh behavior.
