import react from '@vitejs/plugin-react'
import { type Plugin, defineConfig } from 'vite'

const UPSTREAM_RAW =
  'https://raw.githubusercontent.com/Metastruct/garrysmod-chatsounds/master/sound/chatsounds/autoadd'

/**
 * The same character class the nginx locations use, against the decoded path.
 * Every path in the repo is lowercase letters, digits, space and . _ - ! ( ) +,
 * plus one typographic apostrophe, so anything carrying an HTML metacharacter
 * fails here exactly as it fails to match a location in production.
 */
const SOUND_PATH = /^[a-z0-9 ._!()+\/\u0080-\uffff-]+\.ogg$/

/**
 * /s/ and /stream/ in development, which nginx serves in production.
 *
 * Duplicated rather than shared because the production copy is nginx
 * configuration and cannot be imported; the two have to be changed together.
 * See the "sharing one sound" block in docker/nginx.conf.template, which this
 * mirrors down to the markup.
 */
function shareRoutes(): Plugin {
  return {
    name: 'chatsounds-share-routes',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const match = /^\/(s|stream)\/([^?#]+)/.exec(req.url ?? '')
        if (!match) return next()

        const [, route, encoded] = match
        let decoded: string
        try {
          decoded = decodeURIComponent(encoded)
        } catch {
          return next()
        }
        // nginx resolves .. away before a location ever sees the URI; node
        // hands it over untouched, so it is rejected by hand here.
        if (!SOUND_PATH.test(decoded) || decoded.includes('..')) return next()

        if (route === 'stream') {
          void streamSound(encoded, res).catch(() => {
            res.statusCode = 502
            res.end()
          })
          return
        }

        const slash = decoded.indexOf('/')
        if (slash < 0) return next()
        const realm = decoded.slice(0, slash)
        const name = decoded.slice(slash + 1).replace(/\.ogg$/, '')
        const origin = `http://${req.headers.host ?? 'localhost:5173'}`

        res.statusCode = 200
        res.setHeader('Content-Type', 'text/html; charset=utf-8')
        // The dev server sets COOP/COEP globally; this page wants neither, and
        // production does not send them here either.
        res.removeHeader('Cross-Origin-Opener-Policy')
        res.removeHeader('Cross-Origin-Embedder-Policy')
        res.end(sharePage({ realm, name, encoded, origin }))
      })
    },
  }
}

async function streamSound(encoded: string, res: import('node:http').ServerResponse) {
  const upstream = await fetch(`${UPSTREAM_RAW}/${encoded}`)
  if (!upstream.ok || !upstream.body) {
    res.statusCode = upstream.status
    res.end()
    return
  }
  res.statusCode = 200
  // Everything except content-disposition, which is what makes a link to
  // GitHub download the sound instead of playing it.
  res.setHeader('Content-Type', upstream.headers.get('content-type') ?? 'audio/ogg')
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin')
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.end(Buffer.from(await upstream.arrayBuffer()))
}

function sharePage(s: { realm: string; name: string; encoded: string; origin: string }): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="dark">
<title>${s.name} in ${s.realm} - Meta Construct chatsounds</title>
<link rel="canonical" href="${s.origin}/s/${s.encoded}">
<meta name="theme-color" content="#212121">
<meta property="og:type" content="music.song">
<meta property="og:site_name" content="Meta Construct">
<meta property="og:title" content="${s.name}">
<meta property="og:description" content="a chatsound in ${s.realm}">
<meta property="og:url" content="${s.origin}/s/${s.encoded}">
<meta property="og:audio" content="${s.origin}/stream/${s.encoded}">
<meta property="og:audio:secure_url" content="${s.origin}/stream/${s.encoded}">
<meta property="og:audio:type" content="audio/ogg">
<link rel="icon" type="image/x-icon" href="/favicon.ico">
<style>
body{margin:0;min-height:100vh;display:grid;place-items:center;background:#212121;color:#fefefe;font-family:system-ui,-apple-system,sans-serif}
main{padding:2rem;max-width:34rem;text-align:center}
.realm{margin:0;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:.85rem;color:rgba(254,254,254,.5)}
h1{margin:.3rem 0 1.4rem;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:1.4rem;font-weight:600;overflow-wrap:anywhere}
audio{width:100%}
a{display:inline-block;margin-top:1.6rem;color:#09b387;font-size:.85rem}
</style>
</head>
<body>
<main>
<p class="realm">${s.realm}/</p>
<h1>${s.name}</h1>
<audio controls autoplay preload="auto" src="/stream/${s.encoded}"></audio>
<p><a href="/">every chatsound at Meta Construct</a></p>
</main>
</body>
</html>
`
}

export default defineConfig({
  plugins: [react(), shareRoutes()],
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
