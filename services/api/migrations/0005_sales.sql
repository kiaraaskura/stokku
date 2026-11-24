-- Sales: sale, sale_line, payment.
-- sale.total is stored NET of line discounts and the sale-level discount;
-- the report views rely on that (API contract "minus line discounts").

create table sale (
  id             uuid primary key default uuidv7(),
  tenant_id      uuid not null references tenant(id),
  outlet_id      uuid not null references outlet(id),
  number         text,
  customer_id    uuid,
  total          bigint not null check (total >= 0),
  discount       bigint not null default 0 check (discount >= 0),
  payment_method text not null check (payment_method in ('cash','transfer','qris','credit')),
  paid           boolean not null default false,
  mode           text not null default 'per_item' check (mode in ('per_item','daily_total')),
  business_date  date not null,
  voided_at      timestamptz,
  void_reason    text,
  op_id          uuid,
  created_by     uuid references user_app(id),
  created_at     timestamptz not null default now()
);
-- §5.
create index sale_tenant_bdate_idx on sale (tenant_id, business_date);
-- one number per tenant (advisory, not a hard constraint: voided sales keep theirs)
create index sale_tenant_number_idx on sale (tenant_id, number);

create table sale_line (
  id           uuid primary key default uuidv7(),
  sale_id      uuid not null references sale(id),
  item_id      uuid not null references item(id),
  qty          numeric(14,3) not null check (qty > 0),
  unit_price   bigint not null check (unit_price >= 0),
  discount     bigint not null default 0 check (discount >= 0),
  cost_at_sale bigint not null default 0,
  -- §2: discount >= 0 AND discount <= qty * unit_price
  constraint sale_line_discount_range check (discount <= qty * unit_price)
);
-- §5.
create index sale_line_sale_idx on sale_line (sale_id);

create table payment (
  id            uuid primary key default uuidv7(),
  tenant_id     uuid not null references tenant(id),
  sale_id       uuid not null references sale(id),
  method        text not null check (method in ('cash','transfer','qris','credit')),
  provider      text,
  amount_gross  bigint not null check (amount_gross >= 0),
  mdr_amount    bigint not null default 0,
  amount_net    bigint not null check (amount_net >= 0),
  status        text not null default 'pending'
                  check (status in ('pending','paid','expired','refunded')),
  provider_ref  text,
  qr_string     text,
  expires_at    timestamptz,
  paid_at       timestamptz,
  settlement_id text,
  confirmed_by  uuid references user_app(id),
  created_at    timestamptz not null default now()
);
-- §2: "payment unique on (sale_id, status) where status='paid'".
create unique index payment_one_paid_uq on payment (sale_id) where status = 'paid';
-- §5.
create index payment_sale_idx on payment (sale_id);

-- sale.customer_id -> contact (contact is created in 0006)
