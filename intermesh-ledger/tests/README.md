# Local transfer integration test

Run from the repository root:

```sh
sh intermesh-ledger/tests/run-fin03-integration.sh
```

Requires the existing Java 21, Maven wrapper, Go toolchain, PostgreSQL binaries
(`initdb`, `pg_ctl`, `pg_config`) and cached Maven/Go dependencies. Set `PG_BIN`
if the PostgreSQL executables are outside the directory reported by `pg_config`.
The build runs offline and installs nothing.
Ordinary `go test ./...` runs skip this opt-in test unless its fixture variables
are supplied by the runner.

The runner creates a temporary PostgreSQL instance with TCP disabled and an
isolated schema using the shared SQL test fixture. It starts the packaged
Orchestrator and a loopback HTTP server serving Ledger's production router,
handlers and repository. Ledger's command-line launcher is not used, so its
all-interface listener is never exposed. Only JWKS and Fraud Analytics are
synthetic; JWT signatures are verified by Quarkus.

Tests assert persisted balances, request/transaction associations, duplicate
parentage and states, along with downstream call counts. Channels control Fraud
completion for PENDING-cycle scenarios. HTTP 504 simulates a Fraud gateway
timeout; transport-level response loss remains covered by the separate Java
tests. This suite does not validate browser behavior or Istio enforcement.

Java, HTTP listeners, the schema and the temporary PostgreSQL instance are
cleaned up on success and ordinary test failures. Interrupt the runner normally
to let cleanup finish; forcibly killing the process cannot guarantee cleanup.
No application Secret or externally supplied database URL is used.
