import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // The dev server has to reproduce the production headers, or the pipeline
    // silently drops to single-threaded WebAssembly while developing.
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
  worker: { format: 'es' },
  build: {
    outDir: 'dist',
    sourcemap: false,
    // onnxruntime ships multi-megabyte wasm binaries as assets; the warning is
    // expected and not actionable.
    chunkSizeWarningLimit: 2048,
  },
})
