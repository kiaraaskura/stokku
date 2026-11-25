/**
 * QRIS helpers (Tier 0, static payloads only).
 * - crc16: QRIS uses CRC-16/CCITT-FALSE (poly 0x1021, init 0xFFFF) over the
 *   payload up to and including the "6304" tag; the 4 hex digits follow.
 * - net = gross − round(gross * mdr_pct / 100) — the contract's exact rule.
 */

export function qrisCrc16(data: string): string {
  let crc = 0xffff
  for (let i = 0; i < data.length; i++) {
    crc ^= data.charCodeAt(i) << 8
    for (let bit = 0; bit < 8; bit++) {
      if (crc & 0x8000) crc = (crc << 1) ^ 0x1021
      else crc = crc << 1
      crc &= 0xffff
    }
  }
  return crc.toString(16).toUpperCase().padStart(4, '0')
}

/** True when the payload's trailing 4 hex digits match its CRC16. */
export function qrisCrcValid(payload: string): boolean {
  const trimmed = payload.trim()
  if (trimmed.length < 8) return false
  const body = trimmed.slice(0, -4)
  const stated = trimmed.slice(-4).toUpperCase()
  if (!/^[0-9A-F]+$/.test(stated)) return false
  return qrisCrc16(body) === stated
}

/** Light pre-check: starts like a QRIS payload and is long enough. The server does the full EMVCo TLV validation. */
export function qrisLooksLikePayload(payload: string): boolean {
  const s = payload.trim().toUpperCase()
  return s.startsWith('000201') && s.length > 40
}

/** MDR fee and net per the contract: net = gross − round(gross * mdr_pct / 100). */
export function qrisFeeAndNet(gross: number, mdrPct: number): { fee: number; net: number } {
  if (!Number.isInteger(gross) || gross < 0) throw new Error('gross must be an integer rupiah amount')
  const fee = Math.round((gross * mdrPct) / 100)
  return { fee, net: gross - fee }
}
