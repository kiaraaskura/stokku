-- Cash book and contacts. cash_entry.category is the category NAME
-- (string) matching a cash_category row, as in the API contract body.

create table cash_category (
  id        uuid primary key default uuidv7(),
  tenant_id uuid not null references tenant(id),
  name      text not null,
  direction text not null check (direction in ('in','out')),
  sort      integer not null default 0,
  seeded    boolean not null default false,
  unique (tenant_id, name, direction)
);

create table cash_entry (
  id            uuid primary key default uuidv7(),
  tenant_id     uuid not null references tenant(id),
  outlet_id     uuid not null references outlet(id),
  direction     text not null check (direction in ('in','out')),
  amount        bigint not null check (amount > 0),
  category      text not null,
  method        text,
  ref_type      text,
  ref_id        uuid,
  business_date date not null,
  note          text,
  op_id         uuid,
  created_by    uuid references user_app(id),
  created_at    timestamptz not null default now()
);
-- §5.
create index cash_entry_tenant_bdate_idx on cash_entry (tenant_id, business_date);

create table contact (
  id         uuid primary key default uuidv7(),
  tenant_id  uuid not null references tenant(id),
  type       text not null check (type in ('customer','supplier')),
  name       text not null,
  phone      text,
  created_at timestamptz not null default now()
);

create table payable (
  id          uuid primary key default uuidv7(),
  tenant_id   uuid not null references tenant(id),
  contact_id  uuid not null references contact(id),
  amount      bigint not null check (amount > 0),
  due_date    date,
  paid_amount bigint not null default 0 check (paid_amount >= 0 and paid_amount <= amount),
  created_at  timestamptz not null default now()
);

create table receivable (
  id          uuid primary key default uuidv7(),
  tenant_id   uuid not null references tenant(id),
  contact_id  uuid not null references contact(id),
  sale_id     uuid references sale(id),
  amount      bigint not null check (amount > 0),
  due_date    date,
  paid_amount bigint not null default 0 check (paid_amount >= 0 and paid_amount <= amount),
  created_at  timestamptz not null default now()
);

alter table sale
  add constraint sale_customer_fk foreign key (customer_id) references contact(id);

create trigger cash_entry_period_guard
  before insert on cash_entry
  for each row execute function period_guard();

create trigger sale_period_guard
  before insert on sale
  for each row execute function period_guard();
