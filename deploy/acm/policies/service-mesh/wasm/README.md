# WasmPlugin governance

This group contains the existing `intermesh-wasm` Policy and
`binding-intermesh-wasm` PlacementBinding. It uses `placement-all-clusters` and
requires the application foundation and OSSM Operator Policies to be Compliant.

The contained input Kustomization references only the shared
[WasmPlugin base](../../../../../service-mesh/wasm/kustomization.yaml).
Its explicit membership is `intermesh-backend/security-headers-wasmplugin`.
Container image transformations do not change its OCI URL; private configuration
uses a guarded replacement of the embedded `spec.url`.

Parent and embedded remediation are `enforce`, comparison is `musthave`, and
pruning and recreation are disabled. This group is included by the
[public Hub entrypoint](../../../kustomization.yaml). Apply approved private
configuration to the ACM Hub rather than applying the same plugin separately to
managed clusters.
