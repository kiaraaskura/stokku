import { useEffect, useId, useState, type InputHTMLAttributes } from 'react'
import { useI18n } from '../i18n/I18nProvider'
import { groupAmount, parseIDR, formatQty, parseQty } from '../lib/money'

interface BaseFieldProps {
  label?: string
  hint?: string
  error?: string
}

export function Input({
  label,
  hint,
  error,
  className,
  id,
  ...rest
}: BaseFieldProps & InputHTMLAttributes<HTMLInputElement>) {
  const autoId = useId()
  const inputId = id ?? autoId
  const classes = ['input', error ? 'input--error' : '', className].filter(Boolean).join(' ')
  return (
    <div className="field">
      {label && (
        <label className="field__label" htmlFor={inputId}>
          {label}
        </label>
      )}
      <input id={inputId} className={classes} aria-invalid={error ? true : undefined} {...rest} />
      {hint && !error && <span className="field__hint">{hint}</span>}
      <span className="field__error" aria-live="polite">
        {error ?? ''}
      </span>
    </div>
  )
}

/**
 * Currency input (T-006): typing digits shows grouped rupiah, e.g. 1234567 -> "1.234.567".
 * Value is an integer rupiah amount (never a float). "Rp" is shown as a prefix adornment.
 */
export function CurrencyInput({
  label,
  hint,
  error,
  value,
  onValueChange,
  placeholder = '0',
  disabled,
  autoFocus,
  id,
}: BaseFieldProps & {
  value: number
  onValueChange: (amount: number) => void
  placeholder?: string
  disabled?: boolean
  autoFocus?: boolean
  id?: string
}) {
  const autoId = useId()
  const inputId = id ?? autoId
  const [focused, setFocused] = useState(false)
  const [draft, setDraft] = useState<string>(() => (value === 0 ? '' : groupAmount(value)))

  useEffect(() => {
    if (!focused) {
      setDraft(value === 0 ? '' : groupAmount(value))
    }
  }, [value, focused])

  const display = focused ? draft : value === 0 ? '' : groupAmount(value)

  return (
    <div className="field">
      {label && (
        <label className="field__label" htmlFor={inputId}>
          {label}
        </label>
      )}
      <div className="currency-input" style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
        <span
          aria-hidden="true"
          style={{ fontSize: 'var(--text-lg)', fontWeight: 600, color: 'var(--color-text-muted)', minWidth: '1.6em' }}
        >
          Rp
        </span>
        <input
          id={inputId}
          className={['input', 'input--currency', error ? 'input--error' : ''].filter(Boolean).join(' ')}
          inputMode="numeric"
          autoComplete="off"
          placeholder={placeholder}
          disabled={disabled}
          autoFocus={autoFocus}
          value={display}
          onFocus={(e) => {
            setFocused(true)
            const el = e.currentTarget
            requestAnimationFrame(() => el.select())
          }}
          onBlur={() => {
            setFocused(false)
            setDraft(value === 0 ? '' : groupAmount(value))
          }}
          onChange={(e) => {
            const raw = e.target.value
            const amount = parseIDR(raw)
            // Keep the raw keystrokes visible while focused (grouped as they type).
            setDraft(raw === '' ? '' : groupAmount(amount))
            onValueChange(amount)
          }}
          aria-invalid={error ? true : undefined}
        />
      </div>
      {hint && !error && <span className="field__hint">{hint}</span>}
      <span className="field__error" aria-live="polite">
        {error ?? ''}
      </span>
    </div>
  )
}

/** Qty input with up to 3 decimal places, Indonesian comma, with +/- buttons. */
export function QtyInput({
  label,
  error,
  value,
  onValueChange,
  stepM = 1000,
  minM = 0,
  id,
}: {
  label?: string
  error?: string
  value: number | null
  onValueChange: (qtyM: number) => void
  stepM?: number
  minM?: number
  id?: string
}) {
  const { t } = useI18n()
  const autoId = useId()
  const inputId = id ?? autoId
  const [text, setText] = useState<string>(() => (value === null ? '' : formatQty(value)))

  useEffect(() => {
    setText(value === null ? '' : formatQty(value))
  }, [value])

  const current = value ?? 0

  return (
    <div className="field">
      {label && (
        <label className="field__label" htmlFor={inputId}>
          {label}
        </label>
      )}
      <div className="stepper" role="group" aria-label={label ?? 'qty'}>
        <button
          type="button"
          className="stepper__btn"
          disabled={current <= minM}
          onClick={() => onValueChange(Math.max(minM, current - stepM))}
          aria-label={t('common.decrement')}
        >
          −
        </button>
        <input
          id={inputId}
          className="stepper__value"
          style={{ border: 'none', background: 'transparent', minHeight: '44px' }}
          inputMode="decimal"
          value={text}
          onChange={(e) => {
            setText(e.target.value)
            if (e.target.value.trim() === '') {
              onValueChange(0)
              return
            }
            const parsed = parseQty(e.target.value)
            if (parsed !== null) onValueChange(parsed)
          }}
        />
        <button
          type="button"
          className="stepper__btn"
          onClick={() => onValueChange(current + stepM)}
          aria-label={t('common.increment')}
        >
          +
        </button>
      </div>
      <span className="field__error" aria-live="polite">
        {error ?? ''}
      </span>
    </div>
  )
}
