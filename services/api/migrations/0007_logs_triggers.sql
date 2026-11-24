-- Logs: op_log (exactly-once), change_log (sync feed), audit_log (T-104).
-- One AFTER INSERT OR UPDATE trigger on every tenant-scoped business table:
-- each write lands exactly one change_log row, and server_seq is written
-- back to the row when the table has that column (stock_move today).

create table op_log (
  op_id      uuid primary key,
  tenant_id  uuid not null references tenant(id),
  device_id  uuid,
  applied_at timestamptz not null default now(),
  result     jsonb
);

create table change_log (
  server_seq bigserial primary key,
  tenant_id  uuid not null,
  table_name text not null,
  row_id     uuid,
  op         text not null,
  changed_at timestamptz not null default now()
);
-- §5.
create index change_log_tenant_seq_idx on change_log (tenant_id, server_seq);

create table audit_log (
  id        uuid primary key default uuidv7(),
  tenant_id uuid not null,
  actor_id  uuid,
  action    text not null,
  entity    text not null,
  entity_id uuid,
  before    jsonb,
  after     jsonb,
  device    text,
  at        timestamptz not null default now()
);

create function change_log_row() returns trigger
language plpgsql as $$
declare
  v_seq bigint;
  v_row uuid;
begin
  if tg_op = 'UPDATE' then
    -- a no-op UPDATE is not a write
    if new is not distinct from old then
      return new;
    end if;
    -- the server_seq write-back below is internal, not a business write
    if (to_jsonb(new) - 'server_seq') = (to_jsonb(old) - 'server_seq') then
      return new;
    end if;
  end if;

  if tg_table_name = 'tenant' then
    insert into change_log (tenant_id, table_name, row_id, op)
      values (new.id, tg_table_name, new.id, lower(tg_op))
      returning server_seq into v_seq;
  else
    if to_jsonb(new) ? 'id' then
      v_row := (to_jsonb(new)->>'id')::uuid;
    elsif tg_table_name = 'stock_level' then
      -- stock_level has no id: the item is the client's key
      v_row := (to_jsonb(new)->>'item_id')::uuid;
    end if;
    insert into change_log (tenant_id, table_name, row_id, op)
      values (new.tenant_id, tg_table_name, v_row, lower(tg_op))
      returning server_seq into v_seq;
  end if;

  -- write server_seq back where the column exists
  if to_jsonb(new) ? 'server_seq' and (to_jsonb(new)->>'server_seq') is null then
    execute format('update %I.%I set server_seq = $1 where id = $2',
                   tg_table_schema, tg_table_name)
      using v_seq, new.id;
  end if;

  return new;
end;
$$;

-- Attach to every tenant-scoped business table.
-- NOT attached: change_log/audit_log/op_log themselves (log tables),
-- refresh_token (security table — must never enter the sync feed),
-- and the tenant-id-less children sale_line/device/user_app (their parent
-- row carries the change).
create trigger change_log after insert or update on tenant
  for each row execute function change_log_row();
create trigger change_log after insert or update on outlet
  for each row execute function change_log_row();
create trigger change_log after insert or update on membership
  for each row execute function change_log_row();
create trigger change_log after insert or update on category
  for each row execute function change_log_row();
create trigger change_log after insert or update on item
  for each row execute function change_log_row();
create trigger change_log after insert or update on item_barcode
  for each row execute function change_log_row();
create trigger change_log after insert or update on item_unit
  for each row execute function change_log_row();
create trigger change_log after insert or update on stock_move
  for each row execute function change_log_row();
create trigger change_log after insert or update on stock_level
  for each row execute function change_log_row();
create trigger change_log after insert or update on period_lock
  for each row execute function change_log_row();
create trigger change_log after insert or update on sale
  for each row execute function change_log_row();
create trigger change_log after insert or update on payment
  for each row execute function change_log_row();
create trigger change_log after insert or update on cash_entry
  for each row execute function change_log_row();
create trigger change_log after insert or update on cash_category
  for each row execute function change_log_row();
create trigger change_log after insert or update on contact
  for each row execute function change_log_row();
create trigger change_log after insert or update on payable
  for each row execute function change_log_row();
create trigger change_log after insert or update on receivable
  for each row execute function change_log_row();

-- T-104: audit_log for master-data edits. Attachable trigger plus a
-- direct-call helper. Actor and device come from the app context
-- (see set_app_context in 0008).
create function audit_master_data() returns trigger
language plpgsql as $$
begin
  insert into audit_log (tenant_id, actor_id, action, entity, entity_id, before, after, device)
  values (
    coalesce((to_jsonb(new)->>'tenant_id')::uuid, (to_jsonb(old)->>'tenant_id')::uuid),
    nullif(current_setting('app.user_id', true), '')::uuid,
    lower(tg_op),
    tg_table_name,
    coalesce((to_jsonb(new)->>'id')::uuid, (to_jsonb(old)->>'id')::uuid),
    case when tg_op in ('UPDATE','DELETE') then to_jsonb(old) end,
    case when tg_op = 'DELETE' then null else to_jsonb(new) end,
    nullif(current_setting('app.device', true), '')
  );
  return coalesce(new, old);
end;
$$;

-- Master-data tables: category, item, item_barcode, item_unit, contact,
-- cash_category. Backend can also record manual audit rows with
-- audit_record(...) for anything else.
create trigger audit_master after insert or update or delete on category
  for each row execute function audit_master_data();
create trigger audit_master after insert or update or delete on item
  for each row execute function audit_master_data();
create trigger audit_master after insert or update or delete on item_barcode
  for each row execute function audit_master_data();
create trigger audit_master after insert or update or delete on item_unit
  for each row execute function audit_master_data();
create trigger audit_master after insert or update or delete on contact
  for each row execute function audit_master_data();
create trigger audit_master after insert or update or delete on cash_category
  for each row execute function audit_master_data();

-- Direct-call helper for one-off audit records.
create function audit_record(
  p_tenant    uuid,
  p_actor     uuid,
  p_action    text,
  p_entity    text,
  p_entity_id uuid,
  p_before    jsonb default null,
  p_after     jsonb default null,
  p_device    text  default null
) returns void
language sql as $$
  insert into audit_log (tenant_id, actor_id, action, entity, entity_id, before, after, device)
  values (p_tenant, p_actor, p_action, p_entity, p_entity_id, p_before, p_after, p_device);
$$;
