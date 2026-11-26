-- SECURITY FIX (captain's finding, seq 2156): sale_line had NO row-level
-- security — the only business table in public without it — because it
-- carries no tenant_id of its own (pure child of sale, standing decision).
-- Anything reading sale_line directly saw every tenant's lines (a fresh
-- tenant's account archive returned 49 foreign rows).
--
-- Fix: forced RLS with a parent-sale tenant check. No tenant_id column is
-- added; sale_line stays a pure child. The policy expression reads the
-- tenant setting exactly like the 0008 policies do
-- (nullif(current_setting('app.tenant_id', true), '')::uuid).
--
-- No recursion: the EXISTS subquery reads sale, whose own policy checks
-- only sale.tenant_id against the GUC — it never references sale_line, so
-- policy evaluation cannot cycle. The subquery runs under the querying
-- user's RLS, so the parent must also be visible to the caller — the check
-- is enforced twice (parent tenant match + parent RLS visibility).
-- INSERT path: a sale and its lines post in one transaction with the
-- tenant context set, so the parent is visible and WITH CHECK passes.

alter table sale_line enable row level security;
alter table sale_line force row level security;

create policy tenant_isolation on sale_line
  using (exists (
    select 1 from sale s
    where s.id = sale_line.sale_id
      and s.tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
  ))
  with check (exists (
    select 1 from sale s
    where s.id = sale_line.sale_id
      and s.tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
  ));
