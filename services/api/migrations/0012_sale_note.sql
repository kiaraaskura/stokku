-- sale.note (ratified contract change, PRDTASK branch docs-ratify):
-- API_CONTRACT.md's POST /sales body carries a note field; the sale table
-- had nowhere to store it, so GET /v1/sales (which selects note) raised
-- 42703 and the handler returned 500. Additive only: nullable, no default.
-- The existing sale change_log trigger (0007) already covers the whole row,
-- and sale is already tenant-scoped by RLS (0008) — nothing else needed.

alter table sale add column note text;
