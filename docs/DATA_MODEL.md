# Data Model — Stokku MVP

Spec for `services/api/migrations/**`. DB member owns it; Backend reads it.
Postgres 16. UUIDv7 primary keys (pgcrypto fallback: `gen_random_uuid()` if no v7 function; use the `uuidv7()` extension or a small SQL function). Money `BIGINT`. Qty `NUMERIC(14,3)`.

## 1. Tables

```
tenant(id, name, tax_rate NUMERIC(5,2) default 0, created_at)
outlet(id, tenant_id, name, address, timezone default 'Asia/Jakarta',
       qris_mode text default 'none' check in (none,static_image,static_payload),
       qris_image_key, qris_payload, mdr_pct NUMERIC(5,2) default 0)
user_app(id, email citext unique, password_hash, name, created_at)      -- "user" is reserved
membership(id, tenant_id, user_id, role check in (owner,staff), unique(tenant_id,user_id))
device(id, user_id, name, platform, last_seen_at)

-- session rotation (auth): SHA-256 of the opaque token, never the token itself.
-- Deliberately NOT in change_log / the sync feed.
refresh_token(id, user_id, tenant_id, token_hash text unique,
              expires_at, rotated_at, revoked_at, created_at)

category(id, tenant_id, name, sort)
item(id, tenant_id, sku, name, category_id, base_unit,
     sale_price BIGINT, cost_avg BIGINT, min_stock NUMERIC(14,3),
     active bool default true, deleted_at, updated_at)
item_barcode(id, item_id, barcode, unique(tenant_id,barcode) via item join)
item_unit(id, item_id, name, factor NUMERIC(14,3) check factor > 0)

stock_move(id, tenant_id, outlet_id, item_id, qty NUMERIC(14,3) check qty <> 0,
           unit_cost BIGINT, type check in (in,sale,loss,return,adjust,transfer),
           ref_type, ref_id uuid, business_date date, note,
           created_by uuid, created_at, op_id uuid, server_seq bigint)
stock_level(tenant_id, outlet_id, item_id, qty NUMERIC(14,3), primary key(outlet_id,item_id))

sale(id, tenant_id, outlet_id, number, customer_id, total, discount,
     payment_method check in (cash,transfer,qris,credit), paid bool,
     mode check in (per_item,daily_total) default 'per_item',
     business_date, voided_at, void_reason, note, op_id, created_by)
 -- sale.note: additive column, approved 2026-11-24 — the POST /sales body carries `note`
 -- and GET /sales returns it. Without the column the list query fails (found in QA).
sale_line(id, sale_id, item_id, qty, unit_price, discount, cost_at_sale)

payment(id, tenant_id, sale_id, method, provider, amount_gross, mdr_amount,
        amount_net, status check in (pending,paid,expired,refunded),
        provider_ref, qr_string, expires_at, paid_at, settlement_id, confirmed_by)

cash_entry(id, tenant_id, outlet_id, direction check in (in,out), amount BIGINT,
           category, method, ref_type, ref_id, business_date, note, op_id, created_by)
cash_category(id, tenant_id, name, direction, sort, seeded bool)

contact(id, tenant_id, type check in (customer,supplier), name, phone)
payable(id, tenant_id, contact_id, amount, due_date, paid_amount)
receivable(id, tenant_id, contact_id, sale_id, amount, due_date, paid_amount)

opname_session(id, tenant_id, outlet_id, status check in (open,posted,cancelled),
               category_id, business_date, posted_at, posted_by, created_by, created_at)
opname_line(id, tenant_id, session_id, item_id, system_qty NUMERIC(14,3),
            counted_qty NUMERIC(14,3), counted_at, unique(session_id, item_id))
 -- system_qty is a trigger-enforced immutable snapshot; lines are immutable once the
 -- session leaves 'open' (UPDATE/DELETE raise). History is never edited.

op_log(op_id uuid primary key, tenant_id, device_id, applied_at, result jsonb)
change_log(server_seq bigserial primary key, tenant_id, table_name, row_id, op, changed_at)
audit_log(id, tenant_id, actor_id, action, entity, entity_id, before jsonb, after jsonb, device, at)
```

Soft delete: `item.deleted_at`; everything else is append-only or has an explicit void/reversal column.

## 2. Constraints that must exist

