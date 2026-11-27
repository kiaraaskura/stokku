import { describe, expect, it } from 'vitest'
import { normalizeHubUrl, pickHubUrl, HUB_URL_PARAM } from './hub'

describe('normalizeHubUrl', () => {
  it('accepts bare origins and strips trailing slash', () => {
    expect(normalizeHubUrl('http://localhost:8099')).toBe('http://localhost:8099')
    expect(normalizeHubUrl('https://192.168.1.20:8443/')).toBe('https://192.168.1.20:8443')
  })

  it('strips a /v1 suffix the client would duplicate', () => {
    expect(normalizeHubUrl('http://localhost:8099/v1')).toBe('http://localhost:8099')
    expect(normalizeHubUrl('http://localhost:8099/v1/')).toBe('http://localhost:8099')
  })

  it('drops query and hash', () => {
    expect(normalizeHubUrl('http://localhost:8099/?token=x#y')).toBe('http://localhost:8099')
  })

  it('rejects non-http(s) and garbage', () => {
    expect(normalizeHubUrl('ftp://localhost:8099')).toBeNull()
    expect(normalizeHubUrl('javascript:alert(1)')).toBeNull()
    expect(normalizeHubUrl('not a url')).toBeNull()
    expect(normalizeHubUrl('')).toBeNull()
  })
})

describe('pickHubUrl', () => {
  const buildDefault = 'http://localhost:8099'

  it('a valid ?api= param wins over stored and default', () => {
    const res = pickHubUrl({
      pageUrl: `https://192.168.1.5:8443/?${HUB_URL_PARAM}=https://192.168.1.5:8443/v1`,
      storedUrl: 'http://old-hub:9000',
      buildDefault,
    })
    expect(res).toEqual({ url: 'https://192.168.1.5:8443', source: 'query' })
  })

  it('an invalid ?api= param is ignored, not fatal', () => {
    const res = pickHubUrl({
      pageUrl: 'https://phone/?api=garbage',
      storedUrl: 'https://desktop:8443',
      buildDefault,
    })
    expect(res).toEqual({ url: 'https://desktop:8443', source: 'stored' })
  })

  it('stored hub survives page URLs without the param', () => {
    const res = pickHubUrl({ pageUrl: 'https://phone/', storedUrl: 'https://desktop:8443', buildDefault })
    expect(res).toEqual({ url: 'https://desktop:8443', source: 'stored' })
  })

  it('falls back to the build default when nothing is set', () => {
    expect(pickHubUrl({ pageUrl: null, storedUrl: null, buildDefault })).toEqual({
      url: buildDefault,
      source: 'default',
    })
    expect(pickHubUrl({ buildDefault })).toEqual({ url: buildDefault, source: 'default' })
  })

  it('ignores an unparsable page URL', () => {
    const res = pickHubUrl({ pageUrl: '::bad::', storedUrl: 'https://desktop:8443', buildDefault })
    expect(res).toEqual({ url: 'https://desktop:8443', source: 'stored' })
  })
})
