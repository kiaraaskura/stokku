import type { Db } from './db-api'
import { uuidv7 } from '../lib/uuid'

/**
 * Local SQLite schema (T-201) mirroring the server tables we need for the
 * offline MVP (docs/DATA_MODEL.md subset). Migration version in PRAGMA user_version.
 *
 * Conventions:
 * - Money: INTEGER rupiah (BIGINT).
 * - Qty / factors: INTEGER milli-units (qty * 1000) — NUMERIC(14,3) without floats.
 * - IDs: UUIDv7 text, client-generated.
 * - Every mutation writes an outbox row with a UUIDv7 op_id in the same transaction.
 */

export const SCHEMA_VERSION = 3

const DDL = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tenant (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  tax_rate INTEGER NOT NULL DEFAULT 0,        -- basis points (percent * 100)
  business_type TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS outlet (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  name TEXT NOT NULL,
  timezone TEXT NOT NULL DEFAULT 'Asia/Jakarta'
);

CREATE TABLE IF NOT EXISTS category (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  sort INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS item (
  id TEXT PRIMARY KEY,
  sku TEXT,
  name TEXT NOT NULL,
  category_id TEXT,
  base_unit TEXT NOT NULL,
  sale_price INTEGER NOT NULL DEFAULT 0,
  cost_avg INTEGER NOT NULL DEFAULT 0,
  min_stock_m INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  deleted_at TEXT,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_item_sku ON item (sku) WHERE sku IS NOT NULL AND deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS item_barcode (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL REFERENCES item(id),
  barcode TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS item_unit (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL REFERENCES item(id),
  name TEXT NOT NULL,
  factor_m INTEGER NOT NULL CHECK (factor_m > 0)
);

CREATE TABLE IF NOT EXISTS stock_move (
  id TEXT PRIMARY KEY,
  outlet_id TEXT NOT NULL,
  item_id TEXT NOT NULL REFERENCES item(id),
  qty_m INTEGER NOT NULL CHECK (qty_m <> 0),
  unit_cost INTEGER,
  type TEXT NOT NULL CHECK (type IN ('in','sale','loss','return','adjust','transfer')),
  ref_type TEXT,
  ref_id TEXT,
  business_date TEXT NOT NULL,
  note TEXT,
  created_at TEXT NOT NULL,
  op_id TEXT
);

CREATE INDEX IF NOT EXISTS idx_stock_move_item_date ON stock_move (item_id, business_date, created_at);

CREATE TABLE IF NOT EXISTS stock_level (
  outlet_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  qty_m INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (outlet_id, item_id)
);

CREATE TABLE IF NOT EXISTS sale_number_seq (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  next_number INTEGER NOT NULL
);
INSERT OR IGNORE INTO sale_number_seq (singleton, next_number) VALUES (1, 1);

CREATE TABLE IF NOT EXISTS sale (
  id TEXT PRIMARY KEY,
  outlet_id TEXT NOT NULL,
  number INTEGER NOT NULL,
  total INTEGER NOT NULL,
  discount INTEGER NOT NULL DEFAULT 0,
  payment_method TEXT NOT NULL CHECK (payment_method IN ('cash','transfer','qris','credit')),
  paid INTEGER NOT NULL DEFAULT 1,
  mode TEXT NOT NULL DEFAULT 'per_item',
  business_date TEXT NOT NULL,
  voided_at TEXT,
  void_reason TEXT,
  note TEXT,
  op_id TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sale_date ON sale (business_date);

CREATE TABLE IF NOT EXISTS sale_line (
  id TEXT PRIMARY KEY,
  sale_id TEXT NOT NULL REFERENCES sale(id),
  item_id TEXT NOT NULL REFERENCES item(id),
  qty_m INTEGER NOT NULL CHECK (qty_m > 0),
  unit_price INTEGER NOT NULL,
  discount INTEGER NOT NULL DEFAULT 0,
  cost_at_sale INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS cash_entry (
  id TEXT PRIMARY KEY,
  outlet_id TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('in','out')),
  amount INTEGER NOT NULL CHECK (amount > 0),
  category TEXT NOT NULL,
  method TEXT,
  ref_type TEXT,
  ref_id TEXT,
  business_date TEXT NOT NULL,
  note TEXT,
  op_id TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_cash_date ON cash_entry (business_date);

CREATE TABLE IF NOT EXISTS outbox (
  op_id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  payload TEXT NOT NULL,
  client_ts TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  fail_reason TEXT
);

CREATE INDEX IF NOT EXISTS idx_outbox_status ON outbox (status);

-- v2: read-path cache of server responses (offline "last known numbers")
CREATE TABLE IF NOT EXISTS server_cache (
  key TEXT PRIMARY KEY,
  payload TEXT NOT NULL,
  fetched_at TEXT NOT NULL
);

-- v2: local id -> server id remapping for rows created offline
CREATE TABLE IF NOT EXISTS id_map (
  local_id TEXT PRIMARY KEY,
  server_id TEXT NOT NULL
);

-- v3: sync state — device id and pull cursor (server_seq watermark)
CREATE TABLE IF NOT EXISTS sync_state (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  device_id TEXT NOT NULL,
  cursor INTEGER NOT NULL DEFAULT 0,
  last_synced_at TEXT
);

-- v3: items that were changed by another device (LWW notice)
CREATE TABLE IF NOT EXISTS changed_elsewhere (
  item_id TEXT PRIMARY KEY,
  noticed_at TEXT NOT NULL
);

-- v3: rejected/conflicted ops surfaced to the "Perlu dicek" inbox
CREATE TABLE IF NOT EXISTS inbox (
  id TEXT PRIMARY KEY,             -- the outbox op_id
  kind TEXT NOT NULL,              -- 'rejected' | 'conflict'
  type TEXT NOT NULL,              -- op type
  payload TEXT NOT NULL,
  reason TEXT,
  title TEXT NOT NULL,
  created_at TEXT NOT NULL
);
`

/** Run pending migrations. Idempotent; safe to call on every open. */
export function migrate(db: Db): void {
  db.exec('PRAGMA foreign_keys = ON')
  const row = db.get<{ user_version: number }>('PRAGMA user_version')
  const current = row?.user_version ?? 0
  if (current >= SCHEMA_VERSION) return
  db.transaction(() => {
    db.exec(DDL)
    // v1 -> v2: outbox.fail_reason may already exist if a prior attempt half-ran.
    if (current >= 1 && current < 2) {
      try {
        db.exec('ALTER TABLE outbox ADD COLUMN fail_reason TEXT')
      } catch {
        // column already present
      }
    }
    // v3: seed the sync device id once.
    if (current < 3) {
      db.run('INSERT OR IGNORE INTO sync_state (singleton, device_id, cursor) VALUES (1, ?, 0)', [uuidv7()])
    }
    db.run(`PRAGMA user_version = ${SCHEMA_VERSION}`)
  })
}
