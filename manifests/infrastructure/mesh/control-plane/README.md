# Multi-primary control-plane governance

This entrypoint checks one Istio control plane on each of the two managed
clusters. Both use the OSSM 3.4 Sidecar data plane, a shared mesh ID and trust
domain, and distinct cluster and network identities.

The [shared source](base/istio.yaml) retains `meshID: mesh1`,
`trustDomain: cluster.local` and DNS capture from the original Sidecar
configuration. The ordinary overlays add only these values:

| Overlay | `global.multiCluster.clusterName` | `global.network` |
|---|---|---|
| [network1](network1/kustomization.yaml) | `cluster1` | `network1` |
| [network2](network2/kustomization.yaml) | `cluster2` | `network2` |

These are Istio identities; ManagedCluster registration names are independent.
The existing Placements select ManagedClusters labeled `ossm-enabled: "true"`
and `ossm-network: network1` or `ossm-network: network2`. `ossm-network` is a
project-defined label. A single-valued network label makes these selectors
mutually exclusive. Namespace label `topology.istio.io/network` must agree with
the selected control plane's network.

## Istio configuration

The cluster-scoped resource uses `sailoperator.io/v1`, kind `Istio`, name
`default`, and no `metadata.namespace`. `spec.namespace: istio-system` selects
the control-plane namespace. The `openshift` profile is supported by the Red Hat
release-3.4 API and records the intended OpenShift configuration.

`spec.version` is omitted so the installed Red Hat Operator's CRD default
selects the initial version at admission. Record and validate the admitted
version before use; omission neither pins a version nor automatically upgrades
an existing resource when the default changes. The intended node OS baseline
is RHCOS 9.x on a supported OpenShift deployment, without assuming a particular
OpenShift minor version. No `nativeNftables` override is configured.

DNS capture is explicitly enabled with
`values.meshConfig.defaultConfig.proxyMetadata.ISTIO_META_DNS_CAPTURE: "true"`.
The Red Hat release-3.4 values API accepts string-valued proxy metadata, and
the Red Hat Istio Sidecar agent reads this setting to enable its DNS proxy.
It preserves the original Sidecar configuration; DNS interception and
ServiceEntry resolution still require deployment validation.

Session affinity uses the existing cookie-based DestinationRules and dedicated
East-West L7 routing. No experimental Pilot session-persistence settings or
Ambient configuration are added. Control-plane provisioning does not establish
gateway workloads, remote discovery or working cross-network routing.

## Offline rendering

From the repository root:

```sh
oc kustomize manifests/infrastructure/mesh/control-plane/network1
oc kustomize manifests/infrastructure/mesh/control-plane/network2
oc kustomize manifests/infrastructure/mesh/control-plane --enable-alpha-plugins
```

Each ordinary overlay renders one Istio CR for its managed cluster. The
[generator entrypoint](kustomization.yaml) consumes descendant directories and
emits four Hub resources in `open-cluster-management-policies`:

| Policy | PlacementBinding | Existing Placement |
|---|---|---|
| `intermesh-istio-network1` | `binding-intermesh-istio-network1` | `placement-intermesh-network1` |
| `intermesh-istio-network2` | `binding-intermesh-istio-network2` | `placement-intermesh-network2` |

No Placement or standalone Istio CR is emitted in the Hub output. Each Policy
contains exactly one ConfigurationPolicy and one Istio object-template.
Parent and embedded remediation are `inform`, comparison is `musthave`, and
pruning and forced recreation are disabled. The ordinary entrypoints are for
inspection and separately authorized managed-cluster provisioning, not Hub
deployment. Existing governance and application entrypoints do not include them.

## Dependencies and operational prerequisites

Each root Policy requires these Policies to be `Compliant` on the same managed
cluster, in namespace `open-cluster-management-policies`:

- [`intermesh-ossm-operator`](../../../acm-infrastructure/ossm-operator-policy.yaml)
- [`intermesh-infra-ns-ingress`](../../policy-generator.yaml)
- [`intermesh-istio-cni`](../cni/policy-generator.yaml)
- Its corresponding identity Policy:
  [`intermesh-network1-identity`](../../network-identity/policy-generator-network1.yaml)
  or [`intermesh-network2-identity`](../../network-identity/policy-generator-network2.yaml).

Dependencies use API `policy.open-cluster-management.io/v1`, kind `Policy`,
and compliance `Compliant`. `ignorePending` is false; the generator can omit
the field because false is the default. There is no cross-network dependency
or automatic ordering. Inform-only evaluation does not provision control planes.

Before separately authorized provisioning, require:

- Correct ManagedCluster registration, ClusterSet access and PlacementDecision
  membership for the two network Placements.
- The installed OSSM Operator and established, compatible Istio and IstioCNI CRDs.
- Required infrastructure Namespaces and the correct per-cluster
  `topology.istio.io/network` label.
- Securely provisioned and validated `cacerts` Secrets in `istio-system`, sharing
  the intended trust root with the respective intermediate CAs. Keep certificate
  and private key material outside Git.
- An admitted, healthy `IstioCNI/default` resource and healthy CNI DaemonSet
  coverage of all intended nodes, as described in the [CNI checks](../cni/README.md).

Only then provision the Istio control planes. Require each `Istio/default` to
report `Ready=True`, healthy status and the expected observed configuration,
including its admitted version, cluster identity and network. Check
`status.observedGeneration` against `metadata.generation` where applicable.
Policy compliance establishes desired-field agreement, not CNI readiness,
certificate validity or control-plane health; these checks are operational gates.

The existing [networking governance entrypoint](../../../ossm/kustomization.yaml)
contains enforced Policies without bootstrap dependencies. Do not activate it
before the required control planes, gateways and remote discovery are ready.
Its routing resources and deployment gate are separate from this entrypoint.

Local generation uses the installed upstream macOS PolicyGenerator v0.19.0.
It does not establish equivalence with the Red Hat ACM 2.17 distribution or
prove cluster admission or runtime readiness. Deployment tests must also validate
Sidecar injection, DNS capture, shared trust, remote discovery, L4 passthrough,
the dedicated Orchestrator L7 path and network-specific session affinity.

## References

- [OSSM 3.4 installation](https://docs.redhat.com/en/documentation/red_hat_openshift_service_mesh/3.4/html/installing/ossm-installing-service-mesh)
- [OSSM 3.4 multi-cluster topologies](https://docs.redhat.com/en/documentation/red_hat_openshift_service_mesh/3.4/html/installing/ossm-multi-cluster-topologies)
- [Red Hat release-3.4 Istio API](https://github.com/openshift-service-mesh/sail-operator/blob/release-3.4/api/v1/istio_types.go)
- [Red Hat release-3.4 values API](https://github.com/openshift-service-mesh/sail-operator/blob/release-3.4/api/v1/values_types.gen.go)
- [Red Hat Istio agent DNS capture setting](https://github.com/openshift-service-mesh/istio/blob/release-1.30/pilot/cmd/pilot-agent/options/options.go)
- [Red Hat Istio Sidecar DNS proxy](https://github.com/openshift-service-mesh/istio/blob/release-1.30/pkg/istio-agent/agent.go)
- [ACM 2.17 Policy dependencies](https://docs.redhat.com/en/documentation/red_hat_advanced_cluster_management_for_kubernetes/2.17/html/governance/hub-policy-framework)
