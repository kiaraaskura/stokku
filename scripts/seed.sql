-- Stokku demo seed — idempotent (fixed UUIDs + ON CONFLICT DO NOTHING;
-- conditional updates fire no change_log rows on re-run).
-- Run as the non-superuser DB owner (role stokku); RLS is forced even on
-- the owner, so the tenant context is set for the whole transaction.
--
-- Demo tenant : Warung Bu Sri, outlet Warung Pusat (Asia/Jakarta)
-- Owner       : owner@demo.test  / Demo1234!   (Argon2id, m=19456,t=2,p=1)
-- Staff       : staff@demo.test  / Demo1234!
--
-- Three complete months, hand-reconciled (see scripts/verify.sql):
--   2026-08  revenue 753.000  hpp 612.200  opex 220.000  net  -79.200  (rugi, baru buka)
--   2026-09  revenue  60.000  hpp  37.500  opex   5.000  net   17.500  (= ACCEPTANCE A.6)
--   2026-10  revenue 981.000  hpp 508.500  opex 230.000  net  242.500  unpaid 96.000
-- October exercises every report rule: credit/unpaid, daily_total (hpp 0),
-- QRIS payment, one voided sale (contributes 0), stock purchases (not opex).

begin;

select set_config('app.tenant_id', '01900000-0000-7000-8000-000000000001', true);
select set_config('app.user_id',   '01900000-0000-7000-8000-000000010001', true);

-- ---------------------------------------------------------------- tenancy
insert into tenant (id, name, tax_rate) values
  ('01900000-0000-7000-8000-000000000001', 'Warung Bu Sri', 0)
on conflict (id) do nothing;

insert into outlet (id, tenant_id, name, address, timezone, qris_mode, qris_payload, mdr_pct) values
  ('01900000-0000-7000-8000-000000000002',
   '01900000-0000-7000-8000-000000000001',
   'Warung Pusat', 'Jl. Merdeka No. 12, Jakarta Pusat', 'Asia/Jakarta',
   'static_payload',
   -- EMVCo QRIS static payload with valid CRC16-CCITT over everything
   -- up to and including the '6304' tag (computed, not hardcoded)
   (select p.body || '6304' || qris_crc16(p.body || '6304')
      from (select '00020101021126420014ID.CO.QRIS.WWW01151234567890123450201U'
                   || '5204541153033605802ID5913WARUNG BU SRI6007JAKARTA' as body) p),
   0.70)
on conflict (id) do nothing;

insert into user_app (id, email, password_hash, name) values
  ('01900000-0000-7000-8000-000000010001', 'owner@demo.test',
   '$argon2id$v=19$m=19456,t=2,p=1$uF8Z1rFZtVR3vzuY/49O5g$8Q009n0KjsBgE4Z3cHn1NXFIijdfNOtkhEh32InAHnQ',
   'Bu Sri'),
  ('01900000-0000-7000-8000-000000010002', 'staff@demo.test',
   '$argon2id$v=19$m=19456,t=2,p=1$PjP6FOC2GLHqdH69M8EKQQ$H0qIV1ETKNv2g90r9HuSk9IgIOfWC4+VZFnGt1tFXsc',
   'Andi penjaga')
on conflict do nothing;

insert into membership (id, tenant_id, user_id, role) values
  ('01900000-0000-7000-8000-000000200001', '01900000-0000-7000-8000-000000000001',
   '01900000-0000-7000-8000-000000010001', 'owner'),
  ('01900000-0000-7000-8000-000000200002', '01900000-0000-7000-8000-000000000001',
   '01900000-0000-7000-8000-000000010002', 'staff')
on conflict (tenant_id, user_id) do nothing;

-- ---------------------------------------------------------------- catalog
insert into category (id, tenant_id, name, sort) values
  ('01900000-0000-7000-8000-000000300001', '01900000-0000-7000-8000-000000000001', 'Sembako', 1),
  ('01900000-0000-7000-8000-000000300002', '01900000-0000-7000-8000-000000000001', 'Minuman', 2),
  ('01900000-0000-7000-8000-000000300003', '01900000-0000-7000-8000-000000000001', 'Makanan Instan', 3),
  ('01900000-0000-7000-8000-000000300004', '01900000-0000-7000-8000-000000000001', 'Snack', 4),
  ('01900000-0000-7000-8000-000000300005', '01900000-0000-7000-8000-000000000001', 'Kebutuhan Rumah', 5),
  ('01900000-0000-7000-8000-000000300006', '01900000-0000-7000-8000-000000000001', 'Perawatan Diri', 6),
  ('01900000-0000-7000-8000-000000300007', '01900000-0000-7000-8000-000000000001', 'Rokok', 7),
  ('01900000-0000-7000-8000-000000300008', '01900000-0000-7000-8000-000000000001', 'Lain-lain', 8)
on conflict (id) do nothing;

