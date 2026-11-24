import { useEffect, useState } from 'react'
import { useAppState } from '../../state/AppState'
import { useI18n } from '../../i18n/I18nProvider'
import { Sheet } from '../../components/Sheet'
import { Button } from '../../components/primitives'
import { CurrencyInput, Input, QtyInput } from '../../components/inputs'
import { formatIDR, formatQty, qtyTimesUnitCost } from '../../lib/money'
import { todayISO } from '../../lib/date'
import type { Item } from '../../db/types'

/**
 * 3-tap stock-in (T-213): tap "Stok masuk" on a row → qty (defaults to 1, +/− buttons)
 * → cost (prefilled with the current average cost) → Simpan. Works fully offline.
 */
export function StockInSheet({
  item,
  onClose,
  onSaved,
}: {
  item: Item | null
  onClose: () => void
  onSaved: () => void
}) {
  const { repo, toast } = useAppState()
  const { t } = useI18n()
  const [qtyM, setQtyM] = useState(1000)
  const [cost, setCost] = useState(0)
  const [note, setNote] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (item) {
      setQtyM(1000)
      setCost(item.costAvg)
      setNote('')
      setError(null)
    }
  }, [item])

  if (!item) return null

  const save = async () => {
    if (!repo) return
    if (qtyM <= 0) {
      setError(t('common.required'))
      return
    }
    setSaving(true)
    try {
      await repo.call('stockIn', {
        itemId: item.id,
        qtyM,
        unitCost: cost,
        businessDate: todayISO(),
        note: note.trim() === '' ? null : note.trim(),
        supplier: null,
      })
      toast(t('stockin.saved'))
      onSaved()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Sheet open={item !== null} title={`${t('stockin.title')} — ${item.name}`} onClose={onClose}>
      <p className="muted" style={{ margin: 0 }}>
        {t('stockin.currentStock', { qty: formatQty(item.stockM) })} · {t('stockin.avgCost', { cost: formatIDR(item.costAvg) })}
      </p>
      <QtyInput label={`${t('stockin.qty')} (${item.baseUnit})`} value={qtyM} onValueChange={setQtyM} minM={0} />
      <CurrencyInput label={t('stockin.cost')} value={cost} onValueChange={setCost} />
      <Input label={t('stockin.note')} value={note} onChange={(e) => setNote(e.target.value)} />
      {cost > 0 && (
        <p className="muted" style={{ margin: 0 }}>
          {t('common.total')}: {formatIDR(qtyTimesUnitCost(qtyM, cost))}
        </p>
      )}
      {error && (
        <p style={{ color: 'var(--color-danger)', margin: 0 }} role="alert">
          {error}
        </p>
      )}
      <Button block disabled={saving} onClick={() => void save()}>
        {t('common.save')}
      </Button>
    </Sheet>
  )
}
