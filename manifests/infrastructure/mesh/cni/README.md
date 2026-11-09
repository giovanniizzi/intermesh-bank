# Istio CNI governance

This entrypoint checks one `IstioCNI/default` resource per OSSM-enabled managed
cluster. CNI configuration is shared across both Istio networks; network-specific
control-plane settings are outside this entrypoint.

The [source manifest](source/istiocni.yaml) uses `sailoperator.io/v1` and the
`openshift` profile for the Sidecar deployment. The CR is cluster-scoped and has
no `metadata.namespace`; `spec.namespace: istio-cni` selects the component namespace.
The explicit profile records the intended OpenShift configuration, which the
product also layers over its default profile on OpenShift.

The intended node OS baseline is RHCOS 9.x on a supported OpenShift deployment.
No specific OpenShift minor version is assumed. RHEL/RHCOS 10 is outside this
baseline, and no `spec.values.global.nativeNftables` override is configured.

`spec.version` is omitted so the installed Red Hat Operator's CRD default selects
the initial version at admission. Record that admitted version before use; omission
does not pin a release or automatically upgrade an existing CR when defaults change.

## Offline rendering

From the repository root:

```sh
oc kustomize manifests/infrastructure/mesh/cni/source
oc kustomize manifests/infrastructure/mesh/cni --enable-alpha-plugins
```

The ordinary [source Kustomization](source/kustomization.yaml) renders one IstioCNI
CR. The [PolicyGenerator configuration](policy-generator.yaml) consumes that
descendant directory and generates two Hub resources in
`open-cluster-management-policies`:

- Policy `intermesh-istio-cni`, containing one ConfigurationPolicy and one IstioCNI
  object-template.
- PlacementBinding `binding-intermesh-istio-cni`, referencing the existing
  [`placement-all-clusters`](../../../ossm/istio-gateway.yaml), which selects
  ManagedClusters labeled `ossm-enabled: "true"`.

No Placement or standalone IstioCNI CR is emitted in the Hub output. The source
entrypoint is for inspection and separate managed-cluster provisioning, not Hub
deployment. Existing application and governance entrypoints do not include it.

## Dependencies and compliance

The generated root Policy requires both of these Policies to be `Compliant` on
the same managed cluster, using namespace `open-cluster-management-policies`:

- [`intermesh-ossm-operator`](../../../acm-infrastructure/ossm-operator-policy.yaml)
- [`intermesh-infra-ns-ingress`](../../policy-generator.yaml)

Dependencies are explicit, automatic ordering is not used, and `ignorePending`
is false. Both parent and embedded remediation settings are `enforce`. Comparison is
`musthave`, with pruning and forced recreation disabled. Unmet dependencies prevent
the dependent template from activating. Once dependencies are satisfied, ACM can
create IstioCNI and reconcile its declared configuration.

Namespace compliance confirms only the asserted Namespace configuration. Operator
policy compliance does not validate this CR against the selected admission schema.
CNI ConfigurationPolicy compliance means the desired CR fields match; it does not
prove that CNI pods are ready or that traffic redirection works.

Local generation is validated with the installed upstream macOS PolicyGenerator
v0.19.0. It does not establish equivalence with the Red Hat ACM 2.17 distribution
or demonstrate live admission, reconciliation or readiness.

## Rollout checks

Before separately authorized provisioning, verify:

- The shared Placement selects exactly the intended managed clusters, with valid
  ClusterSet access.
- The approved OSSM 3.4 Operator is installed and its IstioCNI CRD is established,
  serves `sailoperator.io/v1`, and accepts the source CR with the selected profile.
- Required namespaces exist and both dependency Policies report compliance.
- Node OS and OpenShift support match the RHCOS 9.x baseline.
- The admitted CNI version is supported and recorded.

After provisioning, require `IstioCNI/default` to report `Ready=True` and healthy
status, with `status.observedGeneration` matching `metadata.generation` where
applicable. Check the CNI DaemonSet's desired and ready counts and healthy coverage
of all intended nodes. CNI readiness is a checkpoint before control-plane
provisioning; a matching CR spec alone is insufficient.

References: [OSSM 3.4 installation](https://docs.redhat.com/en/documentation/red_hat_openshift_service_mesh/3.4/html/installing/ossm-installing-service-mesh),
[Red Hat release-3.4 IstioCNI API](https://github.com/openshift-service-mesh/sail-operator/blob/release-3.4/api/v1/istiocni_types.go),
[ACM 2.17 Policy dependencies](https://docs.redhat.com/en/documentation/red_hat_advanced_cluster_management_for_kubernetes/2.17/html/governance/hub-policy-framework).
