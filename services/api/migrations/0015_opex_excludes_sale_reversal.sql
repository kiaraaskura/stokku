-- F-15: a voided paid sale understated net profit by the sale total.
--
-- Voiding a paid sale writes a mirror cash_entry (direction 'out',
-- ref_type 'sale_void'). v_opex excluded only 'purchase' and 'stock_move', so
-- that reversal was counted as an operating expense: revenue dropped to 0 and
-- opex rose by the sale total, giving net = -sale_total instead of 0.
--
-- A sale's cash-in is revenue, not a negative expense, and its reversal is the
-- mirror of that revenue. Exclude both by ref_type ('sale', 'sale_void')
-- rather than by category name, because a shop may rename 'penjualan'.
--
-- Everything else is unchanged: stock purchases stay excluded, and a voided
-- credit sale (paid = false, so no cash-in and no reversal entry) never
-- touched opex.

create or replace view v_opex as
select tenant_id, outlet_id, period,
       sum(amount) over (partition by tenant_id, outlet_id, period)::bigint as opex,
       category,
       amount
from (
  select c.tenant_id,
         c.outlet_id,
         date_trunc('month', c.business_date)::date as period,
         c.category,
         sum(c.amount)::bigint as amount
  from cash_entry c
  where c.direction = 'out'
    and c.category not in ('pembelian_stok', 'modal')
    and coalesce(c.ref_type, '') not in ('purchase', 'stock_move', 'sale', 'sale_void')
  group by 1, 2, 3, 4
) per_category;

alter view v_opex set (security_invoker = true);
