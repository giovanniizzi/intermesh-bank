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

## Private deployment configuration

Keep environment configuration under Git-ignored `.local/`. One values file
supplies both deployment modes. The independent Keycloak provisioning overlay
inherits its realm settings from the public base.
Choose ACM or standalone ownership for each managed cluster; do not apply both
to the same resources.

Copy these examples to their destinations, creating the directories first.
Restrict private directories to your user and private files to mode `0600`.

| Example | Destination |
| --- | --- |
| [private-values.example.yaml](private-values.example.yaml) | `.local/configuration/values/values.yaml` |
| [private-values.kustomization.example.yaml](private-values.kustomization.example.yaml) | `.local/configuration/values/kustomization.yaml` |
| [local-images.kustomization.example.yaml](local-images.kustomization.example.yaml) | `.local/configuration/standalone/kustomization.yaml` |
| [hub-governance.kustomization.example.yaml](hub-governance.kustomization.example.yaml) | `.local/deploy/acm/kustomization.yaml` |
| [standalone-network1.kustomization.example.yaml](standalone-network1.kustomization.example.yaml) | `.local/deploy/standalone/network1/kustomization.yaml` |
| [standalone-network2.kustomization.example.yaml](standalone-network2.kustomization.example.yaml) | `.local/deploy/standalone/network2/kustomization.yaml` |
| [hub-keycloak.kustomization.example.yaml](hub-keycloak.kustomization.example.yaml) | `.local/prerequisites/keycloak/kustomization.yaml` |

Replace all seven values in `values.yaml`: four complete container image
references, the Wasm OCI URL, the shared PostgreSQL hostname and the canonical
Keycloak base URL. Examples use deliberately nonfunctional placeholders. Use
published artifacts and valid environment
endpoints before deployment. Keep `oci://` on the Wasm URL.

The ConfigMap is a rendering carrier, marked
`config.kubernetes.io/local-config: "true"`. Kustomize consumes its values and
omits it from final output; it is not an application ConfigMap. Keep the values
base and standalone Component in sibling directories as shown above.

The standalone Component applies the shared values to ordinary Kubernetes and
Istio resources. The ACM overlay applies them to embedded resource definitions
inside generated Policies. Ordinary Deployment patches cannot reach those
embedded definitions. Preserve every ACM identity/placeholder test and both
Orchestrator environment-array moves; guards run before replacements.

The values file contains configuration, not credentials. Do not put passwords,
tokens, keys, registry credentials or database connection strings in it. Neither
Git ignore rules nor the local-config annotation provide confidentiality.
Configured values remain visible in rendered resources and ACM Policies; keep
private renderings and logs out of Git and public artifacts.

Render the appropriate deployment mode from the repository root:

```sh
# Hub: 55 governance objects; requires the trusted PolicyGenerator plugin.
oc kustomize .local/deploy/acm --enable-alpha-plugins

# Standalone: 50 resources per network; no executable plugins.
oc kustomize .local/deploy/standalone/network1
oc kustomize .local/deploy/standalone/network2
```

Public entrypoints retain their non-deployable placeholders and do not import
private files. The network-specific public profiles select `NETWORK`, the
DestinationRule and its affinity cookie; do not duplicate those settings in the
shared private values.

## Shared Keycloak endpoint

Set `keycloakUrl` to the canonical HTTPS base URL, without a realm path, query,
fragment or explicit port. Both networks use the same endpoint.

Native replacements derive:

- UI `KEYCLOAK_URL` from the base URL.
- Orchestrator and Istio issuers by retaining `/realms/intermesh-bank`.
- Istio JWKS URI and request-principal pattern by retaining their realm suffixes.
- Keycloak ServiceEntry hostname from the URL's host component.

Quarkus derives its JWKS URI from the configured issuer and independently verifies
bearer JWTs. Keep realm `intermesh-bank` and client `intermesh-frontend` unchanged.
These mappings support the base URL format above; review derivations before
changing that format.

## Hub Keycloak provisioning overlay

The independent `.local/prerequisites/keycloak` overlay references
`applications/prerequisites/dependencies/keycloak` and retains its client-ID guard.
It needs no shared-values reference or logout replacements.
The RHBK 26.6 Operator, existing Keycloak CR `rhbk/keycloak` and credential Secret
are separate prerequisites. This entrypoint does not install Keycloak or configure
its database.

Both frontends use the same realm; no global load balancer is required. The import
defines only the public `intermesh-frontend` OIDC client, which requires PKCE S256
and disables direct access grants. The legacy Channel Hub client is excluded.

`attributes.post.logout.redirect.uris` is `"+"`, which inherits the client's login
redirect allowlist. The frontend requests logout back to `window.location.origin`;
no frontend origin configuration is required before provisioning.

**Demo security:** `redirectUris` and `webOrigins` use `["*"]` so the demo can run
on different frontend hosts without changing login or CORS configuration. This
intentionally permits unrestricted HTTP(S) login and logout redirect destinations
and Web Origins. Production deployments must use explicit redirect URIs, Web
Origins and appropriately restricted logout destinations; PKCE S256 does not
replace those restrictions.

```sh
oc kustomize .local/prerequisites/keycloak
```

