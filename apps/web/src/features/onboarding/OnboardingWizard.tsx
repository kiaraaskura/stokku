import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router'
import { useAppState } from '../../state/AppState'
import { useI18n } from '../../i18n/I18nProvider'
import { Button } from '../../components/primitives'
import { Input, CurrencyInput } from '../../components/inputs'
import { parseQty } from '../../lib/money'
import type { OnboardingDraft } from '../../db/types'

const BUSINESS_TYPES = [
  { id: 'kelontong', label: 'Warung / kelontong', icon: '🏪' },
  { id: 'katering', label: 'Katering / makanan', icon: '🍲' },
  { id: 'laundry', label: 'Laundry', icon: '🧺' },
  { id: 'bengkel', label: 'Bengkel', icon: '🔧' },
  { id: 'fashion', label: 'Fashion', icon: '👕' },
] as const

const TOTAL_STEPS = 4

export function OnboardingWizard() {
  const { repo, refresh, toast, ready } = useAppState()
  const { t, locale } = useI18n()
  const navigate = useNavigate()
  const [draft, setDraft] = useState<OnboardingDraft | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  // Load the resumable draft from local storage (T-210: resumable after kill).
  useEffect(() => {
    if (!repo || draft) return
    void repo.call('getOnboardingDraft').then((d) => {
      setDraft(d)
    })
  }, [repo, draft])

  const step = draft?.step ?? 1

  const update = (patch: Partial<OnboardingDraft>) => {
    setDraft((prev) => {
      if (!prev) return prev
      const next = { ...prev, ...patch }
      void repo?.call('saveOnboardingDraft', next)
      return next
    })
  }

  const canFinish = useMemo(() => {
    if (!draft) return false
    if (step === 1) return draft.businessName.trim() !== ''
    if (step === 2) return draft.businessType !== ''
    if (step === 3) return true
    return true
  }, [draft, step])

  if (!ready || !draft) {
    return <div style={{ display: 'grid', placeItems: 'center', minHeight: '100dvh' }}>…</div>
  }

  const finish = async () => {
    if (!repo) return
    setSubmitting(true)
    setError(null)
    try {
      const openingName = draft.openingItemName.trim()
      const openingQty = parseQty(draft.openingQtyText)
      const useOpening = openingName !== '' && openingQty !== null && openingQty > 0
      await repo.call('completeOnboarding', {
        businessName: draft.businessName.trim(),
        businessType: draft.businessType,
        taxRatePercent: draft.taxRatePercent,
        opening: useOpening
          ? {
              name: openingName,
              qtyM: openingQty,
              unitCost: draft.openingCost,
              salePrice: draft.openingSalePrice,
            }
          : null,
      })
      await refresh()
      toast(t('onboarding.finish'))
      navigate('/barang', { replace: true })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setSubmitting(false)
    }
  }

  return (
    <div
      style={{
        maxWidth: 480,
        margin: '0 auto',
        padding: 'var(--space-5) var(--space-4) var(--space-12)',
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--space-5)',
        minHeight: '100dvh',
      }}
    >
      <header>
        <h1 style={{ margin: 0, fontSize: 'var(--text-xl)', color: 'var(--color-primary-strong)' }}>
          {t('onboarding.title')}
        </h1>
        <p className="muted" style={{ margin: 'var(--space-1) 0 0' }}>
          {t('onboarding.subtitle')}
        </p>
      </header>

      <div
        role="progressbar"
        aria-valuenow={step}
        aria-valuemin={1}
        aria-valuemax={TOTAL_STEPS}
        aria-label={t('onboarding.step', { n: step, total: TOTAL_STEPS })}
        style={{ height: 8, background: 'var(--color-surface-alt)', borderRadius: 'var(--radius-full)', overflow: 'hidden' }}
      >
        <div
          style={{
            height: '100%',
            width: `${(step / TOTAL_STEPS) * 100}%`,
            background: 'var(--color-primary)',
            transition: 'width var(--dur-sheet) ease-out',
          }}
        />
      </div>
      <p className="muted" style={{ margin: 0, fontSize: 'var(--text-sm)' }}>
        {t('onboarding.step', { n: step, total: TOTAL_STEPS })}
        {step > 1 && <span aria-live="polite"> · {t('onboarding.resumed')}</span>}
      </p>

      {step === 1 && (
        <Input
          label={t('onboarding.businessName')}
          placeholder={t('onboarding.businessNamePlaceholder')}
          value={draft.businessName}
          autoFocus
          onChange={(e) => update({ businessName: e.target.value })}
        />
      )}

      {step === 2 && (
        <div className="stack">
          <p className="muted" style={{ margin: 0 }}>
            {t('onboarding.businessTypeHint')}
          </p>
          <div role="radiogroup" aria-label={t('onboarding.businessType')} className="stack" style={{ gap: 'var(--space-2)' }}>
            {BUSINESS_TYPES.map((bt) => (
              <button
                key={bt.id}
                type="button"
                role="radio"
                aria-checked={draft.businessType === bt.id}
                onClick={() => update({ businessType: bt.id })}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 'var(--space-3)',
                  minHeight: 'var(--tap-target)',
                  padding: 'var(--space-3)',
                  borderRadius: 'var(--radius-md)',
                  border:
                    draft.businessType === bt.id
                      ? '2px solid var(--color-primary)'
                      : '1px solid var(--color-border-strong)',
                  background: draft.businessType === bt.id ? 'var(--color-primary-soft)' : 'var(--color-surface)',
                  cursor: 'pointer',
                  textAlign: 'left',
                  fontSize: 'var(--text-md)',
                }}
              >
                <span aria-hidden="true" style={{ fontSize: '1.4rem' }}>
                  {bt.icon}
                </span>
                {bt.label}
              </button>
            ))}
          </div>
        </div>
      )}

      {step === 3 && (
        <div className="stack">
          <Input
            label={`${t('onboarding.tax')} (${t('onboarding.taxPercent')})`}
            hint={t('onboarding.taxHint')}
            type="number"
            min={0}
            max={100}
            step="0.5"
            inputMode="decimal"
            value={draft.taxRatePercent === 0 ? '' : draft.taxRatePercent}
            placeholder="0"
            onChange={(e) => update({ taxRatePercent: Number(e.target.value) || 0 })}
          />
        </div>
      )}

      {step === 4 && (
        <div className="stack">
          <p className="muted" style={{ margin: 0 }}>
            {t('onboarding.openingStockHint')}
          </p>
          <Input
            label={t('onboarding.openingItemName')}
            placeholder={t('onboarding.openingItemNamePlaceholder')}
            value={draft.openingItemName}
            onChange={(e) => update({ openingItemName: e.target.value })}
          />
          <Input
            label={t('onboarding.openingQty')}
            inputMode="decimal"
            placeholder={locale === 'id' ? 'cth. 10' : 'e.g. 10'}
            value={draft.openingQtyText}
            onChange={(e) => update({ openingQtyText: e.target.value })}
          />
          <CurrencyInput
            label={t('onboarding.openingCost')}
            value={draft.openingCost}
            onValueChange={(v) => update({ openingCost: v })}
          />
          <CurrencyInput
            label={t('onboarding.openingSalePrice')}
            value={draft.openingSalePrice}
            onValueChange={(v) => update({ openingSalePrice: v })}
          />
        </div>
      )}

      {error && (
        <p style={{ color: 'var(--color-danger)', margin: 0 }} role="alert">
          {error}
        </p>
      )}

      <div style={{ marginTop: 'auto', display: 'flex', gap: 'var(--space-3)' }}>
        {step > 1 && (
          <Button variant="secondary" onClick={() => update({ step: step - 1 })}>
            {t('common.back')}
          </Button>
        )}
        {step < TOTAL_STEPS ? (
          <Button block disabled={!canFinish} onClick={() => update({ step: step + 1 })}>
            {t('common.next')}
          </Button>
        ) : (
          <Button block disabled={submitting} onClick={() => void finish()}>
            {t('onboarding.finish')}
          </Button>
        )}
      </div>
      {step === 4 && (
        <Button variant="ghost" onClick={() => void finish()} disabled={submitting}>
          {t('onboarding.skip')}
        </Button>
      )}
    </div>
  )
}
