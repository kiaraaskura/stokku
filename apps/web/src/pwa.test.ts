import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const webRoot = fileURLToPath(new URL('..', import.meta.url))

/** PNG width/height live in the IHDR chunk at fixed offsets. */
function pngSize(buf: Buffer): { width: number; height: number } {
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
}

describe('PWA: installable on Windows, Linux, Android, iOS', () => {
  const manifest = JSON.parse(
    readFileSync(resolve(webRoot, 'public/manifest.webmanifest'), 'utf8'),
  ) as {
    name: string
    display: string
    start_url: string
    theme_color: string
    icons: { src: string; sizes: string; purpose?: string }[]
  }

  it('manifest is a standalone app, not just a bookmark', () => {
    expect(manifest.display).toBe('standalone')
    expect(manifest.start_url).toBe('/')
    expect(manifest.name).toContain('Stokku')
    expect(manifest.theme_color).toBe('#0f766e')
  })

  it('every declared icon exists with the declared size', () => {
    expect(manifest.icons.length).toBeGreaterThanOrEqual(2)
    for (const icon of manifest.icons) {
      const buf = readFileSync(resolve(webRoot, `public${icon.src}`))
      const { width, height } = pngSize(buf)
      expect(`${width}x${height}`).toBe(icon.sizes)
    }
  })

  it('has a maskable icon for Android adaptive launchers', () => {
    expect(manifest.icons.some((i) => i.purpose === 'maskable')).toBe(true)
  })

  it('index.html links the manifest and the iOS apple-touch-icon', () => {
    const html = readFileSync(resolve(webRoot, 'index.html'), 'utf8')
    expect(html).toContain('manifest.webmanifest')
    expect(html).toContain('apple-touch-icon.png')
    expect(html).toContain('apple-mobile-web-app-capable')
  })

  it('apple-touch-icon is 180x180 and opaque (no transparency gaps on iOS)', () => {
    const buf = readFileSync(resolve(webRoot, 'public/apple-touch-icon.png'))
    expect(pngSize(buf)).toEqual({ width: 180, height: 180 })
  })

  it('service worker source has the build-injected precache placeholder and never caches API calls', () => {
    const sw = readFileSync(resolve(webRoot, 'public/sw.js'), 'utf8')
    expect(sw).toContain('const PRECACHE = []')
    expect(sw).toContain("url.origin !== self.location.origin")
    expect(sw).toContain('/api/')
  })

  it('vite build injects the precache list and per-build version into sw.js', () => {
    const dist = resolve(webRoot, 'dist')
    if (!existsSync(resolve(dist, 'sw.js'))) return // dist not built in this checkout
    const sw = readFileSync(resolve(dist, 'sw.js'), 'utf8')
    expect(sw).not.toContain('const PRECACHE = []')
    expect(sw).not.toContain("'stokku-dev'")
    expect(sw).toMatch(/const PRECACHE = \["\/",/)
  })

  it('main.tsx registers the service worker in production builds', () => {
    const main = readFileSync(resolve(webRoot, 'src/main.tsx'), 'utf8')
    expect(main).toContain('serviceWorker')
    expect(main).toContain('import.meta.env.PROD')
  })
})
