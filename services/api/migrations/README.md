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

## Sync substrate (T-302/T-303, proven 2026-11-25)

`change_log` + `op_log` fully support cursor pull and exactly-once:

- **Coverage**: every tenant-scoped business table has the `change_log`
  trigger (18/18; only `change_log`, `audit_log`, `op_log`, `refresh_token`
  and `membership_invite` are deliberately excluded — the last two are
  security tables whose rows must never enter the sync feed; both carry
  forced RLS). Each INSERT/UPDATE lands exactly one row with
  `row_id`, `op`, `server_seq` (a no-op UPDATE writes nothing).
- **Tombstone rule (decision)**: `deleted` is **derived from the row payload
  the pull already returns** — `deleted = (row->>'deleted_at' is not null)`.
  Only `item` is soft-deleted (`deleted_at`); no table in the system
  hard-deletes rows, so no other table needs a tombstone. No extra column,
  no second query per row:
  ```sql
  select c.server_seq, c.table_name, to_jsonb(<row>) as row,
         (to_jsonb(<row>) ->> 'deleted_at') is not null as deleted
  from change_log c ...
  ```
  (Equivalently a LEFT JOIN on item for `deleted_at`.) If a hard delete is
  ever introduced, change_log must then emit an explicit `op='delete'` row —
  not the case today. An empty open opname session can be deleted (guard
  allows it while no lines exist): its earlier insert row then vanishes and
  the client just advances the cursor — harmless, no data attached.
- **op_log**: `op_id` is a GLOBAL primary key (`op_log_pkey`), so
  exactly-once is the database constraint, not an application check. A
  cross-tenant probe sees 0 rows (forced RLS), and re-inserting another
  tenant's op_id passes the RLS with-check but is rejected by the PK — the
  collision surfaces as `duplicate` with zero effect. op_ids are client
  UUIDv7 values, so cross-tenant squatting would require guessing a UUID.
- **Indexes for pull** (all present): `change_log(tenant_id, server_seq)`
  (cursor scan), `change_log` PK (ordering), `op_log` PK, every table's own
  PK for the per-row fetch, `stock_move(tenant_id, server_seq)`,
  `item` trigram GIN + `(tenant_id, sku)`.
- **Known gap (reported, not fixed here)**: `sale_line` carries no
  `tenant_id` and no change_log (pure child of `sale`, per DATA_MODEL), so
  a sale created on another device pulls WITHOUT its lines. Smallest
  additive fix is handler-side, no schema change: embed the lines in the
  sale row payload with one LEFT JOIN LATERAL in the same pull query
  (`to_jsonb(s) || jsonb_build_object('lines', …)`). Alternative, if
  uniform per-table rows are wanted: denormalize `tenant_id` onto
  `sale_line` (the item_unit pattern) and attach the change_log trigger —
  a migration; PRDTASK's call.

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
