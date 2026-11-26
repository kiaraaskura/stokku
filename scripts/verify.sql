-- Stokku DB verification (run after migrate + seed):
--   psql "$DATABASE_URL" -f scripts/verify.sql   (or: make verify)
-- Proves: (a) stock_level == sum(stock_move.qty), (b) one change_log row
-- per write, (c) cross-tenant read returns 0 rows, (d) three seeded months
-- reconcile to hand-computed laba rugi — plus append-only, period lock,
-- audit and QRIS CRC checks. Read-only: everything rolls back.

\set QUIET on
\pset pager off
\set QUIET off

\echo '=== (a) stock_level == sum(stock_move.qty) per outlet+item ==='
begin;
select set_config('app.tenant_id', '01900000-0000-7000-8000-000000000001', true);
with ledger as (
  select outlet_id, item_id, sum(qty) as qty
  from stock_move group by 1, 2
)
select count(*) as mismatched_rows
from ledger l
full outer join stock_level s using (outlet_id, item_id)
where coalesce(l.qty, 0) <> coalesce(s.qty, 0);

select sl.item_id, i.name, sl.qty as stock_level,
       (select sum(qty) from stock_move m where m.item_id = sl.item_id and m.outlet_id = sl.outlet_id) as ledger_sum
from stock_level sl join item i on i.id = sl.item_id
order by i.name limit 5;
rollback;

\echo '=== (b) one change_log row per write ==='
begin;
select set_config('app.tenant_id', '01900000-0000-7000-8000-000000000001', true);
select set_config('app.user_id',   '01900000-0000-7000-8000-000000010001', true);
create temp table t_before as select count(*) c from change_log;
insert into item (id, tenant_id, name, base_unit, sale_price, cost_avg)
values ('01900000-0000-7000-8000-00DEAD000001', '01900000-0000-7000-8000-000000000001', 'TEST item verify', 'pcs', 1000, 500);
create temp table t_after_insert as select count(*) c from change_log;
update item set sale_price = 1100 where id = '01900000-0000-7000-8000-00DEAD000001';
create temp table t_after_update as select count(*) c from change_log;
update item set sale_price = 1100 where id = '01900000-0000-7000-8000-00DEAD000001'; -- no-op
create temp table t_after_noop as select count(*) c from change_log;
select (select c from t_after_insert) - (select c from t_before)      as change_rows_for_insert,
       (select c from t_after_update) - (select c from t_after_insert) as change_rows_for_update,
       (select c from t_after_noop) - (select c from t_after_update)   as change_rows_for_noop_update;
select table_name, row_id, op from change_log
where row_id = '01900000-0000-7000-8000-00DEAD000001' order by server_seq;
-- stock_move insert: exactly one change_log row AND server_seq written back
insert into stock_move (id, tenant_id, outlet_id, item_id, qty, unit_cost, type, business_date)
values ('01900000-0000-7000-8000-00DEAD000002', '01900000-0000-7000-8000-000000000001',
        '01900000-0000-7000-8000-000000000002', '01900000-0000-7000-8000-000000400001',
        1, 6000, 'in', date '2026-11-01');
select (select count(*) from change_log where row_id = '01900000-0000-7000-8000-00DEAD000002') as change_rows,
       (select server_seq from stock_move where id = '01900000-0000-7000-8000-00DEAD000002') as server_seq_written_back;
-- audit trail for the master-data edit above
select action, entity, entity_id, before->>'sale_price' as before_price, after->>'sale_price' as after_price
from audit_log where entity_id = '01900000-0000-7000-8000-00DEAD000001' order by at;
rollback;

\echo '=== append-only stock_move: UPDATE (except server_seq) and DELETE must fail ==='
begin;
select set_config('app.tenant_id', '01900000-0000-7000-8000-000000000001', true);
do $$
declare msg text;
begin
  begin
    update stock_move set qty = 99 where id = '01900000-0000-7000-8000-000000800201';
    raise notice 'FAIL: business UPDATE was allowed';
  exception when others then
    msg := sqlerrm;
    if msg like 'stock_move is append-only%' then raise notice 'OK: UPDATE blocked (%)', msg;
    else raise notice 'FAIL: wrong error %', msg; end if;
  end;
  begin
    delete from stock_move where id = '01900000-0000-7000-8000-000000800201';
    raise notice 'FAIL: DELETE was allowed';
  exception when others then
    msg := sqlerrm;
    if msg like 'stock_move is append-only%' then raise notice 'OK: DELETE blocked (%)', msg;
    else raise notice 'FAIL: wrong error %', msg; end if;
  end;
