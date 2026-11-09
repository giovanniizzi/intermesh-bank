# Application and Wasm governance

ACM deploys and reconciles the four active application workloads and the
Orchestrator security-headers WasmPlugin through three Policies configured with
`enforce` in their source definitions.

| Policy and ConfigurationPolicy | Placement | Desired resources |
| --- | --- | --- |
| `intermesh-app-network1` | `placement-intermesh-network1` | Four Deployments and four Services for network1 |
| `intermesh-app-network2` | `placement-intermesh-network2` | Four Deployments and four Services for network2 |
| `intermesh-wasm` | `placement-all-clusters` | `intermesh-backend/security-headers-wasmplugin` |

Each PlacementBinding is named `binding-` followed by its Policy name. Parent and
embedded remediation are `enforce`, comparison is `musthave`, pruning and forced
recreation are `None`, and `ignorePending` defaults to `false`.

## Source inputs and ownership

The [network1 input](inputs/network1/kustomization.yaml) and
[network2 input](inputs/network2/kustomization.yaml) consume the
[shared workload base](../../manifests/workloads/kustomization.yaml). Its explicit
resource list names eight single-object files: the Deployment and Service for
Intermesh UI, Orchestrator, Ledger and Fraud Analytics. Each resource has one
authoritative definition, shared with canonical application rendering.

The [network1 component](../components/network1/kustomization.yaml) and
[network2 component](../components/network2/kustomization.yaml) hold the existing
public image mappings and `NETWORK` patches. Canonical managed-cluster overlays
and ACM inputs use the same component for each network.

The [Wasm input](inputs/wasm/kustomization.yaml) consumes a
[separate base](../../manifests/ossm/wasm/kustomization.yaml) listing only
`security-headers-wasmplugin.yaml`. Canonical application rendering uses that
same definition. No Kind-based exclusion or output filtering is used.

Both source bases have closed membership. Adding another file or referencing a
new resource from the canonical application alone does not include it in these
ACM Policies. To onboard a resource, review its exact API, kind, namespace and
name, and explicitly approve its source-base membership and governance ownership.
Update private guards where necessary and validate complete public/private
equivalence. Treat any change to a source base's resource list as an ACM ownership
change; the Wasm base is scoped to the single approved plugin.

The inputs are contained beneath this governance entrypoint. Reusing application
directory bases from this separate branch avoids ancestor accumulation cycles
and preserves normal Kustomize load restrictions.

Application Kustomizations remain desired-resource references and validation
inputs. Deploy ACM-owned resources through the approved Hub rendering rather
than also applying application overlays manually to managed clusters.

Channel Hub is inactive. Its dormant `allow-ingress-to-intermesh-channel-hub`
AuthorizationPolicy remains in ordinary application rendering but is deliberately
excluded from ACM deployment. Its retained ServiceAccount is already covered by
the application foundation Policy.

## Private configuration

Public application images use `example.invalid` placeholders, and the public
WasmPlugin uses a nonfunctional OCI URL. Configure the existing Git-ignored
`.local/hub-governance/kustomization.yaml`; do not create a parallel Hub entrypoint.
Preserve its five ServiceEntry and OIDC replacements and their guards.

Append targeted JSON patches for the three parent Policies above. Guard the
embedded ConfigurationPolicy identity, each affected resource's API, kind, name
and namespace, container names, environment names and original public values
before making replacements. For each network, configure four image references,
the UI `KEYCLOAK_URL` and Orchestrator `MP_JWT_VERIFY_ISSUER` from the effective
private application rendering. Configure WasmPlugin `spec.url` separately,
preserving `oci://`; both networks must use the same plugin expectation.

Compare environment arrays in order. The public Orchestrator rendering places
`NETWORK` before `MP_JWT_VERIFY_ISSUER`; the private application overlay places
the issuer first. A guarded JSON `move` reproduces that ordering before replacing
the issuer value, without rebuilding the Deployment or changing either source
overlay. Retain the matching network value and all other environment entries.

Require exact resource equality with each private application rendering after
every configuration change, normalizing mapping order only. The UI, Orchestrator
and Istio issuer settings must describe the same shared Keycloak realm. Store
private values and rendered output outside tracked files; patches are not
credential storage.

## Rendering and validation

From the repository root, use the installed trusted PolicyGenerator plugin:

```sh
# Three Policies and three PlacementBindings; no standalone workloads.
oc kustomize overlays/hub-applications --enable-alpha-plugins

# Complete public and private Hub governance.
oc kustomize . --enable-alpha-plugins
oc kustomize overlays/hub-deploy --enable-alpha-plugins
oc kustomize .local/hub-governance --enable-alpha-plugins
```

Each complete Hub rendering contains 55 objects: 26 Policies, 26 PlacementBindings
and three Placements. Public output retains nonfunctional placeholders and must
not be used as environment-specific deployment configuration. The private Hub
expectations must match all eight application resources per network and the
shared WasmPlugin, including scalar types and array ordering.

## Prerequisites and demonstrations

Each application Policy requires `intermesh-app-foundation` and its matching
`intermesh-istio-network1` or `intermesh-istio-network2` Policy to be `Compliant`.
The shared Wasm Policy requires the foundation and `intermesh-ossm-operator`.
It cannot depend on both mutually exclusive network-specific control planes.
Compliance does not establish runtime readiness: verify CRDs and admission
webhooks, CNI, control planes, Sidecar injection, gateways, shared trust, remote
discovery and security configuration before serving application traffic.

Both managed clusters require the separately provisioned Secret
`intermesh-backend/intermesh-ledger-db`, key `DATABASE_URL`, pointing to one shared
external PostgreSQL database. No Secret is generated by these Policies. The active
Deployments reference no additional Secrets or ConfigMaps; registry pull credentials
may be needed for the selected container and Wasm artifacts. PostgreSQL schema,
Keycloak realm/client configuration, coordinated issuer/JWKS/TLS settings and
published images remain external prerequisites. See the
[Hub runtime checks](../hub-deploy/README.md#prerequisites-and-runtime-checks).

All application Deployments retain `replicas: 1`. ACM enforcement can restore a
manually scaled Deployment to one replica, so managed-cluster scale-to-zero is
not a persistent outage control. An intentional workload-unavailability demo
should use a separately reviewed procedure that changes the Hub desired replica
value and restores it afterward. This configuration adds no outage controls or
reconciliation suspension and preserves the Fraud timeout and L4/L7 affinity
definitions.

Offline rendering does not establish runtime admission, image availability,
Wasm execution, HTTPS or end-to-end multicluster behavior. No live deployment
has been validated.
