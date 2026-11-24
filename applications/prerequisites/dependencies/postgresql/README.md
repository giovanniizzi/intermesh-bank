# Application database scripts

The application database contains disposable demo data. Initialize an empty database
with these scripts in order:

| Script | Contents |
| --- | --- |
| [001.sql](001.sql) | Accounts, account sequence and three demo accounts with corrected Italian and German IBANs |
| [002.sql](002.sql) | Transaction history |
| [003-transfer-requests.sql](003-transfer-requests.sql) | Transfer request tracking, relationships, constraints and indexes |

Use the intended application-owner role and the `public` schema. With the approved
connection settings supplied through standard PostgreSQL environment variables,
run from the repository root:

```sh
set -eu
: "${PGDATABASE:?Set the verified application database}"
: "${PGUSER:?Set the application owner role}"
export PGOPTIONS="${PGOPTIONS:-} -c search_path=public"
SQL_DIR=applications/prerequisites/dependencies/postgresql
psql -X -v ON_ERROR_STOP=1 --single-transaction -f "$SQL_DIR/001.sql"
psql -X -v ON_ERROR_STOP=1 --single-transaction -f "$SQL_DIR/002.sql"
psql -X -v ON_ERROR_STOP=1 -f "$SQL_DIR/003-transfer-requests.sql"
```

The third script manages its own transaction. Keep applications stopped if any
script fails; do not serve a partially initialized schema. Never place passwords
or connection strings in command arguments.

## Reinitializing the demo

Reinitialization deletes all application accounts, balances, transaction history
and transfer requests. Stop writers in both managed clusters through the approved
ACM workflow and verify that database connections have drained before resetting.
Do not rely on direct scaling while an enforcing Policy requires running replicas.

On the verified application database only, drop the application objects in
dependency order, then repeat the three initialization commands above:

```sql
BEGIN;
SET LOCAL lock_timeout = '10s';
DROP TABLE IF EXISTS public.intermesh_transactions;
DROP TABLE IF EXISTS public.intermesh_transfer_requests;
DROP TABLE IF EXISTS public.intermesh_accounts;
DROP SEQUENCE IF EXISTS public.intermesh_account_seq;
COMMIT;
```

Use a role authorized to drop these objects, and create the replacement objects
as the application owner. Do not drop the database, roles or `public` schema, or
change database infrastructure, storage, credentials or connection settings.
Unexpected dependencies must be reviewed rather than removed with `CASCADE`.

After initialization, expect three accounts, zero frozen balances, empty
transaction and request tables, and an unused sequence starting at 4000. Verify
ownership and permissions, deploy the corrected Ledger and UI through ACM, then
use fresh browser sessions so discarded transfer request IDs are not reused.
Accounts created during previous demo sessions and their saved transfer request
IDs are discarded.

Ledger generates synthetic Italian IBANs from the account sequence using the
existing bank/branch fields, a fixed-width account number, domestic CIN and
international MOD-97 check digits. German seed data uses the German national
structure. These are demo identifiers, not verified customer bank accounts.

Recipient IBAN format checks run in the frontend. The transfer API preserves its
opaque destination-string contract. Server-side recipient validation would need
explicit compatibility handling for existing requests and is a separate enhancement.
There is no recipient-account lookup or recipient settlement: freeze reduces the
source's available balance and increases frozen funds; commit consumes those frozen
funds and marks that transaction APPROVED; unfreeze restores its source funds and
marks it FAILED. A workflow timeout does not prove either outcome. Status recovery
reads persisted state without continuing a transfer; retrying a recorded request
does not rerun Fraud Analytics or complete a PENDING transfer.