end $$;
rollback;

\echo '=== period_lock: staff insert into locked month must fail, owner passes ==='
begin;
select set_config('app.tenant_id', '01900000-0000-7000-8000-000000000001', true);
insert into period_lock (tenant_id, outlet_id, period) values
  ('01900000-0000-7000-8000-000000000001', '01900000-0000-7000-8000-000000000002', date '2026-10-01');
do $$
declare msg text;
begin
  begin -- staff actor
    insert into stock_move (tenant_id, outlet_id, item_id, qty, unit_cost, type, business_date, created_by)
    values ('01900000-0000-7000-8000-000000000001', '01900000-0000-7000-8000-000000000002',
            '01900000-0000-7000-8000-000000400001', 1, 6000, 'in', date '2026-10-15',
            '01900000-0000-7000-8000-000000010002');
    raise notice 'FAIL: staff write into locked month was allowed';
  exception when others then
    msg := sqlerrm;
    if msg like 'period_locked%' then raise notice 'OK: staff blocked (%', msg;
    else raise notice 'FAIL: wrong error %', msg; end if;
  end;
  begin -- owner actor
    insert into stock_move (tenant_id, outlet_id, item_id, qty, unit_cost, type, business_date, created_by)
    values ('01900000-0000-7000-8000-000000000001', '01900000-0000-7000-8000-000000000002',
            '01900000-0000-7000-8000-000000400001', 1, 6000, 'in', date '2026-10-15',
            '01900000-0000-7000-8000-000000010001');
    raise notice 'OK: owner write into locked month allowed';
  exception when others then
    raise notice 'FAIL: owner blocked (%)', sqlerrm;
  end;
end $$;
rollback;

\echo '=== (c) cross-tenant: second tenant sees 0 rows on every tenant table ==='
begin;
-- create a second tenant + outlet (own scope), then look at tenant 1 data
select set_config('app.tenant_id', '01900000-0000-7000-8000-00AAAA000001', true);
insert into tenant (id, name) values ('01900000-0000-7000-8000-00AAAA000001', 'Warung Lain');
insert into outlet (id, tenant_id, name) values
  ('01900000-0000-7000-8000-00AAAA000002', '01900000-0000-7000-8000-00AAAA000001', 'Cabang Lain');
insert into item (id, tenant_id, name, base_unit, sale_price, cost_avg) values
  ('01900000-0000-7000-8000-00AAAA000003', '01900000-0000-7000-8000-00AAAA000001', 'Item Lain', 'pcs', 500, 300);
do $$
declare
  r record; n bigint; bad text := '';
begin
  -- every tenant table must return ZERO rows belonging to tenant 1
  -- (tenant 2 sees only its own few rows, which the loop excludes)
  for r in
    select table_name from information_schema.columns
    where table_schema = 'public' and column_name = 'tenant_id'
      and table_name in (select relname from pg_class c join pg_namespace ns on ns.oid = c.relnamespace
                         where ns.nspname = 'public' and c.relkind = 'r')
    order by table_name
  loop
    execute format('select count(*) from %I where tenant_id = %L',
                   r.table_name, '01900000-0000-7000-8000-000000000001') into n;
    if n <> 0 then bad := bad || r.table_name || ' '; end if;
  end loop;
  if bad = '' then
    raise notice 'OK: tenant 1 rows leaked to tenant 2 on NO table';
  else
    raise notice 'FAIL: tenant 1 rows visible to tenant 2 via: %', bad;
  end if;
  select count(*) into n from sale;       -- double-check via views' base tables
  if n = 0 then raise notice 'OK: sale count for tenant 2 = 0'; else raise notice 'FAIL: sale leaked'; end if;
  select count(*) into n from v_laba_rugi;
  if n = 0 then raise notice 'OK: v_laba_rugi rows for tenant 2 = 0'; else raise notice 'FAIL: view leaked'; end if;
end $$;
select count(*) as visible_items_tenant2 from item;  -- its own 1 item only
rollback;

\echo '=== RLS coverage: every tenant table enabled + forced + policy ==='
select c.relname as table_name,
       c.relrowsecurity as rls_enabled,
       c.relforcerowsecurity as rls_forced,
       (select count(*) from pg_policy p where p.polrelid = c.oid) as policies
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind = 'r'
order by c.relname;

