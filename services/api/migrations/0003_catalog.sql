-- Catalog: category, item, item_barcode, item_unit.
-- item_barcode and item_unit carry a denormalized tenant_id (with a composite
-- FK to item) so the per-tenant barcode uniqueness from DATA_MODEL.md §2 and
-- RLS work without a join. sale_line stays a pure child of sale.

create table category (
  id         uuid primary key default uuidv7(),
  tenant_id  uuid not null references tenant(id),
  name       text not null,
  sort       integer not null default 0,
  created_at timestamptz not null default now(),
  unique (tenant_id, name)
);

create table item (
  id          uuid primary key default uuidv7(),
  tenant_id   uuid not null references tenant(id),
  sku         text,
  name        text not null,
  category_id uuid references category(id),
  base_unit   text not null,
  sale_price  bigint not null check (sale_price >= 0),
  cost_avg    bigint not null default 0 check (cost_avg >= 0),
  min_stock   numeric(14,3) not null default 0,
  active      boolean not null default true,
  deleted_at  timestamptz,
  updated_at  timestamptz not null default now()
);
-- "item.sku unique per tenant (partial, where deleted_at is null)" — §2.
create unique index item_sku_tenant_live_uq on item (tenant_id, sku) where deleted_at is null;
-- Supports the composite FKs from item_barcode / item_unit / stock_move.
create unique index item_tenant_id_uq on item (tenant_id, id);
-- §5: trigram GIN on name.
create index item_name_trgm on item using gin (name gin_trgm_ops);

create table item_barcode (
  id        uuid primary key default uuidv7(),
  tenant_id uuid not null,
  item_id   uuid not null,
  barcode   text not null,
  foreign key (tenant_id, item_id) references item (tenant_id, id)
);
-- "item_barcode.barcode unique per tenant" — §2.
create unique index item_barcode_tenant_uq on item_barcode (tenant_id, barcode);

create table item_unit (
  id        uuid primary key default uuidv7(),
  tenant_id uuid not null,
  item_id   uuid not null,
  name      text not null,
  factor    numeric(14,3) not null check (factor > 0),
  foreign key (tenant_id, item_id) references item (tenant_id, id),
  unique (item_id, name)
);

create function touch_updated_at() returns trigger
language plpgsql as $$
begin
  -- a no-op UPDATE does not count as a write: do not touch updated_at
  if new is not distinct from old then
    return new;
  end if;
  new.updated_at := clock_timestamp();
  return new;
end;
$$;

create trigger item_touch_updated_at
  before update on item
  for each row execute function touch_updated_at();
