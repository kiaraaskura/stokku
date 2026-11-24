import { useEffect, useState } from 'react'
import { useAppState } from '../../state/AppState'
import { useI18n } from '../../i18n/I18nProvider'
import { Sheet } from '../../components/Sheet'
import { Badge } from '../../components/primitives'
import { Empty, ErrorView, Loading } from '../../components/state'
import { formatIDR } from '../../lib/money'
import { formatDate } from '../../lib/date'
import { currentMonth, formatMonth, recentMonths } from '../../lib/date'
import type { DrillRow, LabaRugi as LabaRugiData } from '../../db/types'

type DrillKind = 'revenue' | 'hpp' | 'opex' | null

export function LabaRugi() {
  const { repo } = useAppState()
  const { t, locale } = useI18n()
  const [month, setMonth] = useState(currentMonth())
  const [report, setReport] = useState<LabaRugiData | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [drill, setDrill] = useState<DrillKind>(null)
  const [drillRows, setDrillRows] = useState<DrillRow[] | null>(null)
  const [drillError, setDrillError] = useState<string | null>(null)

  const reload = () => {
    if (!repo) return
    setError(null)
    repo
      .call('labaRugi', month)
      .then(setReport)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
  }

  useEffect(reload, [repo, month])

  const openDrill = (kind: Exclude<DrillKind, null>) => {
    if (!repo) return
    setDrill(kind)
    setDrillRows(null)
    setDrillError(null)
    const method = kind === 'revenue' ? 'drillRevenue' : kind === 'hpp' ? 'drillHpp' : 'drillOpex'
    repo
      .call(method, month)
      .then(setDrillRows)
      .catch((err: unknown) => setDrillError(err instanceof Error ? err.message : String(err)))
  }

  const months = recentMonths(12)
  const hasData = report !== null && (report.revenue !== 0 || report.opex !== 0 || report.hpp !== 0)

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