\echo '=== (d) three seeded months reconcile to hand-computed laba rugi ==='
begin;
select set_config('app.tenant_id', '01900000-0000-7000-8000-000000000001', true);
select * from v_laba_rugi order by period;

-- expected values, computed by hand from the seed rows (see scripts/seed.sql)
with expected (period, revenue, hpp, gross_profit, opex, net_profit, unpaid_revenue) as (
  values (date '2026-08-01', 753000::bigint, 612200::bigint, 140800::bigint, 220000::bigint,  -79200::bigint, 0::bigint),
         (date '2026-09-01',  60000::bigint,  37500::bigint,  22500::bigint,   5000::bigint,   17500::bigint, 0::bigint),
         (date '2026-10-01', 981000::bigint, 508500::bigint, 472500::bigint, 230000::bigint,  242500::bigint, 96000::bigint)
),
actual as (select period, revenue, hpp, gross_profit, opex, net_profit, unpaid_revenue from v_laba_rugi)
select case when count(*) = 0
            then 'RECONCILE OK: all three months match the hand computation'
            else 'MISMATCH: ' || string_agg(x, ' | ') end as result
from (
  select e.period::text || ' ' || coalesce(a.revenue, -1) || '/' || e.revenue
       || ' ' || coalesce(a.hpp, -1) || '/' || e.hpp
       || ' ' || coalesce(a.gross_profit, -1) || '/' || e.gross_profit
       || ' ' || coalesce(a.opex, -1) || '/' || e.opex
       || ' ' || coalesce(a.net_profit, -1) || '/' || e.net_profit
       || ' ' || coalesce(a.unpaid_revenue, -1) || '/' || e.unpaid_revenue as x
  from expected e left join actual a using (period)
  where row(a.revenue, a.hpp, a.gross_profit, a.opex, a.net_profit, a.unpaid_revenue)
    is distinct from row(e.revenue, e.hpp, e.gross_profit, e.opex, e.net_profit, e.unpaid_revenue)
) diffs;

-- independent recomputation straight from the raw tables (no views)
select date_trunc('month', s.business_date)::date as period,
       sum(s.total)::bigint as revenue,
       sum(s.total) filter (where not s.paid)::bigint as unpaid
from sale s where s.voided_at is null group by 1 order by 1;
select date_trunc('month', s.business_date)::date as period,
       sum(l.qty * l.cost_at_sale)::bigint as hpp
from sale s join sale_line l on l.sale_id = s.id
where s.voided_at is null group by 1 order by 1;
select date_trunc('month', c.business_date)::date as period, sum(c.amount)::bigint as opex
from cash_entry c
where c.direction = 'out' and c.category not in ('pembelian_stok','modal')
  and coalesce(c.ref_type,'') not in ('purchase','stock_move')
group by 1 order by 1;

\echo '=== report rules: voided=0, daily_total hpp=0, purchases not opex ==='
select
  (select coalesce(sum(s.total),0) from sale s where s.voided_at is not null) as voided_sale_total_exists,
  (select coalesce(sum(s.total),0) from sale s where s.voided_at is null) as nonvoided_sales_total,
  (select revenue from v_revenue where period = date '2026-10-01') as oct_revenue_view,
  (select coalesce(sum(l.qty*l.cost_at_sale),0) from sale s join sale_line l on l.sale_id=s.id
     where s.mode = 'daily_total') as daily_total_hpp_must_be_0,
  (select sum(amount) from cash_entry where category = 'pembelian_stok') as purchase_cash_out_never_in_opex,
  (select mdr_amount || '/' || amount_net from payment where status = 'paid') as qris_mdr_420_net_59580;
-- nonvoided_sales_total must equal sum(v_revenue.revenue): the voided 68.000 is excluded
select (select coalesce(sum(s.total),0) from sale s where s.voided_at is null)
       = (select coalesce(sum(revenue),0) from v_revenue) as voided_excluded_ok;
rollback;

\echo '=== QRIS payload: valid CRC, matches EMVCo structure ==='
begin;
select set_config('app.tenant_id', '01900000-0000-7000-8000-000000000001', true);
select qris_payload from outlet;
select case
  when qris_payload like '%6304' || qris_crc16(left(qris_payload, length(qris_payload) - 4))
    then 'OK: CRC valid'
  else 'FAIL: CRC invalid' end as crc_check
