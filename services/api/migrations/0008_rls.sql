-- RLS (T-102): enable + FORCE on every tenant-scoped table so even the
-- table owner (non-superuser role stokku) is bound by the policies; only a
-- superuser bypasses. The API must never connect as a superuser.
--
-- Tenant scoping helper for Backend: set once per request transaction
-- (equivalent to SET LOCAL):
--   begin;
--   select set_app_context('<tenant_uuid>', '<user_uuid>', '<device>');
--   ... queries ...
--   commit;   -- settings reset automatically

create function set_app_context(
  p_tenant uuid,
  p_user   uuid default null,
  p_device text  default null
) returns void
language plpgsql as $$
begin
  perform set_config('app.tenant_id', p_tenant::text, true);
  if p_user is not null then
    perform set_config('app.user_id', p_user::text, true);
  end if;
  if p_device is not null then
    perform set_config('app.device', p_device, true);
  end if;
end;
$$;

-- tenant itself: identified by its own id
alter table tenant enable row level security;
alter table tenant force row level security;
create policy tenant_isolation on tenant
  using (id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (id = nullif(current_setting('app.tenant_id', true), '')::uuid);

-- tenant-scoped tables: policy on app.tenant_id
alter table outlet           enable row level security;
alter table outlet           force row level security;
create policy tenant_isolation on outlet
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

alter table refresh_token enable row level security;
alter table refresh_token force row level security;
create policy tenant_isolation on refresh_token
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

alter table category enable row level security;
alter table category force row level security;
create policy tenant_isolation on category
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

alter table item enable row level security;
alter table item force row level security;
create policy tenant_isolation on item
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

alter table item_barcode enable row level security;
alter table item_barcode force row level security;
create policy tenant_isolation on item_barcode
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

alter table item_unit enable row level security;
alter table item_unit force row level security;
create policy tenant_isolation on item_unit
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

alter table stock_move enable row level security;
alter table stock_move force row level security;
create policy tenant_isolation on stock_move
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

alter table stock_level enable row level security;
alter table stock_level force row level security;
create policy tenant_isolation on stock_level
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

alter table period_lock enable row level security;
alter table period_lock force row level security;
create policy tenant_isolation on period_lock
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

alter table sale enable row level security;
alter table sale force row level security;
create policy tenant_isolation on sale
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

alter table payment enable row level security;
alter table payment force row level security;
create policy tenant_isolation on payment
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

alter table cash_entry enable row level security;
alter table cash_entry force row level security;
create policy tenant_isolation on cash_entry
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

alter table cash_category enable row level security;
alter table cash_category force row level security;
create policy tenant_isolation on cash_category
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

alter table contact enable row level security;
alter table contact force row level security;
create policy tenant_isolation on contact
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

alter table payable enable row level security;
alter table payable force row level security;
create policy tenant_isolation on payable
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

alter table receivable enable row level security;
alter table receivable force row level security;
create policy tenant_isolation on receivable
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

alter table op_log enable row level security;
alter table op_log force row level security;
create policy tenant_isolation on op_log
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

alter table change_log enable row level security;
alter table change_log force row level security;
create policy tenant_isolation on change_log
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

alter table audit_log enable row level security;
alter table audit_log force row level security;
create policy tenant_isolation on audit_log
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

-- user_app and membership are per user, not per tenant (DATA_MODEL.md §4).
-- signup is public, so inserts are allowed; reads are scoped.
alter table user_app enable row level security;
alter table user_app force row level security;
create policy user_self on user_app
  using (id = nullif(current_setting('app.user_id', true), '')::uuid)
  with check (true);

-- membership: readable by the member themselves or any member of the tenant
-- (member list); the API enforces owner-only writes (invites).
alter table membership enable row level security;
alter table membership force row level security;
create policy member_of on membership
  using (user_id = nullif(current_setting('app.user_id', true), '')::uuid
         or tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

alter table device enable row level security;
alter table device force row level security;
create policy device_self on device
  using (user_id = nullif(current_setting('app.user_id', true), '')::uuid)
  with check (user_id = nullif(current_setting('app.user_id', true), '')::uuid);
