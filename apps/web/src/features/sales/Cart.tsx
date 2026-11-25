import { useNavigate } from 'react-router'
import { useEffect, useMemo, useState } from 'react'
import { useAppState } from '../../state/AppState'
import { useAuth } from '../../state/AuthState'
import { useI18n } from '../../i18n/I18nProvider'
import { Button, Badge } from '../../components/primitives'
import { CurrencyInput, Input } from '../../components/inputs'
import { Empty, ErrorView } from '../../components/state'
import { formatIDR, formatQty, qtyTimesUnitCost } from '../../lib/money'
import { todayISO } from '../../lib/date'
import { uuidv7 } from '../../lib/uuid'
import { remoteOrLocal, wireItemToLocal } from '../../api/gateway'
import { NetworkError, type ApiQrisSettings } from '../../api/types'
import type { Item, PaymentMethod } from '../../db/types'

interface CartLine {
  item: Item
  qtyM: number
  unitPrice: number
  discount: number
}

const PAYMENT_METHODS: { id: PaymentMethod; key: 'sell.payment.cash' | 'sell.payment.transfer' | 'sell.payment.qris' | 'sell.payment.credit' }[] = [
  { id: 'cash', key: 'sell.payment.cash' },
  { id: 'transfer', key: 'sell.payment.transfer' },
  { id: 'qris', key: 'sell.payment.qris' },
  { id: 'credit', key: 'sell.payment.credit' },
]

