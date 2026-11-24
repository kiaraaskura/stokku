import { useEffect, useState } from 'react'
import { useAppState } from '../../state/AppState'
import { useI18n } from '../../i18n/I18nProvider'
import { Button, Badge } from '../../components/primitives'
import { Sheet } from '../../components/Sheet'
import { CurrencyInput, Input } from '../../components/inputs'
import { Empty, ErrorView, Loading } from '../../components/state'
import { formatIDR } from '../../lib/money'
import { formatDate } from '../../lib/date'
import { translate, type MessageKey } from '../../i18n/messages'
import { currentMonth, formatMonth, recentMonths, todayISO } from '../../lib/date'
import type { CashBookPage } from '../../db/repo'
import type { CashEntryInput } from '../../db/types'

const METHODS = ['cash', 'transfer', 'qris'] as const

function categoryLabel(category: string, locale: 'id' | 'en'): string {
  const key = `cash.category.${category}` as MessageKey
  const val = translate(locale, key)
  return val === key ? category : val
}

export function CashBook() {
  const { repo, toast, refresh } = useAppState()
  const { t, locale } = useI18n()
  const [month, setMonth] = useState(currentMonth())
  const [page, setPage] = useState<CashBookPage | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [sheetOpen, setSheetOpen] = useState(false)

  const reload = () => {
    if (!repo) return
    repo
      .call('listCashEntries', month)
      .then(setPage)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
  }

  useEffect(reload, [repo, month])

  const months = recentMonths(12)

  return (
    <div className="screen">
      <div className="screen__header">
        <h1 className="screen__title">{t('cash.title')}</h1>
        <div className="screen__actions">
          <select className="input" style={{ width: 'auto' }} value={month} onChange={(e) => setMonth(e.target.value)} aria-label={t('reports.month')}>
            {months.map((m) => (
              <option key={m} value={m}>
                {formatMonth(m, locale)}
              </option>
            ))}
          </select>
          <Button onClick={() => setSheetOpen(true)}>+ {t('cash.addOut')}</Button>
        </div>
      </div>

      {error && <ErrorView message={error} onRetry={reload} />}
      {!error && page === null && <Loading />}

      {page && !error && (
        <>
          {page.entries.length === 0 ? (
            <Empty icon="💵">{t('cash.empty')}</Empty>
          ) : (
            <div className="card-list">
              {page.entries.map((e) => (
                <div key={e.id} className="card-row" style={{ cursor: 'default' }}>
                  <div className="card-row__main">
                    <span className="card-row__title">
                      {e.direction === 'in' ? '↑ ' : '↓ '}
                      {categoryLabel(e.category, locale)}
                      {e.note ? <span className="muted" style={{ fontWeight: 400 }}> · {e.note}</span> : null}
                    </span>
                    <span className="card-row__sub">
                      {formatDate(e.businessDate, locale)}
                      {e.refType === 'sale' ? ` · ${t('cash.autoSale')}` : ''}
                    </span>
                  </div>
                  <div className="card-row__end">
                    <span
                      style={{
                        color: e.direction === 'in' ? 'var(--color-success)' : 'var(--color-danger)',
                        fontWeight: 600,
                      }}
                    >
                      {e.direction === 'in' ? '+' : '−'}
                      {formatIDR(e.amount)}
                    </span>
                    {e.category === 'pembelian_stok' ? <Badge tone="neutral">{t('reports.hppExplain').split('.')[0]}</Badge> : null}
                  </div>
                </div>
              ))}
            </div>
          )}

          <div className="card-list" style={{ padding: 'var(--space-4)', gap: 'var(--space-2)' }}>
            <div className="total-line">
              <span>{t('cash.totalIn')}</span>
              <span className="num" style={{ color: 'var(--color-success)', fontWeight: 600 }}>
                +{formatIDR(page.totalIn)}
              </span>
            </div>
            <div className="total-line">
              <span>{t('cash.totalOut')}</span>
              <span className="num" style={{ color: 'var(--color-danger)', fontWeight: 600 }}>
                −{formatIDR(page.totalOut)}
              </span>
            </div>
            <div className="total-line total-line--grand">
              <span>{t('cash.net')}</span>
              <span className="num">{formatIDR(page.net)}</span>
            </div>
          </div>
        </>
      )}

      <CashEntrySheet
        open={sheetOpen}
        onClose={() => setSheetOpen(false)}
        onSaved={() => {
          setSheetOpen(false)
          reload()
          void refresh()
          toast(t('cash.saved'))
        }}
      />
    </div>
  )
}

function CashEntrySheet({ open, onClose, onSaved }: { open: boolean; onClose: () => void; onSaved: () => void }) {
  const { repo } = useAppState()
  const { t, locale } = useI18n()
  const [direction, setDirection] = useState<'in' | 'out'>('out')
  const [amount, setAmount] = useState(0)
  const [category, setCategory] = useState('listrik')
  const [method, setMethod] = useState<'cash' | 'transfer' | 'qris'>('cash')
  const [note, setNote] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (open) {
      setAmount(0)
      setDirection('out')
      setCategory('listrik')
      setMethod('cash')
      setNote('')
      setError(null)
    }
  }, [open])

  const save = async () => {
    if (!repo) return
    if (amount <= 0) {
      setError(t('cash.amount'))
      return
    }
    setSaving(true)
    const input: CashEntryInput = {
      direction,
      amount,
      category,
      method,
      businessDate: todayISO(),
      note: note.trim() === '' ? null : note.trim(),
      refType: null,
      refId: null,
    }
    try {
      await repo.call('addCashEntry', input)
      // Keep the entry visible even if the picked month differs.
      onSaved()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  const categories = ['modal', 'penjualan', 'pembelian_stok', 'listrik', 'sewa', 'gaji', 'transport', 'lain']

  return (
    <Sheet open={open} title={direction === 'in' ? t('cash.addIn') : t('cash.addOut')} onClose={onClose}>
      <div role="radiogroup" aria-label={t('cash.direction')} className="row">
        {(['in', 'out'] as const).map((d) => (
          <button
            key={d}
            type="button"
            role="radio"
            aria-checked={direction === d}
            className={`btn btn--${direction === d ? 'primary' : 'secondary'} btn--sm`}
            onClick={() => setDirection(d)}
          >
            {d === 'in' ? t('cash.in') : t('cash.out')}
          </button>
        ))}
      </div>
      <CurrencyInput label={t('cash.amount')} value={amount} onValueChange={setAmount} autoFocus />
      <div className="field">
        <label className="field__label" htmlFor="cash-category">
          {t('cash.category')}
        </label>
        <select id="cash-category" className="input" value={category} onChange={(e) => setCategory(e.target.value)}>
          {categories.map((c) => (
            <option key={c} value={c}>
              {categoryLabel(c, locale)}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label className="field__label" htmlFor="cash-method">
          {t('cash.method')}
        </label>
        <select id="cash-method" className="input" value={method} onChange={(e) => setMethod(e.target.value as typeof method)}>
          {METHODS.map((m) => (
            <option key={m} value={m}>
              {t(`sell.payment.${m}` as 'sell.payment.cash')}
            </option>
          ))}
        </select>
      </div>
      <Input label={t('cash.note')} value={note} onChange={(e) => setNote(e.target.value)} />
      {error && (
        <p style={{ color: 'var(--color-danger)', margin: 0 }} role="alert">
          {error}
        </p>
      )}
      <Button block disabled={saving || amount <= 0} onClick={() => void save()}>
        {t('common.save')}
      </Button>
    </Sheet>
  )
}
