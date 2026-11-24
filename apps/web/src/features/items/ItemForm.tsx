import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router'
import { useAppState } from '../../state/AppState'
import { useI18n } from '../../i18n/I18nProvider'
import { Button } from '../../components/primitives'
import { CurrencyInput, Input } from '../../components/inputs'
import { ErrorView, Loading } from '../../components/state'
import { parseQty } from '../../lib/money'
import type { ItemDetail } from '../../db/types'

interface UnitDraft {
  name: string
  factorText: string
}

export function ItemForm() {
  const { id } = useParams()
  const isEdit = id !== undefined
  const { repo, toast, refresh } = useAppState()
  const { t, locale } = useI18n()
  const navigate = useNavigate()

  const [name, setName] = useState('')
  const [sku, setSku] = useState('')
  const [barcode, setBarcode] = useState('')
  const [categoryId, setCategoryId] = useState('')
  const [baseUnit, setBaseUnit] = useState('')
  const [units, setUnits] = useState<UnitDraft[]>([])
  const [salePrice, setSalePrice] = useState(0)
  const [cost, setCost] = useState(0)
  const [minStockText, setMinStockText] = useState('')
  const [active, setActive] = useState(true)
  const [categories, setCategories] = useState<{ id: string; name: string }[]>([])
  const [detail, setDetail] = useState<ItemDetail | null>(null)
  const [loading, setLoading] = useState(isEdit)
  const [error, setError] = useState<string | null>(null)
  const [fieldError, setFieldError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!repo) return
    void repo.call('listCategories').then(setCategories)
    if (isEdit && id) {
      repo
        .call('getItem', id)
        .then((d) => {
          if (d) {
            setDetail(d)
            setName(d.name)
            setSku(d.sku ?? '')
            setBarcode(d.barcodes.map((b) => b.barcode).join(', '))
            setCategoryId(d.categoryId ?? '')
            setBaseUnit(d.baseUnit)
            setUnits(d.units.map((u) => ({ name: u.name, factorText: String(u.factorM / 1000).replace('.', ',') })))
            setSalePrice(d.salePrice)
            setCost(d.costAvg)
            setMinStockText(d.minStockM > 0 ? String(d.minStockM / 1000).replace('.', ',') : '')
            setActive(d.active)
          }
          setLoading(false)
        })
        .catch((err: unknown) => {
          setError(err instanceof Error ? err.message : String(err))
          setLoading(false)
        })
    } else {
      setBaseUnit('pcs')
      setLoading(false)
    }
  }, [repo, id, isEdit])

  if (loading) return <Loading />
  if (error) return <ErrorView message={error} onRetry={() => navigate('/barang')} />
  if (isEdit && !detail) return <ErrorView message="NOT_FOUND" onRetry={() => navigate('/barang')} />

  const save = async () => {
    if (!repo) return
    setFieldError(null)
    const minStockM = minStockText.trim() === '' ? 0 : parseQty(minStockText)
    if (minStockM === null) {
      setFieldError(t('form.minStock'))
      return
    }
    const unitDrafts = units
      .map((u) => ({ name: u.name.trim(), factorM: parseQty(u.factorText) }))
      .filter((u): u is { name: string; factorM: number } => u.name !== '' || u.factorM !== null)
    for (const u of unitDrafts) {
      if (u.factorM === null || u.factorM <= 0 || u.name === '') {
        setFieldError(t('form.units'))
        return
      }
    }
    const barcodes = barcode
      .split(',')
      .map((b) => b.trim())
      .filter((b) => b !== '')

    setSaving(true)
    try {
      const input = {
        name,
        sku: sku.trim() === '' ? null : sku.trim(),
        barcodes,
        categoryId: categoryId === '' ? null : categoryId,
        baseUnit,
        units: unitDrafts.map((u) => ({ name: u.name, factorM: u.factorM! })),
        salePrice,
        cost,
        minStockM,
        active,
      }
      if (isEdit && id) {
        await repo.call('updateItem', id, input)
      } else {
        await repo.call('createItem', input)
      }
      toast(t('form.itemSaved'))
      void refresh()
      navigate('/barang')
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (msg.startsWith('VALIDATION')) setFieldError(msg.replace('VALIDATION ', ''))
      else setError(msg)
      setSaving(false)
    }
  }

  return (
    <div className="screen" style={{ maxWidth: 560 }}>
      <div className="screen__header">
        <h1 className="screen__title">{isEdit ? t('form.editItem') : t('form.newItem')}</h1>
        <div className="screen__actions">
          <Button variant="secondary" onClick={() => navigate('/barang')}>
            {t('common.cancel')}
          </Button>
        </div>
      </div>

      <Input label={t('form.name')} value={name} onChange={(e) => setName(e.target.value)} autoFocus={!isEdit} />
      <div className="row" style={{ flexWrap: 'wrap' }}>
        <div style={{ flex: '1 1 160px' }}>
          <Input label={t('form.sku')} value={sku} onChange={(e) => setSku(e.target.value)} />
        </div>
        <div style={{ flex: '1 1 200px' }}>
          <Input
            label={t('form.barcode')}
            inputMode="numeric"
            hint={locale === 'id' ? 'Pisahkan dengan koma untuk lebih dari satu' : 'Separate multiple with commas'}
            value={barcode}
            onChange={(e) => setBarcode(e.target.value)}
          />
        </div>
      </div>
      <div className="row" style={{ flexWrap: 'wrap' }}>
        <div style={{ flex: '1 1 200px' }}>
          <label className="field__label" htmlFor="item-category">
            {t('form.category')}
          </label>
          <select
            id="item-category"
            className="input"
            value={categoryId}
            onChange={(e) => setCategoryId(e.target.value)}
          >
            <option value="">—</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </div>
        <div style={{ flex: '1 1 160px' }}>
          <Input
            label={t('form.baseUnit')}
            placeholder={t('form.baseUnitPlaceholder')}
            value={baseUnit}
            onChange={(e) => setBaseUnit(e.target.value)}
          />
        </div>
      </div>

      <div className="stack" style={{ gap: 'var(--space-2)' }}>
        <div className="field__label">{t('form.units')}</div>
        <p className="field__hint" style={{ margin: 0 }}>
          {t('form.unitsHint')}
        </p>
        {units.map((u, i) => (
          <div key={i} className="row" style={{ flexWrap: 'nowrap' }}>
            <div style={{ flex: 1 }}>
              <Input
                label={i === 0 ? t('form.unitName') : undefined}
                placeholder={locale === 'id' ? 'cth. dus' : 'e.g. box'}
                value={u.name}
                onChange={(e) => setUnits((arr) => arr.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))}
              />
            </div>
            <div style={{ width: 140 }}>
              <Input
                label={i === 0 ? t('form.factor') : undefined}
                inputMode="decimal"
                placeholder="24"
                value={u.factorText}
                onChange={(e) => setUnits((arr) => arr.map((x, j) => (j === i ? { ...x, factorText: e.target.value } : x)))}
              />
            </div>
            <Button
              variant="ghost"
              size="sm"
              aria-label={t('common.delete')}
              onClick={() => setUnits((arr) => arr.filter((_, j) => j !== i))}
            >
              ✕
            </Button>
          </div>
        ))}
        <div>
          <Button variant="secondary" size="sm" onClick={() => setUnits((arr) => [...arr, { name: '', factorText: '' }])}>
            + {t('form.addUnit')}
          </Button>
        </div>
      </div>

      <div className="row" style={{ flexWrap: 'wrap' }}>
        <div style={{ flex: '1 1 200px' }}>
          <CurrencyInput label={t('form.salePrice')} value={salePrice} onValueChange={setSalePrice} />
        </div>
        <div style={{ flex: '1 1 200px' }}>
          <CurrencyInput label={t('form.cost')} value={cost} onValueChange={setCost} />
        </div>
      </div>
      <Input
        label={t('form.minStock')}
        inputMode="decimal"
        placeholder="0"
        value={minStockText}
        onChange={(e) => setMinStockText(e.target.value)}
      />
      <label className="row" style={{ minHeight: 'var(--tap-target)', cursor: 'pointer' }}>
        <input
          type="checkbox"
          checked={active}
          onChange={(e) => setActive(e.target.checked)}
          style={{ width: 20, height: 20 }}
        />
        {t('form.active')}
      </label>

      {fieldError && (
        <p style={{ color: 'var(--color-danger)', margin: 0 }} role="alert">
          {fieldError}
        </p>
      )}
      {error && <ErrorView message={error} onRetry={() => setError(null)} />}

      <Button block disabled={saving || name.trim() === '' || baseUnit.trim() === ''} onClick={() => void save()}>
        {t('common.save')}
      </Button>
    </div>
  )
}
