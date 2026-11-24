# Stokku migrations (owner: DB)

sqlx layout: `NNNN_description.sql`, applied in order, one transaction each.
Run everything from an empty database with one command:

```sh
scripts/migrate.sh        # wraps: (cd services/api && sqlx migrate run)
scripts/seed.sh           # idempotent demo seed (run twice to prove it)
scripts/verify.sh         # all proof queries: ledger, change log, RLS, laba rugi
```

`DATABASE_URL` stays the **app-role** connection (non-superuser `stokku`) at
all times. Migrations that need elevated rights (0010: only a superuser can
grant BYPASSRLS to the definer role) run on a **separate admin connection**:

- `MIGRATION_DATABASE_URL` — explicit admin URL, used only for migrations.
- If unset, `migrate.sh` falls back to `DATABASE_URL`; when that is not a
  superuser it tries the `postgres` admin account on the same server
  (passwordless on trust-auth dev installs, or with `POSTGRES_PASSWORD`).
- When the migrations ran as someone other than the app role, the app role
  is granted table/sequence/function rights afterwards — the same model as
  `infra/pg-init.sh` in compose.
- If no admin connection is reachable, the run proceeds as-is and 0010
  fails loudly (never silently degrades: auth must not quietly break).

## Notes for Backend

- **Tenant context per request transaction** (RLS is FORCED, it binds even
  the table owner; only a superuser bypasses — never connect as one):
  ```sql
  begin;
  select set_app_context('<tenant_uuid>', '<user_uuid>', '<device>');
  -- or plain: select set_config('app.tenant_id', $1, true);
  ...
  commit;  -- context resets automatically
  ```
- `user_app` / `membership` / `device` are scoped by `app.user_id`, not
  tenant (DATA_MODEL.md §4). `membership` is also readable by tenant
  members for the member-list screen; enforce owner-only invites in the API.
- **RLS + `ON CONFLICT`**: an `INSERT ... ON CONFLICT (arbiter)` also checks
  proposed rows against the SELECT policy's USING clause (PostgreSQL docs,
  CREATE POLICY table 308). Plain INSERTs only need WITH CHECK. This bit the
  seed once; avoid arbiter ON CONFLICT on `user_app` (signup inserts a user
  whose id cannot be the current `app.user_id` yet).
- `refresh_token` exists exactly as requested in the channel (SHA-256 hash
  column, rotation/revoke timestamps). It has RLS but NO change_log trigger,
  so auth churn never enters the sync feed.
- `stock_move` is append-only: a BEFORE trigger rejects DELETE and any
  UPDATE except the change-log trigger's `server_seq` write-back (NULL ->
  value). Reversals must be new rows.
- `change_log` gets exactly one row per INSERT/UPDATE on every tenant-scoped
  business table; a no-op UPDATE writes nothing. `stock_level` rows are
  logged with `row_id = item_id` (no id column); `period_lock` with NULL.
- Master-data tables (category, item, item_barcode, item_unit, contact,
  cash_category) also write `audit_log` via the `audit_master_data` trigger
  (actor from `app.user_id`, device from `app.device`). For one-off records
  call `audit_record(tenant, actor, action, entity, entity_id, before, after, device)`.
- Period locks: inserts into `stock_move` / `cash_entry` / `sale` whose
  business_date falls in a locked `(tenant, outlet, month)` are rejected for
  non-owner actors with message `period_locked: ...` (map to HTTP 423).
  Owner writes and system rows (no `created_by`) pass.
- `sale.total` must be stored NET of line discounts and the sale-level
  discount — the report views rely on it.
- `sale_line` carries no `tenant_id` (pure child of `sale`, per DATA_MODEL);
  it is therefore not RLS-scoped and not change-logged — always read lines
  through the parent sale. `item_barcode` / `item_unit` DO carry a
  denormalized `tenant_id` (composite FK to item) for per-tenant uniqueness
  + RLS.
- `uuidv7()` is available as a default on every PK; `qris_crc16(text)`
  computes CRC-16/CCITT-FALSE for QRIS payload validation.
- Report views: `v_revenue`, `v_hpp`, `v_opex` (one row per category,
  `opex` column = period total), `v_laba_rugi`. All four are
  `security_invoker` (0011), so they read *through* the caller's RLS
  policies — they never bypass tenant isolation even where the views are
  owned by the superuser (compose/CI). Voided sales contribute 0;
  daily_total sales contribute revenue with hpp 0; stock purchases are
  never opex (category `pembelian_stok` / `modal`, or `ref_type` in
  `purchase` / `stock_move`).

## Seed & verify

```sh
scripts/seed.sh    # idempotent demo tenant "Warung Bu Sri" (run twice to prove it)
scripts/verify.sh  # all proof queries: ledger projection, change log, RLS, laba rugi
```

## Auth functions (login/refresh under forced RLS)

`auth_find_user(email)`, `auth_lookup_refresh(token_hash)`,
`auth_revoke_tokens(user_id)` (migration 0010, PRDTASK-ratified): the ONLY
reads/writes allowed on `user_app`/`refresh_token` before
`set_app_context()` has run. Call them for login and refresh, then set the
context and use normal queries.

- They are `SECURITY DEFINER` owned by a dedicated role `stokku_auth`
  (NOLOGIN, BYPASSRLS, SELECT on `user_app`, SELECT/UPDATE on
  `refresh_token`, granted to nobody) — SECURITY DEFINER alone would not
  suffice, because the app role owns the tables on a locally migrated
  database and FORCED RLS binds even the owner.
- `EXECUTE` is granted to `stokku` only (revoked from PUBLIC). The pinned
  `search_path` is `public, pg_temp`.
- `auth_revoke_tokens(user_id)` revokes every still-active token of that
  user — call it only for the user the API has authenticated or caught in
  reuse detection; the function itself does not check who is calling.
- They are deliberately out of `change_log` (SELECTs fire no triggers and
  `refresh_token` has none), like `refresh_token` itself.
- Migration 0010 must run as a **superuser** (only a superuser can grant
  BYPASSRLS). `scripts/migrate.sh` handles this: it prefers
  `MIGRATION_DATABASE_URL`, else auto-uses the local `postgres` admin
  account, and grants the app role its rights afterwards. Without any admin
  access it fails loudly with instructions.
