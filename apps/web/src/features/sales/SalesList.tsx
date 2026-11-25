import { useEffect, useState } from 'react'
import { useAppState } from '../../state/AppState'
import { useAuth, useCapabilities } from '../../state/AuthState'
import { useI18n } from '../../i18n/I18nProvider'
import { Badge } from '../../components/primitives'
import { Empty, ErrorView, Loading } from '../../components/state'
import { formatIDR } from '../../lib/money'
import { formatDate, currentMonth, formatMonth, monthRange, recentMonths } from '../../lib/date'
import type { ApiSale } from '../../api/types'

interface SaleRow {
  id: string
  number: string
  businessDate: string
  total: number
  paymentMethod: string
  paid: boolean
  note: string | null
  voided: boolean
}

function toRow(s: ApiSale): SaleRow {
  return {
    id: s.id,
    number: s.number,
    businessDate: s.business_date,
    total: s.total,
    paymentMethod: s.payment_method,
    paid: s.paid,
    note: s.note ?? null,
    voided: s.voided_at !== null,
  }
}

/** Sales list: reads GET /sales when online; offline shows the last cached list plus queued local sales. */
export function SalesList(): React.ReactNode {
  const { repo, online, apiMode, dataTick } = useAppState()
  const { api } = useAuth()
  const { can } = useCapabilities()
  const { t, locale } = useI18n()
  const [month, setMonth] = useState(currentMonth())
  const [rows, setRows] = useState<SaleRow[] | null>(null)
  const [source, setSource] = useState<'server' | 'local'>('local')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!repo) return
    setError(null)
    const { from, to } = monthRange(month)
    const localFallback = async (): Promise<SaleRow[]> => {
      const cached = await repo.call('getServerCache', `sales:${month}`)
      const cachedRows = cached ? ((cached.payload as ApiSale[]).map(toRow) ?? []) : []
      const localRows = (await repo.call('listSalesLocal', month)).map((s) => ({
        id: s.id,
        number: `#${s.number}`,
        businessDate: s.businessDate,
        total: s.total,
        paymentMethod: s.paymentMethod,
        paid: s.paid,
        note: s.note,
        voided: s.voidedAt !== null,
      }))
      return [...cachedRows, ...localRows]
    }
    if (online && apiMode) {
      api
        .listSales(from, to)
        .then(async (sales) => {
          const mapped = sales.map(toRow)
          await repo.call('setServerCache', `sales:${month}`, sales)
          setRows(mapped)
          setSource('server')
        })
        .catch(() => {
          void localFallback().then((r) => {
            setRows(r)
            setSource('local')
          })
        })
    } else {
      void localFallback().then((r) => {
        setRows(r)
        setSource('local')
      })
    }
  }, [repo, api, month, online, apiMode, dataTick])

  const months = recentMonths(12)

  return (
    <div className="screen">
      <div className="screen__header">
        <h1 className="screen__title">{t('sales.title')}</h1>
        <div className="screen__actions">
          <span className="muted" style={{ fontSize: 'var(--text-xs)' }}>
            {source === 'server' ? t('common.serverData') : t('common.cachedData')}
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

      {error && <ErrorView message={error} onRetry={() => setError(null)} />}
      {!error && rows === null && <Loading />}

      {rows !== null && !error && (
        <>
          {rows.length === 0 ? (
            <Empty icon="🧾">{t('sales.empty')}</Empty>
          ) : (
            <div className="card-list">
              {rows.map((r) => (
                <div key={r.id} className="card-row" style={{ cursor: 'default' }}>
                  <div className="card-row__main">
                    <span className="card-row__title">
                      {r.number}
                      {r.note ? <span className="muted" style={{ fontWeight: 400 }}> · {r.note}</span> : null}
                    </span>
                    <span className="card-row__sub">
                      {formatDate(r.businessDate, locale)} · {t(`sell.payment.${r.paymentMethod}` as 'sell.payment.cash')}
                    </span>
                  </div>
                  <div className="card-row__end">
                    <span className="num">{formatIDR(r.total)}</span>
                    {r.voided ? (
                      <Badge tone="danger">void</Badge>
                    ) : !r.paid || r.paymentMethod === 'credit' ? (
                      <Badge tone="warning">{t('reports.creditSale')}</Badge>
                    ) : null}
                  </div>
                </div>
              ))}
            </div>
          )}
        </>
      )}
      {can('report.read') && (
        <p className="muted" style={{ margin: 0, fontSize: 'var(--text-xs)' }}>
          {source === 'server' ? 'HTTP GET /v1/sales' : t('common.cachedData')}
        </p>
      )}
    </div>
  )
}
