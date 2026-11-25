import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { openRepository, type Repository } from '../db/store'
import type { Outlet, Tenant } from '../db/types'
import { useAuth } from './AuthState'
import { runSync, type SyncRunResult } from '../sync/engine'

export type SyncStatus = 'synced' | 'pending' | 'error'

interface AppStateValue {
  ready: boolean
  statusLoaded: boolean
  /** Bumped after a sync applied server rows, so screens re-read the store. */
  dataTick: number
  repo: Repository | null
  persisted: boolean
  openError: string | null
  onboarded: boolean
  tenant: Tenant | null
  outlet: Outlet | null
  pendingOps: number
  inboxTotal: number
  online: boolean
  /** True when operating against the API with a confirmed session. */
  apiMode: boolean
  /** The real sync state, straight off the last run + queue. */
  syncStatus: SyncStatus
  syncError: string | null
  syncAgain: () => void
  refresh: () => Promise<void>
  toast: (message: string) => void
  toastMessage: string | null
}

const AppStateContext = createContext<AppStateValue | null>(null)

export function AppStateProvider({ children }: { children: ReactNode }) {
  const { api, session } = useAuth()
  const [repo, setRepo] = useState<Repository | null>(null)
  const [persisted, setPersisted] = useState(false)
  const [openError, setOpenError] = useState<string | null>(null)
  const [status, setStatus] = useState<{
    onboarded: boolean
    tenant: Tenant | null
    outlet: Outlet | null
    pendingOps: number
    inbox: number
  }>({ onboarded: false, tenant: null, outlet: null, pendingOps: 0, inbox: 0 })
  const [statusLoaded, setStatusLoaded] = useState(false)
  const [online, setOnline] = useState(() => (typeof navigator === 'undefined' ? true : navigator.onLine))
  const [toastMessage, setToastMessage] = useState<string | null>(null)
  const [dataTick, setDataTick] = useState(0)
  const [lastSyncResult, setLastSyncResult] = useState<SyncRunResult | null>(null)
  const toastTimer = useRef<number | null>(null)
  const syncing = useRef(false)
  const [syncTick, setSyncTick] = useState(0)
  const debounceTimer = useRef<number | null>(null)

  useEffect(() => {
    let cancelled = false
    openRepository()
      .then((r) => {
        if (cancelled) return
        setRepo(r)
        setPersisted(r.persisted)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setOpenError(err instanceof Error ? err.message : String(err))
      })
    return () => {
      cancelled = true
    }
  }, [])

  const refresh = useCallback(async () => {
    if (!repo) return
    try {
      const [onboarded, tenant, outlet, pendingOps, inbox] = await Promise.all([
        repo.call('isOnboarded'),
        repo.call('getTenant'),
        repo.call('getOutlet'),
        repo.call('pendingOutboxCount'),
        repo.call('inboxCount'),
      ])
      setStatus({ onboarded, tenant, outlet, pendingOps, inbox })
      setStatusLoaded(true)
    } catch {
      // keep the last good status; screens surface their own errors
    }
  }, [repo])

  useEffect(() => {
    void refresh()
  }, [refresh])

  // Bind the local store to the server identity whenever a session appears.
  useEffect(() => {
    if (!repo || !session) return
    void (async () => {
      try {
        await repo.call('setServerSession', session.tenant, session.outlet)
        await refresh()
      } catch {
        // surfaced by the next read
      }
    })()
  }, [repo, session, refresh])

  // On logout, wipe the cached tenant data so a different account starts clean.
  useEffect(() => {
    if (!repo) return
    void (async () => {
      if (!api.hasSession()) {
        const wasApiMode = (await repo.call('getServerCache', 'api:had-session') as { payload: unknown } | null)?.payload === true
        if (wasApiMode) {
          await repo.call('resetAll')
          await refresh()
        }
      }
    })()
  }, [repo, api, refresh])

  useEffect(() => {
    if (session) {
      void repo?.call('setServerCache', 'api:had-session', true)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.tenant.id])

  // Network state.
  useEffect(() => {
    const goOnline = () => setOnline(true)
    const goOffline = () => setOnline(false)
    window.addEventListener('online', goOnline)
    window.addEventListener('offline', goOffline)
    const onVisible = () => {
      if (document.visibilityState === 'visible') setSyncTick((t) => t + 1)
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      window.removeEventListener('online', goOnline)
      window.removeEventListener('offline', goOffline)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [])

  // One sync run: push batches then pull pages.
  const doSync = useCallback(async () => {
    if (!repo || syncing.current) return
    syncing.current = true
    try {
      const result = await runSync(repo, api, online)
      setLastSyncResult(result)
      await refresh()
      if (result.pulled > 0 || result.pushed > 0) {
        // server rows changed or were confirmed — screens re-read the store
        setDataTick((t) => t + 1)
      }
    } finally {
      syncing.current = false
    }
  }, [repo, api, online, refresh])

  // Triggers (docs/SYNC_INCREMENT.md): foreground/visibility, network regained,
  // session change, tick (mutation debounce + 15-min background), and at boot.
  useEffect(() => {
    void doSync()
  }, [doSync, session?.tenant.id, online, syncTick])

  // 15-minute background heartbeat.
  useEffect(() => {
    const timer = window.setInterval(() => setSyncTick((t) => t + 1), 15 * 60 * 1000)
    return () => window.clearInterval(timer)
  }, [])

  /**
   * Ask for a sync soon: 1 s debounce after a mutation (the queue may still be
   * filling), immediate for an explicit user request.
   */
  const syncAgain = useCallback((immediate = false) => {
    if (debounceTimer.current) window.clearTimeout(debounceTimer.current)
    if (immediate) {
      setSyncTick((t) => t + 1)
      return
    }
    debounceTimer.current = window.setTimeout(() => setSyncTick((t) => t + 1), 1000)
  }, [])

  const toast = useCallback((message: string) => {
    setToastMessage(message)
    if (toastTimer.current) window.clearTimeout(toastTimer.current)
    toastTimer.current = window.setTimeout(() => setToastMessage(null), 2600)
  }, [])

  // The dot only says synced when the queue is empty, we are in API mode,
  // the last run ended without an error, and the inbox is empty of rejects.
  const syncStatus: SyncStatus = useMemo(() => {
    if (!online) return 'pending'
    if (status.pendingOps > 0) return 'pending'
    if (!session) return 'pending' // local mode: nothing has been confirmed
    if (lastSyncResult && !lastSyncResult.ok) return 'error'
    if (status.inbox > 0) return 'error'
    return 'synced'
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [online, status.pendingOps, status.inbox, session, lastSyncResult])

  const value = useMemo<AppStateValue>(
    () => ({
      ready: repo !== null || openError !== null,
      statusLoaded,
      dataTick,
      repo,
      persisted,
      openError,
      onboarded: status.onboarded,
      tenant: status.tenant,
      outlet: status.outlet,
      pendingOps: status.pendingOps,
      inboxTotal: status.inbox,
      online,
      apiMode: session !== null,
      syncStatus,
      syncError: lastSyncResult?.error ?? null,
      syncAgain,
      refresh,
      toast,
      toastMessage,
    }),
    [repo, statusLoaded, status, dataTick, persisted, openError, online, session, syncStatus, lastSyncResult, syncAgain, refresh, toast, toastMessage],
  )

  return <AppStateContext.Provider value={value}>{children}</AppStateContext.Provider>
}

export function useAppState(): AppStateValue {
  const ctx = useContext(AppStateContext)
  if (!ctx) throw new Error('useAppState must be used inside AppStateProvider')
  return ctx
}