-- 20 items, mixed units (pcs / kg base units, extra units dus=24, dus=40,
-- lusin=12, slop=10 below in item_unit). cost_avg starts at the opening
-- cost; Gula's is corrected to the moving average 7.500 after its purchases.
insert into item (id, tenant_id, sku, name, category_id, base_unit, sale_price, cost_avg, min_stock) values
  ('01900000-0000-7000-8000-000000400001', '01900000-0000-7000-8000-000000000001', 'GLA-001', 'Gula Pasir 1kg',          '01900000-0000-7000-8000-000000300001', 'pcs', 12000,  6000,  3),
  ('01900000-0000-7000-8000-000000400002', '01900000-0000-7000-8000-000000000001', 'BRS-002', 'Beras Premium 5kg',       '01900000-0000-7000-8000-000000300001', 'pcs', 68000, 60000,  2),
  ('01900000-0000-7000-8000-000000400003', '01900000-0000-7000-8000-000000000001', 'BRS-003', 'Beras Curah',             '01900000-0000-7000-8000-000000300001', 'kg',  14000, 11000,  5),
  ('01900000-0000-7000-8000-000000400004', '01900000-0000-7000-8000-000000000001', 'TLR-004', 'Telur Ayam 1kg',          '01900000-0000-7000-8000-000000300001', 'kg',  28000, 24000,  5),
  ('01900000-0000-7000-8000-000000400005', '01900000-0000-7000-8000-000000000001', 'MYK-005', 'Minyak Goreng 1L',        '01900000-0000-7000-8000-000000300005', 'pcs', 17500, 15000,  6),
  ('01900000-0000-7000-8000-000000400006', '01900000-0000-7000-8000-000000000001', 'AQU-006', 'Aqua 600ml',              '01900000-0000-7000-8000-000000300002', 'pcs',  3000,  1800, 24),
  ('01900000-0000-7000-8000-000000400007', '01900000-0000-7000-8000-000000000001', 'TEH-007', 'Teh Botol Sosro 350ml',   '01900000-0000-7000-8000-000000300002', 'pcs',  4500,  3000, 12),
  ('01900000-0000-7000-8000-000000400008', '01900000-0000-7000-8000-000000000001', 'IND-008', 'Indomie Goreng',          '01900000-0000-7000-8000-000000300003', 'pcs',  3500,  2400, 20),
  ('01900000-0000-7000-8000-000000400009', '01900000-0000-7000-8000-000000000001', 'KPI-009', 'Kopi Kapal Api 65g',      '01900000-0000-7000-8000-000000300002', 'pcs',  2500,  1500, 12),
  ('01900000-0000-7000-8000-000000400010', '01900000-0000-7000-8000-000000000001', 'SBN-010', 'Sabun Lifebuoy 70g',      '01900000-0000-7000-8000-000000300006', 'pcs',  4500,  3000,  6),
  ('01900000-0000-7000-8000-000000400011', '01900000-0000-7000-8000-000000000001', 'PST-011', 'Pasta Gigi Pepsodent 190g','01900000-0000-7000-8000-000000300006','pcs', 12000,  8000,  4),
  ('01900000-0000-7000-8000-000000400012', '01900000-0000-7000-8000-000000000001', 'SMP-012', 'Shampoo Sachet Clear 10ml','01900000-0000-7000-8000-000000300006','pcs',  1500,   800, 24),
  ('01900000-0000-7000-8000-000000400013', '01900000-0000-7000-8000-000000000001', 'ROK-013', 'Rokok Sampoerna Mild 16', '01900000-0000-7000-8000-000000300007', 'pcs', 34000, 30500,  4),
  ('01900000-0000-7000-8000-000000400014', '01900000-0000-7000-8000-000000000001', 'KRP-014', 'Keripik Singkong Maicih 250g','01900000-0000-7000-8000-000000300004','pcs', 8000,  5000,  5),
  ('01900000-0000-7000-8000-000000400015', '01900000-0000-7000-8000-000000000001', 'KCP-015', 'Kecap Manis Bango 520ml', '01900000-0000-7000-8000-000000300005', 'pcs', 18000, 13000,  3),
  ('01900000-0000-7000-8000-000000400016', '01900000-0000-7000-8000-000000000001', 'SRS-016', 'Saus Sambal ABC 340ml',   '01900000-0000-7000-8000-000000300005', 'pcs', 12000,  8500,  3),
  ('01900000-0000-7000-8000-000000400017', '01900000-0000-7000-8000-000000000001', 'TPG-017', 'Tepung Terigu Segitiga Biru 1kg','01900000-0000-7000-8000-000000300001','pcs', 13000,  9500,  4),
  ('01900000-0000-7000-8000-000000400018', '01900000-0000-7000-8000-000000000001', 'SKM-018', 'Susu Kental Manis Frisian Flag 405g','01900000-0000-7000-8000-000000300003','pcs', 9500, 6500,  6),
  ('01900000-0000-7000-8000-000000400019', '01900000-0000-7000-8000-000000000001', 'GRM-019', 'Garam Berjodoh 500g',     '01900000-0000-7000-8000-000000300001', 'pcs',  3000,  1800,  8),
  ('01900000-0000-7000-8000-000000400020', '01900000-0000-7000-8000-000000000001', 'BTR-020', 'Baterai ABC AA 2s',       '01900000-0000-7000-8000-000000300008', 'pcs',  5000,  3000,  6)
on conflict (id) do nothing;

