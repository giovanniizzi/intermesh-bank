# Configuration examples

This directory contains sanitized, tracked configuration templates.

- Name examples `*.example` or `*.example.*`, such as `.env.example` or
  `postgres-secret.example.yaml`. Keep them outside ignored directories.
- Use obvious replacement markers, fictional identities and reserved domains
  such as `db.example.invalid`. Never include working credentials or previously
  exposed password values. Base64 encoding does not protect a Kubernetes Secret.
- Keep completed copies in the ignored repository-root `.local/` directory, for
  example `.local/postgres-secret.yaml` or `.local/demo.env`. Keep private keys,
  kubeconfigs and cloud or registry credentials there as well.
- Review example contents before staging. Filename exceptions allow examples to
  be tracked; they do not verify that the contents are sanitized.

The ignore rules are safeguards against accidental additions. They do not affect
already tracked files, encrypt local files or configure an application or cluster.
Current-source cleanup and Git history remediation remain separate tasks.

## Shared PostgreSQL database

All Ledger workloads across the OpenShift clusters use one shared external
PostgreSQL database. Each cluster running the Ledger needs its own Secret named
`intermesh-ledger-db` in namespace `intermesh-backend`, with key `DATABASE_URL`.
These Secrets can contain the same complete connection string. Do not create
per-cluster databases, schemas, replication or synchronization mechanisms.

[postgres-secret.example.yaml](postgres-secret.example.yaml) documents the Secret
structure. Its placeholder is deliberately nonfunctional: do not deploy it
unchanged. Keep completed copies under `.local/`, never in this directory.

Preserve the shared endpoint, database name, credentials, TLS settings and all
connection options, including any schema/search-path options, when moving an
existing connection string into the Secret. The Ledger passes `DATABASE_URL`
through unchanged and exits with a configuration error if it is missing or blank.
There is no built-in database connection fallback. The database hostname must
also agree with the mesh configuration; changing mesh endpoints is a separate
cleanup step.

### Create the Secret without putting credentials in command arguments

From the repository root, prepare a protected local directory:

```sh
mkdir -p .local
chmod 700 .local
```

Using a secure local editor, save the intended complete connection string to
`.local/database-url` as one line with no trailing newline. Avoid printing it or
including it directly in shell commands. Restrict access to the file:

```sh
chmod 600 .local/database-url
```

For initial provisioning, ensure `intermesh-backend` already exists in each target
cluster. Replace the example context names below with the intended kubeconfig
contexts, then create both Secrets from the same protected file:

```sh
oc --context=cluster-a --namespace=intermesh-backend create secret generic intermesh-ledger-db \
  --from-file=DATABASE_URL=.local/database-url
oc --context=cluster-b --namespace=intermesh-backend create secret generic intermesh-ledger-db \
  --from-file=DATABASE_URL=.local/database-url
```

Repeat for every cluster running the Ledger. The commands create separate
namespaced Kubernetes objects pointing to the same database; a Secret in one
cluster is not available in another. They create Secrets only and do not provision
a database or change the SQL schema.

Create the Secret before starting Ledger pods. These commands are for initial
creation; if a Secret already exists, update it through your normal Secret
management process. Secret updates do not refresh environment variables in
running containers, so restart affected Ledger workloads after an update.
Kubernetes Secrets are not encrypted merely because their data is base64-encoded;
use appropriate cluster access controls and encryption at rest.