from outlet;
rollback;

\echo '=== uuidv7 sanity ==='
select substring(u::text,15,1) = '7' and substring(u::text,20,1) in ('8','9','a','b')
         and abs(extract(epoch from (to_timestamp(('x'||substring(translate(u::text,'-',''),1,12))::bit(48)::bigint / 1000.0))) - extract(epoch from now())) < 5
       as uuidv7_ok
from (select uuidv7() u) s;

\echo '=== auth functions (pre-login reads under forced RLS, migration 0010) ==='
begin;
-- FIRST, with no app context at all: plain reads must return 0 rows
select case
  when current_setting('is_superuser') = 'on'
    then 'SKIPPED: running as superuser, which bypasses RLS (run as the app role for this check)'
  when (select count(*) from user_app) = 0
       and (select count(*) from refresh_token) = 0
    then 'OK: plain user_app/refresh_token reads with no app context return 0 rows (policies not widened)'
  else 'FAIL: functions or policies widened access'
end as no_widening;
select set_config('app.tenant_id', '01900000-0000-7000-8000-000000000001', true);
select (select count(*) from auth_find_user('owner@demo.test')) as owner_found,
       (select count(*) from auth_find_user('nobody@demo.test')) as unknown_email_rows,
       (select count(*) from auth_lookup_refresh('bogus-not-a-real-hash')) as bogus_hash_rows,
       (select left(password_hash, 9) from auth_find_user('owner@demo.test')) as hash_prefix;
create temp table auth_cl_before as select count(*) c from change_log;
insert into refresh_token (id, user_id, tenant_id, token_hash, expires_at) values
  ('01900000-0000-7000-8000-00DEAD000003', '01900000-0000-7000-8000-000000010001',
   '01900000-0000-7000-8000-000000000001', 'deadbeef-token-hash', now() + interval '30 days');
select count(*) as lookup_rows from auth_lookup_refresh('deadbeef-token-hash');
select auth_revoke_tokens('01900000-0000-7000-8000-000000010001') as revoke_call;
select revoked_at is not null as revoked from refresh_token where token_hash = 'deadbeef-token-hash';
select (select count(*) from change_log) - (select c from auth_cl_before) as new_change_log_rows_must_be_0;
select p.proname, p.prosecdef as security_definer, pg_get_userbyid(p.proowner) as owner,
       coalesce(array_to_string(p.proacl, ','), 'DEFAULT-PUBLIC') as acl
from pg_proc p where p.proname in ('auth_find_user','auth_lookup_refresh','auth_revoke_tokens') order by 1;
rollback;

\echo '=== T-403 stock report: values reconcile, dead stock sane and business_date-based ==='
begin;
select set_config('app.tenant_id', '01900000-0000-7000-8000-000000000001', true);
select (select count(*) from v_stock_report) as stock_rows,
       (select sum(value_at_cost) from v_stock_report) as at_cost_total,
       (select sum(sl.qty * i.cost_avg) from stock_level sl join item i on i.id = sl.item_id) as at_cost_independent;
select case when (select count(*) from v_stock_report)
                  = (select count(*) from stock_level)
            then 'OK: one row per stock_level row' else 'FAIL: row mismatch' end as rows_ok;
select case when (select sum(value_at_cost) from v_stock_report)
                  = (select sum(sl.qty * i.cost_avg) from stock_level sl join item i on i.id = sl.item_id)
            then 'OK: value_at_cost == sum(qty * cost_avg) (ledger value)'
            else 'FAIL: at-cost value does not reconcile' end as at_cost_ok;
-- dead stock: sane set (not all, not none) and derived from business_date
select count(*) filter (where dead_stock) as dead_count,
       count(*) as total_items,
       count(*) filter (where dead_stock) between 1 and count(*) - 1 as dead_sane
from v_stock_report;
select count(*) as dead_definition_matches from v_stock_report sr
where sr.dead_stock = (
  select coalesce(max(m.business_date) < current_date - 60, true)
  from stock_move m
  where m.outlet_id = sr.outlet_id and m.item_id = sr.item_id
);
select item_name, qty, last_movement_date, (current_date - last_movement_date) as days_idle,
       move_count, move_count_90d
from v_stock_report where dead_stock order by days_idle desc limit 5;
rollback;

