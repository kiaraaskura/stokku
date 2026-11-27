/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

// Rewrites dist/sw.js after the build: injects the real PRECACHE list (all
// content-hashed assets plus the static public files) and a per-build VERSION
// hash. This makes a freshly installed service worker able to serve the whole
// app offline on the very first visit, and makes sw.js bytes change with every
// build so browsers detect updates. Registration is production-only (main.tsx).
function swPrecache(outDir: string) {
  return {
    name: 'stokku-sw-precache',
    apply: 'build' as const,
    closeBundle() {
      const dist = resolve(outDir)
      const hashed = readdirSync(resolve(dist, 'assets')).map((f) => `assets/${f}`)
      const statics = [
        '/',
        '/manifest.webmanifest',
        '/apple-touch-icon.png',
        '/icon.svg',
        '/icons/icon-192.png',
        '/icons/icon-512.png',
        '/icons/maskable-512.png',
      ]
      const precache = [...statics, ...hashed]
      const build = createHash('sha256').update(precache.join(' ')).digest('hex').slice(0, 12)
      const swPath = resolve(dist, 'sw.js')
      let sw = readFileSync(swPath, 'utf8')
      sw = sw.replace('const PRECACHE = []', `const PRECACHE = ${JSON.stringify(precache)}`)
      sw = sw.replace("const VERSION = 'stokku-dev'", `const VERSION = 'stokku-${build}'`)
      writeFileSync(swPath, sw)
    },
  }
}

export default defineConfig({
  plugins: [react(), swPrecache('dist')],
  build: {
    target: 'es2022',
  },
  server: {
    port: 5173,
    host: true,
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
})
