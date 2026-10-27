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

## Keycloak realm provisioning credentials

The active request path is Intermesh UI -> Istio Ingress Gateway -> Intermesh
Orchestrator -> Intermesh Ledger / Fraud Analytics. Keycloak provides frontend
SSO. The Channel Hub is inactive; its existing confidential Keycloak client is
retained for possible future use. Its secret is needed for realm provisioning,
not by the active application request path. Do not inject it into frontend assets
or add a Channel Hub deployment dependency.

`manifests/keycloak/realmimport.yaml` uses the Keycloak Operator's
`spec.placeholders` mechanism to populate its five existing credential fields
from Secret `intermesh-keycloak-credentials` in namespace `keycloak`:

| Secret key / placeholder | Existing credential |
| --- | --- |
| `HUB_CLIENT_SECRET` | Client `intermesh-channel-hub` secret |
| `DEMO_USER_1_PASSWORD` | First banking user (`spec.realm.users[0]`) |
| `DEMO_USER_2_PASSWORD` | Second banking user (`spec.realm.users[1]`) |
| `DEMO_USER_3_PASSWORD` | Third banking user (`spec.realm.users[2]`) |
| `DEMO_ADMIN_PASSWORD` | Existing realm-admin user (`spec.realm.users[3]`) |

These indexes identify the existing entries; usernames and their SQL fixture
relationships remain unchanged. Realm and client identifiers, roles, groups,
profile fields, login settings and password `temporary` flags are preserved.
No forced first-login password change is introduced.

The [RHBK 26.4 Operator guide](https://docs.redhat.com/en/documentation/red_hat_build_of_keycloak/26.4/html-single/operator_guide/index)
documents Secret-backed placeholders for `k8s.keycloak.org/v2alpha1`. The repository
does not pin an Operator version or include its CRD. Before deployment, confirm
the selected Operator and matching CRD support `spec.placeholders`. This is an
Operator feature, not automatic Kubernetes expansion of `${...}` strings.

### Prepare and create the provisioning Secret

[keycloak-credentials.secret.example.yaml](keycloak-credentials.secret.example.yaml)
documents the required Secret structure. Never apply it with its public
replacement markers unchanged. Use five independently generated credentials;
do not reuse any previously published values or share one password across users.

From the repository root, prepare protected local storage before saving values:

```sh
umask 077
mkdir -p .local/keycloak
chmod 700 .local .local/keycloak
```

Use an offline password generator and a secure local editor to save each value
in a separate file under `.local/keycloak/`, named exactly like its Secret key
in the table above. Each file must contain only its nonempty value on one line,
without a trailing newline. Reject empty values and unreplaced example markers.
Do not print the files or put their contents in command arguments or shell history.
Restrict their permissions:

```sh
chmod 600 .local/keycloak/HUB_CLIENT_SECRET \
  .local/keycloak/DEMO_USER_1_PASSWORD \
  .local/keycloak/DEMO_USER_2_PASSWORD \
  .local/keycloak/DEMO_USER_3_PASSWORD \
  .local/keycloak/DEMO_ADMIN_PASSWORD
```

For initial provisioning, select the cluster hosting the existing Keycloak CR
named `keycloak`. Ensure namespace `keycloak` exists, then replace the example
context name and create the Secret from the protected files:

```sh
oc --context=keycloak-host --namespace=keycloak create secret generic intermesh-keycloak-credentials \
  --from-file=HUB_CLIENT_SECRET=.local/keycloak/HUB_CLIENT_SECRET \
  --from-file=DEMO_USER_1_PASSWORD=.local/keycloak/DEMO_USER_1_PASSWORD \
  --from-file=DEMO_USER_2_PASSWORD=.local/keycloak/DEMO_USER_2_PASSWORD \
  --from-file=DEMO_USER_3_PASSWORD=.local/keycloak/DEMO_USER_3_PASSWORD \
  --from-file=DEMO_ADMIN_PASSWORD=.local/keycloak/DEMO_ADMIN_PASSWORD
```

Create this Secret before applying the realm import. It belongs in the same
namespace and cluster as Keycloak and the import, not in every cluster consuming
SSO. No additional Keycloak instances or Ledger databases are required.

RealmImport creates new realms; it does not overwrite an existing realm. Updating
this Secret or reapplying the import does not rotate credentials already imported
into Keycloak. Existing-realm credential changes require a separate authorized
administrative operation. No runtime application or Istio settings are changed
by this provisioning cleanup. Historical credentials remain in Git history;
history remediation is separate.
