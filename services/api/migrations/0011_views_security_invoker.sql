-- Views must isolate tenants in the compose/CI model too.
--
-- When migrations run as the superuser (compose, CI, and the dev path since
-- scripts/migrate.sh elevated the runner), the report views are owned by
-- that superuser — and a view normally executes with its OWNER's rights,
-- so the underlying forced RLS policies never applied: any tenant could
-- read every tenant's numbers through v_laba_rugi. Caught by verify.sql's
-- cross-tenant check on a freshly migrated database.
--
-- security_invoker (PG15+) makes the views run with the querying role's
-- rights, so the app.tenant_id policies apply exactly as they do for the
-- base tables. No behavior change where the app role already owned the
-- views (locally migrated databases): same rows, same numbers.

alter view v_revenue  set (security_invoker = true);
alter view v_hpp      set (security_invoker = true);
alter view v_opex     set (security_invoker = true);
alter view v_laba_rugi set (security_invoker = true);
