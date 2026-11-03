# OSSM Operator governance

This Hub entrypoint describes the Red Hat OpenShift Service Mesh 3 Operator
installation to monitor on both managed clusters. The target baseline is
ACM 2.17 with multicluster engine 2.12 and OSSM 3.4. No active clusters exist;
the Operator is not installed or validated by this repository configuration.

Both the parent Policy and its direct OperatorPolicy template use `inform`:
they report compliance without installing, updating or removing resources.
The parent remediation setting overrides the child setting. The setting
`upgradeApproval: None` prevents this policy from approving upgrades if enforcement
is later enabled; it does not prevent initial installation or approvals made
outside this policy.

The Subscription describes package `servicemeshoperator3` from
`openshift-marketplace/redhat-operators`, installed in `openshift-operators`
with AllNamespaces scope. No OperatorGroup is declared; verify the existing
compatible AllNamespaces group rather than creating a competing group.

The OSSM 3.4 installation guide describes version-specific channels. Do not substitute the generic `stable` channel, which can select another minor release, or omit the channel and accept catalog defaults.

The dedicated PlacementBinding reuses
[`placement-all-clusters`](../ossm/istio-gateway.yaml), in
`open-cluster-management-policies`. The existing
[networking entrypoint](../ossm/kustomization.yaml) supplies that Placement;
this entrypoint does not create it or provision the namespace. The selector
`ossm-enabled: "true"` must identify only the intended managed clusters. Do not
apply that label to the Hub. ACM registration, governance add-ons and the
appropriate ManagedClusterSetBinding are separate prerequisites.

Render and inspect from the repository root without contacting a cluster:

```sh
oc kustomize manifests/acm-infrastructure
```

Before enabling enforcement, verify the target catalog's package, 3.4-specific
channel and supported versions; replace the placeholder with the verified channel.
Review any CSV allowlist without inventing version names. Confirm ACM 2.17 API
support, OLM/catalog health, existing Subscription ownership, OperatorGroup scope
and the Placement's actual decisions. Keep both remediation settings at `inform`
until that review is complete.

Operator installation is separate from `Istio` and `IstioCNI` provisioning.
This entrypoint creates neither resource and does not provision gateways,
certificates, discovery Secrets or the complete mesh. It uses no PolicyGenerator.

References: [ACM 2.17 OperatorPolicy parameters](https://docs.redhat.com/en/documentation/red_hat_advanced_cluster_management_for_kubernetes/2.17/html/governance/policy-controllers),
[parent Policy remediation](https://docs.redhat.com/en/documentation/red_hat_advanced_cluster_management_for_kubernetes/2.17/html/governance/hub-policy-framework),
[ACM 2.17 / engine 2.12 baseline](https://docs.redhat.com/en/documentation/red_hat_advanced_cluster_management_for_kubernetes/2.17/html/release_notes/acm-release-notes),
[OSSM 3.4 installation](https://docs.redhat.com/en/documentation/red_hat_openshift_service_mesh/3.4/html/installing/ossm-installing-service-mesh),
[Red Hat Subscription example](https://developers.redhat.com/articles/2025/12/09/integrate-openshift-gateway-api-openshift-service-mesh).
