# Stokku migrations (owner: DB)

sqlx layout: `NNNN_description.sql`, applied in order, one transaction each.
Run everything from an empty database with one command:

```sh
scripts/migrate.sh        # wraps: (cd services/api && sqlx migrate run)
```

`DATABASE_URL` comes from the environment or `.env` at the repo root.
The dev Postgres is the shared instance on `127.0.0.1:55442`, database
`stokku`, role `stokku` (trust auth on localhost).

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
  `opex` column = period total), `v_laba_rugi`. Voided sales contribute 0;
  daily_total sales contribute revenue with hpp 0; stock purchases are
  never opex (category `pembelian_stok` / `modal`, or `ref_type` in
  `purchase` / `stock_move`).

## Seed & verify

```sh
scripts/seed.sh    # idempotent demo tenant "Warung Bu Sri" (run twice to prove it)
scripts/verify.sh  # all proof queries: ledger projection, change log, RLS, laba rugi
```
