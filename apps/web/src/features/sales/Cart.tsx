import { useEffect, useMemo, useRef, useState } from 'react'
import { useAppState } from '../../state/AppState'
import { useI18n } from '../../i18n/I18nProvider'
import { Button, Badge } from '../../components/primitives'
import { CurrencyInput, Input } from '../../components/inputs'
import { Empty, ErrorView } from '../../components/state'
import { formatIDR, formatQty, qtyTimesUnitCost } from '../../lib/money'
import { todayISO } from '../../lib/date'
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
  const { repo, toast, refresh } = useAppState()
  const { t } = useI18n()
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<Item[]>([])
  const [lines, setLines] = useState<CartLine[]>([])
  const [discount, setDiscount] = useState(0)
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>('cash')
  const [paid, setPaid] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [negWarning, setNegWarning] = useState<string | null>(null)
  const timingRef = useRef<number>(0)

  useEffect(() => {
    if (!repo) return
    const q = query.trim()
    if (q === '') {
      setResults([])
      return
    }
    let cancelled = false
    const timer = setTimeout(() => {
      repo
        .call('searchItems', q)
        .then((items) => {
          if (!cancelled) setResults(items)
        })
        .catch(() => {
          if (!cancelled) setResults([])
        })
    }, 100)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [repo, query])

  const subtotal = useMemo(
    () => lines.reduce((sum, l) => sum + qtyTimesUnitCost(l.qtyM, l.unitPrice) - l.discount, 0),
    [lines],
  )
  const total = Math.max(0, subtotal - discount)

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
    try {
      const negative = lines.filter((l) => l.qtyM > l.item.stockM)
      timingRef.current = performance.now()
      await repo.call('postSale', {
        businessDate: todayISO(),
        discount,
        paymentMethod,
        paid: paymentMethod === 'credit' ? false : paid,
        note: null,
        lines: lines.map((l) => ({
          itemId: l.item.id,
          qtyM: l.qtyM,
          unitPrice: l.unitPrice,
          discount: l.discount,
        })),
      })
      const elapsed = performance.now() - timingRef.current
      if (negative.length > 0) {
        setNegWarning(
          t('sell.negativeStock') + ' (' + negative.map((l) => l.item.name).join(', ') + ')',
        )
      }
      toast(t('sell.saved', { total: formatIDR(total) }) + ` · ${elapsed < 1000 ? (elapsed / 1000).toFixed(2) : (elapsed / 1000).toFixed(2)}s`)
      setLines([])
      setDiscount(0)
      setPaymentMethod('cash')
      setPaid(true)
      void refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
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

          {paymentMethod !== 'credit' && (
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