insert into item_barcode (id, tenant_id, item_id, barcode) values
  ('01900000-0000-7000-8000-000000500001', '01900000-0000-7000-8000-000000000001', '01900000-0000-7000-8000-000000400001', '8991001000014'),
  ('01900000-0000-7000-8000-000000500002', '01900000-0000-7000-8000-000000000001', '01900000-0000-7000-8000-000000400002', '8991001000021'),
  ('01900000-0000-7000-8000-000000500003', '01900000-0000-7000-8000-000000000001', '01900000-0000-7000-8000-000000400003', '8991001000038'),
  ('01900000-0000-7000-8000-000000500004', '01900000-0000-7000-8000-000000000001', '01900000-0000-7000-8000-000000400004', '8991001000045'),
  ('01900000-0000-7000-8000-000000500005', '01900000-0000-7000-8000-000000000001', '01900000-0000-7000-8000-000000400005', '8991001000052'),
  ('01900000-0000-7000-8000-000000500006', '01900000-0000-7000-8000-000000000001', '01900000-0000-7000-8000-000000400006', '8991001000069'),
  ('01900000-0000-7000-8000-000000500007', '01900000-0000-7000-8000-000000000001', '01900000-0000-7000-8000-000000400013', '8991001000076'),
  ('01900000-0000-7000-8000-000000500008', '01900000-0000-7000-8000-000000000001', '01900000-0000-7000-8000-000000400018', '8991001000083')
on conflict (id) do nothing;

insert into item_unit (id, tenant_id, item_id, name, factor) values
  ('01900000-0000-7000-8000-000000600001', '01900000-0000-7000-8000-000000000001', '01900000-0000-7000-8000-000000400005', 'dus', 24),
  ('01900000-0000-7000-8000-000000600002', '01900000-0000-7000-8000-000000000001', '01900000-0000-7000-8000-000000400006', 'dus', 24),
  ('01900000-0000-7000-8000-000000600003', '01900000-0000-7000-8000-000000000001', '01900000-0000-7000-8000-000000400007', 'dus', 24),
  ('01900000-0000-7000-8000-000000600004', '01900000-0000-7000-8000-000000000001', '01900000-0000-7000-8000-000000400008', 'dus', 40),
  ('01900000-0000-7000-8000-000000600005', '01900000-0000-7000-8000-000000000001', '01900000-0000-7000-8000-000000400009', 'dus', 24),
  ('01900000-0000-7000-8000-000000600006', '01900000-0000-7000-8000-000000000001', '01900000-0000-7000-8000-000000400010', 'lusin', 12),
  ('01900000-0000-7000-8000-000000600007', '01900000-0000-7000-8000-000000000001', '01900000-0000-7000-8000-000000400011', 'lusin', 12),
  ('01900000-0000-7000-8000-000000600008', '01900000-0000-7000-8000-000000000001', '01900000-0000-7000-8000-000000400013', 'slop', 10),
  ('01900000-0000-7000-8000-000000600009', '01900000-0000-7000-8000-000000000001', '01900000-0000-7000-8000-000000400018', 'dus', 24)
on conflict (id) do nothing;

insert into cash_category (id, tenant_id, name, direction, sort, seeded) values
  ('01900000-0000-7000-8000-0000001A0001', '01900000-0000-7000-8000-000000000001', 'modal',          'in',  1, true),
  ('01900000-0000-7000-8000-0000001A0002', '01900000-0000-7000-8000-000000000001', 'penjualan',      'in',  2, true),
  ('01900000-0000-7000-8000-0000001A0003', '01900000-0000-7000-8000-000000000001', 'pembelian_stok', 'out', 1, true),
  ('01900000-0000-7000-8000-0000001A0004', '01900000-0000-7000-8000-000000000001', 'listrik',        'out', 2, true),
  ('01900000-0000-7000-8000-0000001A0005', '01900000-0000-7000-8000-000000000001', 'gaji',           'out', 3, true),
  ('01900000-0000-7000-8000-0000001A0006', '01900000-0000-7000-8000-000000000001', 'kemasan',        'out', 4, true),
  ('01900000-0000-7000-8000-0000001A0007', '01900000-0000-7000-8000-000000000001', 'transportasi',   'out', 5, true),
  ('01900000-0000-7000-8000-0000001A0008', '01900000-0000-7000-8000-000000000001', 'sewa',           'out', 6, true)
on conflict (id) do nothing;

insert into contact (id, tenant_id, type, name, phone) values
  ('01900000-0000-7000-8000-000000700001', '01900000-0000-7000-8000-000000000001', 'customer', 'Ibu Wati', '0812-1111-2222'),
  ('01900000-0000-7000-8000-000000700002', '01900000-0000-7000-8000-000000000001', 'customer', 'Pak Dedi', '0813-3333-4444'),
  ('01900000-0000-7000-8000-000000700003', '01900000-0000-7000-8000-000000000001', 'supplier', 'Toko Grosir Amanah', '0815-5555-6666')
on conflict (id) do nothing;

