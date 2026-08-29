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
        const match = /^\/(s|stream|mp4)\/([^?#]+)/.exec(req.url ?? '')
        if (!match) return next()

        const [, route, encoded] = match
        let decoded: string
        try {
          decoded = decodeURIComponent(encoded)
        } catch {
          return next()
        }
        // The mp4 route names a sound by its .mp4 rendering; what has to be a
        // legal sound path is the .ogg behind it.
        const asSound = route === 'mp4' ? decoded.replace(/\.mp4$/, '.ogg') : decoded
        // nginx resolves .. away before a location ever sees the URI; node
        // hands it over untouched, so it is rejected by hand here.
        if (!SOUND_PATH.test(asSound) || decoded.includes('..')) return next()

        if (route === 'stream') {
          void streamSound(encoded, res).catch(() => {
            res.statusCode = 502
            res.end()
          })
          return
        }

        if (route === 'mp4') {
          void buildMp4(encoded, decoded, res).catch((error: Error) => {
            server.config.logger.warn(`/mp4/: ${error.message}`)
            res.statusCode = 503
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
        res.end(sharePage({ realm, name, encoded, mp4: encoded.replace(/\.ogg$/, '.mp4'), origin }))
      })
    },
  }
}

/**
 * /yt/status and /yt/dl in development, which nginx serves in production; see
 * the "youtube" block in docker/nginx.conf.template, changed
 * together with this.
 *
 * API answers an empty status forever unless the Referer and Origin
 * look like its own site, and its download host sends no CORS headers at all,
 * so the browser can talk to neither directly. These routes forward the two
 * calls with the headers the service expects, and nothing else: the status
 * route takes only an 11-char video id, the download route only a host inside
 * the API's download domain, so neither is a proxy to anywhere.
 */
const MP3COW_HEADERS = {
  Referer: 'https://mp3cow.com/',
  Origin: 'https://mp3cow.com',
  'User-Agent':
    'Mozilla/5.0 (X11; Linux x86_64; rv:129.0) Gecko/20100101 Firefox/129.0',
  Accept: '*/*',
}
const YT_VIDEO_ID = /^[\w-]{11}$/
const YT_DOWNLOAD_HOST = /^([a-z0-9-]+\.)*wejfknwejfkerf\.org$/
const YT_DOWNLOAD_ID = /^[0-9a-f]+$/

// Only our own page may drive the proxy routes. Sec-Fetch-Site is set by the
// browser and page script cannot forge it, so same-origin is the real gate;
// Origin and Referer are belt and braces, and since a same-origin GET carries
// no Origin, each is refused only when present and foreign. Kept in step with
// the maps in the nginx templates. localhost is allowed so the dev server and
// the docker quickstart work; the deployment is chatsounds.metastruct.net.
const PROXY_PATHS = new Set(['/yt/status', '/yt/dl', '/fetch'])
const proxyOriginOk = (origin?: string) =>
  !origin ||
  origin === 'https://chatsounds.metastruct.net' ||
  /^https?:\/\/localhost(:\d+)?$/.test(origin) ||
  /^https?:\/\/127\.0\.0\.1(:\d+)?$/.test(origin)
const proxyRefererOk = (referer?: string) =>
  !referer ||
  /^https:\/\/chatsounds\.metastruct\.net\//.test(referer) ||
  /^https?:\/\/localhost(:\d+)?\//.test(referer) ||
  /^https?:\/\/127\.0\.0\.1(:\d+)?\//.test(referer)
function fromOwnPage(req: import('node:http').IncomingMessage): boolean {
  return (
    req.headers['sec-fetch-site'] === 'same-origin' &&
    proxyOriginOk(req.headers.origin) &&
    proxyRefererOk(req.headers.referer)
  )
}

function ytRoutes(): Plugin {
  return {
    name: 'chatsounds-yt-routes',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = new URL(req.url ?? '', 'http://localhost')

        if (PROXY_PATHS.has(url.pathname) && !fromOwnPage(req)) {
          res.statusCode = 403
          return res.end()
        }

        if (url.pathname === '/yt/status') {
          const id = url.searchParams.get('id') ?? ''
          if (!YT_VIDEO_ID.test(id)) {
            res.statusCode = 403
            return res.end()
          }
          void ytStatus(id, res).catch(() => {
            res.statusCode = 502
            res.end()
          })
          return
        }

        if (url.pathname === '/yt/dl') {
          const host = url.searchParams.get('h') ?? ''
          const id = url.searchParams.get('i') ?? ''
          if (!YT_DOWNLOAD_HOST.test(host) || !YT_DOWNLOAD_ID.test(id)) {
            res.statusCode = 403
            return res.end()
          }
          void ytDownload(host, id, res).catch(() => {
            res.statusCode = 502
            res.end()
          })
          return
        }

        // Direct audio/video links, through the same SSRF-guarded fetch mp4d
        // runs in production. Same module, so the guard cannot drift.
        if (url.pathname === '/fetch') {
          void import('../docker/mediaProxy.mjs')
            .then(({ proxyMedia }) => proxyMedia(url.searchParams.get('url'), res))
            .catch(() => {
              res.statusCode = 502
              res.end()
            })
          return
        }

        next()
      })
    },
  }
}

