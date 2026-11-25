-- Opname (stock count) tables for B11 / T-124. Columns agreed with Backend
-- in-channel; three deliberate DB-side additions, all following existing
-- house patterns:
--   * opname_line carries a denormalized tenant_id (item_barcode/item_unit
--     pattern) so tenant RLS and the change_log trigger work without a join;
--     composite FKs keep line.tenant_id consistent with both the session
--     and the item.
--   * system_qty is a snapshot: a trigger refuses any change to it, forever.
--   * history is kept: once a session leaves 'open', its lines are frozen
--     (UPDATE/DELETE refused) and the session itself may only change
--     status/posted_at/posted_by. While open, the API re-reads stock_level
--     at post time; the snapshot column is never rewritten.
--
-- Post flow (Backend): one 'adjust' stock_move per non-zero variance, in
-- one transaction — stock_move's period lock and append-only triggers
-- apply as everywhere else.

create table opname_session (
  id            uuid primary key default uuidv7(),
  tenant_id     uuid not null references tenant(id),
  outlet_id     uuid not null references outlet(id),
  status        text not null default 'open'
                  check (status in ('open','posted','cancelled')),
  category_id   uuid references category(id),
  business_date date not null,
  posted_at     timestamptz,
  posted_by     uuid references user_app(id),
  created_by    uuid references user_app(id),
  created_at    timestamptz not null default now(),
  unique (tenant_id, id)   -- target for opname_line's composite FK
);
create index opname_session_tenant_bdate_idx on opname_session (tenant_id, business_date);

create table opname_line (
  id          uuid primary key default uuidv7(),
  tenant_id   uuid not null references tenant(id),
  session_id  uuid not null,
  item_id     uuid not null,
  system_qty  numeric(14,3) not null,
  counted_qty numeric(14,3),
  counted_at  timestamptz,
  foreign key (tenant_id, session_id) references opname_session (tenant_id, id),
  foreign key (tenant_id, item_id) references item (tenant_id, id),
  unique (session_id, item_id)
);

-- system_qty is the snapshot from session creation: never editable
create function opname_line_snapshot() returns trigger
language plpgsql as $$
begin
  if tg_op = 'UPDATE' and new.system_qty is distinct from old.system_qty then
    raise exception 'opname_line.system_qty is a snapshot and cannot be changed (line %)', old.id;
  end if;
  return coalesce(new, old);
end;
$$;
create trigger opname_line_system_qty_snapshot
  before update on opname_line
  for each row execute function opname_line_snapshot();

-- history: lines are frozen once the session is no longer open
create function opname_history_guard() returns trigger
language plpgsql as $$
declare
  v_status text;
  v_session uuid;
begin
  v_session := case when tg_op = 'DELETE' then old.session_id else new.session_id end;
  select status into v_status from opname_session where id = v_session;
  if v_status is distinct from 'open' then
    raise exception 'opname lines are immutable once the session is % (session %)', v_status, v_session;
  end if;
  return coalesce(new, old);
end;
$$;
create trigger opname_line_immutable
  before update or delete on opname_line
  for each row execute function opname_history_guard();

-- history: a session that left 'open' can only change status/posted_*;
-- an open session cannot be deleted once it has lines (the FK holds it),
-- and a closed one never can.
create function opname_session_guard() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    if old.status <> 'open' then
      raise exception 'opname_session history is kept forever (status %, id %)', old.status, old.id;
    end if;
    return old;
  end if;
  if old.status <> 'open'
     and (new.tenant_id, new.outlet_id, new.category_id, new.business_date,
          new.created_by, new.created_at)
        is distinct from
        (old.tenant_id, old.outlet_id, old.category_id, old.business_date,
         old.created_by, old.created_at) then
    raise exception 'opname_session is closed: only status, posted_at and posted_by may change (id %)', old.id;
  end if;
  return new;
end;
$$;
create trigger opname_session_immutable
  before update or delete on opname_session
  for each row execute function opname_session_guard();

-- change_log (T-103 pattern): one row per insert/update on both tables
create trigger change_log after insert or update on opname_session
  for each row execute function change_log_row();
create trigger change_log after insert or update on opname_line
  for each row execute function change_log_row();

-- RLS (T-102 pattern): forced, tenant_isolation on app.tenant_id
alter table opname_session enable row level security;
alter table opname_session force row level security;
create policy tenant_isolation on opname_session
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

alter table opname_line enable row level security;
alter table opname_line force row level security;
create policy tenant_isolation on opname_line
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
