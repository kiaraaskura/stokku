-- Report views (T-401) + QRIS CRC helper.
-- Rules (DATA_MODEL.md §6): stock purchases are NOT opex; voided sales
-- contribute 0 everywhere; daily_total sales add revenue with hpp = 0.
-- Laba rugi is exact integer arithmetic: revenue - hpp - opex = net_profit.

-- v_revenue: monthly revenue from non-voided sales (accrual basis:
-- unpaid credit sales count as revenue and as unpaid_revenue).
create view v_revenue as
select s.tenant_id,
       s.outlet_id,
       date_trunc('month', s.business_date)::date as period,
       sum(s.total)::bigint as revenue,
       sum(s.total) filter (where not s.paid)::bigint as unpaid_revenue
from sale s
where s.voided_at is null
group by 1, 2, 3;

-- v_hpp: sum(qty * cost_at_sale) over non-voided per_item sales
-- (daily_total sales have no lines, so hpp = 0 for them by construction).
create view v_hpp as
select s.tenant_id,
       s.outlet_id,
       date_trunc('month', s.business_date)::date as period,
       sum(l.qty * l.cost_at_sale)::bigint as hpp
from sale s
join sale_line l on l.sale_id = s.id
where s.voided_at is null
group by 1, 2, 3;

-- v_opex: cash out, excluding stock purchases ('pembelian_stok' category or
-- entries linked to a purchase via ref_type) and owner capital ('modal').
-- One row per category; opex = the period total (same on every row).
create view v_opex as
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
    and coalesce(c.ref_type, '') not in ('purchase', 'stock_move')
  group by 1, 2, 3, 4
) per_category;

-- v_laba_rugi: revenue - hpp - opex = net_profit, exactly.
create view v_laba_rugi as
with keys as (
  select tenant_id, outlet_id, period from v_revenue
  union
  select tenant_id, outlet_id, period from v_hpp
  union
  select tenant_id, outlet_id, period from v_opex
),
r as (select tenant_id, outlet_id, period, revenue, unpaid_revenue from v_revenue),
h as (select tenant_id, outlet_id, period, hpp from v_hpp),
o as (select tenant_id, outlet_id, period, max(opex) as opex from v_opex group by 1, 2, 3)
select k.tenant_id,
       k.outlet_id,
       k.period,
       coalesce(r.revenue, 0)::bigint as revenue,
       coalesce(h.hpp, 0)::bigint as hpp,
       (coalesce(r.revenue, 0) - coalesce(h.hpp, 0))::bigint as gross_profit,
       coalesce(o.opex, 0)::bigint as opex,
       (coalesce(r.revenue, 0) - coalesce(h.hpp, 0) - coalesce(o.opex, 0))::bigint as net_profit,
       coalesce(r.unpaid_revenue, 0)::bigint as unpaid_revenue
from keys k
left join r using (tenant_id, outlet_id, period)
left join h using (tenant_id, outlet_id, period)
left join o using (tenant_id, outlet_id, period);

-- QRIS: CRC-16/CCITT-FALSE over the ASCII bytes of the payload.
-- Used to build the seed fixture and by Backend to validate pasted
-- payloads (PUT /outlets/{id}/qris).
create function qris_crc16(payload text) returns text
language plpgsql immutable as $$
declare
  b     bytea := convert_to(payload, 'UTF8');
  crc   bigint := 65535;   -- 0xFFFF
  i     int;
  j     int;
  byte_ int;
begin
  for i in 0 .. octet_length(b) - 1 loop
    byte_ := get_byte(b, i);
    crc   := (crc # (byte_ << 8)) & 65535;
    for j in 1 .. 8 loop
      if (crc & 32768) <> 0 then       -- 0x8000
        crc := (((crc << 1) # 4129) & 65535);  -- 0x1021
      else
        crc := ((crc << 1) & 65535);
      end if;
    end loop;
  end loop;
  return upper(lpad(to_hex(crc::int), 4, '0'));
end;
$$;
