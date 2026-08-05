/**
 * One sound as an MP4, made on demand and kept.
 *
 * Discord will not play a link to a sound. It has never supported the
 * OpenGraph audio tags -- a maintainer said so in 2020 and it is still true --
 * and the player embeds it does render are reserved for a handful of
 * whitelisted music services. The one thing it plays from anybody's domain is
 * og:video pointing at an MP4, so that is what a shared sound has to be: the
 * Vorbis audio re-encoded to AAC, under a black frame, in an MP4 container.
 * cs.spiralp.xyz reaches the same conclusion and serves the same shape of
 * file.
 *
 * Only sounds somebody actually shares are ever built, and each one is built
 * once. The repo holds 38,000 sounds and this cache will hold the few dozen
 * that get linked, so it is small even though the corpus is not.
 *
 * This is the only server-side code in the project. It exists because
 * transcoding cannot happen in the browser that shares the link nor in the
 * crawler that reads it.
 */

import { spawn } from 'node:child_process'
import { createReadStream } from 'node:fs'
import { mkdir, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { dirname, join } from 'node:path'

const PORT = Number(process.env.MP4D_PORT ?? 8081)
const CACHE_ROOT = process.env.MP4D_CACHE ?? '/var/cache/chatsounds-mp4'
const UPSTREAM =
  process.env.MP4D_UPSTREAM ??
  'https://raw.githubusercontent.com/Metastruct/garrysmod-chatsounds/master/sound/chatsounds/autoadd'
/** Beyond this the oldest files go. A sound is tens of kilobytes. */
const MAX_CACHE_BYTES = Number(process.env.MP4D_MAX_CACHE ?? 512 * 1024 * 1024)
/** Nothing in the repo is close to this; it is a guard, not a policy. */
const MAX_SECONDS = Number(process.env.MP4D_MAX_SECONDS ?? 300)

/**
 * The same class the nginx locations use, against the decoded path. Every path
 * in the repo is lowercase letters, digits, space and . _ - ! ( ) +, plus one
 * typographic apostrophe. nginx has already rejected anything else before this
 * process sees it; this is the second lock on the same door, because the value
 * ends up in a filename and an argv.
 */
const SOUND_PATH = /^[a-z0-9 ._!()+\/\u0080-\uffff-]+\.ogg$/

/** Requests for a sound already being built wait on the first one. */
const inFlight = new Map()

const server = createServer((req, res) => {
  handle(req, res).catch((error) => {
    console.error('mp4d:', error?.message ?? error)
    if (!res.headersSent) res.writeHead(500)
    res.end()
  })
})

async function handle(req, res) {
  const match = /^\/mp4\/([^?#]+)\.mp4$/.exec(req.url ?? '')
  if (!match) return send(res, 404)

  let decoded
  try {
    decoded = decodeURIComponent(match[1])
  } catch {
    return send(res, 400)
  }

  const sound = `${decoded}.ogg`
  if (!SOUND_PATH.test(sound) || sound.includes('..')) return send(res, 404)

  const file = join(CACHE_ROOT, 'mp4', `${decoded}.mp4`)
  if (!(await exists(file))) {
    // nginx serves every later request for this sound straight off the disk;
    // this process only ever handles the first one.
    let job = inFlight.get(file)
    if (!job) {
      job = build(decoded, sound, file).finally(() => inFlight.delete(file))
      inFlight.set(file, job)
    }
    const built = await job
    if (!built) return send(res, 404)
  }

  const { size } = await stat(file)
  res.writeHead(200, {
    'Content-Type': 'video/mp4',
    'Content-Length': size,
    'Cache-Control': 'public, max-age=86400',
    'Access-Control-Allow-Origin': '*',
    'Cross-Origin-Resource-Policy': 'cross-origin',
  })
  if (req.method === 'HEAD') return res.end()
  createReadStream(file).pipe(res)
}

async function build(decoded, sound, file) {
  const encoded = sound.split('/').map(encodeURIComponent).join('/')
  const upstream = await fetch(`${UPSTREAM}/${encoded}`)
  if (!upstream.ok) {
    console.error(`mp4d: ${sound} -> ${upstream.status} from upstream`)
    return false
  }

  // Scratch space inside the cache, not /tmp: the cache is a mounted volume and
  // therefore a different filesystem, and rename cannot cross one (EXDEV).
  const scratch = join(CACHE_ROOT, 'tmp', `${process.pid}-${Date.now()}`)
  await mkdir(scratch, { recursive: true })
  const oggPath = join(scratch, 'in.ogg')
  const mp4Path = join(scratch, 'out.mp4')
  try {
    await writeFile(oggPath, Buffer.from(await upstream.arrayBuffer()))
    await ffmpeg(oggPath, mp4Path)
    await mkdir(dirname(file), { recursive: true })
    // Into place in one step, so nginx never finds a half-written file.
    await rename(mp4Path, file)
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
  await prune()
  console.log(`mp4d: built ${sound}`)
  return true
}

function ffmpeg(oggPath, mp4Path) {
  const args = [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    // Discord draws its own controls over the bottom of the video, so anything
    // in the frame is a picture nobody asked for sitting above a player. The
    // frame is therefore black, and it is 400x144 because that is the box
    // Discord reserves for embedded media, measured off the client: the
    // loading overlay it puts up before the video arrives is 400x144 CSS
    // pixels, and it holds that height afterwards whatever the video turns out
    // to be. Neither og:video:width/height nor an og:image moves it.
    //
    // So a flatter video buys no space back, it only leaves the difference
    // empty under the player. Filling the box exactly is what makes the embed
    // stop resizing as it loads and stop trailing dead space: same footprint
    // Discord was always going to take, with a player in it rather than a bar
    // and a hole.
    //
    // A generated colour source rather than an image on disk, so nothing has to
    // be built into the container for this.
    //
    // 15fps on a frame that never changes looks like waste and is not. The
    // frame rate is what decides how many frames a short sound gets, and most
    // chatsounds are short: at 2fps anything under half a second came out as a
    // one-frame video, which Discord answers with "Image failed to load". x264
    // spends almost nothing on a frame identical to the last and less than that
    // on a flat black one, so the whole difference between 2fps and 15fps is
    // about six percent of a file whose weight is all audio anyway.
    '-f',
    'lavfi',
    '-i',
    'color=c=black:s=400x144:r=15',
    '-i',
    oggPath,
    '-t',
    String(MAX_SECONDS),
    '-c:v',
    'libx264',
    '-tune',
    'stillimage',
    '-preset',
    'veryfast',
    '-crf',
    '30',
    // Without this the file plays nowhere: yuv420p is what every decoder
    // agrees on, and a generated frame does not arrive as one.
    '-pix_fmt',
    'yuv420p',
    // The source is Ogg Vorbis, already lossy, and this is a preview in a chat
    // client. Re-encoding it at 128k stereo spent bytes on detail the input
    // never had; mono at 64k is most of an embed's weight saved.
    '-c:a',
    'aac',
    '-ac',
    '1',
    '-b:a',
    '64k',
    // Stop when the audio does, rather than looping the image forever.
    '-shortest',
    // Moves the index to the front, so a player can start without the whole
    // file. A crawler fetching the first bytes cares about this.
    '-movflags',
    '+faststart',
    mp4Path,
  ]
  return new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    child.on('error', reject)
    child.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}: ${stderr.trim()}`)),
    )
  })
}

/** Oldest out first, once the cache passes its ceiling. */
async function prune() {
  const files = []
  let total = 0
  const walk = async (dir) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) await walk(path)
      else if (entry.isFile()) {
        const info = await stat(path)
        files.push({ path, mtime: info.mtimeMs, size: info.size })
        total += info.size
      }
    }
  }
  try {
    await walk(join(CACHE_ROOT, 'mp4'))
  } catch {
    return
  }
  if (total <= MAX_CACHE_BYTES) return

  files.sort((a, b) => a.mtime - b.mtime)
  for (const file of files) {
    if (total <= MAX_CACHE_BYTES) break
    await rm(file.path, { force: true })
    total -= file.size
    console.log(`mp4d: evicted ${file.path}`)
  }
}

async function exists(path) {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

function send(res, status) {
  res.writeHead(status)
  res.end()
}

// A crash mid-encode leaves scratch behind; it is worthless on the next start.
await rm(join(CACHE_ROOT, 'tmp'), { recursive: true, force: true })
await mkdir(join(CACHE_ROOT, 'mp4'), { recursive: true })
server.listen(PORT, '127.0.0.1', () => console.log(`mp4d: listening on 127.0.0.1:${PORT}`))
