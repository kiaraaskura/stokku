import { describe, expect, it } from 'vitest'
import { formatIDR, formatQty, groupAmount, groupDigits, parseIDR, parseQty, qtyTimesUnitCost } from './money'
import { uuidv7 } from './uuid'
import { todayISO, monthRange, formatMonth } from './date'

describe('formatIDR (T-008: Rp1.234.567)', () => {
  it('formats the spec example exactly', () => {
    expect(formatIDR(1234567)).toBe('Rp1.234.567')
  })

  it('formats small and zero amounts', () => {
    expect(formatIDR(0)).toBe('Rp0')
    expect(formatIDR(500)).toBe('Rp500')
    expect(formatIDR(12000)).toBe('Rp12.000')
    expect(formatIDR(60000)).toBe('Rp60.000')
    expect(formatIDR(37500)).toBe('Rp37.500')
  })

  it('formats negative amounts with a leading minus', () => {
    expect(formatIDR(-17500)).toBe('-Rp17.500')
  })

  it('rejects non-integers (money is never a float)', () => {
    expect(() => formatIDR(1234.5)).toThrow()
  })
})

describe('groupDigits / groupAmount', () => {
  it('groups every three digits from the right', () => {
    expect(groupDigits('1234567')).toBe('1.234.567')
    expect(groupDigits('999')).toBe('999')
    expect(groupDigits('1234')).toBe('1.234')
  })
  it('groupAmount truncates toward zero', () => {
    expect(groupAmount(1234567)).toBe('1.234.567')
  })
})

describe('parseIDR', () => {
  it('parses grouped and prefixed input', () => {
    expect(parseIDR('1.234.567')).toBe(1234567)
    expect(parseIDR('Rp 1.234.567')).toBe(1234567)
    expect(parseIDR('rp1234567')).toBe(1234567)
  })
  it('returns 0 for empty or invalid input', () => {
    expect(parseIDR('')).toBe(0)
    expect(parseIDR('abc')).toBe(0)
  })
})

describe('formatQty / parseQty (milli-units)', () => {
  it('uses Indonesian decimal comma and trims zeros', () => {
    expect(formatQty(1000)).toBe('1')
    expect(formatQty(1500)).toBe('1,5')
    expect(formatQty(250)).toBe('0,25')
    expect(formatQty(24000)).toBe('24')
    expect(formatQty(-500)).toBe('-0,5')
  })
  it('parses comma and dot decimals', () => {
    expect(parseQty('1,5')).toBe(1500)
    expect(parseQty('1.5')).toBe(1500)
    expect(parseQty('2')).toBe(2000)
    expect(parseQty('x')).toBeNull()
  })
})

describe('qtyTimesUnitCost', () => {
  it('multiplies and rounds to the rupiah (acceptance A4: 5 × 7.500)', () => {
    expect(qtyTimesUnitCost(5000, 7500)).toBe(37500)
    expect(qtyTimesUnitCost(5000, 12000)).toBe(60000)
  })
  it('rounds fractional results', () => {
    expect(qtyTimesUnitCost(100, 6955)).toBe(696) // 0.1 × 6.955
  })
})

describe('uuidv7', () => {
  it('produces a valid UUID shape with version 7', () => {
    const id = uuidv7()
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  })
  it('is unique across many calls', () => {
    const ids = new Set(Array.from({ length: 1000 }, () => uuidv7()))
    expect(ids.size).toBe(1000)
  })
})

describe('date helpers (Asia/Jakarta)', () => {
  it('business dates are plain YYYY-MM-DD', () => {
    expect(todayISO()).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })
  it('monthRange covers the whole month', () => {
    expect(monthRange('2026-11')).toEqual({ from: '2026-11-01', to: '2026-11-30' })
    expect(monthRange('2024-02')).toEqual({ from: '2024-02-01', to: '2024-02-29' })
  })
  it('month labels are locale-aware', () => {
    expect(formatMonth('2026-11', 'id')).toBe('November 2026')
    expect(formatMonth('2026-11', 'en')).toBe('November 2026')
  })
})
