# Standalone OpenShift deployment

These profiles compose Intermesh Bank without Advanced Cluster Management. They
target OpenShift with the supported OpenShift Service Mesh Sidecar installation
and the RHCOS 9.x node baseline. Standalone does not imply generic Kubernetes
compatibility; other platforms require separate validation.

Choose either standalone management or ACM reconciliation for each managed
cluster. Do not apply both modes to the same resources. See the
[shared-source deployment diagram](../acm/README.md#shared-sources-and-deployment-ownership)
for the two ownership paths.

## Render a complete profile

From the repository root, without executable plugins:

```sh
oc kustomize deploy/standalone/network1
oc kustomize deploy/standalone/network2
```

Each profile renders 50 unique resources from shared authoritative sources:

| Source group | Resources |
| --- | ---: |
| [Application prerequisites](../../applications/prerequisites/kubernetes/kustomization.yaml) | Two Namespaces and five ServiceAccounts: 7 |
| Application overlay: [network1](../../applications/overlays/network1/kustomization.yaml), [network2](../../applications/overlays/network2/kustomization.yaml) | Four Deployments and four Services: 8 |
| Platform overlay: [network1](../../platform/openshift/ossm/overlays/network1/kustomization.yaml), [network2](../../platform/openshift/ossm/overlays/network2/kustomization.yaml) | Four infrastructure Namespaces, IstioCNI, Istio and gateway workloads: 17 |
| [Istio resources](../../service-mesh/README.md) | Three Gateways, three VirtualServices, three ServiceEntries, one DestinationRule, six AuthorizationPolicies, one RequestAuthentication and one WasmPlugin: 18 |

The platform overlay supplies exactly one `Namespace/istio-system`, including its
network label. Each profile selects one Orchestrator DestinationRule:

| Profile | Istio cluster ID | Istio network | Affinity cookie |
| --- | --- | --- | --- |
| `network1` | `cluster1` | `network1` | `network1.session` |
| `network2` | `cluster2` | `network2` | `network2.session` |

These identities do not specify kubeconfig context names. Verify the destination
cluster before applying any stage. Both profiles retain mesh ID `mesh1`, trust
domain `cluster.local`, DNS capture and the existing OpenShift profiles.

Channel Hub is inactive. Its retained ServiceAccount remains in application
prerequisites, but its Deployment, Service and AuthorizationPolicy are absent.
No ACM resources, Operator installation resources or credential Secrets are
included.

## Environment configuration

Public profiles contain deliberately nonfunctional container images, Wasm OCI
URLs and external endpoint placeholders. Configure actual published artifacts,
DNS names and coordinated OIDC settings before deployment. A successful rendering
does not make these public values deployable.

Copy the [private configuration examples](../../docs/examples/README.md#private-deployment-configuration)
to `.local/` and configure the seven values in
`.local/configuration/values/values.yaml`. The two private profiles reuse one
Component for images, WasmPlugin, PostgreSQL discovery and coordinated OIDC
settings. The rendering-only ConfigMap carrier is omitted from final output.
Credentials remain separately provisioned Secrets.

```sh
oc kustomize .local/deploy/standalone/network1
oc kustomize .local/deploy/standalone/network2
```

Each private profile renders 50 resources. Network assignments, DestinationRules
and affinity cookies come from its matching public profile. Keycloak provisioning
remains independent at `.local/prerequisites/keycloak`. Private ACM output contains
Hub governance objects and must not be applied to a managed cluster. Choose one
deployment owner per cluster.

The staged sources below identify resource boundaries. Apply environment-configured
definitions that agree with the complete private profile, rather than raw public
placeholder values.

## Staged installation

A complete rendering is a configuration inventory, not a readiness-ordered
installer. Apply approved stages to the matching cluster and wait for their
controllers and workloads before continuing.

1. **Install the OSSM Operator separately.** Use the supported OpenShift
   installation procedure. Verify controller readiness, the `sailoperator.io/v1`
   IstioCNI and Istio CRDs, and required admission webhooks. This profile does not
   install the Operator or pin new Istio versions.
2. **Create infrastructure Namespaces and assign the network label.** Use
   [the Namespace base](../../platform/openshift/ossm/namespaces/kustomization.yaml),
   then the matching label-only fragment:
   [network1](../../platform/openshift/ossm/namespaces/network1/kustomization.yaml)
   or [network2](../../platform/openshift/ossm/namespaces/network2/kustomization.yaml).
   The complete platform overlay merges the same label natively. Do not add the
   label fragment as a second Namespace resource inside that complete composition.
3. **Prepare shared trust before creating the control planes.** Provision the
   appropriate per-cluster `cacerts` Secrets in `istio-system` with a shared trust
   root and the intended signing chains. Certificate and private-key preparation
   is external to these manifests; keep Secret material outside Git.
4. **Install and validate IstioCNI.** Use the
   [CNI entrypoint](../../platform/openshift/ossm/cni/kustomization.yaml). Verify
   the admitted resource and healthy CNI coverage of the intended nodes.
5. **Configure each control plane.** Use
   [network1](../../platform/openshift/ossm/control-plane/network1/kustomization.yaml)
   or [network2](../../platform/openshift/ossm/control-plane/network2/kustomization.yaml).
   Check readiness, admitted version, cluster/network identities, DNS capture and
   trust configuration. Configure reciprocal remote-discovery credentials and
   cross-cluster API reachability separately; these profiles do not provision them.
6. **Deploy gateway workloads.** Use the shared
   [Ingress base](../../platform/openshift/ossm/gateways/ingress/kustomization.yaml)
   and matching East-West overlay:
   [network1](../../platform/openshift/ossm/gateways/eastwest/network1/kustomization.yaml)
   or [network2](../../platform/openshift/ossm/gateways/eastwest/network2/kustomization.yaml).
   Verify injection, SCC admission, Ready Pods, Service endpoints and LoadBalancer
   reachability. `image: auto` requires working gateway injection. Preserve the
   existing RBAC, ports, HPA and PDB; admitted Pods also depend on injector defaults.
7. **Provision application prerequisites and external dependencies.** Apply the
   [application prerequisite base](../../applications/prerequisites/kubernetes/kustomization.yaml).
   Each cluster needs `intermesh-backend/intermesh-ledger-db`, key `DATABASE_URL`,
   pointing to the same external PostgreSQL instance. Preserve database, TLS and
   connection options; the Secret hostname must agree with the PostgreSQL
   ServiceEntry. No database, credentials or Secret is generated by this profile.
   The shared database must already have the
   [Ledger schema](../../applications/prerequisites/dependencies/postgresql) prepared.
8. **Prepare shared Keycloak SSO.** Keycloak is an external dependency for both
   frontends. The existing [RealmImport entrypoint](../../applications/prerequisites/dependencies/keycloak/kustomization.yaml)
   belongs in its hosting environment, with the Keycloak Operator, Keycloak CR and
   provisioning Secret already available. RealmImport initially provisions a realm;
   it does not reconcile an existing realm. Demo redirects and Web Origins use
   wildcards, with logout inheriting the login redirect allowlist through `+`; no
   frontend origin configuration is required. Keep issuer, JWKS, TLS trust and
   client settings consistent. Use explicit allowlists for production.
9. **Install Istio configuration before admitting application traffic.** Use the
   existing [Gateways](../../service-mesh/networking/gateways/kustomization.yaml),
   [VirtualServices](../../service-mesh/traffic-management/virtual-services/kustomization.yaml),
   [ServiceEntries](../../service-mesh/networking/service-entries/kustomization.yaml),
   [AuthorizationPolicies](../../service-mesh/security/authorization-policies/kustomization.yaml),
   [RequestAuthentication](../../service-mesh/security/request-authentications/kustomization.yaml)
   and [WasmPlugin](../../service-mesh/wasm/kustomization.yaml) entrypoints. Select
   only the matching [network1](../../service-mesh/traffic-management/destination-rules/network1/kustomization.yaml)
   or [network2](../../service-mesh/traffic-management/destination-rules/network2/kustomization.yaml)
   DestinationRule. Verify API admission, JWT/JWKS configuration, published Wasm
   artifact access and the accepted L4/L7 routes before serving traffic.
10. **Deploy the eight application workloads** from the matching application
    overlay listed above, after Secrets, external dependencies, images, injection
    and security configuration are ready. Keep traffic gated until runtime checks
    pass. Gateway listeners or public Services may become reachable before this
    point; installation order alone does not provide a traffic gate.

## Runtime verification

Verify browser `/` routing to UI and `/api` routing directly to Orchestrator,
shared Keycloak login/logout, JWT rejection and account ownership checks. Confirm
both Ledgers access the same database. Validate public HTTPS certificates and
redirect behavior separately; the existing Gateway declarations do not establish
HTTPS-only access by themselves.

Test local and cross-network service calls, L4 workload mTLS for Ledger/Fraud,
the dedicated Orchestrator L7 route, authority rewriting, Fraud fault/timeout
behavior and workload-unavailability scenarios. Verify the matching
`network1.session` or `network2.session` cookie and local application-session
isolation. `JSESSIONID` identifies Orchestrator's locally stored session; it is
separate from network affinity. Also verify gateway Secret access, HPA/PDB behavior
and Wasm execution. Offline rendering does not prove admission, connectivity,
security enforcement or readiness on a deployed mesh.