-- ------------------------------------------------------------- stock moves
-- Opening stock: 19 items x 10 units at base cost, Aug 1 (Gula excluded:
-- its first purchases are the acceptance scenario in September).
insert into stock_move (id, tenant_id, outlet_id, item_id, qty, unit_cost, type, ref_type, business_date, note, created_by, created_at)
select ('01900000-0000-7000-8000-' || lpad((80000 + row_number() over (order by i.id))::text, 12, '0'))::uuid,
       '01900000-0000-7000-8000-000000000001', '01900000-0000-7000-8000-000000000002',
       i.id, 10, i.cost_avg, 'in', 'purchase', date '2026-08-01', 'Stok awal',
       '01900000-0000-7000-8000-000000010001',
       (date '2026-08-01' + time '09:00') at time zone 'Asia/Jakarta'
from item i
where i.name <> 'Gula Pasir 1kg'
on conflict (id) do nothing;

-- 60 days of moves: daily restock Aug 2 .. Sep 29 (59 days + Aug 1 = 60
-- distinct dates), one item per day in id rotation, qty 5 at base cost.
insert into stock_move (id, tenant_id, outlet_id, item_id, qty, unit_cost, type, ref_type, business_date, note, created_by, created_at)
select ('01900000-0000-7000-8000-' || lpad((80100 + row_number() over (order by g.d))::text, 12, '0'))::uuid,
       '01900000-0000-7000-8000-000000000001', '01900000-0000-7000-8000-000000000002',
       it.id, 5, it.cost_avg, 'in', 'purchase', g.d, 'Restock harian',
       '01900000-0000-7000-8000-000000010001',
       (g.d + time '10:00') at time zone 'Asia/Jakarta'
from generate_series(date '2026-08-02', date '2026-09-29', interval '1 day') g(d)
cross join lateral (
  select i.id, i.cost_avg
  from item i
  where i.name <> 'Gula Pasir 1kg'
  order by i.id
  offset ((g.d::date - date '2026-08-02') % 19)
  limit 1
) it
on conflict (id) do nothing;

-- Acceptance scenario purchases: 10 @ 6.000 then 10 @ 9.000 -> avg 7.500.
insert into stock_move (id, tenant_id, outlet_id, item_id, qty, unit_cost, type, ref_type, business_date, note, created_by, created_at) values
  ('01900000-0000-7000-8000-000000800201', '01900000-0000-7000-8000-000000000001', '01900000-0000-7000-8000-000000000002',
   '01900000-0000-7000-8000-000000400001', 10, 6000, 'in', 'purchase', date '2026-09-02', 'Beli gula 1',
   '01900000-0000-7000-8000-000000010001', (date '2026-09-02' + time '10:00') at time zone 'Asia/Jakarta'),
  ('01900000-0000-7000-8000-000000800202', '01900000-0000-7000-8000-000000000001', '01900000-0000-7000-8000-000000000002',
   '01900000-0000-7000-8000-000000400001', 10, 9000, 'in', 'purchase', date '2026-09-03', 'Beli gula 2',
   '01900000-0000-7000-8000-000000010001', (date '2026-09-03' + time '10:00') at time zone 'Asia/Jakarta')
on conflict (id) do nothing;

-- Inventory corrections (loss + opname-style adjust).
insert into stock_move (id, tenant_id, outlet_id, item_id, qty, unit_cost, type, ref_type, business_date, note, created_by, created_at) values
  ('01900000-0000-7000-8000-000000800301', '01900000-0000-7000-8000-000000000001', '01900000-0000-7000-8000-000000000002',
   '01900000-0000-7000-8000-000000400014', -0.5, 5000, 'loss', null, date '2026-10-30', 'Kemasan rusak',
   '01900000-0000-7000-8000-000000010001', (date '2026-10-30' + time '16:00') at time zone 'Asia/Jakarta'),
  ('01900000-0000-7000-8000-000000800302', '01900000-0000-7000-8000-000000000001', '01900000-0000-7000-8000-000000000002',
   '01900000-0000-7000-8000-000000400003', 0.5, 11000, 'adjust', null, date '2026-10-29', 'Koreksi timbangan (opname)',
   '01900000-0000-7000-8000-000000010001', (date '2026-10-29' + time '15:00') at time zone 'Asia/Jakarta')
on conflict (id) do nothing;

-- ------------------------------------------------------------------- sales
-- 40 sales staged, then inserted as sale + sale_line + sale stock_move.
-- total = qty*unit_price - line discount; sale-level discount is 0.
create temp table st_sale (
  n          int primary key,
  item_id    uuid,
  qty        numeric,
  price      bigint,
  disc       bigint,
  cost       bigint,
  bdate      date,
  method     text,
  paid       boolean,
  mode       text,
  customer   uuid,
  voided     boolean
);

