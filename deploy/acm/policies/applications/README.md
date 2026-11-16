# Application governance

ACM deploys the application foundation and the four active workloads in each
network through three Policies configured with `enforce` in their sources.
The security-headers WasmPlugin is governed by the separate
[Wasm group](../service-mesh/wasm/kustomization.yaml).

| Policy and ConfigurationPolicy | Placement | Desired resources |
| --- | --- | --- |
| `intermesh-app-network1` | `placement-intermesh-network1` | Four Deployments and four Services for network1 |
| `intermesh-app-network2` | `placement-intermesh-network2` | Four Deployments and four Services for network2 |
| `intermesh-app-foundation` | `placement-all-clusters` | Two application Namespaces and five ServiceAccounts |

Each PlacementBinding is named `binding-` followed by its Policy name. Parent and
embedded remediation are `enforce`, comparison is `musthave`, pruning and forced
recreation are `None`, and `ignorePending` defaults to `false`.

## Source inputs and ownership

The [network1 input](inputs/network1/kustomization.yaml) and
[network2 input](inputs/network2/kustomization.yaml) consume the
[network1](../../../../applications/overlays/network1/kustomization.yaml) and
[network2](../../../../applications/overlays/network2/kustomization.yaml) application overlays.
Their [shared workload base](../../../../applications/base/kustomization.yaml) has an explicit
resource list naming eight single-object files: the Deployment and Service for
Intermesh UI, Orchestrator, Ledger and Fraud Analytics. Each resource has one
authoritative definition, shared with standalone rendering.

The shared workload base defines the existing public image mappings once.
Each application overlay applies its matching `NETWORK` patch. Standalone
profiles and ACM inputs use the same application overlay for each network.

The [Wasm input](../service-mesh/wasm/inputs/wasm/kustomization.yaml) consumes a
[separate base](../../../../service-mesh/wasm/kustomization.yaml) listing only
`security-headers-wasmplugin.yaml`. Standalone rendering uses that
same definition. No Kind-based exclusion or output filtering is used.

Both source bases have closed membership. Adding another file or referencing a
new resource from another composition alone does not include it in these
ACM Policies. To onboard a resource, review its exact API, kind, namespace and
name, and explicitly approve its source-base membership and governance ownership.
Update private guards where necessary and validate complete public/private
equivalence. Treat any change to a source base's or application overlay's resource
list as an ACM ownership change; the Wasm base is scoped to the single approved plugin.

The inputs are contained beneath this governance entrypoint. Reusing application
directory bases from contained inputs avoids ancestor accumulation cycles
and preserves normal Kustomize load restrictions.

Application Kustomizations remain desired-resource references and validation
inputs. Deploy ACM-owned resources through the approved Hub rendering rather
than also applying application overlays manually to managed clusters.

Channel Hub is inactive. Its retained ServiceAccount is covered by the
application foundation Policy; no Channel Hub AuthorizationPolicy is included.

## Private configuration

Public application images use `example.invalid` placeholders, and the public
WasmPlugin uses a nonfunctional OCI URL. Configure their complete private
references once in `.local/configuration/values/values.yaml`.
The [shared configuration examples](../../../../docs/examples/README.md#private-deployment-configuration)
provide the values base, standalone Component and separate ACM mappings.

The `.local/deploy/acm` overlay retains guarded JSON tests for each affected
ConfigurationPolicy, embedded resource, container, environment name and public
value. Native replacements write the shared configuration only after those
checks pass. WasmPlugin `spec.url` has a separate mapping and retains `oci://`.

Compare environment arrays in order. The public Orchestrator rendering places
`NETWORK` before `MP_JWT_VERIFY_ISSUER`; guarded JSON moves reproduce the private
issuer-first order. Retain the matching network value and all other entries.

Require exact equality with the corresponding private standalone resources after
configuration changes, normalizing mapping order only. Keep UI, Orchestrator and
Istio aligned with the shared Keycloak realm. Private files and rendering output
remain outside Git; the values carrier must not contain credentials.

## Rendering and validation

From the repository root, use the installed trusted PolicyGenerator plugin:

```sh
# Foundation and two workload Policies with their PlacementBindings.
oc kustomize deploy/acm/policies/applications --enable-alpha-plugins

# Eight application workloads per network.
oc kustomize applications/overlays/network1
oc kustomize applications/overlays/network2

# Complete public and private Hub governance.
oc kustomize deploy/acm --enable-alpha-plugins
oc kustomize .local/deploy/acm --enable-alpha-plugins
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
[Hub runtime checks](../../README.md#prerequisites-and-runtime-checks).

All application Deployments retain `replicas: 1`. ACM enforcement can restore a
manually scaled Deployment to one replica, so managed-cluster scale-to-zero is
not a persistent outage control. An intentional workload-unavailability demo
must coordinate Hub desired replicas and restoration. Follow the
[workload-unavailability procedure](../../../../docs/acm-deployment-readiness.md#workload-unavailability-and-restoration)
without changing Fraud timeouts or L4/L7 affinity definitions.

Offline rendering does not establish runtime admission, image availability,
Wasm execution, HTTPS or end-to-end multicluster behavior. No live deployment
has been validated.
