-- Report views for the three 404 endpoints (T-403 stock, T-404 sales,
-- T-405 dashboard). Views only — the API binds them to handlers.
--
-- All rules from the contract: voided sales contribute zero everywhere;
-- daily_total-mode sales count in the by-day revenue and are excluded from
-- by-item/by-category rows EXPLICITLY (visible mode filters, not silently
-- dropped by an inner join); month profit REUSES v_laba_rugi instead of
-- re-deriving opex.
--
-- SECURITY (the 0011 lesson): every view here is security_invoker = true,
-- so it runs with the querying role's rights and the forced RLS policies
-- apply — an admin-owned view must never bypass tenant isolation.

-- ---------------------------------------------------------------- T-403 --
-- Stock report: one row per outlet+item (items without a stock_level row
-- are absent: they have never moved).
--   dead_stock window: no stock_move whose business_date is within the
--   last 60 days (business_date, NOT created_at — business reality, not
--   insert time; items that never moved count as dead too). Window is
--   fixed at 60 days for this build; make it configurable in V1.
--   slow movers: order by move_count_90d (movements whose business_date is
--   within the last 90 days); the view exposes the counts, the report sorts.
create view v_stock_report as
select sl.tenant_id,
       sl.outlet_id,
       sl.item_id,
       i.name as item_name,
       i.sku,
       i.category_id,
       sl.qty,
       i.cost_avg,
       i.sale_price,
       (sl.qty * i.cost_avg) as value_at_cost,
       (sl.qty * i.sale_price) as value_at_sale,
       (sl.qty <= i.min_stock) as low_stock,
       (sl.qty < 0) as negative_stock,
       mv.last_movement_date,
       (mv.last_movement_date is null
        or mv.last_movement_date < current_date - 60) as dead_stock,
       mv.move_count_90d,
       mv.move_count
from stock_level sl
join item i on i.id = sl.item_id
left join lateral (
  select max(m.business_date) as last_movement_date,
         count(*) filter (
           where m.business_date >= current_date - 90) as move_count_90d,
         count(*) as move_count
  from stock_move m
  where m.outlet_id = sl.outlet_id
    and m.item_id = sl.item_id
) mv on true;
alter view v_stock_report set (security_invoker = true);

-- ---------------------------------------------------------------- T-404 --
-- Sales report over a date range, excluding voided sales (they contribute
-- zero everywhere). dimension column drives the grouping:
--   'day'      one row per business_date; ALL non-voided sales, including
--              mode=daily_total (daily_total_count shows how many).
--   'item'     one row per business_date+item, per_item sales only
--              (explicit mode filter — daily_total rows have no lines and
--              are excluded on purpose, not by an inner join accident);
--              revenue = sum(qty*unit_price - line discount). Sale-level
--              discount is only ever subtracted in sale.total, so it shows
--              up in 'day' rows; per-line revenue ignores it. The seed and
--              acceptance data use sale.discount = 0, so by-item +
--              daily_total reconcile to total revenue exactly.
--   'category' same as 'item' but grouped by the item's category.
-- line_count = number of sale lines; sale_count = distinct sales. The
-- daily_total dimension is its own 'day' contribution and is why
-- sum(by-item) can be less than sum(by-day) by design of the shop's mode.
create view v_sales_report as
-- by day: every non-voided sale, daily_total included
select s.tenant_id,
       s.outlet_id,
       'day'::text as dimension,
       s.business_date as day,
       null::uuid as item_id,
       null::uuid as category_id,
       sum(s.total) as revenue,
       count(*) as sale_count,
       count(*) filter (where s.mode = 'daily_total') as daily_total_count,
       0::bigint as line_count
from sale s
where s.voided_at is null
group by 1, 2, 3, 4
union all
-- by item: per_item sales only (explicit daily_total exclusion)
select s.tenant_id,
       s.outlet_id,
       'item'::text as dimension,
       s.business_date as day,
       l.item_id,
       null::uuid as category_id,
       sum(l.qty * l.unit_price - l.discount) as revenue,
       count(distinct s.id) as sale_count,
       0::bigint as daily_total_count,
       count(*) as line_count
from sale s
join sale_line l on l.sale_id = s.id
where s.voided_at is null
  and s.mode = 'per_item'
group by 1, 2, 3, 4, 5
union all
-- by category: per_item sales only (explicit daily_total exclusion)
select s.tenant_id,
       s.outlet_id,
       'category'::text as dimension,
       s.business_date as day,
       null::uuid as item_id,
       i.category_id,
       sum(l.qty * l.unit_price - l.discount) as revenue,
       count(distinct s.id) as sale_count,
       0::bigint as daily_total_count,
       count(*) as line_count
from sale s
join sale_line l on l.sale_id = s.id
join item i on i.id = l.item_id
where s.voided_at is null
  and s.mode = 'per_item'
group by 1, 2, 3, 4, 6;
alter view v_sales_report set (security_invoker = true);

-- ---------------------------------------------------------------- T-405 --
-- Dashboard, as of today (current_date; a view cannot take parameters —
-- the API filters by date itself when needed):
--   today_sales     revenue of non-voided sales whose business_date is today
--   cash_position   sum(cash in) - sum(cash out) over business_date <= today
--   low_stock_count current stock rows with qty <= min_stock (current
--                   levels; a view cannot reconstruct history)
--   month_profit    net_profit of the current month, REUSED from
--                   v_laba_rugi (opex definition stays in exactly one place)
create view v_dashboard as
select t.id as tenant_id,
       o.id as outlet_id,
       current_date as day,
       coalesce((select sum(s.total)
                 from sale s
                 where s.tenant_id = t.id
                   and s.outlet_id = o.id
                   and s.voided_at is null
                   and s.business_date = current_date), 0) as today_sales,
       coalesce((select sum(c.amount)
                   filter (where c.direction = 'in')
                 - sum(c.amount)
                   filter (where c.direction = 'out')
                 from cash_entry c
                 where c.tenant_id = t.id
                   and c.outlet_id = o.id
                   and c.business_date <= current_date), 0) as cash_position,
       (select count(*)
        from stock_level sl
        join item i on i.id = sl.item_id
        where sl.tenant_id = t.id
          and sl.outlet_id = o.id
          and sl.qty <= i.min_stock) as low_stock_count,
       coalesce((select lr.net_profit
                 from v_laba_rugi lr
                 where lr.tenant_id = t.id
                   and lr.outlet_id = o.id
                   and lr.period = date_trunc('month', current_date)::date),
                0) as month_profit
from tenant t
join outlet o on o.tenant_id = t.id;
alter view v_dashboard set (security_invoker = true);
