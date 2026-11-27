import { useEffect, useRef, type ReactNode } from 'react'
import { useI18n } from '../i18n/I18nProvider'

/**
 * Sheet (T-006): bottom sheet on mobile, centered dialog on desktop.
 * Traps focus loosely, closes on Escape and backdrop click.
 */
export function Sheet({
  open,
  title,
  onClose,
  children,
  closeLabel,
}: {
  open: boolean
  title: string
  onClose: () => void
  children: ReactNode
  closeLabel?: string
}) {
  const { t } = useI18n()
  const panelRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose()
        return
      }
      if (e.key === 'Tab' && panelRef.current) {
        const focusables = panelRef.current.querySelectorAll<HTMLElement>(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
        )
        if (focusables.length === 0) return
        const first = focusables[0]!
        const last = focusables[focusables.length - 1]!
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault()
          last.focus()
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault()
          first.focus()
        }
      }
    }
    document.addEventListener('keydown', onKey)
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const timer = requestAnimationFrame(() => {
      // Explicit priority: a marked target, then a real field, then any
      // control. One combined selector would match whichever comes first in
      // document order, which is the close button — so a keyboard user landed
      // on "Tutup" instead of the quantity they came to type (G29).
      const panel = panelRef.current
      if (!panel) return
      const target =
        panel.querySelector<HTMLElement>('[data-autofocus]') ??
        panel.querySelector<HTMLElement>('input, select, textarea') ??
        panel.querySelector<HTMLElement>('button')
      target?.focus()
    })
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = prevOverflow
      cancelAnimationFrame(timer)
    }
  }, [open, onClose])

  if (!open) return null

  return (
    <>
      <div className="sheet-backdrop" onClick={onClose} aria-hidden="true" />
      <div
        className="sheet"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        ref={panelRef}
      >
        <div className="sheet__header">
          <h2 className="sheet__title">{title}</h2>
          <button type="button" className="sheet__close" onClick={onClose} aria-label={closeLabel ?? t('common.close')}>
            ×
          </button>
        </div>
        <div className="sheet__body">{children}</div>
      </div>
    </>
  )
}