This renders one RealmImport independently of deployment mode. RealmImport
initially provisions a realm; it does not reconcile updates to an existing realm.
Changing these files does not update an imported client's allowlists. Update an
existing realm through a separate administrative operation.

## Hub governance overlay

The `.local/deploy/acm` overlay imports `deploy/acm` and the shared values base.
It configures application images, UI/Orchestrator OIDC settings, ServiceEntry
hosts, Istio issuer/JWKS/principal and WasmPlugin URL through narrowly targeted
replacements. The example includes the complete guarded mappings.

Keep all ConfigurationPolicy, embedded-resource identity, container, environment
and public-placeholder tests unchanged. Preserve template and environment-array
ordering. Shared values must produce the same complete resources through ACM and
standalone, including scalar types and array order.

ACM deploys and reconciles its desired resources. Do not apply standalone or
canonical application renderings alongside ACM ownership. Validate DNS, TLS,
JWKS retrieval, JWT enforcement, browser login/logout and cross-network behavior
on the target clusters; offline rendering does not prove runtime behavior.

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
There is no built-in database connection fallback.

The public PostgreSQL ServiceEntry uses `postgres.example.invalid`. Configure
`postgresHost` once in `.local/configuration/values/values.yaml`; both deployment
modes and networks use that shared hostname. It must agree with the hostname in
the separately provisioned `DATABASE_URL` Secret. Keep the complete connection
string in the Secret, not in the shared values or Kustomize mappings.

PostgreSQL egress isolation is not configured. The ServiceEntry registers an
external destination; it does not restrict database access to Ledger.

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

The browser loads UI assets through ingress at `/` and sends `/api` requests
through ingress directly to Orchestrator, which calls Ledger and Fraud Analytics.
Keycloak provides browser SSO through the public frontend client, which needs no
client secret. Channel Hub is inactive and has no client in the RealmImport.

`applications/prerequisites/dependencies/keycloak/realmimport.yaml` uses the Keycloak Operator's
`spec.placeholders` mechanism to populate its four demo-user password fields
from Secret `intermesh-keycloak-credentials` in namespace `rhbk`:

| Secret key / placeholder | Existing credential |
| --- | --- |
| `DEMO_USER_1_PASSWORD` | First banking user (`spec.realm.users[0]`) |
| `DEMO_USER_2_PASSWORD` | Second banking user (`spec.realm.users[1]`) |
| `DEMO_USER_3_PASSWORD` | Third banking user (`spec.realm.users[2]`) |
| `DEMO_ADMIN_PASSWORD` | Demo user with the custom realm role `admin` (`spec.realm.users[3]`) |

The user indexes identify the realm entries and their SQL fixture relationships.
Keep usernames and fixture owner keys aligned. Credential placeholders do not
change the realm's roles, groups, client settings or password `temporary` flags.
The custom `admin` role does not grant Keycloak administration permissions.

The [RHBK 26.6 Operator guide](https://docs.redhat.com/en/documentation/red_hat_build_of_keycloak/26.6/html-single/operator_guide/index)
documents Secret-backed placeholders for `k8s.keycloak.org/v2beta1`. Confirm the
installed Operator and CRD serve this version and support `spec.placeholders`.
This is an Operator feature, not automatic Kubernetes expansion of `${...}` strings.

### Prepare and create the provisioning Secret

[keycloak-credentials.secret.example.yaml](keycloak-credentials.secret.example.yaml)
documents the required Secret structure. Never apply it with its public
replacement markers unchanged. Use four independently generated passwords;
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
chmod 600 .local/keycloak/DEMO_USER_1_PASSWORD \
  .local/keycloak/DEMO_USER_2_PASSWORD \
  .local/keycloak/DEMO_USER_3_PASSWORD \
  .local/keycloak/DEMO_ADMIN_PASSWORD
```

For initial provisioning, select the cluster hosting the existing Keycloak CR
`rhbk/keycloak`. Ensure namespace `rhbk` exists, then replace the example
context name and create the Secret from the protected files:

```sh
oc --context=keycloak-host --namespace=rhbk create secret generic intermesh-keycloak-credentials \
  --from-file=DEMO_USER_1_PASSWORD=.local/keycloak/DEMO_USER_1_PASSWORD \
  --from-file=DEMO_USER_2_PASSWORD=.local/keycloak/DEMO_USER_2_PASSWORD \
  --from-file=DEMO_USER_3_PASSWORD=.local/keycloak/DEMO_USER_3_PASSWORD \
  --from-file=DEMO_ADMIN_PASSWORD=.local/keycloak/DEMO_ADMIN_PASSWORD
```

Create this Secret before applying the realm import. It belongs in the same
namespace and cluster as Keycloak and the import, not in every cluster consuming
SSO. No additional Keycloak instances or Ledger databases are required.

The import targets only `intermesh-bank`; it does not configure the `master` or
`openshift` realms. Confirm `intermesh-bank` is absent before first provisioning.
RealmImport creates new realms; it does not overwrite an existing realm. Updating
this Secret or reapplying the import does not rotate credentials already imported
into Keycloak. Existing-realm credential changes require an administrative operation.
Removing a credential from a file does not remove it from existing Git history or
clones; any exposed credential that is still valid must be revoked or rotated.