export function Cart() {
  const { repo, toast, refresh, online, apiMode, outlet, flushAgain } = useAppState()
  const { api } = useAuth()
  const { t } = useI18n()
  const navigate = useNavigate()
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<Item[]>([])
  const [lines, setLines] = useState<CartLine[]>([])
  const [discount, setDiscount] = useState(0)
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>('cash')
  const [paid, setPaid] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [negWarning, setNegWarning] = useState<string | null>(null)

  useEffect(() => {
    if (!repo) return
    const q = query.trim()
    if (q === '') {
      setResults([])
      return
    }
    let cancelled = false
    const timer = setTimeout(() => {
      const local = () => repo.call('searchItems', q)
      const finish = (wire: Item[] | { id: string; sku: string | null; name: string; base_unit: string; sale_price: number; cost_avg?: number; min_stock: number; stock: number; active: boolean; updated_at?: string }[]) => {
        if (!cancelled) setResults(apiMode ? wire.map((r) => wireItemToLocal(r as never)) : (wire as Item[]))
      }
      if (online && apiMode) {
        api
          .searchItems(q)
          .then(async (rows) => {
            await repo.call('applyServerItems', rows)
            finish(rows as never)
          })
          .catch(() => void local().then(finish))
      } else {
        void local().then(finish)
      }
    }, 100)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [repo, api, query, online, apiMode])

  const subtotal = useMemo(
    () => lines.reduce((sum, l) => sum + qtyTimesUnitCost(l.qtyM, l.unitPrice) - l.discount, 0),
    [lines],
  )
  const total = Math.max(0, subtotal - discount)

  // Pre-cache the outlet QR while the shopper picks QRIS, so the QR screen
  // opens instantly (and offline) after the sale posts.
  useEffect(() => {
    if (paymentMethod !== 'qris' || !repo || !outlet || !online || !apiMode) return
    void api
      .getQrisSettings(outlet.id)
      .then((fresh: ApiQrisSettings) => repo.call('setServerCache', `qris:${outlet.id}`, fresh))
      .catch(() => undefined)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paymentMethod, outlet?.id])

  const addItem = (item: Item) => {
    setQuery('')
    setResults([])
    setLines((prev) => {
      const existing = prev.find((l) => l.item.id === item.id)
      if (existing) {
        return prev.map((l) => (l.item.id === item.id ? { ...l, qtyM: l.qtyM + 1000 } : l))
      }
      return [...prev, { item, qtyM: 1000, unitPrice: item.salePrice, discount: 0 }]
    })
  }

  const updateLine = (itemId: string, patch: Partial<CartLine>) => {
    setLines((prev) => prev.map((l) => (l.item.id === itemId ? { ...l, ...patch } : l)))
  }

  const save = async () => {
    if (!repo || lines.length === 0) return
    setSaving(true)
    setError(null)
    setNegWarning(null)
    const negative = lines.filter((l) => l.qtyM > l.item.stockM)
    try {
      const t0 = performance.now()
      const salePaid = paymentMethod === 'credit' ? false : paid
      const { source, value } = await remoteOrLocal({
        online,
        session: apiMode,
        remote: () =>
          api.postSale({
            outlet_id: outlet?.id ?? '',
            business_date: todayISO(),
            customer_id: null,
            discount,
            payment_method: paymentMethod,
            // QRIS money arrives via the confirm call; unpaid here on purpose.
            paid: paymentMethod === 'qris' ? false : salePaid,
            note: null,
            lines: lines.map((l) => ({
              item_id: l.item.id,
              qty: l.qtyM / 1000,
              unit_price: l.unitPrice,
              discount: l.discount,
            })),
            op_id: uuidv7(),
          }),
        onRemoteSuccess: async (sale) => {
          await repo.call('applyServerSale', sale)
          for (const l of lines) {
            try {
              const fresh = await api.getItem(l.item.id)
              await repo.call('applyServerItems', [fresh])
            } catch {
              // read path refreshes on next screen load
            }
          }
        },
        local: () =>
          repo.call('postSale', {
            businessDate: todayISO(),
            discount,
            paymentMethod,
            paid: paymentMethod === 'qris' ? false : salePaid,
            note: null,
            lines: lines.map((l) => ({
              itemId: l.item.id,
              qtyM: l.qtyM,
              unitPrice: l.unitPrice,
              discount: l.discount,
            })),
          }),
      })
      const elapsed = performance.now() - t0
      if (negative.length > 0) {
        setNegWarning(
          t('sell.negativeStock') + ' (' + negative.map((l) => l.item.name).join(', ') + ')',
        )
      }
      if (source === 'server') {
        toast(`${t('sell.saved', { total: formatIDR(total) })} · ${t('common.serverData')} · ${(elapsed / 1000).toFixed(2)}s`)
      } else {
        flushAgain()
        toast(`${t('sell.saved', { total: formatIDR(total) })} · ${t('sync.queued')}`)
      }
      setLines([])
      setDiscount(0)
      setPaymentMethod('cash')
      setPaid(true)
      void refresh()
      if (paymentMethod === 'qris') {
        // QR screen: amount in hand so it renders instantly.
        navigate('/qris/' + String((value as { id?: string })?.id ?? ''), {
          state: { total, offlineSale: source === 'local' },
        })
      }
    } catch (err) {
      if (err instanceof NetworkError) setError(t('auth.networkError'))
      else setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="screen">
      <div className="screen__header">
        <h1 className="screen__title">{t('sell.title')}</h1>
      </div>

      <Input
        placeholder={t('sell.searchPlaceholder')}
        type="search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      {results.length > 0 && (
        <div className="card-list">
          {results.map((item) => (
            <button key={item.id} type="button" className="card-row" onClick={() => addItem(item)}>
              <div className="card-row__main">
                <span className="card-row__title">{item.name}</span>
                <span className="card-row__sub">
                  {t('items.inStock', { qty: formatQty(item.stockM) })} {item.baseUnit}
                </span>
              </div>
              <div className="card-row__end">
                <span>{formatIDR(item.salePrice)}</span>
                {item.stockM <= 0 ? <Badge tone="danger">{t('items.outOfStock')}</Badge> : null}
              </div>
            </button>
          ))}
        </div>
      )}

      {lines.length === 0 && results.length === 0 && (
        <Empty icon="🛒">{t('sell.cartEmpty')}</Empty>
      )}

      {lines.length > 0 && (
        <>
          <div className="stack" style={{ gap: 'var(--space-2)' }}>
            <div className="field__label">{t('sell.cart')}</div>
            {lines.map((l) => {
              const lowStock = l.qtyM > l.item.stockM
              return (
                <div key={l.item.id} className="card-list" style={{ border: '1px solid var(--color-border)', borderRadius: 'var(--radius-md)' }}>
                  <div className="card-row" style={{ cursor: 'default' }}>
                    <div className="card-row__main">
                      <span className="card-row__title">{l.item.name}</span>
                      <span className="card-row__sub">
                        {formatQty(l.qtyM)} {l.item.baseUnit} × {formatIDR(l.unitPrice)}
                        {lowStock ? ` · ${t('sell.insufficient', { qty: formatQty(l.item.stockM) })}` : ''}
                      </span>
                    </div>
                    <div className="card-row__end">
                      <span>{formatIDR(qtyTimesUnitCost(l.qtyM, l.unitPrice) - l.discount)}</span>
                    </div>
                  </div>
                  <div className="card-row" style={{ cursor: 'default', gap: 'var(--space-2)' }}>
                    <div className="stepper" role="group" aria-label={t('sell.qty')}>
                      <button
                        type="button"
                        className="stepper__btn"
                        aria-label="-"
                        onClick={() => updateLine(l.item.id, { qtyM: Math.max(0, l.qtyM - 1000) })}
                      >
                        −
                      </button>
                      <span className="stepper__value">{formatQty(l.qtyM)}</span>
                      <button
                        type="button"
                        className="stepper__btn"
                        aria-label="+"
                        onClick={() => updateLine(l.item.id, { qtyM: l.qtyM + 1000 })}
                      >
                        +
                      </button>
                    </div>
                    <div style={{ flex: 1 }} />
                    <Button variant="ghost" size="sm" onClick={() => setLines((prev) => prev.filter((x) => x.item.id !== l.item.id))}>
                      ✕
                    </Button>
                  </div>
                </div>
              )
            })}
          </div>

          <CurrencyInput label={t('sell.discount')} value={discount} onValueChange={(v) => setDiscount(Math.min(v, subtotal))} />

          <fieldset style={{ border: 'none', padding: 0, margin: 0 }}>
            <legend className="field__label">{t('sell.paymentMethod')}</legend>
            <div className="row" role="radiogroup" aria-label={t('sell.paymentMethod')}>
              {PAYMENT_METHODS.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  role="radio"
                  aria-checked={paymentMethod === m.id}
                  className={`btn btn--${paymentMethod === m.id ? 'primary' : 'secondary'} btn--sm`}
                  onClick={() => {
                    setPaymentMethod(m.id)
                    if (m.id === 'credit') setPaid(false)
                  }}
                >
                  {t(m.key)}
                </button>
              ))}
            </div>
          </fieldset>

          {paymentMethod === 'qris' && (
            <p className="muted" style={{ margin: 0, fontSize: 'var(--text-sm)' }}>
              {t('qris.payAfterScan')}
            </p>
          )}

          {paymentMethod !== 'credit' && paymentMethod !== 'qris' && (
            <label className="row" style={{ minHeight: 'var(--tap-target)', cursor: 'pointer' }}>
              <input type="checkbox" checked={paid} onChange={(e) => setPaid(e.target.checked)} style={{ width: 20, height: 20 }} />
              {paid ? t('sell.paid') : t('sell.unpaid')}
            </label>
          )}

          <div>
            <div className="total-line">
              <span>{t('common.total')}</span>
              <span className="num">{formatIDR(subtotal)}</span>
            </div>
            {discount > 0 && (
              <div className="total-line">
                <span>{t('sell.discount')}</span>
                <span className="num">−{formatIDR(discount)}</span>
              </div>
            )}
            <div className="total-line total-line--grand">
              <span>{t('sell.total')}</span>
              <span className="num">{formatIDR(total)}</span>
            </div>
          </div>

          {negWarning && (
            <p style={{ color: 'var(--color-warning)', margin: 0 }} role="status">
              {negWarning}
            </p>
          )}
          {error && <ErrorView message={error} onRetry={() => setError(null)} />}

          <Button block disabled={saving || lines.length === 0} onClick={() => void save()}>
            {t('sell.save')} · {formatIDR(total)}
          </Button>
        </>
      )}
    </div>
  )
}