\echo '=== T-404 sales report: by-day = total, by-item + daily_total = total, category = item ==='
begin;
select set_config('app.tenant_id', '01900000-0000-7000-8000-000000000001', true);
select (select sum(revenue) from v_sales_report where dimension = 'day') as by_day_revenue,
       (select sum(revenue) from v_sales_report where dimension = 'item') as by_item_revenue,
       (select sum(revenue) from v_sales_report where dimension = 'category') as by_category_revenue,
       (select sum(total) from sale where voided_at is null) as nonvoided_sales_total,
       (select sum(total) from sale where mode = 'daily_total' and voided_at is null) as daily_total_revenue;
select case
  when (select sum(revenue) from v_sales_report where dimension = 'day')
       = (select sum(total) from sale where voided_at is null)
    then 'OK: by-day revenue == sum of non-voided sale totals (voided contributes 0)'
    else 'FAIL: by-day does not equal sales total' end as by_day_ok;
select case
  when (select sum(revenue) from v_sales_report where dimension = 'item')
       + (select sum(total) from sale where mode = 'daily_total' and voided_at is null)
       = (select sum(total) from sale where voided_at is null)
    then 'OK: by-item + daily_total == total revenue exactly'
    else 'FAIL: by-item + daily_total does not reconcile' end as item_plus_daily_ok;
select case
  when (select sum(revenue) from v_sales_report where dimension = 'category')
       = (select sum(revenue) from v_sales_report where dimension = 'item')
    then 'OK: by-category == by-item revenue'
    else 'FAIL: category/item mismatch' end as category_ok;
select case
  when (select sum(revenue) from v_sales_report where dimension = 'day')
       = (select sum(revenue) from v_revenue)
    then 'OK: by-day also matches v_revenue (existing view)'
    else 'FAIL: by-day vs v_revenue mismatch' end as day_vs_v_revenue_ok;
select day, revenue, sale_count, daily_total_count from v_sales_report
where dimension = 'day' order by day desc limit 4;
rollback;

\echo '=== T-405 dashboard: cash position, low stock, month profit reuses v_laba_rugi ==='
begin;
select set_config('app.tenant_id', '01900000-0000-7000-8000-000000000001', true);
select * from v_dashboard;
select case
  when (select cash_position from v_dashboard)
       = (select sum(amount) filter (where direction = 'in')
                - sum(amount) filter (where direction = 'out')
          from cash_entry)
    then 'OK: cash_position == in - out over the cash book'
    else 'FAIL: cash position mismatch' end as cash_ok;
select case
  when (select low_stock_count from v_dashboard)
       = (select count(*) from v_stock_report where low_stock)
    then 'OK: low_stock_count matches the stock report'
    else 'FAIL: low stock mismatch' end as low_stock_ok;
select case
  when (select month_profit from v_dashboard)
       = coalesce((select net_profit from v_laba_rugi
                   where period = date_trunc('month', current_date)::date), 0)
    then 'OK: month_profit is v_laba_rugi net_profit for the current month'
    else 'FAIL: month profit not from v_laba_rugi' end as month_profit_ok;
rollback;

\echo '=== T-403..T-405 cross-tenant: second tenant reads 0 rows from the new views ==='
begin;
select set_config('app.tenant_id', '01900000-0000-7000-8000-00AAAA000001', true);
insert into tenant (id, name) values ('01900000-0000-7000-8000-00AAAA000001', 'Warung Lain');
insert into outlet (id, tenant_id, name) values
  ('01900000-0000-7000-8000-00AAAA000002', '01900000-0000-7000-8000-00AAAA000001', 'Cabang Lain');
insert into item (id, tenant_id, name, base_unit, sale_price, cost_avg) values
  ('01900000-0000-7000-8000-00AAAA000003', '01900000-0000-7000-8000-00AAAA000001', 'Item Lain', 'pcs', 500, 300);
select (select count(*) from v_stock_report) as t2_stock_rows,
       (select count(*) from v_sales_report) as t2_sales_rows,
       (select count(*) from v_dashboard) as t2_dashboard_rows,
       (select count(*) from v_dashboard where tenant_id = '01900000-0000-7000-8000-000000000001') as t2_rows_from_tenant1,
       (select today_sales + cash_position + low_stock_count + month_profit from v_dashboard) as t2_measures;