insert into st_sale values
-- Aug: one sale per item (except Gula), qty 2, Aug 6..24  (n 1..19)
 ( 1, '01900000-0000-7000-8000-000000400002', 2, 68000, 0, 60000, date '2026-08-06', 'cash', true, 'per_item', null, false),
 ( 2, '01900000-0000-7000-8000-000000400003', 2, 14000, 0, 11000, date '2026-08-07', 'cash', true, 'per_item', null, false),
 ( 3, '01900000-0000-7000-8000-000000400004', 2, 28000, 0, 24000, date '2026-08-08', 'cash', true, 'per_item', null, false),
 ( 4, '01900000-0000-7000-8000-000000400005', 2, 17500, 0, 15000, date '2026-08-09', 'cash', true, 'per_item', null, false),
 ( 5, '01900000-0000-7000-8000-000000400006', 2,  3000, 0,  1800, date '2026-08-10', 'cash', true, 'per_item', null, false),
 ( 6, '01900000-0000-7000-8000-000000400007', 2,  4500, 0,  3000, date '2026-08-11', 'cash', true, 'per_item', null, false),
 ( 7, '01900000-0000-7000-8000-000000400008', 2,  3500, 0,  2400, date '2026-08-12', 'cash', true, 'per_item', null, false),
 ( 8, '01900000-0000-7000-8000-000000400009', 2,  2500, 0,  1500, date '2026-08-13', 'cash', true, 'per_item', null, false),
 ( 9, '01900000-0000-7000-8000-000000400010', 2,  4500, 0,  3000, date '2026-08-14', 'cash', true, 'per_item', null, false),
 (10, '01900000-0000-7000-8000-000000400011', 2, 12000, 0,  8000, date '2026-08-15', 'cash', true, 'per_item', null, false),
 (11, '01900000-0000-7000-8000-000000400012', 2,  1500, 0,   800, date '2026-08-16', 'cash', true, 'per_item', null, false),
 (12, '01900000-0000-7000-8000-000000400013', 2, 34000, 0, 30500, date '2026-08-17', 'cash', true, 'per_item', null, false),
 (13, '01900000-0000-7000-8000-000000400014', 2,  8000, 0,  5000, date '2026-08-18', 'cash', true, 'per_item', null, false),
 (14, '01900000-0000-7000-8000-000000400015', 2, 18000, 0, 13000, date '2026-08-19', 'cash', true, 'per_item', null, false),
 (15, '01900000-0000-7000-8000-000000400016', 2, 12000, 0,  8500, date '2026-08-20', 'cash', true, 'per_item', null, false),
 (16, '01900000-0000-7000-8000-000000400017', 2, 13000, 0,  9500, date '2026-08-21', 'cash', true, 'per_item', null, false),
 (17, '01900000-0000-7000-8000-000000400018', 2,  9500, 0,  6500, date '2026-08-22', 'cash', true, 'per_item', null, false),
 (18, '01900000-0000-7000-8000-000000400019', 2,  3000, 0,  1800, date '2026-08-23', 'cash', true, 'per_item', null, false),
 (19, '01900000-0000-7000-8000-000000400020', 2,  5000, 0,  3000, date '2026-08-24', 'cash', true, 'per_item', null, false),
-- extra Aug sales: Telur x4, Aqua x1  (n 20..24)
 (20, '01900000-0000-7000-8000-000000400004', 2, 28000, 0, 24000, date '2026-08-25', 'cash', true, 'per_item', null, false),
 (21, '01900000-0000-7000-8000-000000400004', 2, 28000, 0, 24000, date '2026-08-26', 'cash', true, 'per_item', null, false),
 (22, '01900000-0000-7000-8000-000000400004', 2, 28000, 0, 24000, date '2026-08-27', 'cash', true, 'per_item', null, false),
 (23, '01900000-0000-7000-8000-000000400004', 2, 28000, 0, 24000, date '2026-08-28', 'cash', true, 'per_item', null, false),
 (24, '01900000-0000-7000-8000-000000400006', 2,  3000, 0,  1800, date '2026-08-29', 'cash', true, 'per_item', null, false),
-- ACCEPTANCE scenario: Gula 5 @ 12.000 cash after 10@6.000 + 10@9.000 (n 25)
 (25, '01900000-0000-7000-8000-000000400001', 5, 12000, 0,  7500, date '2026-09-04', 'cash', true, 'per_item', null, false),
-- Oct: 5x Sabun qty 10 (n 26..30), 5x Indomie qty 20 (n 31..35)
 (26, '01900000-0000-7000-8000-000000400010', 10, 4500, 0, 3000, date '2026-10-02', 'cash', true, 'per_item', null, false),
 (27, '01900000-0000-7000-8000-000000400010', 10, 4500, 0, 3000, date '2026-10-03', 'cash', true, 'per_item', null, false),
 (28, '01900000-0000-7000-8000-000000400010', 10, 4500, 0, 3000, date '2026-10-04', 'cash', true, 'per_item', null, false),
 (29, '01900000-0000-7000-8000-000000400010', 10, 4500, 0, 3000, date '2026-10-05', 'cash', true, 'per_item', null, false),
 (30, '01900000-0000-7000-8000-000000400010', 10, 4500, 0, 3000, date '2026-10-06', 'cash', true, 'per_item', null, false),
 (31, '01900000-0000-7000-8000-000000400008', 20, 3500, 0, 2400, date '2026-10-07', 'cash', true, 'per_item', null, false),
 (32, '01900000-0000-7000-8000-000000400008', 20, 3500, 0, 2400, date '2026-10-08', 'cash', true, 'per_item', null, false),
 (33, '01900000-0000-7000-8000-000000400008', 20, 3500, 0, 2400, date '2026-10-09', 'cash', true, 'per_item', null, false),
 (34, '01900000-0000-7000-8000-000000400008', 20, 3500, 0, 2400, date '2026-10-10', 'cash', true, 'per_item', null, false),
 (35, '01900000-0000-7000-8000-000000400008', 20, 3500, 0, 2400, date '2026-10-11', 'cash', true, 'per_item', null, false),
