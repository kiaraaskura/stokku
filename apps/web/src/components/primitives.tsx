import type { ButtonHTMLAttributes, ReactNode } from 'react'
import '../styles/primitives.css'

type Variant = 'primary' | 'secondary' | 'danger' | 'ghost'
type Size = 'md' | 'sm'

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant
  size?: Size
  block?: boolean
  children?: ReactNode
}

export function Button({ variant = 'primary', size = 'md', block, className, type, ...rest }: ButtonProps) {
  const classes = ['btn', `btn--${variant}`, size === 'sm' ? 'btn--sm' : '', block ? 'btn--block' : '', className]
  return <button type={type ?? 'button'} className={classes.filter(Boolean).join(' ')} {...rest} />
}

export function Badge({
  tone = 'neutral',
  children,
}: {
  tone?: 'warning' | 'danger' | 'success' | 'neutral'
  children: ReactNode
}) {
  return <span className={`badge badge--${tone}`}>{children}</span>
}

export function Stepper({
  value,
  onDecrement,
  onIncrement,
  label,
  min = 0,
}: {
  value: string
  onDecrement: () => void
  onIncrement: () => void
  label: string
  min?: number
}) {
  const numeric = Number(value.replace(',', '.')) || 0
  return (
    <div className="stepper" role="group" aria-label={label}>
      <button type="button" className="stepper__btn" onClick={onDecrement} disabled={numeric <= min} aria-label="-">
        −
      </button>
      <span className="stepper__value">{value}</span>
      <button type="button" className="stepper__btn" onClick={onIncrement} aria-label="+">
        +
      </button>
    </div>
  )
}
