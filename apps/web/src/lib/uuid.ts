/**
 * UUIDv7 generator (client-generated IDs and op_ids, docs/DECISIONS.md "IDs").
 * 48-bit unix-ms timestamp + version 7 + random. No dependencies.
 */

export function uuidv7(): string {
  const ts = Date.now()
  const tsHex = ts.toString(16).padStart(12, '0')
  const bytes = new Uint8Array(16)
  // timestamp big-endian in bytes 0..5
  for (let i = 0; i < 6; i++) {
    bytes[i] = parseInt(tsHex.slice(i * 2, i * 2 + 2), 16)
  }
  // random pool for the remaining 10 bytes
  const rnd = crypto.getRandomValues(new Uint8Array(10))
  bytes.set(rnd, 6)
  // version 7 in the high nibble of byte 6
  bytes[6] = (bytes[6]! & 0x0f) | 0x70
  // variant 10xx in byte 8
  bytes[8] = (bytes[8]! & 0x3f) | 0x80
  return toHex(bytes)
}

function toHex(bytes: Uint8Array): string {
  const h = Array.from(bytes, (b) => b.toString(16).padStart(2, '0'))
  return `${h.slice(0, 4).join('')}-${h.slice(4, 6).join('')}-${h.slice(6, 8).join('')}-${h.slice(8, 10).join('')}-${h.slice(10, 16).join('')}`
}
