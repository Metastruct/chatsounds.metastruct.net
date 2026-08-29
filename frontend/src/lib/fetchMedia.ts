/**
 * Turning a pasted link into a File the pipeline can decode.
 *
 * Direct links are fetched through the same-origin `/fetch` route rather than
 * from the browser: the page runs under COEP require-corp and most file hosts
 * send no CORS headers, so a direct browser fetch would be blocked before a
 * byte arrives. The route (nginx to mp4d in production, a vite middleware in
 * development) fetches server-side behind an SSRF guard.
 *
 * YouTube links go through a converter. Its API answers an eternal
 * `{"status": ""}` unless the Referer and Origin look like the API's DNS, and the
 * download host sends no CORS headers at all, so both calls run through the
 * same-origin `/yt/` routes (nginx in production, a vite middleware in
 * development) that set the headers the service expects. The protocol is
 * polling: the same GET every few seconds until the conversion lands.
 */

import { ACCEPTED_EXTENSIONS } from '../pipeline/decode'

/** Their own site's pattern; the capture must then be an 11-char video id. */
const YOUTUBE =
  /^.*(youtu\.be\/|v\/|u\/\w\/|embed\/|watch\?v=|&v=|youtube\.com\/shorts\/)([^#&?]*).*/

export function youtubeId(url: string): string | null {
  const id = YOUTUBE.exec(url)?.[2] ?? ''
  return /^[\w-]{11}$/.test(id) ? id : null
}

const EXTENSION_FOR_TYPE: Record<string, string> = {
  'audio/mpeg': '.mp3',
  'audio/ogg': '.ogg',
  'audio/wav': '.wav',
  'audio/flac': '.flac',
  'video/webm': '.webm',
  'video/mp4': '.mp4',
  'audio/mp4': '.m4a',
  'audio/aac': '.aac',
}

/**
 * A filename for a fetched URL: the path's basename, with an extension the
 * decoder accepts. When the path carries none, the Content-Type picks one, and
 * failing that `.mp3` is appended so the decode gets attempted anyway:
 * decodeAudioData sniffs bytes, not names, so the extension gate is the only
 * thing a wrong guess could trip.
 */
export function filenameFromUrl(finalUrl: string, contentType: string | null): string {
  let base = ''
  let host = 'download'
  try {
    const url = new URL(finalUrl)
    host = url.hostname
    base = url.pathname.split('/').filter(Boolean).pop() ?? ''
    try {
      base = decodeURIComponent(base)
    } catch {
      /* keep it encoded */
    }
  } catch {
    /* not a URL, the host fallback carries it */
  }
  if (!base) base = host

  const extension = /\.[^.]+$/.exec(base)?.[0]?.toLowerCase()
  if (extension && ACCEPTED_EXTENSIONS.includes(extension)) return base

  const type = (contentType ?? '').split(';')[0].trim().toLowerCase()
  return base + (EXTENSION_FOR_TYPE[type] ?? '.mp3')
}

export type Mp3cowResult =
  | { kind: 'pending' }
  | { kind: 'done'; download: string; title: string }
  | { kind: 'failed'; message: string }

/**
 * One poll answer, interpreted. "" and "3" are the converter still working;
 * "1" is done; "0" is its own error with a message; "c" is a captcha and "p"
 * an ad interstitial, both dead ends for a page that is not their website.
 */
export function interpretMp3cow(body: unknown): Mp3cowResult {
  const data = (body ?? {}) as Record<string, unknown>
  const status = typeof data.status === 'string' ? data.status : null

  if (status === '' || status === '3') return { kind: 'pending' }
  if (status === '1') {
    if (typeof data.download === 'string' && data.download) {
      const title = typeof data.title === 'string' && data.title ? data.title : 'youtube audio'
      return { kind: 'done', download: data.download, title }
    }
    return { kind: 'failed', message: 'the converter finished without a download link' }
  }
  if (status === '0') {
    const message =
      typeof data.message === 'string' && data.message
        ? data.message
        : 'the converter refused this video'
    return { kind: 'failed', message }
  }
  if (status === 'c') {
    return { kind: 'failed', message: 'the converter is asking for a captcha, try again in a while' }
  }
  return { kind: 'failed', message: 'the converter answered something unexpected' }
}

/**
 * The same allowlist the nginx route enforces, checked here first so a
 * surprising download host fails with a sentence instead of a proxied 403.
 */
const DOWNLOAD_HOST = /^([a-z0-9-]+\.)*wejfknwejfkerf\.org$/

/** The converter's download URL, rewritten onto the same-origin proxy route. */
export function ytDownloadPath(download: string): string {
  let url: URL
  try {
    url = new URL(download)
  } catch {
    throw new Error('the converter answered with a download link that is not a link')
  }
  const id = url.searchParams.get('id') ?? ''
  if (!DOWNLOAD_HOST.test(url.hostname) || !/^[0-9a-f]+$/.test(id)) {
    throw new Error('the converter moved to a download host this site does not know yet')
  }
  return `/yt/dl?h=${url.hostname}&i=${id}`
}

/** A direct link, routed through the same-origin SSRF-guarded fetch. */
export function directFetchPath(url: string): string {
  return `/fetch?url=${encodeURIComponent(url)}`
}

export async function resolveYoutube(
  videoId: string,
  onWait: (elapsedS: number) => void,
  { pollMs = 5000, timeoutMs = 180000 }: { pollMs?: number; timeoutMs?: number } = {},
): Promise<{ download: string; title: string }> {
  const startedAt = Date.now()
  for (;;) {
    // A single bad poll proves nothing; only a 4xx from the route or the
    // overall timeout ends the wait early.
    let result: Mp3cowResult = { kind: 'pending' }
    try {
      const response = await fetch(`/yt/status?id=${videoId}&t=${Date.now()}`)
      if (response.ok) result = interpretMp3cow(await response.json())
      else if (response.status < 500) {
        throw new Error(`the converter route answered ${response.status}`)
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('the converter route')) throw error
    }

    if (result.kind === 'done') return result
    if (result.kind === 'failed') throw new Error(result.message)

    const elapsed = Date.now() - startedAt
    if (elapsed >= timeoutMs) throw new Error('the conversion took too long, try again later')
    onWait(Math.round(elapsed / 1000))
    await sleep(pollMs)
  }
}

/** Past this the fetch stops; decoding to PCM multiplies whatever comes in. */
export const MAX_FETCH_BYTES = 512 * 1024 * 1024

export async function fetchAsFile(
  url: string,
  opts: {
    name?: string
    /** URL to name the file after, when `url` is a proxy path. */
    nameFromUrl?: string
    onProgress?: (loaded: number, total: number) => void
    maxBytes?: number
  } = {},
): Promise<File> {
  const maxBytes = opts.maxBytes ?? MAX_FETCH_BYTES

  let response: Response
  try {
    response = await fetch(url)
  } catch {
    throw new Error('the download did not go through, check the connection and try again')
  }
  if (!response.ok) {
    // The /fetch and /yt routes answer failures with a plain-text reason.
    const reason = (await response.text().catch(() => '')).trim()
    throw new Error(reason || `the download answered ${response.status}`)
  }

  const contentType = response.headers.get('Content-Type')
  if ((contentType ?? '').toLowerCase().startsWith('text/html')) {
    throw new Error('that link is a web page, not a media file')
  }

  const name = opts.name ?? filenameFromUrl(opts.nameFromUrl ?? response.url ?? url, contentType)
  const total = Number(response.headers.get('Content-Length')) || 0

  if (!response.body) {
    const blob = await response.blob()
    if (blob.size > maxBytes) throw oversize(maxBytes)
    return new File([blob], name)
  }

  const reader = response.body.getReader()
  const chunks: BlobPart[] = []
  let loaded = 0
  opts.onProgress?.(0, total)
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
    loaded += value.byteLength
    if (loaded > maxBytes) {
      await reader.cancel()
      throw oversize(maxBytes)
    }
    opts.onProgress?.(loaded, total)
  }
  return new File(chunks, name)
}

function oversize(maxBytes: number): Error {
  return new Error(
    `that file passed ${Math.round(maxBytes / 1024 / 1024)} MB, which is more than this page can hold`,
  )
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
