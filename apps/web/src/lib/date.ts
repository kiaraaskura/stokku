/**
 * Date helpers. Storage is UTC / ISO; rendering is in the outlet timezone,
 * default Asia/Jakarta (docs/DECISIONS.md "Time").
 *
 * business_date is a plain "YYYY-MM-DD" string in the outlet timezone.
 */

export const DEFAULT_TIMEZONE = 'Asia/Jakarta'

export function todayISO(tz: string = DEFAULT_TIMEZONE): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date())
}

/** "2026-11-24" -> "24 Nov 2026" (locale-aware month abbreviations). */
export function formatDate(iso: string, locale: string): string {
  const d = parseISODate(iso)
  return new Intl.DateTimeFormat(locale, {
    timeZone: 'UTC',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).format(d)
}

/** "2026-11-24" -> "24 Nov" (no year, for tight rows). */
export function formatDateShort(iso: string, locale: string): string {
  const d = parseISODate(iso)
  return new Intl.DateTimeFormat(locale, {
    timeZone: 'UTC',
    day: 'numeric',
    month: 'short',
  }).format(d)
}

/** "2026-11-24T10:30:00Z" (or any ISO datetime) -> "24 Nov, 17.30" in the outlet timezone. */
export function formatDateTime(isoDateTime: string, locale: string, tz: string = DEFAULT_TIMEZONE): string {
  const d = new Date(isoDateTime)
  return new Intl.DateTimeFormat(locale, {
    timeZone: tz,
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  }).format(d)
}

/** Local month key "2026-11" from a business_date "2026-11-24". */
export function monthOfBusinessDate(businessDate: string): string {
  return businessDate.slice(0, 7)
}

export function currentMonth(tz: string = DEFAULT_TIMEZONE): string {
  return todayISO(tz).slice(0, 7)
}

/** First and last business_date of a month key "2026-11". */
export function monthRange(month: string): { from: string; to: string } {
  const [y, m] = month.split('-').map(Number)
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate()
  return { from: `${month}-01`, to: `${month}-${String(last).padStart(2, '0')}` }
}

/** Month label "November 2026" (locale-aware). */
export function formatMonth(month: string, locale: string): string {
  const [y, m] = month.split('-').map(Number)
  const d = new Date(Date.UTC(y, m - 1, 1))
  return new Intl.DateTimeFormat(locale, {
    timeZone: 'UTC',
    month: 'long',
    year: 'numeric',
  }).format(d)
}

/** Recent month keys, newest first, for pickers. */
export function recentMonths(count: number, tz: string = DEFAULT_TIMEZONE): string[] {
  const out: string[] = []
  const today = todayISO(tz)
  let y = Number(today.slice(0, 4))
  let m = Number(today.slice(5, 7))
  for (let i = 0; i < count; i++) {
    out.push(`${y}-${String(m).padStart(2, '0')}`)
    m -= 1
    if (m === 0) {
      m = 12
      y -= 1
    }
  }
  return out
}

function parseISODate(iso: string): Date {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d))
}
