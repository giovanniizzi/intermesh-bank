# Network identity governance

This Hub governance entrypoint checks the `istio-system` network label separately
from the [shared Namespace existence policy](../README.md). It uses project-defined
labels on Hub `ManagedCluster` objects to select the intended Istio network:

| Hub ManagedCluster labels | Placement | Required Namespace label |
| --- | --- | --- |
| `ossm-enabled=true`, `intermesh.io/network=network1` | `placement-intermesh-network1` | `topology.istio.io/network=network1` |
| `ossm-enabled=true`, `intermesh.io/network=network2` | `placement-intermesh-network2` | `topology.istio.io/network=network2` |

`intermesh.io/network` is a project selection convention, not an Istio label.
Verify ownership of the `intermesh.io` DNS prefix before production adoption.
The `topology.istio.io/network` label belongs on the managed cluster's
`istio-system` Namespace. Labeling that Namespace does not label its Hub
ManagedCluster object.

## Bootstrap labels

After verifying the actual ACM registration names, apply these labels on the Hub:

```sh
oc label managedcluster <cluster1-managedcluster-name> \
  intermesh.io/network=network1
oc label managedcluster <cluster2-managedcluster-name> \
  intermesh.io/network=network2
```

These are manual examples, not automated actions. The existing `ossm-enabled=true`
label is also required. A cluster missing either selector label is not selected.
The two network selectors are mutually exclusive, but multiple clusters can match
the same Placement if mislabeled. No `numberOfClusters` limit substitutes for
verifying those identities. Confirm ManagedClusterSet membership and the
governance namespace's ManagedClusterSetBinding permissions before deployment.

## Offline generation

From the repository root, use the installed PolicyGenerator plugin:

```sh
oc kustomize manifests/infrastructure/network-identity --enable-alpha-plugins
```

The Kustomization explicitly includes two Placement manifests and invokes one
generator configuration per network. Each generator consumes only its descendant
[network1](namespace-labels/network1.yaml) or
[network2](namespace-labels/network2.yaml) Namespace label definition and references
the corresponding Placement by name, so it does not generate another Placement.
The Namespace inputs are policy source fragments, not standalone Hub resources.

The output contains six Hub resources in `open-cluster-management-policies`:

| Policy | PlacementBinding | Placement |
| --- | --- | --- |
| `intermesh-network1-identity` | `binding-intermesh-network1-identity` | `placement-intermesh-network1` |
| `intermesh-network2-identity` | `binding-intermesh-network2-identity` | `placement-intermesh-network2` |

Each Policy contains one ConfigurationPolicy with one `Namespace/istio-system`
object-template. Both `complianceType` and `metadataComplianceType` are `musthave`;
the only asserted label is `topology.istio.io/network`. Both parent and embedded
remediation are `inform`, with pruning and recreation disabled. Missing or wrong
labels are reported without changing the Namespace.

The shared existence policy omits labels. Partial-object `musthave` comparison
therefore permits these network-specific assertions without requiring unrelated
OpenShift metadata to be absent. This follows the documented comparison semantics;
actual ACM enforcement and metadata preservation require live validation.

Local generation is validated with the upstream macOS PolicyGenerator reporting
v0.19.0. It does not establish equivalence with the Red Hat ACM 2.17 distribution,
runtime admission or cluster compliance. This entrypoint is independent of
[Operator governance](../../acm-infrastructure/kustomization.yaml),
[shared Namespace governance](../kustomization.yaml),
[networking governance](../../ossm/kustomization.yaml) and application overlays.

## Provisioning and enforcement gates

Before control-plane provisioning, verify both Hub labels and the corresponding
Namespace label. Namespace existence compliance alone is insufficient: a missing
or wrong network label must block provisioning. Secure `cacerts` preparation is a
separate prerequisite; no CA keys or Secret contents belong in these manifests.

On an available Hub, inspect both Placement decisions:

```sh
oc get placementdecision -n open-cluster-management-policies \
  -l cluster.open-cluster-management.io/placement=placement-intermesh-network1 -o yaml
oc get placementdecision -n open-cluster-management-policies \
  -l cluster.open-cluster-management.io/placement=placement-intermesh-network2 -o yaml
```

Require each PlacementDecision set to select exactly its intended cluster, exclude
the other cluster, and report no unresolved placement failures. Both intended
clusters must satisfy `ossm-enabled=true`, their respective project network label
and ClusterSet access requirements.

Before enabling enforcement, test that correct labels stay unchanged, missing or
incorrect labels are reported NonCompliant, remediation preserves unrelated
Namespace metadata, and repeated reconciliation causes no oscillation or recreation.
Confirm compatibility with the shared existence policy. Neither control plane may
be provisioned until its network identity and secure `cacerts` prerequisites are
satisfied. These policies remain inform-only and do not implement a provisioning
gate automatically.

References: [ACM 2.17 configuration policy semantics](https://docs.redhat.com/en/documentation/red_hat_advanced_cluster_management_for_kubernetes/2.17/html/governance/policy-controllers),
[ACM 2.17 Placement selection](https://docs.redhat.com/en/documentation/red_hat_advanced_cluster_management_for_kubernetes/2.17/html-single/clusters/index),
[OSSM 3.4 multicluster preparation](https://docs.redhat.com/en/documentation/red_hat_openshift_service_mesh/3.4/html/installing/ossm-multi-cluster-topologies).
