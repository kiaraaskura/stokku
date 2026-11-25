import { describe, expect, it } from 'vitest'
import { qrisCrc16, qrisCrcValid, qrisFeeAndNet, qrisLooksLikePayload } from './qris'

// Payload + CRC from the seed fixture (scripts/seed.sql computes it the same way).
const SEED_BODY =
  '00020101021126420014ID.CO.QRIS.WWW01151234567890123450201U5204541153033605802ID5913WARUNG BU SRI6007JAKARTA'

describe('qrisCrc16 (CRC-16/CCITT-FALSE)', () => {
  it('matches the seed fixture CRC', () => {
    expect(qrisCrc16(SEED_BODY + '6304')).toBe('7952')
  })

  it('matches the known CRC check value "123456789" -> 29B1', () => {
    expect(qrisCrc16('123456789')).toBe('29B1')
  })
})

describe('qrisCrcValid', () => {
  it('accepts the seed payload', () => {
    expect(qrisCrcValid(SEED_BODY + '63047952')).toBe(true)
  })
  it('rejects a wrong CRC', () => {
    expect(qrisCrcValid(SEED_BODY + '6304FFFF')).toBe(false)
  })
  it('rejects junk', () => {
    expect(qrisCrcValid('')).toBe(false)
    expect(qrisCrcValid('1234')).toBe(false)
  })
})

describe('qrisLooksLikePayload', () => {
  it('accepts the seed payload', () => {
    expect(qrisLooksLikePayload(SEED_BODY + '63047952')).toBe(true)
  })
  it('rejects junk and empty input', () => {
    expect(qrisLooksLikePayload('')).toBe(false)
    expect(qrisLooksLikePayload('zz')).toBe(false)
    expect(qrisLooksLikePayload('12345678901234567890123456789012345678901234')).toBe(false)
  })
})

describe('qrisFeeAndNet (acceptance D20: 60.000 @ 0,7% → 420 / 59.580)', () => {
  it('computes the acceptance numbers exactly', () => {
    expect(qrisFeeAndNet(60000, 0.7)).toEqual({ fee: 420, net: 59580 })
  })
  it('rounds half up and zeroes at 0%', () => {
    expect(qrisFeeAndNet(100, 0.5)).toEqual({ fee: 1, net: 99 })
    expect(qrisFeeAndNet(60000, 0)).toEqual({ fee: 0, net: 60000 })
  })
  it('rejects non-integer gross', () => {
    expect(() => qrisFeeAndNet(60000.5, 0.7)).toThrow()
  })
})
