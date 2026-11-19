# OSSM Operator governance

This Hub entrypoint describes the Red Hat OpenShift Service Mesh 3 Operator
installation to reconcile on both managed clusters. The target baseline is
ACM 2.17 with multicluster engine 2.12 and OSSM 3.5. Verify catalog availability
and installed Operator health before provisioning mesh custom resources.

Both the parent Policy and its direct OperatorPolicy template declare `enforce`:
ACM can install and reconcile the Operator when the governance is deployed.
The parent remediation setting overrides the child setting. The setting
`upgradeApproval: None` prevents this policy from approving upgrades; it does not
prevent initial installation or approvals made outside this policy.

The Subscription describes package `servicemeshoperator3` from
`openshift-marketplace/redhat-operators`, installed in `openshift-operators`
with AllNamespaces scope. No OperatorGroup is declared; verify the existing
compatible AllNamespaces group rather than creating a competing group.

The configured `stable-3.5` channel targets the OSSM minor release. The generic
`stable` channel or an omitted channel can select a different catalog default.
The published component baseline is Operator 3.5.0 with Istio and IstioCNI 1.31.1.
The Policy does not pin a CSV name or declare a `versions` allowlist. Confirm the
channel's actual CSV and version in each managed cluster's catalog before approval.

The dedicated PlacementBinding reuses
[`placement-all-clusters`](../../../placements/placement-all-clusters.yaml), in
`open-cluster-management-policies`. The
[central Placement group](../../../placements/kustomization.yaml) supplies that
Placement; this entrypoint does not create it or provision the namespace. The selector
`ossm-enabled: "true"` must identify only the intended managed clusters. Do not
apply that label to the Hub. ACM registration, governance add-ons and the
appropriate ManagedClusterSetBinding are separate prerequisites.

Render and inspect from the repository root without contacting a cluster:

```sh
oc kustomize deploy/acm/policies/platform/operator
```

Before deployment, verify the target catalog's package, configured `stable-3.5`
channel and supported versions.
Review any CSV allowlist without inventing version names. Confirm ACM 2.17 API
support, OLM/catalog health, existing Subscription ownership, OperatorGroup scope
and the Placement's actual decisions before applying this enforcing configuration.

Operator installation is separate from `Istio` and `IstioCNI` provisioning.
This entrypoint creates neither resource and does not provision gateways,
certificates, discovery Secrets or the complete mesh. It uses no PolicyGenerator.

For an existing installation, reapply the regenerated Stage 1 artifact on the Hub.
Only the Operator Policy's channel changes; the other bootstrap objects retain
their desired definitions. Keep Subscription ownership with ACM. Because
`upgradeApproval: None` is preserved, this operation does not authorize ACM to
approve the upgrade. Review and explicitly approve the matching OLM InstallPlan
on each managed cluster; do not edit the managed Subscription. Follow the
[Operator upgrade procedure](../../../../../docs/acm-deployment-readiness.md#updating-the-operator-before-mesh-provisioning).
Policy compliance alone does not establish that the installed CSV has upgraded.

References: [ACM 2.17 OperatorPolicy parameters](https://docs.redhat.com/en/documentation/red_hat_advanced_cluster_management_for_kubernetes/2.17/html/governance/policy-controllers),
[parent Policy remediation](https://docs.redhat.com/en/documentation/red_hat_advanced_cluster_management_for_kubernetes/2.17/html/governance/hub-policy-framework),
[ACM 2.17 / engine 2.12 baseline](https://docs.redhat.com/en/documentation/red_hat_advanced_cluster_management_for_kubernetes/2.17/html/release_notes/acm-release-notes),
[OSSM 3.5 component versions](https://docs.redhat.com/en/documentation/red_hat_openshift_service_mesh/3.5/html/release_notes/ossm-release-notes-version-support-tables),
[OSSM 3.5 updating](https://docs.redhat.com/en/documentation/red_hat_openshift_service_mesh/3.5/html/updating/index),
[Red Hat Subscription example](https://developers.redhat.com/articles/2025/12/09/integrate-openshift-gateway-api-openshift-service-mesh).
