/// <reference types="vite/client" />

declare module '*.wasm?url' {
  const src: string
  export default src
}

interface WorkerGlobalScope {
  onmessage: ((ev: MessageEvent) => void) | null
  postMessage: (msg: unknown) => void
}
