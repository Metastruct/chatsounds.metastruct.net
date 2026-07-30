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
    // GitHub's OAuth endpoints send no CORS headers, so the sign-in calls go
    // through the page's own origin. nginx does the same forwarding in
    // production; see docker/nginx.conf.template.
    proxy: {
      '/github/device/code': {
        target: 'https://github.com',
        changeOrigin: true,
        rewrite: () => '/login/device/code',
      },
      '/github/oauth/token': {
        target: 'https://github.com',
        changeOrigin: true,
        rewrite: () => '/login/oauth/access_token',
      },
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