select case
  when (select count(*) from v_stock_report) = 0
       and (select count(*) from v_sales_report) = 0
       -- the dashboard is one row per tenant+outlet: tenant 2 sees exactly
       -- its OWN row, not tenant 1's, and every measure must be 0
       and (select count(*) from v_dashboard) = 1
       and (select count(*) from v_dashboard where tenant_id = '01900000-0000-7000-8000-000000000001') = 0
       and (select today_sales + cash_position + low_stock_count + month_profit from v_dashboard) = 0
    then 'OK: tenant 2 sees only its own empty dashboard row; stock/sales views return 0 rows'
    else 'FAIL: new views leaked tenant 1 data' end as new_views_isolation;
rollback;

\echo '=== all report views are security_invoker (the 0011 rule) ==='
select v.viewname, (c.reloptions @> '{security_invoker=true}') as security_invoker
from pg_views v
join pg_class c on c.relname = v.viewname
join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
where v.schemaname = 'public'
order by v.viewname;

\echo '=== sync substrate: change_log coverage, tombstone rule, op_log exactly-once ==='
begin;
select set_config('app.tenant_id', '01900000-0000-7000-8000-000000000001', true);
select case when count(*) = 0
            then 'OK: every business tenant table has the change_log trigger (18/18; log/security tables excluded by design)'
            else 'FAIL: tenant tables without change_log: ' || string_agg(relname, ', ') end as change_log_coverage
from (
  select c.relname
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind = 'r'
    and c.relname in (select table_name from information_schema.columns
                      where table_schema = 'public' and column_name = 'tenant_id')
    and c.relname not in ('op_log','change_log','audit_log','refresh_token','membership_invite')
    and not exists (select 1 from pg_trigger t
                    where t.tgrelid = c.oid and t.tgname = 'change_log' and not t.tgisinternal)
) missing;
-- membership_invite is excluded on purpose: like refresh_token it is a
-- security table (one-time hashed invite codes) that must never enter the
-- sync feed; it does carry forced RLS (verified in the RLS section above).
insert into item (id, tenant_id, name, base_unit, sale_price, cost_avg)
values ('01900000-0000-7000-8000-00DEAD000102', '01900000-0000-7000-8000-000000000001',
        'verify tombstone', 'pcs', 1000, 500);
update item set deleted_at = now()
where id = '01900000-0000-7000-8000-00DEAD000102';
select case when (to_jsonb(i) ->> 'deleted_at') is not null
            then 'OK: tombstone derived from the row payload (deleted_at in the JSON), no extra column, no second query'
            else 'FAIL: tombstone not derivable from the row' end as tombstone_rule
from item i where i.id = '01900000-0000-7000-8000-00DEAD000102';
rollback;
begin;
-- op_log: the PK is the exactly-once guard; cross-tenant probes see nothing
select set_config('app.tenant_id', '01900000-0000-7000-8000-00AAAA000001', true);
insert into tenant (id, name) values ('01900000-0000-7000-8000-00AAAA000001', 'Warung Lain');
select set_config('app.tenant_id', '01900000-0000-7000-8000-000000000001', true);
insert into op_log (op_id, tenant_id, result)
values ('01900000-0000-7000-8000-00DEAD000202', '01900000-0000-7000-8000-000000000001', '{"status":"applied"}');
select set_config('app.tenant_id', '01900000-0000-7000-8000-00AAAA000001', true);
select case when count(*) = 0
            then 'OK: cross-tenant op_id probe returns 0 rows'
            else 'FAIL: op_log leaked across tenants' end as cross_tenant_op_probe
from op_log where op_id = '01900000-0000-7000-8000-00DEAD000202';
do $$
begin
  begin
    insert into op_log (op_id, tenant_id) values
      ('01900000-0000-7000-8000-00DEAD000202', '01900000-0000-7000-8000-00AAAA000001');
    raise notice 'FAIL: cross-tenant op_id re-insert was allowed';
  exception when unique_violation then
    raise notice 'OK: op_log primary key (not an app check) rejects a duplicate op_id — exactly-once is the constraint';
  end;
end $$;
select (to_regclass('public.change_log_tenant_seq_idx') is not null) as change_log_cursor_idx,
       (to_regclass('public.op_log_pkey') is not null) as op_log_pk,
       (to_regclass('public.stock_move_tenant_seq_idx') is not null) as stock_move_seq_idx,
       (to_regclass('public.item_name_trgm') is not null) as item_trgm_idx;
rollback;

\echo '=== done ==='
