/**
 * Money helpers. All amounts are integer rupiah — never floats.
 * Format target (docs/TASKS.md T-008): Rp1.234.567
 */

/** Format an integer rupiah amount as "Rp1.234.567". Negative: "-Rp1.234.567". */
export function formatIDR(amount: number): string {
  if (!Number.isInteger(amount)) {
    throw new Error(`formatIDR: amount must be an integer, got ${amount}`)
  }
  const sign = amount < 0 ? '-' : ''
  const digits = Math.abs(amount).toString()
  return sign + 'Rp' + groupDigits(digits)
}

/** Group digits with dots: "1234567" -> "1.234.567" */
export function groupDigits(digits: string): string {
  let out = ''
  for (let i = 0; i < digits.length; i++) {
    if (i > 0 && (digits.length - i) % 3 === 0) out += '.'
    out += digits[i]
  }
  return out
}

/** Grouped digits without the Rp prefix, for input fields: 1234567 -> "1.234.567". */
export function groupAmount(amount: number): string {
  return groupDigits(Math.abs(Math.trunc(amount)).toString())
}

/**
 * Parse user input into an integer rupiah amount.
 * Accepts "1.234.567", "Rp 1.234.567", "1234567", "1,5"? No — commas are ignored,
 * everything that is not a digit is stripped. Returns 0 for empty/invalid input.
 */
export function parseIDR(input: string): number {
  const digits = input.replace(/\D/g, '')
  if (digits === '') return 0
  // Guard against precision loss for absurdly long inputs.
  const n = Number(digits.slice(0, 15))
  if (!Number.isSafeInteger(n)) return 0
  return n
}

/**
 * Format a qty (base units, up to 3 dp) for display: 1.5 -> "1,5", 2 -> "2".
 * Indonesian decimal comma. qty_milli = qty * 1000 (integer, no floats).
 */
export function formatQty(qtyM: number): string {
  if (!Number.isInteger(qtyM)) {
    throw new Error(`formatQty: qtyM must be an integer (milli-units), got ${qtyM}`)
  }
  const sign = qtyM < 0 ? '-' : ''
  const abs = Math.abs(qtyM)
  const whole = Math.floor(abs / 1000)
  const frac = abs % 1000
  if (frac === 0) return sign + whole.toString()
  // Trim trailing zeros of the fractional part (3 -> "3", 500 -> "5", 250 -> "25")
  let f = frac.toString().padStart(3, '0')
  while (f.endsWith('0')) f = f.slice(0, -1)
  return `${sign}${whole},${f}`
}

/** Parse a qty string ("1,5", "2", "0.25") into milli-units. Returns null when invalid. */
export function parseQty(input: string): number | null {
  const s = input.trim().replace(/\s/g, '').replace(',', '.')
  if (s === '' || isNaN(Number(s))) return null
  const m = Math.round(Number(s) * 1000)
  if (!Number.isInteger(m) || !Number.isFinite(m)) return null
  return m
}

/** Multiply qty (milli) by rupiah-per-unit, rounding to the nearest rupiah. */
export function qtyTimesUnitCost(qtyM: number, unitCost: number): number {
  return Math.round((qtyM * unitCost) / 1000)
}
