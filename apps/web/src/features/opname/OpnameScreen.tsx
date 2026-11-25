import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router'
import { useAppState } from '../../state/AppState'
import { useAuth } from '../../state/AuthState'
import { useI18n } from '../../i18n/I18nProvider'
import { Button, Badge } from '../../components/primitives'
import { Empty, ErrorView } from '../../components/state'
import { formatQty } from '../../lib/money'
import { NetworkError, type ApiOpnameSession } from '../../api/types'
import type { Item } from '../../db/types'

type Phase = 'idle' | 'counting' | 'review' | 'posted'

interface CountRow {
  itemId: string
  name: string
  systemQty: number
  counted: number | null
}

/**
 * Opname (B11): count mode with big numbers and auto-advance, system vs
 * counted side by side, variance review, then ONE atomic post. If the post
 * fails the counts are kept and no posted state is ever shown.
 */
export function OpnameScreen(): React.ReactNode {
  const { repo, outlet, online, apiMode, refresh, toast, dataTick } = useAppState()
  const { api } = useAuth()
  const { t } = useI18n()
  const navigate = useNavigate()
  const [phase, setPhase] = useState<Phase>('idle')
  const [session, setSession] = useState<ApiOpnameSession | null>(null)
  const [rows, setRows] = useState<CountRow[]>([])
  const [cursor, setCursor] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [starting, setStarting] = useState(false)
  const [posting, setPosting] = useState(false)
  const [postResult, setPostResult] = useState<{ posted: number } | null>(null)
  const [savingCounts, setSavingCounts] = useState(false)
  const itemsRef = useRef<Map<string, Item>>(new Map())
  const inputRef = useRef<HTMLInputElement>(null)

  // Names come from the item cache (server truth when online).
  useEffect(() => {
    if (!repo) return
    void repo
      .call('listItems', '', false)
      .then((items) => {
        itemsRef.current = new Map(items.map((i) => [i.id, i]))
        setRows((prev) => prev.map((r) => ({ ...r, name: itemsRef.current.get(r.itemId)?.name ?? r.name })))
      })
      .catch(() => undefined)
  }, [repo, dataTick])

  // Resume an open session after a reload (draft counts live in the local store).
  useEffect(() => {
    if (!repo || !online || !apiMode || !outlet || session) return
    void repo
      .call('getServerCache', 'opname:open')
      .then(async (cached) => {
        const draft = cached?.payload as { id?: string; counts?: Record<string, number | null> } | undefined
        if (!draft?.id) return
        try {
          const s = await api.getOpname(draft.id)
          if (s.status === 'open') {
            applySession(s, draft.counts ?? {})
          } else {
            await repo.call('setServerCache', 'opname:open', {})
          }
        } catch {
          // server unreachable or session gone; ignore
        }
      })
      .catch(() => undefined)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repo, online, apiMode, outlet?.id])

  const applySession = (s: ApiOpnameSession, counts?: Record<string, number | null>) => {
    setSession(s)
    const newRows: CountRow[] = (s.lines ?? []).map((l) => ({
      itemId: l.item_id,
      name: l.item_name ?? itemsRef.current.get(l.item_id)?.name ?? '…',
      systemQty: Number(l.system_qty ?? 0),
      counted: counts?.[l.item_id] ?? (l.counted_qty !== null && l.counted_qty !== undefined ? Number(l.counted_qty) : null),
    }))
    const firstUncounted = newRows.findIndex((r) => r.counted === null)
    setRows(newRows)
    setCursor(firstUncounted >= 0 ? firstUncounted : 0)
    setPhase('counting')
    setPostResult(null)
    requestAnimationFrame(() => inputRef.current?.focus())
  }

  const start = async () => {
    if (!outlet) return
    setStarting(true)
    setError(null)
    try {
      const s = await api.createOpname({ outlet_id: outlet.id })
      if (repo) await repo.call('setServerCache', 'opname:open', { id: s.id, counts: {} })
      applySession(s, {})
    } catch (err) {
      if (err instanceof NetworkError) setError(t('auth.networkError'))
      else setError(err instanceof Error ? err.message : String(err))
    } finally {
      setStarting(false)
    }
  }

  const persistDraft = async (counts: Record<string, number | null>, sessionId: string) => {
    if (!repo) return
    await repo.call('setServerCache', 'opname:open', { id: sessionId, counts }).catch(() => undefined)
  }

  const patchCounts = async (sessionId: string, lines: { item_id: string; counted_qty: number | null }[]) => {
    if (!online || !apiMode) return // offline: the draft is the record, the post needs the network anyway
    setSavingCounts(true)
    try {
      // the wire type wants plain numbers; null (uncounted) is simply skipped
      const wire = lines.filter((l) => l.counted_qty !== null).map((l) => ({ item_id: l.item_id, counted_qty: l.counted_qty as number }))
      if (wire.length > 0) await api.patchOpnameLines(sessionId, wire)
    } catch {
      // non-fatal: the draft keeps the counts; the post re-sends the truth
    } finally {
      setSavingCounts(false)
    }
  }

  const setCount = (index: number, value: number | null) => {
    setRows((prev) => {
      const next = prev.map((r, i) => (i === index ? { ...r, counted: value } : r))
      if (session) {
        const counts: Record<string, number | null> = {}
        for (const r of next) counts[r.itemId] = r.counted
        void persistDraft(counts, session.id)
        const line: { item_id: string; counted_qty: number } = { item_id: next[index]!.itemId, counted_qty: value ?? 0 }
        void patchCounts(session.id, [line])
      }
      return next
    })
  }

  const advance = () => {
    setRows((prev) => {
      // find next uncounted row after the cursor
      let next = cursor + 1
      while (next < prev.length && prev[next]!.counted !== null) next += 1
      const target = next < prev.length ? next : cursor
      setCursor(target)
      requestAnimationFrame(() => {
        const inputs = document.querySelectorAll<HTMLInputElement>('input[data-count-input]')
        inputs[target]?.focus()
        inputs[target]?.select()
      })
      return prev
    })
  }

  const varianceRows = useMemo(
    () => rows.filter((r) => r.counted !== null && Math.round(r.counted * 1000) !== Math.round(r.systemQty * 1000)),
    [rows],
  )
  const uncountedCount = rows.filter((r) => r.counted === null).length

  const post = async () => {
    if (!session) return
    setPosting(true)
    setError(null)
    try {
      // Send the final truth first (counts), then the atomic post.
      const lines = rows
        .filter((r) => r.counted !== null)
        .map((r) => ({ item_id: r.itemId, counted_qty: r.counted as number }))
      try {
        await api.patchOpnameLines(session.id, lines)
      } catch {
        // the post below is the authority; a failed patch will surface there
      }
      await api.postOpname(session.id)
      setPostResult({ posted: varianceRows.length })
      setPhase('posted')
      if (repo) {
        await repo.call('setServerCache', 'opname:open', {}).catch(() => undefined)
      }
      toast(t('opname.posted', { n: varianceRows.length }))
      void refresh()
      // refresh item stock from the server
      if (online && apiMode) {
        void api
          .listItems('')
          .then((items) => repo?.call('applyServerItems', items))
          .catch(() => undefined)
      }
    } catch (err) {
      // Post failed: keep every count, never pretend it posted.
      if (err instanceof NetworkError) setError(t('opname.postFailedOffline'))
      else setError(err instanceof Error ? err.message : String(err))
    } finally {
      setPosting(false)
    }
  }

  const finishCounting = () => {
    if (uncountedCount > 0) {
      setError(t('opname.uncountedLeft', { n: uncountedCount }))
      setPhase('counting')
      return
    }
    setError(null)
    setPhase('review')
  }

  return (
    <div className="screen">
      <div className="screen__header">
        <h1 className="screen__title">{t('opname.title')}</h1>
        <div className="screen__actions">
          <Link to="/barang" className="btn btn--secondary btn--sm">
            {t('common.close')}
          </Link>
        </div>
      </div>

      {error && <ErrorView message={error} onRetry={() => setError(null)} />}

      {phase === 'idle' && !error && (
        <>
          <Empty icon="📋" action={<Button disabled={starting} onClick={() => void start()}>{t('opname.start')}</Button>}>
            {t('opname.idleHint')}
          </Empty>
          <p className="muted" style={{ margin: 0, fontSize: 'var(--text-sm)' }}>
            {t('opname.idleNote')}
          </p>
        </>
      )}

      {phase === 'counting' && session && (
        <>
          <p className="muted" style={{ margin: 0 }}>
            {t('opname.progress', { done: rows.length - uncountedCount, total: rows.length })}
            {savingCounts ? ' · …' : ''}
          </p>
          <div className="card-list">
            {rows.map((r, i) => (
              <div
                key={r.itemId}
                className="card-row"
                style={{
                  cursor: 'default',
                  outline: i === cursor ? '2px solid var(--color-primary)' : 'none',
                  flexDirection: 'column',
                  alignItems: 'stretch',
                  gap: 'var(--space-2)',
                }}
              >
                <div className="row" style={{ justifyContent: 'space-between' }}>
                  <div className="card-row__main">
                    <span className="card-row__title">{r.name}</span>
                    <span className="card-row__sub">
                      {t('opname.system')}: {formatQty(Math.round(r.systemQty * 1000))}
                    </span>
                  </div>
                  {r.counted !== null && r.counted !== r.systemQty ? (
                    <Badge tone="warning">
                      Δ {formatQty(Math.round((r.counted - r.systemQty) * 1000))}
                    </Badge>
                  ) : r.counted !== null ? (
                    <Badge tone="success">✓</Badge>
                  ) : null}
                </div>
                <div className="row" style={{ justifyContent: 'space-between' }}>
                  <div className="stepper" role="group" aria-label={t('opname.counted')}>
                    <button
                      type="button"
                      className="stepper__btn"
                      aria-label={t('common.decrement')}
                      onClick={() => setCount(i, Math.max(0, (r.counted ?? 0) - 1))}
                    >
                      −
                    </button>
                    <input
                      data-count-input={i}
                      ref={i === cursor ? inputRef : undefined}
                      className="stepper__value"
                      style={{ border: 'none', background: 'transparent', minHeight: '44px', width: '110px', fontSize: 'var(--text-xl)' }}
                      inputMode="decimal"
                      value={r.counted === null ? '' : String(r.counted).replace('.', ',')}
                      placeholder="—"
                      onChange={(e) => {
                        const v = e.target.value.replace(',', '.')
                        setCount(i, v === '' ? null : Number(v))
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault()
                          advance()
                        }
                      }}
                    />
                    <button
                      type="button"
                      className="stepper__btn"
                      aria-label={t('common.increment')}
                      onClick={() => setCount(i, (r.counted ?? 0) + 1)}
                    >
                      +
                    </button>
                  </div>
                  {i === cursor && (
                    <Button variant="ghost" size="sm" onClick={advance}>
                      {t('opname.next')} ⏎
                    </Button>
                  )}
                </div>
              </div>
            ))}
          </div>
          <Button block onClick={finishCounting}>
            {t('opname.finish')}
          </Button>
        </>
      )}

      {phase === 'review' && session && (
        <>
          <p className="muted" style={{ margin: 0 }}>
            {t('opname.reviewHint')}
          </p>
          {varianceRows.length === 0 ? (
            <Empty icon="✅">{t('opname.noVariance')}</Empty>
          ) : (
            <div className="card-list">
              {varianceRows.map((r) => (
                <div key={r.itemId} className="card-row" style={{ cursor: 'default' }}>
                  <div className="card-row__main">
                    <span className="card-row__title">{r.name}</span>
                    <span className="card-row__sub">
                      {t('opname.system')}: {formatQty(Math.round(r.systemQty * 1000))} → {t('opname.counted')}:{' '}
                      {formatQty(Math.round((r.counted ?? 0) * 1000))}
                    </span>
                  </div>
                  <div className="card-row__end">
                    <Badge tone={r.counted !== null && r.counted < r.systemQty ? 'danger' : 'success'}>
                      {r.counted !== null && r.counted < r.systemQty ? '−' : '+'}
                      {formatQty(Math.round(Math.abs((r.counted ?? 0) - r.systemQty) * 1000))}
                    </Badge>
                  </div>
                </div>
              ))}
            </div>
          )}
          <div className="row">
            <Button variant="secondary" onClick={() => setPhase('counting')}>
              {t('common.back')}
            </Button>
            <Button disabled={posting} onClick={() => void post()}>
              {posting ? '…' : t('opname.post')}
            </Button>
          </div>
          <p className="muted" style={{ margin: 0, fontSize: 'var(--text-xs)' }}>
            {t('opname.atomicNote')}
          </p>
        </>
      )}

      {phase === 'posted' && postResult && (
        <>
          <Empty icon="✅" action={<Button onClick={() => navigate('/barang')}>{t('opname.backToItems')}</Button>}>
            {t('opname.posted', { n: postResult.posted })}
          </Empty>
        </>
      )}
    </div>
  )
}
