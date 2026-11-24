/**
 * SQLite worker (T-201): sql.js (SQLite compiled to WASM) with OPFS
 * persistence. Every mutating repo call is followed by a full flush of the
 * database file, so a kill at any point leaves a consistent committed state.
 *
 * Fallback: when OPFS is unavailable the database lives in memory only.
 */
/// <reference lib="webworker" />
import initSqlJs from 'sql.js'
import wasmUrl from 'sql.js/dist/sql-wasm.wasm?url'
import { makeDbAdapter, type Db } from './db-api'
import { migrate } from './schema'
import { repoMethods, MUTATING_METHODS, type RepoMethodName } from './repo'

type CallMsg = { kind: 'call'; id: number; method: RepoMethodName; args: unknown[] }
type OutMsg =
  | { kind: 'ready'; persisted: boolean }
  | { kind: 'reply'; id: number; ok: true; result: unknown }
  | { kind: 'reply'; id: number; ok: false; error: string }

interface Storage {
  kind: 'opfs' | 'memory'
  write: (data: Uint8Array) => void
}

const ctx = self as unknown as {
  onmessage: ((ev: MessageEvent<CallMsg>) => void) | null
  postMessage: (msg: OutMsg) => void
}

async function openStorage(): Promise<{ storage: Storage; existing: Uint8Array | null }> {
  try {
    const root = await navigator.storage.getDirectory()
    const dir = await root.getDirectoryHandle('stokku', { create: true })
    const file = await dir.getFileHandle('stokku.db', { create: true })
    const handle = await file.createSyncAccessHandle()
    const size = handle.getSize()
    let existing: Uint8Array | null = null
    if (size > 0) {
      const buf = new ArrayBuffer(size)
      handle.read(buf, { at: 0 })
      existing = new Uint8Array(buf)
    }
    return {
      existing,
      storage: {
        kind: 'opfs',
        write: (data) => {
          handle.truncate(0)
          handle.write(data, { at: 0 })
          handle.flush()
        },
      },
    }
  } catch {
    return { existing: null, storage: { kind: 'memory', write: () => {} } }
  }
}

async function main(): Promise<void> {
  const SQL = await initSqlJs({ locateFile: () => wasmUrl, useOldExtensionFunctions: true })
  const { storage, existing } = await openStorage()
  const sqlDb = existing && existing.length > 0 ? new SQL.Database(existing) : new SQL.Database()
  const db: Db = makeDbAdapter(sqlDb)
  migrate(db)

  ctx.onmessage = (ev: MessageEvent<CallMsg>) => {
    const msg = ev.data
    if (msg?.kind !== 'call') return
    try {
      const fn = repoMethods[msg.method] as (db: Db, ...args: unknown[]) => unknown
      const result = fn(db, ...msg.args)
      if (MUTATING_METHODS.has(msg.method)) {
        storage.write(sqlDb.export())
      }
      ctx.postMessage({ kind: 'reply', id: msg.id, ok: true, result })
    } catch (err) {
      ctx.postMessage({
        kind: 'reply',
        id: msg.id,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  ctx.postMessage({ kind: 'ready', persisted: storage.kind === 'opfs' })
}

void main()
