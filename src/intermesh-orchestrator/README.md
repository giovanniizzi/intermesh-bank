# Intermesh Orchestrator

The Java 21 / Quarkus 3.35.4 Orchestrator is the backend entry point for Intermesh
Bank. It verifies browser JWTs independently of Istio, isolates authenticated local
sessions, checks banking-resource ownership and coordinates Ledger and Fraud HTTP
calls. It does not settle the destination account.

## Build and test

Run from this directory with Java 21 and the Maven wrapper. With dependencies
already cached, these commands run offline:

```sh
./mvnw -o -DargLine= test
./mvnw -o -DargLine= -DskipITs=false verify
./mvnw -o -DargLine= -DskipTests package
```

`test` runs unit/in-process tests. `verify` with `skipITs=false` also exercises the
packaged JVM application. `-DargLine=` supplies the late-bound property referenced
by Surefire and Failsafe. Packaging produces `target/quarkus-app/quarkus-run.jar`
and its accompanying directories; keep the complete directory when running it.

[JwtSecurityTestResource](src/test/java/it/intermesh/bank/security/JwtSecurityTestResource.java)
serves synthetic JWKS and downstream fixtures. Signed-token HTTP tests cover
verification, account ownership, session reuse/concurrency, transfer admission,
compensation and recovery. They verify cryptographic signatures rather than only
injecting a mocked user. Diagnostic tests cover `/hello` behavior.

The [isolated transfer integration runner](../intermesh-ledger/tests/README.md)
adds real Ledger handlers/repository and a temporary PostgreSQL instance. See the
[development guide](../../docs/development.md) for other components. Native-build
compatibility is not established by these JVM tests.

## Runtime configuration

| Setting | Purpose |
| --- | --- |
| `MP_JWT_VERIFY_ISSUER` | Required canonical Keycloak realm issuer. Public deployment sources use `https://keycloak.example.invalid/realms/intermesh-bank`. |
| `mp.jwt.verify.publickey.location` | Derived in [application.properties](src/main/resources/application.properties) as the issuer plus `/protocol/openid-connect/certs`. |
| `ledger-service/mp-rest/url` | Ledger REST client URL, default `http://intermesh-ledger` on Service port 80. |
| `fraud-service/mp-rest/url` | Fraud client URL, default `http://fraud-analytics` on Service port 80. |
| `NETWORK`, `HOSTNAME` | Network and Pod labels used in diagnostic responses. |
| `quarkus.http.port` | Workload HTTP port, default `8080`. |
| Session cookie name and timeout | `JSESSIONID` and five minutes, read by the custom Vert.x SessionHandler. |

Configure issuer and Istio OIDC values together through the
[shared private values](../../docs/examples/README.md#shared-keycloak-endpoint).
Both the application and receiving proxies need JWKS reachability, TLS trust and
compatible signing keys. Verification uses RS256 with a configured 60-second clock
skew. No static key or development authentication fallback is supplied.

For local execution, supply the issuer through protected environment configuration
and override REST client properties with Java system properties when Kubernetes
DNS is unavailable. The Deployment's `QUARKUS_REST_CLIENT_LEDGER_API_URL` and
`FRAUD_ANALYTICS_URL` names do not configure these registered client keys. Do not
rely on their values when changing local endpoints. After configuration:

```sh
java -jar target/quarkus-app/quarkus-run.jar
```

For live reload, `./mvnw -o -DargLine= quarkus:dev` uses the same required issuer
and reachable downstream services. Its Dev UI is a development interface, not an
application deployment endpoint.

## API and identity contracts

Banking routes under `/api/v1` include:

| Route | Behavior |
| --- | --- |
| `GET /accounts/{userID}` | Same-user lookup using the verified owner key. |
| `POST /accounts` | Creation for the verified owner with exact opening-deposit validation. |
| `GET /account/{id}/transactions` | Account lookup and ownership check before history retrieval. |
| `POST /transfers` | Source ownership check before admission/freeze, Fraud and transaction-specific finalization. |
| `GET /transfer-requests/{transfer_request_id}` | Persisted request recovery scoped by verified identity. |

[BankingIdentityProvider](src/main/java/it/intermesh/bank/security/BankingIdentityProvider.java)
parses and verifies the current request's bearer JWT and requires nonblank string
`iss`, `sub` and `preferred_username` claims. Subject identity is `(iss, sub)`;
`preferred_username` is the existing Ledger owner key. Session attributes and
client identity headers are not authoritative.

[BankingSessionGuard](src/main/java/it/intermesh/bank/security/BankingSessionGuard.java)
binds a clean local session to that subject before banking calls. A different
subject receives 403 and invalidates the resolved session; a valid JWT can create
a clean session when local state is absent. Session storage is Pod-local and does
not replace operation ownership checks. See the
[mesh security and affinity guide](../../service-mesh/README.md).

Transfer request IDs persist across replay/recovery. Commit and compensation use
the transaction ID acknowledged by Ledger. No automatic financial POST retries
are added, and an unknown result is not reported as verified restoration. The
[architecture sequence](../../docs/deployment-architecture.md#transfer-request-sequence)
describes the workflow and its limits.

## Diagnostics and deployment boundaries

`/hello`, `/hello/session` and other diagnostic routes report Pod/network behavior.
They are not mapped by the committed ingress API route. Mesh JWT enforcement covers
all incoming Orchestrator port-8080 traffic, including diagnostics; direct local
tests do not reproduce that mesh boundary.

The session handler bypasses health paths but does not implement health endpoints
or Kubernetes probes. Likewise, similarly named Quarkus cookie properties do not
wire Secure, HttpOnly or SameSite into the custom handler. Public exposure requires
the [HTTPS and cookie checks](../../docs/acm-deployment-readiness.md#public-https-and-cookies).
