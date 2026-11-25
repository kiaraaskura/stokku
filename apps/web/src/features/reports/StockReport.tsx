import { useEffect, useState } from 'react'
import { useAppState } from '../../state/AppState'
import { useAuth, useCapabilities } from '../../state/AuthState'
import { useI18n } from '../../i18n/I18nProvider'
import { Badge } from '../../components/primitives'
import { Empty, ErrorView, Loading } from '../../components/state'
import { formatIDR, formatQty } from '../../lib/money'
import { formatDate } from '../../lib/date'
import type { ApiStockReport } from '../../api/types'

/** Stock report (T-403): values at cost/sale, low-stock and dead-stock lists, from GET /reports/stock. */
export function StockReport(): React.ReactNode {
  const { repo, outlet, online, apiMode, dataTick } = useAppState()
  const { api } = useAuth()
  const { role } = useCapabilities()
  const { t, locale } = useI18n()
  const [report, setReport] = useState<ApiStockReport | null>(null)
  const [source, setSource] = useState<'server' | 'local'>('local')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!repo || !outlet || role === 'staff') return
    setError(null)
    const localRead = (): Promise<ApiStockReport | null> =>
      repo.call('getServerCache', `report:stock:${outlet.id}`).then((c) => (c ? (c.payload as ApiStockReport) : null))
    if (online && apiMode) {
      api
        .stockReport(outlet.id)
        .then(async (r) => {
          await repo.call('setServerCache', `report:stock:${outlet.id}`, r)
          setReport(r)
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
  }, [repo, api, outlet, online, apiMode, dataTick, role])

  if (role === 'staff') {
    return (
      <div className="screen">
        <Empty icon="🔒">{t('auth.noAccess')}</Empty>
      </div>
    )
  }

  const rowName = (r: { item_id?: string; item_name?: string; name?: string }): string =>
    r.item_name ?? r.name ?? r.item_id?.slice(0, 8) ?? '?'

  return (
    <div className="screen">
      <div className="screen__header">
        <h1 className="screen__title">{t('stockReport.title')}</h1>
        <div className="screen__actions">
          <span className="muted" style={{ fontSize: 'var(--text-xs)' }}>
            {source === 'server' ? t('common.serverData') : t('common.cachedData')}
          </span>
        </div>
      </div>

      {error && <ErrorView message={error} />}
      {!error && report === null && <Loading label={source === 'local' ? t('common.cachedData') : undefined} />}

      {report && !error && (
        <>
          <div className="card-list" style={{ padding: 'var(--space-4)', gap: 'var(--space-2)' }}>
            <div className="total-line">
              <span>{t('stockReport.atCost')}</span>
              <span className="num">{formatIDR(report.at_cost ?? 0)}</span>
            </div>
            <div className="total-line">
              <span>{t('stockReport.atSale')}</span>
              <span className="num">{formatIDR(report.at_sale ?? 0)}</span>
            </div>
          </div>

          <h2 style={{ margin: 0, fontSize: 'var(--text-lg)' }}>
            {t('stockReport.allItems')} ({report.data?.length ?? 0})
          </h2>
          {(report.data?.length ?? 0) === 0 ? (
            <Empty icon="📦">{t('common.emptyList')}</Empty>
          ) : (
            <div className="card-list">
              {report.data.map((r) => (
                <div key={r.item_id ?? rowName(r)} className="card-row" style={{ cursor: 'default' }}>
                  <div className="card-row__main">
                    <span className="card-row__title">{rowName(r)}</span>
                    <span className="card-row__sub">
                      {t('opname.system')}: {formatQty(Math.round((r.qty ?? 0) * 1000))} ·{' '}
                      {r.last_movement_date ? formatDate(r.last_movement_date, locale) : t('stockReport.neverMoved')}
                    </span>
                  </div>
                  <div className="card-row__end">
                    <span className="num">{formatIDR(r.value_at_cost ?? 0)}</span>
                    {(r.qty ?? 0) < 0 ? (
                      <Badge tone="danger">{t('items.outOfStock')}</Badge>
                    ) : r.low_stock ? (
                      <Badge tone="warning">{t('items.lowStock')}</Badge>
                    ) : r.dead_stock ? (
                      <Badge tone="neutral">{t('stockReport.deadStock')}</Badge>
                    ) : null}
                  </div>
                </div>
              ))}
            </div>
          )}

          <h2 style={{ margin: 0, fontSize: 'var(--text-lg)' }}>
            {t('stockReport.lowStock')} ({report.low_stock?.length ?? 0})
          </h2>
          {(report.low_stock?.length ?? 0) === 0 ? (
            <Empty icon="✅">{t('common.emptyList')}</Empty>
          ) : (
            <div className="card-list">
              {report.low_stock.map((r) => (
                <div key={r.item_id ?? rowName(r)} className="card-row" style={{ cursor: 'default' }}>
                  <div className="card-row__main">
                    <span className="card-row__title">{rowName(r)}</span>
                    <span className="card-row__sub">
                      {t('opname.system')}: {formatQty(Math.round((r.qty ?? 0) * 1000))} · min{' '}
                      {formatQty(Math.round((r.min_stock ?? 0) * 1000))}
                    </span>
                  </div>
                  <div className="card-row__end">
                    <Badge tone={(r.qty ?? 0) < 0 ? 'danger' : 'warning'}>
                      {(r.qty ?? 0) < 0 ? t('items.outOfStock') : t('items.lowStock')}
                    </Badge>
                  </div>
                </div>
              ))}
            </div>
          )}

          <h2 style={{ margin: 0, fontSize: 'var(--text-lg)' }}>
            {t('stockReport.deadStock')} ({report.dead_stock?.length ?? 0})
          </h2>
          {(report.dead_stock?.length ?? 0) === 0 ? (
            <Empty icon="🗑️">{t('common.emptyList')}</Empty>
          ) : (
            <div className="card-list">
              {report.dead_stock.map((r) => (
                <div key={(r.item_id ?? rowName(r)) + 'dead'} className="card-row" style={{ cursor: 'default' }}>
                  <div className="card-row__main">
                    <span className="card-row__title">{rowName(r)}</span>
                    <span className="card-row__sub">
                      {r.last_movement_date ? formatDate(r.last_movement_date, locale) : t('stockReport.neverMoved')}
                    </span>
                  </div>
                  <div className="card-row__end">
                    <span className="num">{formatIDR(r.value_at_cost ?? 0)}</span>
                  </div>
                </div>
              ))}
            </div>
          )}
          <p className="muted" style={{ margin: 0, fontSize: 'var(--text-xs)' }}>
            {t('stockReport.deadStockHint')}
          </p>
        </>
      )}
    </div>
  )
}
