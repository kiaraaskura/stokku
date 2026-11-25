import { useEffect, useState } from 'react'
import { useAppState } from '../../state/AppState'
import { useAuth, useCapabilities } from '../../state/AuthState'
import { useI18n } from '../../i18n/I18nProvider'
import { Empty, Loading } from '../../components/state'
import { formatIDR } from '../../lib/money'
import { currentMonth, formatMonth, monthRange, recentMonths } from '../../lib/date'
import type { ApiSalesReportRow } from '../../api/types'

type GroupBy = 'day' | 'item' | 'category'

/** Sales report (T-404): GET /reports/sales grouped by day / item / category. */
export function SalesReport(): React.ReactNode {
  const { repo, online, apiMode, dataTick } = useAppState()
  const { api } = useAuth()
  const { role } = useCapabilities()
  const { t, locale } = useI18n()
  const [month, setMonth] = useState(currentMonth())
  const [groupBy, setGroupBy] = useState<GroupBy>('day')
  const [rows, setRows] = useState<ApiSalesReportRow[] | null>(null)
  const [source, setSource] = useState<'server' | 'local'>('local')

  useEffect(() => {
    if (!repo || role === 'staff') return
    const { from, to } = monthRange(month)
    const cacheKey = `report:sales:${month}:${groupBy}`
    const localRead = (): Promise<ApiSalesReportRow[] | null> =>
      repo.call('getServerCache', cacheKey).then((c) => (c ? (c.payload as ApiSalesReportRow[]) : null))
    if (online && apiMode) {
      api
        .salesReport(from, to, groupBy)
        .then(async (r) => {
          await repo.call('setServerCache', cacheKey, r)
          setRows(r)
          setSource('server')
        })
        .catch(() => {
          void localRead().then((r) => {
            setRows(r)
            setSource('local')
          })
        })
    } else {
      void localRead().then((r) => {
        setRows(r)
        setSource('local')
      })
    }
  }, [repo, api, month, groupBy, online, apiMode, dataTick, role])

  if (role === 'staff') {
    return (
      <div className="screen">
        <Empty icon="🔒">{t('auth.noAccess')}</Empty>
      </div>
    )
  }

  const label = (r: ApiSalesReportRow): string => {
    if (groupBy === 'day') return r.day ?? r.business_date ?? '?'
    if (groupBy === 'item') return r.item_name ?? r.item_id?.slice(0, 8) ?? '?'
    return r.category_name ?? r.category_id?.slice(0, 8) ?? '?'
  }
  const total = (rows ?? []).reduce((s, r) => s + (r.revenue ?? 0), 0)

  return (
    <div className="screen">
      <div className="screen__header">
        <h1 className="screen__title">{t('salesReport.title')}</h1>
        <div className="screen__actions">
          <span className="muted" style={{ fontSize: 'var(--text-xs)' }}>
            {source === 'server' ? t('common.serverData') : t('common.cachedData')}
          </span>
          <select className="input" style={{ width: 'auto' }} value={month} onChange={(e) => setMonth(e.target.value)} aria-label={t('reports.month')}>
            {recentMonths(12).map((m) => (
              <option key={m} value={m}>
                {formatMonth(m, locale)}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="row" role="radiogroup" aria-label={t('salesReport.groupBy')}>
        {(['day', 'item', 'category'] as GroupBy[]).map((g) => (
          <button
            key={g}
            type="button"
            role="radio"
            aria-checked={groupBy === g}
            className={`btn btn--${groupBy === g ? 'primary' : 'secondary'} btn--sm`}
            onClick={() => setGroupBy(g)}
          >
            {t(`salesReport.group_${g}` as 'salesReport.group_day')}
          </button>
        ))}
      </div>

      {rows === null && <Loading label={source === 'local' ? t('common.cachedData') : undefined} />}

      {rows !== null && rows.length === 0 && <Empty icon="🧾">{t('reports.empty')}</Empty>}

      {rows !== null && rows.length > 0 && (
        <>
          <div className="card-list">
            {rows.map((r, i) => (
              <div key={i} className="card-row" style={{ cursor: 'default' }}>
                <div className="card-row__main">
                  <span className="card-row__title">{label(r)}</span>
                  <span className="card-row__sub">
                    {t('sell.number', { n: r.sale_count ?? 0 })}
                    {r.daily_total_count ? ` · ${t('reports.dailyTotal')}: ${r.daily_total_count}` : ''}
                    {r.line_count !== undefined ? ` · ${r.line_count} baris` : ''}
                  </span>
                </div>
                <div className="card-row__end">
                  <span className="num">{formatIDR(r.revenue ?? 0)}</span>
                </div>
              </div>
            ))}
          </div>
          <div className="card-list" style={{ padding: 'var(--space-4)' }}>
            <div className="total-line total-line--grand">
              <span>{t('common.total')}</span>
              <span className="num">{formatIDR(total)}</span>
            </div>
          </div>
          <p className="muted" style={{ margin: 0, fontSize: 'var(--text-xs)' }}>
            {t('salesReport.totalNote')}
          </p>
        </>
      )}
    </div>
  )
}
