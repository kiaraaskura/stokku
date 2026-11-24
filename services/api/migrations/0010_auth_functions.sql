-- Auth helpers for login/refresh under forced RLS (PRDTASK decision, seq 464).
-- At login/refresh neither app.user_id nor app.tenant_id is known yet, so
-- the RLS policies return 0 rows. These SECURITY DEFINER functions are the
-- only sanctioned pre-auth reads/writes; everything after goes through
-- set_app_context() + the normal policies.
--
-- SECURITY MODEL
--   * Definer role stokku_auth: NOLOGIN, BYPASSRLS, and *nothing else* —
--     no table rights except SELECT on user_app and SELECT/UPDATE on
--     refresh_token, no memberships, no grants to anyone. It exists only
--     to own these three functions, so the definer identity can cross the
--     forced RLS it exists to serve. It is NOT granted to any role, so
--     nobody can SET ROLE to it.
--   * SECURITY DEFINER alone would NOT be enough: the app role stokku owns
--     the tables on a locally migrated database, and FORCED RLS binds even
--     the table owner. The dedicated definer role is what makes the
--     functions actually able to read before a tenant/user context exists.
--   * This migration must run as a superuser (as compose and CI already
--     do — only a superuser can grant BYPASSRLS). It fails loudly otherwise.
--   * search_path pinned to public, pg_temp on every function.
--   * EXECUTE: the app role stokku only (revoked from PUBLIC).
--   * Each function touches only the row(s) named by its argument. SELECTs
--     never fire change_log/audit triggers (and refresh_token has none),
--     so these stay out of the sync feed, like refresh_token itself.

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'stokku_auth') then
    create role stokku_auth nologin;
  end if;
  if (select rolsuper from pg_roles where rolname = current_user) then
    alter role stokku_auth bypassrls;
  end if;
  if not (select rolbypassrls from pg_roles where rolname = 'stokku_auth') then
    raise exception
      'migration 0010 needs a superuser runner: only a superuser can grant BYPASSRLS to stokku_auth (compose and CI run migrations as the superuser already)';
  end if;
  alter role stokku_auth nologin;  -- idempotent re-assertion
end
$$;

-- least privilege for the definer: read users, read + revoke refresh tokens
grant select on public.user_app to stokku_auth;
grant select, update on public.refresh_token to stokku_auth;

-- the row needed to verify a login password: id, password_hash, name
create function public.auth_find_user(p_email text)
returns table (id uuid, password_hash text, name text)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select u.id, u.password_hash, u.name
  from public.user_app u
  where u.email = p_email::citext;
$$;

-- the refresh-token row for an exactly-once rotation / reuse check
create function public.auth_lookup_refresh(p_token_hash text)
returns table (id uuid, user_id uuid, tenant_id uuid,
               expires_at timestamptz, rotated_at timestamptz, revoked_at timestamptz)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select r.id, r.user_id, r.tenant_id, r.expires_at, r.rotated_at, r.revoked_at
  from public.refresh_token r
  where r.token_hash = p_token_hash;
$$;

-- reuse detection: revoke every still-active token of the given user
create function public.auth_revoke_tokens(p_user_id uuid)
returns void
language sql
volatile
security definer
set search_path = public, pg_temp
as $$
  update public.refresh_token r
     set revoked_at = coalesce(r.revoked_at, now())
   where r.user_id = p_user_id
     and r.revoked_at is null;
$$;

-- the definer role owns the functions, not the migration runner
alter function public.auth_find_user(text) owner to stokku_auth;
alter function public.auth_lookup_refresh(text) owner to stokku_auth;
alter function public.auth_revoke_tokens(uuid) owner to stokku_auth;

revoke all on function public.auth_find_user(text) from public;
revoke all on function public.auth_lookup_refresh(text) from public;
revoke all on function public.auth_revoke_tokens(uuid) from public;

grant execute on function public.auth_find_user(text)      to stokku;
grant execute on function public.auth_lookup_refresh(text) to stokku;
grant execute on function public.auth_revoke_tokens(uuid)  to stokku;