-- credit sales (unpaid, receivable stubs)  (n 36..37)
 (36, '01900000-0000-7000-8000-000000400003', 3, 14000, 2000, 11000, date '2026-10-12', 'credit', false, 'per_item', '01900000-0000-7000-8000-000000700001', false),
 (37, '01900000-0000-7000-8000-000000400004', 2, 28000, 0, 24000, date '2026-10-13', 'credit', false, 'per_item', '01900000-0000-7000-8000-000000700002', false),
-- daily-total sale: revenue only, no stock move  (n 38)
 (38, null, null, null, 0, null, date '2026-10-25', 'cash', true, 'daily_total', null, false),
-- QRIS sale: Gula 5 @ 12.000, paid via QRIS (MDR fixture)  (n 39)
 (39, '01900000-0000-7000-8000-000000400001', 5, 12000, 0, 7500, date '2026-10-20', 'qris', true, 'per_item', null, false),
-- voided sale: contributes 0 to all reports  (n 40)
 (40, '01900000-0000-7000-8000-000000400013', 2, 34000, 0, 30500, date '2026-10-26', 'cash', true, 'per_item', null, true);

-- sale.total for the daily-total row is the recorded amount:
update st_sale set price = 250000, qty = null, cost = null where n = 38;

insert into sale (id, tenant_id, outlet_id, number, customer_id, total, discount, payment_method, paid, mode, business_date, voided_at, void_reason, created_by, created_at)
select ('01900000-0000-7000-8000-' || lpad(('A' || lpad(s.n::text, 5, '0')), 12, '0'))::uuid,
       '01900000-0000-7000-8000-000000000001', '01900000-0000-7000-8000-000000000002',
       lpad(s.n::text, 4, '0'), s.customer,
       case when s.n = 38 then 250000 else (s.qty * s.price - s.disc)::bigint end,
       0, s.method, s.paid, s.mode, s.bdate,
       case when s.voided then (date '2026-10-28' + time '11:00') at time zone 'Asia/Jakarta' end,
       case when s.voided then 'Salah input (barang diambil kembali)' end,
       '01900000-0000-7000-8000-000000010001',
       (s.bdate + time '13:00') at time zone 'Asia/Jakarta'
from st_sale s
on conflict (id) do nothing;

insert into sale_line (id, sale_id, item_id, qty, unit_price, discount, cost_at_sale)
select ('01900000-0000-7000-8000-' || lpad(('B' || lpad(s.n::text, 5, '0')), 12, '0'))::uuid,
       ('01900000-0000-7000-8000-' || lpad(('A' || lpad(s.n::text, 5, '0')), 12, '0'))::uuid,
       s.item_id, s.qty, s.price, s.disc, s.cost
from st_sale s
where s.mode = 'per_item'
on conflict (id) do nothing;

-- one stock_move per sale line (type 'sale'); daily-total rows have none
insert into stock_move (id, tenant_id, outlet_id, item_id, qty, unit_cost, type, ref_type, ref_id, business_date, note, created_by, created_at)
select ('01900000-0000-7000-8000-' || lpad(('9' || lpad(s.n::text, 5, '0')), 12, '0'))::uuid,
       '01900000-0000-7000-8000-000000000001', '01900000-0000-7000-8000-000000000002',
       s.item_id, -s.qty, s.cost, 'sale', 'sale',
       ('01900000-0000-7000-8000-' || lpad(('A' || lpad(s.n::text, 5, '0')), 12, '0'))::uuid,
       s.bdate, null,
       '01900000-0000-7000-8000-000000010001',
       (s.bdate + time '13:30') at time zone 'Asia/Jakarta'
from st_sale s
where s.mode = 'per_item'
on conflict (id) do nothing;

-- void reversal: counter-entry, never an edit (n 40)
insert into stock_move (id, tenant_id, outlet_id, item_id, qty, unit_cost, type, ref_type, ref_id, business_date, note, created_by, created_at) values
  ('01900000-0000-7000-8000-000000800303', '01900000-0000-7000-8000-000000000001', '01900000-0000-7000-8000-000000000002',
   '01900000-0000-7000-8000-000000400013', 2, 30500, 'return', 'sale_void',
   '01900000-0000-7000-8000-000000A00040', date '2026-10-28', 'Pembatalan penjualan 0040',
   '01900000-0000-7000-8000-000000010001', (date '2026-10-28' + time '11:30') at time zone 'Asia/Jakarta')
on conflict (id) do nothing;

