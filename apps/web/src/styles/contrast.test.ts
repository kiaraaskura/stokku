import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * G30 contrast lock: computes WCAG 2.1 contrast ratios for the token pairs
 * used by body text, the sync dot and the status badges, and asserts >= 4.5:1
 * (ACCEPTANCE.md line 30). If someone darkens the palette, this fails before
 * a human notices grey-on-grey.
 */

const tokensCss = readFileSync(resolve(__dirname, '../styles/tokens.css'), 'utf8')

function token(name: string): string {
  const m = tokensCss.match(new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})`))
  if (!m) throw new Error(`token --${name} not found in tokens.css`)
  return m[1]!
}

function srgbLin(c: number): number {
  const v = c / 255
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
}

function luminance(hex: string): number {
  const h = hex.slice(1)
  const r = parseInt(h.slice(0, 2), 16)
  const g = parseInt(h.slice(2, 4), 16)
  const b = parseInt(h.slice(4, 6), 16)
  return 0.2126 * srgbLin(r) + 0.7152 * srgbLin(g) + 0.0722 * srgbLin(b)
}

export function contrastRatio(fg: string, bg: string): number {
  const a = luminance(fg)
  const b = luminance(bg)
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
}

describe('G30: WCAG contrast >= 4.5:1 for body text, sync dot and badges', () => {
  it('body text and muted text on every background they render on', () => {
    const text = token('color-text')
    const muted = token('color-text-muted')
    const bg = token('color-bg')
    const surface = token('color-surface')
    const surfaceAlt = token('color-surface-alt')
    expect(contrastRatio(text, bg)).toBeGreaterThanOrEqual(4.5)
    expect(contrastRatio(text, surface)).toBeGreaterThanOrEqual(4.5)
    expect(contrastRatio(muted, surface)).toBeGreaterThanOrEqual(4.5)
    expect(contrastRatio(muted, bg)).toBeGreaterThanOrEqual(4.5)
    // the sync dot sits on surface-alt with muted text and a text label
    expect(contrastRatio(muted, surfaceAlt)).toBeGreaterThanOrEqual(4.5)
  })

  it('primary buttons/links, badges and the toast', () => {
    const onPrimary = token('color-on-primary')
    const primary = token('color-primary')
    const primaryStrong = token('color-primary-strong')
    expect(contrastRatio(onPrimary, primary)).toBeGreaterThanOrEqual(4.5)
    expect(contrastRatio(onPrimary, primaryStrong)).toBeGreaterThanOrEqual(4.5)
    expect(contrastRatio(primary, token('color-surface'))).toBeGreaterThanOrEqual(4.5)
    expect(contrastRatio(token('color-warning'), token('color-warning-soft'))).toBeGreaterThanOrEqual(4.5)
    expect(contrastRatio(token('color-danger'), token('color-danger-soft'))).toBeGreaterThanOrEqual(4.5)
    expect(contrastRatio(token('color-success'), token('color-success-soft'))).toBeGreaterThanOrEqual(4.5)
    expect(contrastRatio('#ffffff', token('color-text'))).toBeGreaterThanOrEqual(4.5) // toast
  })

  it('tap-target token is at least 44px and controls use it', () => {
    const m = tokensCss.match(/--tap-target:\s*(\d+)px/)
    expect(m).not.toBeNull()
    expect(Number(m![1])).toBeGreaterThanOrEqual(44)
    expect(tokensCss).toMatch(/--control-height:\s*44px/)
    const primitives = readFileSync(resolve(__dirname, '../styles/primitives.css'), 'utf8')
    // buttons and steppers derive their min-height from the tokens
    expect(primitives).toMatch(/\.btn\s*\{[^}]*min-height:\s*var\(--control-height\)/)
    expect(primitives).toMatch(/\.stepper__btn\s*\{[^}]*min-height:\s*var\(--tap-target\)/)
  })
})
