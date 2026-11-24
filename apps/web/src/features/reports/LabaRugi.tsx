import { useEffect, useState } from 'react'
import { useAppState } from '../../state/AppState'
import { useAuth, useCapabilities } from '../../state/AuthState'
import { useI18n } from '../../i18n/I18nProvider'
import { Sheet } from '../../components/Sheet'
import { Badge } from '../../components/primitives'
import { Empty, ErrorView, Loading } from '../../components/state'
import { formatIDR } from '../../lib/money'
import { formatDate } from '../../lib/date'
import { currentMonth, formatMonth, monthRange, recentMonths } from '../../lib/date'
import type { ApiLabaRugi, ApiDrillRow } from '../../api/types'
import type { DrillRow, LabaRugi as LabaRugiData } from '../../db/types'

type DrillKind = 'revenue' | 'hpp' | 'opex' | null

export function LabaRugi() {
  const { repo, online, apiMode } = useAppState()
  const { api } = useAuth()
  const { role } = useCapabilities()
  const { t, locale } = useI18n()
  const [month, setMonth] = useState(currentMonth())
  const [report, setReport] = useState<LabaRugiData | null>(null)
  const [source, setSource] = useState<'server' | 'local'>('local')
  const [error, setError] = useState<string | null>(null)
  const [drill, setDrill] = useState<DrillKind>(null)
  const [drillRows, setDrillRows] = useState<DrillRow[] | null>(null)
  const [drillError, setDrillError] = useState<string | null>(null)

  const reload = () => {
    if (!repo) return
    setError(null)
    const { from, to } = monthRange(month)
    const localCompute = (): Promise<LabaRugiData> => repo.call('labaRugi', month)
    const localRead = (): Promise<LabaRugiData> =>
      repo
        .call('getServerCache', `report:${month}`)
        .then((cached) => (cached ? (cached.payload as LabaRugiData) : localCompute()))
    if (online && apiMode) {
      // The numbers come from the server, not the local computation.
      api
        .labaRugi(from, to)
        .then(async (res: ApiLabaRugi) => {
          const mapped: LabaRugiData = {
            month,
            revenue: res.revenue,
            hpp: res.hpp,
            grossProfit: res.gross_profit,
            opex: res.opex,
            netProfit: res.net_profit,
            unpaidRevenue: res.unpaid_revenue,
          }
          await repo.call('setServerCache', `report:${month}`, mapped)
          setReport(mapped)
          setSource('server')
        })
        .catch(() => {
          void localRead().then((r) => {
            setReport(r)
            setSource('local')
          })
        })
    } else {
      void localRead().then((r) => {
        setReport(r)
        setSource('local')
      })
    }
  }

  useEffect(reload, [repo, api, month, online, apiMode])

  const mapDrillRow = (r: ApiDrillRow): DrillRow => {
    const amount = Number(r.amount ?? r.total ?? 0)
    const label =
      typeof r.name === 'string'
        ? r.name
        : typeof r.number === 'string'
          ? r.number
          : typeof r.label === 'string'
            ? r.label
            : typeof r.category === 'string'
              ? r.category
              : '#'
    return {
      id: String(r.sale_id ?? r.id ?? r.label ?? Math.random()),
      label,
      sublabel:
        typeof r.qty === 'number' && typeof r.unit_cost === 'number'
          ? `${r.qty} × ${formatIDR(r.unit_cost)}`
          : typeof r.number === 'string' && typeof r.name === 'string'
            ? r.number
            : (r.note as string | null) ?? null,
      amount,
      flagged: r.unpaid === true ? 'unpaid' : r.mode === 'daily_total' ? 'daily_total' : (r.mode as string | null) ?? null,
      businessDate: String(r.business_date ?? ''),
    }
  }

  const openDrill = (kind: Exclude<DrillKind, null>) => {
    if (!repo) return
    setDrill(kind)
    setDrillRows(null)
    setDrillError(null)
    const localDrill = (): Promise<DrillRow[]> => {
      const method = kind === 'revenue' ? 'drillRevenue' : kind === 'hpp' ? 'drillHpp' : 'drillOpex'
      return repo.call(method, month)
    }
    if (online && apiMode) {
      api
        .drill(kind)
        .then(async (rows) => {
          await repo.call('setServerCache', `drill:${kind}:${month}`, rows)
          setDrillRows(rows.map(mapDrillRow))
        })
        .catch(() => {
          void localDrill().then(setDrillRows)
        })
    } else {
      repo
        .call('getServerCache', `drill:${kind}:${month}`)
        .then((cached) => {
          if (cached && Array.isArray(cached.payload)) setDrillRows((cached.payload as ApiDrillRow[]).map(mapDrillRow))
          else void localDrill().then(setDrillRows)
        })
        .catch(() => void localDrill().then(setDrillRows))
    }
  }

  const months = recentMonths(12)
  const hasData = report !== null && (report.revenue !== 0 || report.opex !== 0 || report.hpp !== 0)

  if (role === 'staff') {
    return (
      <div className="screen">
        <div className="screen__header">
          <h1 className="screen__title">{t('reports.title')}</h1>
        </div>
        <Empty icon="🔒">{t('auth.noAccess')}</Empty>
      </div>
    )
  }

  const lines: { key: string; label: string; amount: number; drill: DrillKind; strong?: boolean }[] = report
    ? [
        { key: 'revenue', label: t('reports.revenue'), amount: report.revenue, drill: 'revenue' },
        { key: 'hpp', label: t('reports.hpp'), amount: report.hpp, drill: 'hpp' },
        { key: 'gross', label: t('reports.gross'), amount: report.grossProfit, drill: null, strong: true },
        { key: 'opex', label: t('reports.opex'), amount: report.opex, drill: 'opex' },
        { key: 'net', label: t('reports.net'), amount: report.netProfit, drill: null, strong: true },
      ]
    : []

  const drillTitle =
    drill === 'revenue' ? t('reports.drillRevenue') : drill === 'hpp' ? t('reports.drillHpp') : t('reports.drillOpex')

  return (
    <div className="screen">
      <div className="screen__header">
        <h1 className="screen__title">{t('reports.title')}</h1>
        <div className="screen__actions">
          <span className="muted" style={{ fontSize: 'var(--text-xs)' }}>
            {source === 'server' ? t('common.serverData') : t('common.localData')}
          </span>
          <select className="input" style={{ width: 'auto' }} value={month} onChange={(e) => setMonth(e.target.value)} aria-label={t('reports.month')}>
            {months.map((m) => (
              <option key={m} value={m}>
                {formatMonth(m, locale)}
              </option>
            ))}
          </select>
        </div>
      </div>

      {error && <ErrorView message={error} onRetry={reload} />}
      {!error && report === null && <Loading />}

      {report && !error && (
        <>
          {!hasData ? (
            <Empty icon="📈">{t('reports.empty')}</Empty>
          ) : (
            <div className="card-list" style={{ padding: 'var(--space-2) var(--space-4) var(--space-4)' }}>
              {lines.map((line) => (
                <button
                  key={line.key}
                  type="button"
                  className="total-line"
                  style={{
                    background: 'none',
                    border: 'none',
                    borderTop: line.strong ? '2px solid var(--color-border-strong)' : 'none',
                    marginTop: line.strong ? 'var(--space-2)' : 0,
                    paddingTop: line.strong ? 'var(--space-3)' : 'var(--space-1)',
                    cursor: line.drill ? 'pointer' : 'default',
                    textAlign: 'left',
                    minHeight: 'var(--tap-target)',
                    font: 'inherit',
                    color: 'inherit',
                    width: '100%',
                  }}
                  onClick={() => line.drill && openDrill(line.drill)}
                  disabled={!line.drill}
                >
                  <span style={{ fontWeight: line.strong ? 700 : 400 }}>
                    {line.label}
                    {line.drill ? <span className="muted" aria-hidden="true"> ›</span> : null}
                  </span>
                  <span
                    className="num"
                    style={{
                      fontWeight: line.strong ? 700 : 600,
                      color:
                        line.key === 'net' && line.amount < 0
                          ? 'var(--color-danger)'
                          : line.key === 'revenue'
                            ? 'var(--color-success)'
                            : line.key === 'opex' || line.key === 'hpp'
                              ? 'var(--color-danger)'
                              : 'inherit',
                    }}
                  >
                    {formatIDR(line.amount)}
                  </span>
                </button>
              ))}
              {report.unpaidRevenue > 0 && (
                <p className="muted" style={{ margin: 'var(--space-2) 0 0', fontSize: 'var(--text-sm)' }}>
                  {t('reports.unpaid')}: {formatIDR(report.unpaidRevenue)}
                </p>
              )}
            </div>
          )}

          <p className="muted" style={{ margin: 0, fontSize: 'var(--text-sm)' }}>
            ℹ️ {t('reports.hppExplain')}
          </p>
        </>
      )}

      <Sheet open={drill !== null} title={drillTitle} onClose={() => setDrill(null)}>
        {drillError && <ErrorView message={drillError} />}
        {drillRows === null && !drillError && <Loading />}
        {drillRows !== null && (
          <>
            {drillRows.length === 0 ? (
              <Empty icon="🗂️">{t('common.emptyList')}</Empty>
            ) : (
              <div className="card-list">
                {drillRows.map((row) => (
                  <div key={row.id} className="card-row" style={{ cursor: 'default' }}>
                    <div className="card-row__main">
                      <span className="card-row__title">{row.label}</span>
                      <span className="card-row__sub">
                        {formatDate(row.businessDate, locale)}
                        {row.sublabel ? ` · ${row.sublabel}` : ''}
                      </span>
                    </div>
                    <div className="card-row__end">
                      <span className="num">{formatIDR(row.amount)}</span>
                      {row.flagged === 'unpaid' ? (
                        <Badge tone="warning">{t('reports.creditSale')}</Badge>
                      ) : row.flagged === 'daily_total' ? (
                        <Badge tone="neutral">{t('reports.dailyTotal')}</Badge>
                      ) : null}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </Sheet>
    </div>
  )
}
