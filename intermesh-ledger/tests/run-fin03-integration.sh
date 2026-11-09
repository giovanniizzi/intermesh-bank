#!/bin/sh
set -eu
umask 077

repo_dir=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
pg_bin=${PG_BIN:-$(pg_config --bindir)}
for executable in initdb pg_ctl; do
    test -x "$pg_bin/$executable" || { echo "Missing local PostgreSQL executable: $executable" >&2; exit 1; }
done

export GOTOOLCHAIN=local GOPROXY=off GOSUMDB=off
cd "$repo_dir/intermesh-orchestrator"
./mvnw -o -DargLine= -DskipTests package

fixture_dir=$(mktemp -d /private/tmp/intermesh-fin02-e2e.XXXXXX)
cleanup() {
    # Fallback if Go exits before its normal test cleanup (for example, a timeout).
    for pid_file in "$fixture_dir"/orchestrator-*.pid; do
        test -f "$pid_file" || continue
        java_pid=$(cat "$pid_file")
        case "$java_pid" in ''|*[!0-9]*) continue ;; esac
        if ps -ww -p "$java_pid" -o args= | grep -F -- "-Dintermesh.integration.fixture=$fixture_dir " > /dev/null; then
            kill -KILL "$java_pid" 2>/dev/null || :
        fi
    done
    if test -f "$fixture_dir/data/postmaster.pid"; then
        "$pg_bin/pg_ctl" -D "$fixture_dir/data" -m fast -w stop || return 1
    fi
    rm -rf "$fixture_dir"
}
trap 'test_exit_status=$?; cleanup || test_exit_status=1; exit "$test_exit_status"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

"$pg_bin/initdb" -D "$fixture_dir/data" -U fin02_test --auth=trust --no-locale -E UTF8 > "$fixture_dir/initdb.log" 2>&1
"$pg_bin/pg_ctl" -D "$fixture_dir/data" -l "$fixture_dir/postgres.log" \
    -o "-h '' -k '$fixture_dir' -p 55432" -w start

export INTERMESH_TEST_POSTGRES_SOCKET_DIR="$fixture_dir"
export INTERMESH_TEST_ORCHESTRATOR_JAR="$repo_dir/intermesh-orchestrator/target/quarkus-app/quarkus-run.jar"
cd "$repo_dir/intermesh-ledger"
go test -race -count=1 -timeout=3m -v ./internal/integration
