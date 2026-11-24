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
  | { kind: 'ready'; persisted: boolean; mode: StorageMode }
  | { kind: 'reply'; id: number; ok: true; result: unknown }
  | { kind: 'reply'; id: number; ok: false; error: string }

type StorageMode = 'opfs-sync' | 'opfs-writable' | 'memory'

interface Storage {
  kind: 'opfs' | 'memory'
  mode: StorageMode
  write: (data: Uint8Array) => void | Promise<void>
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
    // Read any existing database before taking a handle.
    const blob = await file.getFile()
    const existing = blob.size > 0 ? new Uint8Array(await blob.arrayBuffer()) : null
    // Fast path: sync access handle (where supported).
    try {
      const handle = await file.createSyncAccessHandle()
      return {
        existing,
        storage: {
          kind: 'opfs',
          mode: 'opfs-sync',
          write: (data) => {
            handle.truncate(0)
            handle.write(data, { at: 0 })
            handle.flush()
          },
        },
      }
    } catch {
      // Fallback: standard FileSystemWritableFileStream (async, serialized).
      let chain: Promise<void> = Promise.resolve()
      return {
        existing,
        storage: {
          kind: 'opfs',
          mode: 'opfs-writable',
          write: (data) => {
            chain = chain
              .then(async () => {
                const writable = await file.createWritable()
                await writable.write(data as unknown as FileSystemWriteChunkType)
                await writable.close()
              })
              .catch((err: unknown) => {
                // A failed flush must be visible, not silent.
                const name = err instanceof DOMException ? `${err.name} (${err.code})` : String(err)
                console.error('[stokku] OPFS flush failed:', name, err)
              })
            return chain
          },
        },
      }
    }
  } catch {
    return { existing: null, storage: { kind: 'memory', mode: 'memory', write: () => {} } }
  }
}

async function main(): Promise<void> {
  const SQL = await initSqlJs({ locateFile: () => wasmUrl, useOldExtensionFunctions: true })
  const { storage, existing } = await openStorage()
  const sqlDb = existing && existing.length > 0 ? new SQL.Database(existing) : new SQL.Database()
  const db: Db = makeDbAdapter(sqlDb)
  migrate(db)

  ctx.onmessage = async (ev: MessageEvent<CallMsg>) => {
    const msg = ev.data
    if (msg?.kind !== 'call') return
    try {
      const fn = repoMethods[msg.method] as (db: Db, ...args: unknown[]) => unknown
      const result = fn(db, ...msg.args)
      if (MUTATING_METHODS.has(msg.method)) {
        // Flush before replying so the caller never sees a save that is not yet durable.
        await storage.write(sqlDb.export())
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

  ctx.postMessage({ kind: 'ready', persisted: storage.kind === 'opfs', mode: storage.mode })
}

void main()
