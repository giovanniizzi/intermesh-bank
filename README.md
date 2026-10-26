# intermesh-bank

## Safe local configuration

Keep credentials and environment-specific configuration in the ignored root
`.local/` directory. Do not commit passwords, tokens, private keys, kubeconfigs or
cloud and registry credentials. Use newly generated credentials rather than any
values previously published in this repository.

Sanitized templates belong in [manifests/examples/](manifests/examples/README.md)
and should use names such as `postgres-secret.example.yaml` or `.env.example`.
Use obvious replacement markers and reserved example domains; an example filename
does not make its contents safe. Copy templates into `.local/` before filling in
actual values. Ignore rules do not load or inject configuration into applications.

These safeguards do not remove sensitive values already tracked by Git. Source
cleanup removes them from current files; Git history cleanup is a separate,
coordinated operation. Neither cleanup revokes credentials or erases existing
clones. If a published credential was reused elsewhere, handle that reuse
separately.
