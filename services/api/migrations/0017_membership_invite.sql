-- Staff membership (T-140). The owner invites an email; the invited person
-- accepts with one code and becomes staff. No email is sent from here — the
-- owner shares the code (WhatsApp, in person), which is how a warung actually
-- onboards a helper.
--
-- Design notes:
--  * only the SHA-256 of the invite token is stored, like refresh_token:
--    a database dump cannot be replayed to join a shop;
--  * role is fixed to 'staff' — an invite can never mint a second owner;
--  * single use and time-boxed (7 days), revoked on accept;
--  * the invite row is tenant-scoped so RLS keeps other shops out.

create table membership_invite (
  id          uuid primary key default uuidv7(),
  tenant_id   uuid not null references tenant(id),
  email       citext not null,
  role        text not null default 'staff' check (role = 'staff'),
  token_hash  text not null unique,
  invited_by  uuid references user_app(id),
  expires_at  timestamptz not null,
  accepted_at timestamptz,
  created_at  timestamptz not null default now()
);

create index membership_invite_tenant_idx on membership_invite (tenant_id, created_at desc);

alter table membership_invite enable row level security;
alter table membership_invite force row level security;

create policy tenant_isolation on membership_invite
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
-- Accepting happens before the person has any tenant context, and
-- membership_invite is tenant-locked, so the lookup runs as a definer
-- function with a pinned search_path — the same shape as the 0010 auth_*
-- helpers. It returns nothing for expired, used or unknown tokens.
create function public.auth_lookup_invite(p_token_hash text)
returns table (id uuid, tenant_id uuid, email citext, role text)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select i.id, i.tenant_id, i.email, i.role
  from public.membership_invite i
  where i.token_hash = p_token_hash
    and i.accepted_at is null
    and i.expires_at > now();
$$;

-- BYPASSRLS is not a table privilege; the definer role needs SELECT explicitly.
grant select on public.membership_invite to stokku_auth;

alter function public.auth_lookup_invite(text) owner to stokku_auth;
revoke all on function public.auth_lookup_invite(text) from public;
grant execute on function public.auth_lookup_invite(text) to stokku;

-- Members of one shop, for the owner's member list. user_app is self-only
-- under RLS, so a plain join cannot show a colleague's name; this definer
-- function is the one place that reads across members, and the handler always
-- passes the caller's own tenant.
create function public.auth_members_of_tenant(p_tenant uuid)
returns table (user_id uuid, name text, email text, role text, since timestamptz)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select m.user_id, u.name, u.email::text, m.role, m.created_at
  from public.membership m
  join public.user_app u on u.id = m.user_id
  where m.tenant_id = p_tenant
  order by m.created_at;
$$;

grant select on public.user_app to stokku_auth;
grant select on public.membership to stokku_auth;
alter function public.auth_members_of_tenant(uuid) owner to stokku_auth;
revoke all on function public.auth_members_of_tenant(uuid) from public;
grant execute on function public.auth_members_of_tenant(uuid) to stokku;
