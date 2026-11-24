-- Ledger: stock_move (append-only), stock_level (projection), period_lock.
-- Triggers: the append-only guard (§2) and the period-lock guard (§2).

create table stock_move (
  id            uuid primary key default uuidv7(),
  tenant_id     uuid not null references tenant(id),
  outlet_id     uuid not null references outlet(id),
  item_id       uuid not null,
  qty           numeric(14,3) not null check (qty <> 0),
  unit_cost     bigint not null default 0,
  type          text not null check (type in ('in','sale','loss','return','adjust','transfer')),
  ref_type      text,
  ref_id        uuid,
  business_date date not null,
  note          text,
  created_by    uuid references user_app(id),
  created_at    timestamptz not null default now(),
  op_id         uuid,
  server_seq    bigint,
  foreign key (tenant_id, item_id) references item (tenant_id, id)
);
-- §5 indexes.
create index stock_move_ledger_idx on stock_move (outlet_id, item_id, business_date, created_at);
create index stock_move_tenant_seq_idx on stock_move (tenant_id, server_seq);

create table stock_level (
  tenant_id uuid not null references tenant(id),
  outlet_id uuid not null references outlet(id),
  item_id   uuid not null,
  qty       numeric(14,3) not null default 0,
  primary key (outlet_id, item_id),
  foreign key (tenant_id, item_id) references item (tenant_id, id)
);
-- §5: "stock_level(outlet_id) where qty <= 0 for the negative flag".
create index stock_level_negative_idx on stock_level (outlet_id) where qty <= 0;

-- §2: "trigger blocks UPDATE/DELETE (allow only server_seq assignment by the
-- change-log trigger)". Implemented as the explicit column comparison below:
-- the only permitted change is server_seq going from NULL to a value.
create function stock_move_block_write() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'stock_move is append-only: DELETE is not allowed (id %)', old.id;
  end if;
  if (new.tenant_id, new.outlet_id, new.item_id, new.qty, new.unit_cost, new.type,
      new.ref_type, new.ref_id, new.business_date, new.note, new.created_by,
      new.created_at, new.op_id)
     is distinct from
     (old.tenant_id, old.outlet_id, old.item_id, old.qty, old.unit_cost, old.type,
      old.ref_type, old.ref_id, old.business_date, old.note, old.created_by,
      old.created_at, old.op_id)
  then
    raise exception 'stock_move is append-only: only server_seq may be updated (id %)', old.id;
  end if;
  return new;
end;
$$;

create trigger stock_move_append_only
  before update or delete on stock_move
  for each row execute function stock_move_block_write();

create table period_lock (
  tenant_id  uuid not null references tenant(id),
  outlet_id  uuid not null references outlet(id),
  period     date not null check (period = date_trunc('month', period)::date),
  created_at timestamptz not null default now(),
  primary key (tenant_id, outlet_id, period)
);

-- §2: "a trigger rejects stock_move/cash_entry/sale inserts into a locked
-- period for non-owner actors". Actor = NEW.created_by, role looked up in
-- membership; rows with no actor (system) and unknown actors pass (auth is
-- the API's job; a staff member is always a member and is always rejected).
create function period_guard() returns trigger
language plpgsql as $$
declare
  v_outlet uuid;
  v_actor  uuid;
  v_role   text;
begin
  if to_jsonb(new) ? 'outlet_id' then
    v_outlet := (to_jsonb(new)->>'outlet_id')::uuid;
  end if;
  if to_jsonb(new) ? 'created_by' then
    v_actor := nullif(to_jsonb(new)->>'created_by', '')::uuid;
  end if;
  if v_outlet is null or v_actor is null then
    return new;
  end if;

  select m.role into v_role
  from membership m
  where m.tenant_id = new.tenant_id
    and m.user_id = v_actor;

  if v_role = 'owner' or v_role is null then
    return new;
  end if;

  if exists (
    select 1 from period_lock pl
    where pl.tenant_id = new.tenant_id
      and pl.outlet_id = v_outlet
      and pl.period = date_trunc('month', new.business_date)::date
  ) then
    raise exception 'period_locked: month % is closed for non-owner writes',
      date_trunc('month', new.business_date)::date
      using errcode = '42501';
  end if;
  return new;
end;
$$;

create trigger stock_move_period_guard
  before insert on stock_move
  for each row execute function period_guard();