-- payment (QRIS, n 39): gross 60.000, MDR 0.7% = 420, net 59.580
insert into payment (id, tenant_id, sale_id, method, provider, amount_gross, mdr_amount, amount_net, status, provider_ref, qr_string, paid_at, confirmed_by)
values
  ('01900000-0000-7000-8000-0000000D0001', '01900000-0000-7000-8000-000000000001',
   '01900000-0000-7000-8000-000000A00039',
   'qris', 'static', 60000, 420, 59580, 'paid', 'QRIS-STATIC-001',
   (select qris_payload from outlet where id = '01900000-0000-7000-8000-000000000002'),
   (date '2026-10-20' + time '13:05') at time zone 'Asia/Jakarta',
   '01900000-0000-7000-8000-000000010001')
on conflict (id) do nothing;

-- receivable stubs for the two credit sales
insert into receivable (id, tenant_id, contact_id, sale_id, amount, due_date, paid_amount) values
  ('01900000-0000-7000-8000-0000000E0001', '01900000-0000-7000-8000-000000000001',
   '01900000-0000-7000-8000-000000700001', '01900000-0000-7000-8000-000000A00036',
   40000, date '2026-11-10', 0),
  ('01900000-0000-7000-8000-0000000E0002', '01900000-0000-7000-8000-000000000001',
   '01900000-0000-7000-8000-000000700002', '01900000-0000-7000-8000-000000A00037',
   56000, date '2026-11-15', 0)
on conflict (id) do nothing;

insert into payable (id, tenant_id, contact_id, amount, due_date, paid_amount) values
  ('01900000-0000-7000-8000-0000000F0001', '01900000-0000-7000-8000-000000000001',
   '01900000-0000-7000-8000-000000700003', 500000, date '2026-10-30', 200000)
on conflict (id) do nothing;

-- --------------------------------------------------------------- cash book
-- 20 entries. Purchases (pembelian_stok / ref purchase / ref stock_move)
-- are NOT opex; 'modal' is not opex; sale cash-ins are direction 'in'.
insert into cash_entry (id, tenant_id, outlet_id, direction, amount, category, method, ref_type, ref_id, business_date, note, created_by) values
  ('01900000-0000-7000-8000-0000000C0001', '01900000-0000-7000-8000-000000000001', '01900000-0000-7000-8000-000000000002', 'out', 2083000, 'pembelian_stok', 'cash', 'purchase', null, date '2026-08-01', 'Stok awal (19 item x 10)', '01900000-0000-7000-8000-000000010001'),
  ('01900000-0000-7000-8000-0000000C0002', '01900000-0000-7000-8000-000000000001', '01900000-0000-7000-8000-000000000002', 'out',  45000, 'listrik', 'cash', null, null, date '2026-08-15', 'Token listrik', '01900000-0000-7000-8000-000000010001'),
  ('01900000-0000-7000-8000-0000000C0003', '01900000-0000-7000-8000-000000000001', '01900000-0000-7000-8000-000000000002', 'out',  25000, 'kemasan', 'cash', null, null, date '2026-08-20', 'Plastik dan kemasan', '01900000-0000-7000-8000-000000010001'),
  ('01900000-0000-7000-8000-0000000C0004', '01900000-0000-7000-8000-000000000001', '01900000-0000-7000-8000-000000000002', 'out', 150000, 'gaji', 'cash', null, null, date '2026-08-28', 'Gaji penjaga', '01900000-0000-7000-8000-000000010001'),
  ('01900000-0000-7000-8000-0000000C0005', '01900000-0000-7000-8000-000000000001', '01900000-0000-7000-8000-000000000002', 'out',  60000, 'pembelian_stok', 'cash', 'stock_move', '01900000-0000-7000-8000-000000800201', date '2026-09-02', 'Beli gula 1 (10 @ 6.000)', '01900000-0000-7000-8000-000000010001'),
  ('01900000-0000-7000-8000-0000000C0006', '01900000-0000-7000-8000-000000000001', '01900000-0000-7000-8000-000000000002', 'out',  90000, 'pembelian_stok', 'cash', 'stock_move', '01900000-0000-7000-8000-000000800202', date '2026-09-03', 'Beli gula 2 (10 @ 9.000)', '01900000-0000-7000-8000-000000010001'),
  ('01900000-0000-7000-8000-0000000C0007', '01900000-0000-7000-8000-000000000001', '01900000-0000-7000-8000-000000000002', 'in',   60000, 'penjualan', 'cash', 'sale', '01900000-0000-7000-8000-000000A00025', date '2026-09-04', 'Setoran penjualan tunai', '01900000-0000-7000-8000-000000010001'),
  ('01900000-0000-7000-8000-0000000C0008', '01900000-0000-7000-8000-000000000001', '01900000-0000-7000-8000-000000000002', 'out',   5000, 'listrik', 'cash', null, null, date '2026-09-05', 'Token listrik', '01900000-0000-7000-8000-000000010001'),
  ('01900000-0000-7000-8000-0000000C0009', '01900000-0000-7000-8000-000000000001', '01900000-0000-7000-8000-000000000002', 'out', 100000, 'pembelian_stok', 'cash', 'purchase', null, date '2026-09-12', 'Restock', '01900000-0000-7000-8000-000000010001'),
  ('01900000-0000-7000-8000-0000000C0010', '01900000-0000-7000-8000-000000000001', '01900000-0000-7000-8000-000000000002', 'out', 100000, 'pembelian_stok', 'cash', 'purchase', null, date '2026-09-19', 'Restock', '01900000-0000-7000-8000-000000010001'),
  ('01900000-0000-7000-8000-0000000C0011', '01900000-0000-7000-8000-000000000001', '01900000-0000-7000-8000-000000000002', 'out', 100000, 'pembelian_stok', 'cash', 'purchase', null, date '2026-09-26', 'Restock', '01900000-0000-7000-8000-000000010001'),
  ('01900000-0000-7000-8000-0000000C0012', '01900000-0000-7000-8000-000000000001', '01900000-0000-7000-8000-000000000002', 'out', 300000, 'pembelian_stok', 'cash', 'purchase', null, date '2026-10-03', 'Restock besar', '01900000-0000-7000-8000-000000010001'),
  ('01900000-0000-7000-8000-0000000C0013', '01900000-0000-7000-8000-000000000001', '01900000-0000-7000-8000-000000000002', 'out', 250000, 'pembelian_stok', 'cash', 'purchase', null, date '2026-10-10', 'Restock besar', '01900000-0000-7000-8000-000000010001'),
  ('01900000-0000-7000-8000-0000000C0014', '01900000-0000-7000-8000-000000000001', '01900000-0000-7000-8000-000000000002', 'out', 200000, 'pembelian_stok', 'cash', 'purchase', null, date '2026-10-17', 'Restock besar', '01900000-0000-7000-8000-000000010001'),
  ('01900000-0000-7000-8000-0000000C0015', '01900000-0000-7000-8000-000000000001', '01900000-0000-7000-8000-000000000002', 'out',  60000, 'listrik', 'cash', null, null, date '2026-10-15', 'Token listrik', '01900000-0000-7000-8000-000000010001'),
  ('01900000-0000-7000-8000-0000000C0016', '01900000-0000-7000-8000-000000000001', '01900000-0000-7000-8000-000000000002', 'out',  20000, 'transportasi', 'cash', null, null, date '2026-10-20', 'Bensin ambil barang', '01900000-0000-7000-8000-000000010001'),
  ('01900000-0000-7000-8000-0000000C0017', '01900000-0000-7000-8000-000000000001', '01900000-0000-7000-8000-000000000002', 'in',   70000, 'penjualan', 'cash', 'sale', '01900000-0000-7000-8000-000000A00035', date '2026-10-11', 'Setoran penjualan tunai', '01900000-0000-7000-8000-000000010001'),
  ('01900000-0000-7000-8000-0000000C0018', '01900000-0000-7000-8000-000000000001', '01900000-0000-7000-8000-000000000002', 'in',  250000, 'penjualan', 'cash', 'sale', '01900000-0000-7000-8000-000000A00038', date '2026-10-25', 'Setoran penjualan harian (daily total)', '01900000-0000-7000-8000-000000010001'),
  ('01900000-0000-7000-8000-0000000C0019', '01900000-0000-7000-8000-000000000001', '01900000-0000-7000-8000-000000000002', 'out', 150000, 'gaji', 'cash', null, null, date '2026-10-28', 'Gaji penjaga', '01900000-0000-7000-8000-000000010001'),
  ('01900000-0000-7000-8000-0000000C0020', '01900000-0000-7000-8000-000000000001', '01900000-0000-7000-8000-000000000002', 'in', 1000000, 'modal', 'cash', null, null, date '2026-10-01', 'Modal tambahan', '01900000-0000-7000-8000-000000010001')
