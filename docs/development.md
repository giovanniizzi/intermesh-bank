# Development and testing

Source code lives under `src/`; application, mesh, platform and deployment
configuration is separate. Start with the [architecture](deployment-architecture.md)
and choose the component you want to study. Channel Hub source is retained for
reference and is not part of the active application.

## Toolchains

| Component | Build/runtime requirements | Tests and packaging |
| --- | --- | --- |
| [Orchestrator](../src/intermesh-orchestrator/README.md) | Java 21, Maven wrapper, Quarkus platform 3.35.4 | Signed-JWT HTTP tests and packaged integration tests; JVM Containerfile definitions under `src/main/docker/`. |
| [Ledger](../src/intermesh-ledger) | Go 1.25, PostgreSQL for database-backed tests | Go tests, race detector and vet; [Containerfile](../src/intermesh-ledger/Containerfile). |
| [UI](../src/intermesh-ui) | Browser ES modules; Nginx in the container | Dependency-free JavaScriptCore-shell tests; [Containerfile](../src/intermesh-ui/Containerfile). No npm toolchain is defined. |
| [Fraud Analytics](../src/fraud-analytics) | Python 3.11 container with FastAPI, Uvicorn and Pydantic | [Containerfile](../src/fraud-analytics/Containerfile) defines installation and startup; no dedicated Python test suite is supplied. |
| [WasmPlugin](../src/security-headers-wasmplugin) | Rust supporting edition 2024, Cargo and `wasm32-wasip1` target | Proxy-Wasm SDK, [Cargo lockfile](../src/security-headers-wasmplugin/Cargo.lock) and OCI [Containerfile](../src/security-headers-wasmplugin/Containerfile). |

Only install tools for the components you need. Container tooling is optional for
source tests and required for image packaging. A cluster is unnecessary for the
synthetic HTTP/unit tests. Database integration needs existing local PostgreSQL
binaries; mesh behavior needs an OpenShift/OSSM deployment.

## Orchestrator

Follow the [component guide](../src/intermesh-orchestrator/README.md) for build,
test and runtime configuration. The tests use synthetic signing keys and a local
JWKS server; they do not require Keycloak. Application JWT verification, session
isolation and ownership checks still apply when running outside the mesh.

## Ledger

From `src/intermesh-ledger`, with Go installed:

```sh
go test ./...
go test -race ./...
go vet ./...
go build -o /tmp/intermesh-ledger ./cmd/ledger
```

For offline execution with the required toolchain and dependencies already cached,
prefix a command with `GOTOOLCHAIN=local GOPROXY=off GOSUMDB=off` to prevent
toolchain and dependency downloads. Ordinary test runs skip opt-in PostgreSQL
cases without their fixture configuration. Use the
[isolated integration runner](../src/intermesh-ledger/tests/README.md) for the real
Java → Go → PostgreSQL path; do not point tests at a shared database.
The production launcher requires `DATABASE_URL` and a prepared schema. Keep its
connection string in protected local configuration, outside command arguments and
logs.

## Frontend

The tests require a compatible JavaScriptCore shell. Check that `jsc` is available,
then run the modules from the repository root:

```sh
command -v jsc
jsc -m src/intermesh-ui/tests/transfer-requests.test.js
jsc -m src/intermesh-ui/tests/app.test.js
```

The tests exercise request persistence, replay/duplicate confirmation, identity
changes, exact amount serialization and safe DOM rendering using synthetic browser
fixtures. They are not real-browser or mesh tests. `jsc` is not Node.js; the UI
wiring fixture also uses its `readFile` function, so a different runner needs
explicit compatibility work.

The UI container starts Nginx after replacing `PLACEHOLDER_KEYCLOAK_URL` using
`KEYCLOAK_URL`. Merely opening the source HTML does not perform this substitution.
Interactive use also needs a configured Keycloak client and reachable
authenticated API. See the
[configuration examples](examples/README.md#shared-keycloak-endpoint).

## Fraud Analytics

The [container definition](../src/fraud-analytics/Containerfile) specifies Python
3.11 and installs `fastapi`, `uvicorn` and `pydantic`. With those packages already
available, run from `src/fraud-analytics`:

```sh
uvicorn app:app --host 127.0.0.1 --port 8080
```

Orchestrator test fixtures simulate Fraud responses and timeouts. Direct local
execution does not provide the mesh's Wasm routing headers, fault injection or
three-second timeout. The service itself checks the routing headers and deliberately
sleeps four seconds for a `DE`-prefixed destination. See
[Wasm and Fraud scenarios](../service-mesh/README.md#wasm-and-fraud-scenarios).

## Rust and WebAssembly

From `src/security-headers-wasmplugin`, with Rust and the `wasm32-wasip1` target
installed:

```sh
cargo build --locked --release --target wasm32-wasip1
```

Add `--offline` when dependencies are already cached and network access is not
needed. The build produces the Containerfile's input artifact:
`target/wasm32-wasip1/release/security_headers_wasmplugin.wasm`. The build produces
a module; it does not demonstrate Envoy ABI/runtime compatibility. Package the
artifact with that Containerfile using your container tooling and publish it to
your registry. Configure the complete `oci://` URL separately from application
container images. Validate plugin loading and header processing in the mesh.

## Configuration and contribution checks

Public profiles use nonfunctional placeholders. Copy the
[sanitized examples](examples/README.md#private-deployment-configuration) into
`.local/` for environment-specific values; provision credentials independently.
Do not put private renderings, tokens, cookie values or database URLs in test
fixtures or commits.

Before proposing a change, run the relevant component tests, `git diff --check`
and affected Kustomize renderings. Preserve explicit source membership and the
single deployment owner for each resource. For documentation changes, check local
links and Mermaid rendering. Offline tests do not establish live routing, TLS,
policy enforcement or cross-network affinity; use the
[operational verification matrix](acm-deployment-readiness.md#functional-verification-matrix)
for deployed behavior.