- `stock_move`: trigger blocks `UPDATE`/`DELETE` (allow only `server_seq` assignment by the change-log trigger).
- `sale_line.qty > 0`, `unit_price >= 0`, `discount >= 0 AND discount <= qty*unit_price`.
- `cash_entry.amount > 0`.
- `item.sku` unique per tenant (partial, where deleted_at is null); `item_barcode.barcode` unique per tenant.
- `payment` unique on `(sale_id, status)` where status='paid' — one paid payment per sale.
- `op_log.op_id` primary key = exactly-once.
- Period lock table `period_lock(tenant_id, outlet_id, period date)` (month, first day); a trigger rejects `stock_move`/`cash_entry`/`sale` inserts into a locked period for non-owner actors.

## 3. Change log trigger

One `AFTER INSERT OR UPDATE` trigger function on every business table:
`insert into change_log(tenant_id, table_name, row_id, op) values (NEW.tenant_id, TG_TABLE_NAME, NEW.id, TG_OP) returning server_seq;` and write `server_seq` back to the row when the column exists.
Verify: any insert/update produces exactly one change_log row.

## 4. RLS

Enable + force RLS on every table with `tenant_id`. Policy pattern:

```sql
create policy tenant_isolation on item
  using (tenant_id = current_setting('app.tenant_id')::uuid)
  with check (tenant_id = current_setting('app.tenant_id')::uuid);
```

Connection helper sets `SET LOCAL app.tenant_id = $1` per request transaction. `user_app` and `membership` are set per user, not tenant. Test: a second tenant's token sees zero rows on every table.

### 4.1 Authentication bypass (approved 2026-11-24)

Login and refresh read `user_app` and `refresh_token` **before** a tenant or user is known, so
under forced RLS those reads return zero rows. Do **not** widen the policies. Instead, three
`SECURITY DEFINER` functions owned by a dedicated `NO LOGIN` role (not the API's role) carry the
only permitted bypass:

| Function | Returns |
|---|---|
| `auth_find_user(email)` | the matching `user_app` row, or none |
| `auth_lookup_refresh(token_hash)` | the matching `refresh_token` row, or none |
| `auth_revoke_tokens(user_id)` | revokes that user's active tokens; returns count |

Requirements: `search_path` pinned to `public, pg_temp`; `EXECUTE` granted to the app role only,
never `public`; the owner role has no members and is not `SET ROLE`-able. The API calls these,
then `set_app_context(tenant, user)` for the rest of the request transaction.

Reports views must set `security_invoker = true` (migration 0011) — an admin-owned view otherwise
runs as its owner and bypasses RLS, leaking every tenant's numbers.

## 5. Indexes

- `stock_move(outlet_id, item_id, business_date, created_at)` — ledger + reports.
- `stock_move(tenant_id, server_seq)`; `change_log(tenant_id, server_seq)`.
- `item` trigram GIN on `name`, plus `(tenant_id, sku)` btree.
- `sale(tenant_id, business_date)`, `cash_entry(tenant_id, business_date)`.
- `sale_line(sale_id)`, `payment(sale_id)`.
- `stock_level(outlet_id)` where qty <= 0 for the negative flag.

## 6. Report views (owner of these: DB, T-401)

```sql
-- revenue per period: sales (per_item + daily_total, not voided) minus line discounts
v_revenue(tenant_id, outlet_id, period, revenue, unpaid_revenue)
-- hpp: sum(sale_line.qty * cost_at_sale) for non-voided sales
v_hpp(tenant_id, outlet_id, period, hpp)
-- opex: cash_entry out, category not in ('pembelian_stok','modal') and not linked to a purchase
v_opex(tenant_id, outlet_id, period, opex, category, amount)
-- net: revenue - hpp - opex, exactly, no rounding drift
v_laba_rugi(tenant_id, outlet_id, period, revenue, hpp, gross_profit, opex, net_profit, unpaid_revenue)
```

Rules: stock purchases are **not** opex. A voided sale contributes 0 to all views. Daily-total sales add revenue with hpp = 0 and are labelled in the drill-down.

## 7. Seed data

`scripts/seed.sql` must create, idempotently:
- tenant "Warung Bu Sri", outlet "Warung Pusat" (Asia/Jakarta), owner `owner@demo.test` / `Demo1234!`, one staff `staff@demo.test`.
- 8 categories, 20 items with mixed units (pcs, dus=24, kg), 60 days of stock moves, 40 sales (some credit/unpaid), 20 cash entries, 1 QRIS static payload fixture.
- three complete months so T-401 can be checked by hand.

## 8. Backup

`infra/backup.sh`: nightly `pg_dump -Fc` to object storage, 7-day retention, restore command documented. Quarterly drill is out of scope; the restore command must be copy-paste runnable.