on conflict (id) do nothing;

-- ------------------------------------------------------- projections
-- stock_level = sum(stock_move.qty) per outlet+item
insert into stock_level (tenant_id, outlet_id, item_id, qty)
select tenant_id, outlet_id, item_id, sum(qty)
from stock_move
group by 1, 2, 3
on conflict (outlet_id, item_id) do update set qty = excluded.qty;

-- Gula moving average: (10*6.000 + 10*9.000) / 20 = 7.500
update item
set cost_avg = 7500
where id = '01900000-0000-7000-8000-000000400001'
  and cost_avg is distinct from 7500;

-- keep the QRIS fixture correct on re-runs / older seeds (CRC covers '6304')
update outlet
set qris_payload = (select p.body || '6304' || qris_crc16(p.body || '6304')
                      from (select '00020101021126420014ID.CO.QRIS.WWW01151234567890123450201U'
                                   || '5204541153033605802ID5913WARUNG BU SRI6007JAKARTA' as body) p)
where id = '01900000-0000-7000-8000-000000000002'
  and qris_payload is distinct from (select p.body || '6304' || qris_crc16(p.body || '6304')
                      from (select '00020101021126420014ID.CO.QRIS.WWW01151234567890123450201U'
                                   || '5204541153033605802ID5913WARUNG BU SRI6007JAKARTA' as body) p);

update payment
set qr_string = (select qris_payload from outlet where id = '01900000-0000-7000-8000-000000000002')
where id = '01900000-0000-7000-8000-0000000D0001'
  and qr_string is distinct from (select qris_payload from outlet where id = '01900000-0000-7000-8000-000000000002');

commit;