async function ytStatus(id: string, res: import('node:http').ServerResponse) {
  const upstream = await fetch(`https://api.mp3cow.com/z.php?id=${id}&t=${Date.now()}`, {
    headers: MP3COW_HEADERS,
  })
  res.statusCode = upstream.status
  res.setHeader('Content-Type', 'application/json')
  res.end(Buffer.from(await upstream.arrayBuffer()))
}

async function ytDownload(
  host: string,
  id: string,
  res: import('node:http').ServerResponse,
) {
  const upstream = await fetch(`https://${host}/dl.php?id=${id}`, {
    headers: MP3COW_HEADERS,
  })
  if (!upstream.ok || !upstream.body) {
    res.statusCode = upstream.status || 502
    return res.end()
  }
  res.statusCode = 200
  res.setHeader('Content-Type', upstream.headers.get('content-type') ?? 'audio/mpeg')
  const length = upstream.headers.get('content-length')
  if (length) res.setHeader('Content-Length', length)
  // Piped rather than buffered: this one can be a whole video's worth of mp3.
  const { Readable } = await import('node:stream')
  Readable.fromWeb(upstream.body as import('node:stream/web').ReadableStream).pipe(res)
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

/**
 * The dev-time stand-in for mp4d (docker/mp4d.mjs), which nginx runs in
 * production. Same ffmpeg invocation, so what embeds here embeds there; it
 * just keeps its handful of files under node_modules/.cache and needs ffmpeg
 * on PATH, warning rather than failing when there is none.
 */
async function buildMp4(encoded: string, decoded: string, res: import('node:http').ServerResponse) {
  const { mkdir, readFile, writeFile } = await import('node:fs/promises')
  const { dirname, resolve } = await import('node:path')

  const cache = resolve('node_modules/.cache/chatsounds-mp4', decoded)
  let bytes: Buffer | null = null
  try {
    bytes = await readFile(cache)
  } catch {
    const upstream = await fetch(`${UPSTREAM_RAW}/${encoded.replace(/\.mp4$/, '.ogg')}`)
    if (!upstream.ok) {
      res.statusCode = upstream.status
      return res.end()
    }
    await mkdir(dirname(cache), { recursive: true })
    const oggPath = `${cache}.ogg`
    await writeFile(oggPath, Buffer.from(await upstream.arrayBuffer()))
    await ffmpegRun(SOUND_TO_MP4(oggPath, cache))
    bytes = await readFile(cache)
  }

  res.statusCode = 200
  res.setHeader('Content-Type', 'video/mp4')
  res.setHeader('Content-Length', bytes.length)
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin')
  res.end(bytes)
}

/**
 * Kept in step with the argument list in docker/mp4d.mjs, including the black
 * 400x144 frame, which is the box Discord reserves for embedded media whatever
 * the video's own size says. The reasoning is there.
 */
// biome-ignore format: reads as one command line
const SOUND_TO_MP4 = (oggPath: string, out: string) => [
  '-hide_banner', '-loglevel', 'error', '-y',
  '-f', 'lavfi', '-i', 'color=c=black:s=400x144:r=15',
  '-i', oggPath,
  '-t', '300',
  '-c:v', 'libx264', '-tune', 'stillimage', '-preset', 'veryfast', '-crf', '30',
  '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-ac', '1', '-b:a', '64k',
  '-shortest', '-movflags', '+faststart', out,
]

async function ffmpegRun(args: string[]): Promise<void> {
  const { spawn } = await import('node:child_process')
  return new Promise((ok, fail) => {
    const child = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    child.on('error', () => fail(new Error('ffmpeg is not on PATH, so /mp4/ cannot answer here')))
    child.on('close', (code) => (code === 0 ? ok() : fail(new Error(stderr.trim()))))
  })
}

function sharePage(s: {
  realm: string
  name: string
  encoded: string
  mp4: string
  origin: string
}): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="dark">
<title>${s.name} in ${s.realm} - Meta Construct chatsounds</title>
<link rel="canonical" href="${s.origin}/s/${s.encoded}">
<meta name="theme-color" content="#212121">
<meta property="og:video" content="${s.origin}/mp4/${s.mp4}">
<meta property="og:video:secure_url" content="${s.origin}/mp4/${s.mp4}">
<meta property="og:video:type" content="video/mp4">
<meta property="og:video:width" content="400">
<meta property="og:video:height" content="144">
<meta property="twitter:card" content="player">
<meta property="twitter:player:stream" content="${s.origin}/mp4/${s.mp4}">
<meta property="twitter:player:stream:content_type" content="video/mp4">
<meta property="twitter:player:width" content="400">
<meta property="twitter:player:height" content="144">
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
  plugins: [react(), shareRoutes(), ytRoutes()],
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
