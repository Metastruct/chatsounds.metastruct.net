/**
 * Fetch a user-supplied media URL server-side and stream it back.
 *
 * The Extract tab wants to open direct links to audio and video, but the page
 * runs cross-origin-isolated (COEP require-corp, for SharedArrayBuffer) and
 * most file hosts send no CORS headers, so the browser cannot read them. This
 * fetches on the browser's behalf from the same origin instead.
 *
 * Fetching arbitrary URLs from the server is an SSRF surface: without a guard,
 * a link to http://169.254.169.254/ hands back a cloud VM's metadata (IAM
 * credentials on most providers), and a link to a 127.0.0.1 or LAN address
 * reaches services meant to be internal. So every connection resolves through
 * `guardedLookup`, which refuses private, loopback, link-local and metadata
 * addresses and pins the socket to the address it validated, closing the
 * resolve-then-reconnect gap. Redirects are followed by hand so each hop runs
 * the same check, the response must look like media, and the body is capped.
 *
 * Shared verbatim by docker/mp4d.mjs (production, behind nginx) and the dev
 * middleware in frontend/vite.config.ts, so the guard cannot drift between the
 * two.
 */

import dns from 'node:dns'
import http from 'node:http'
import https from 'node:https'
import { isIP } from 'node:net'

const MAX_BYTES = Number(process.env.FETCH_MAX_BYTES ?? 512 * 1024 * 1024)
const MAX_REDIRECTS = 5
const TIMEOUT_MS = Number(process.env.FETCH_TIMEOUT_MS ?? 30000)

// Anything that is not clearly audio or video is refused, so this cannot be
// turned into a general-purpose web proxy. octet-stream is here because plenty
// of file hosts label an mp3 that way; the decoder sniffs bytes regardless.
const ALLOWED_TYPE = /^(audio\/|video\/|application\/ogg\b|application\/octet-stream\b)/

/** Attach an HTTP status and a human reason to an error for the responder. */
function withMeta(error, status, reason) {
  error.status = status
  error.reason = reason
  return error
}

export function isBlockedAddress(ip) {
  const version = isIP(ip)
  if (version === 4) return isBlockedV4(ip)
  if (version === 6) return isBlockedV6(ip)
  // Not an address we can reason about, so do not connect to it.
  return true
}

function isBlockedV4(ip) {
  const p = ip.split('.').map(Number)
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true
  const [a, b] = p
  return (
    a === 0 || // "this" network
    a === 10 || // private
    (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
    a === 127 || // loopback
    (a === 169 && b === 254) || // link-local, and the cloud metadata endpoint
    (a === 172 && b >= 16 && b <= 31) || // private
    (a === 192 && b === 168) || // private
    (a === 198 && (b === 18 || b === 19)) || // benchmarking
    a >= 224 // multicast and reserved, up through 255.255.255.255
  )
}

function isBlockedV6(ip) {
  const address = ip.toLowerCase().split('%')[0] // drop any zone id
  // IPv4-mapped is really a v4 destination; judge it as one. Node writes it
  // either dotted (::ffff:1.2.3.4) or hex (::ffff:102:304), so handle both.
  const mapped = /^::ffff:(.+)$/.exec(address)
  if (mapped) {
    const tail = mapped[1]
    if (isIP(tail) === 4) return isBlockedV4(tail)
    const hex = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(tail)
    if (hex) {
      const hi = parseInt(hex[1], 16)
      const lo = parseInt(hex[2], 16)
      return isBlockedV4(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`)
    }
    return true // a mapped form we cannot read is not one we will dial
  }
  if (address === '::' || address === '::1') return true // unspecified, loopback
  const head = address.slice(0, 2)
  if (head === 'fc' || head === 'fd') return true // unique local
  if (head === 'ff') return true // multicast
  // Link-local and deprecated site-local, fe80::/10 through feff.
  if (/^fe[89ab-f]/.test(address)) return true
  return false
}

/**
 * A dns.lookup drop-in that validates every candidate address and hands back
 * only permitted ones. Because the socket connects to what this returns, a
 * hostname that resolves to a blocked address is never dialled, and there is no
 * second resolution to rebind.
 */
function guardedLookup(hostname, options, callback) {
  dns.lookup(hostname, { ...options, all: true }, (error, addresses) => {
    if (error) return callback(error)
    const safe = addresses.filter((entry) => !isBlockedAddress(entry.address))
    if (!safe.length) {
      return callback(
        withMeta(new Error('blocked address'), 403, 'that link points to an address this server will not reach'),
      )
    }
    if (options && options.all) return callback(null, safe)
    callback(null, safe[0].address, safe[0].family)
  })
}

function requestGuarded(url) {
  return new Promise((resolve, reject) => {
    const lib = url.protocol === 'https:' ? https : http
    const request = lib.request(
      url,
      { method: 'GET', lookup: guardedLookup, timeout: TIMEOUT_MS, headers: { 'User-Agent': 'chatsounds-media-proxy', Accept: '*/*' } },
      resolve,
    )
    request.on('timeout', () =>
      request.destroy(withMeta(new Error('timeout'), 504, 'that link took too long to answer')),
    )
    request.on('error', reject)
    request.end()
  })
}

async function stream(url, res, depth) {
  if (depth > MAX_REDIRECTS) {
    throw withMeta(new Error('too many redirects'), 502, 'that link redirects too many times')
  }
  // Node skips the lookup hook when the host is already an IP literal, so a
  // link straight to 127.0.0.1 or [::1] would connect unchecked. The hook still
  // covers hostnames; this covers the literals it never sees. URL.hostname
  // keeps the brackets on an IPv6 literal, so strip them before judging.
  const literal = url.hostname.replace(/^\[|\]$/g, '')
  if (isIP(literal) && isBlockedAddress(literal)) {
    throw withMeta(new Error('blocked address'), 403, 'that link points to an address this server will not reach')
  }
  const upstream = await requestGuarded(url)
  const status = upstream.statusCode ?? 0

  if (status >= 300 && status < 400 && upstream.headers.location) {
    upstream.resume() // let the socket close
    let next
    try {
      next = new URL(upstream.headers.location, url)
    } catch {
      throw withMeta(new Error('bad redirect'), 502, 'that link could not be reached')
    }
    if (next.protocol !== 'http:' && next.protocol !== 'https:') {
      throw withMeta(new Error('bad scheme'), 400, 'that link redirects somewhere unsupported')
    }
    return stream(next, res, depth + 1)
  }

  if (status !== 200) {
    upstream.resume()
    throw withMeta(new Error(`upstream ${status}`), 502, `that link answered ${status}`)
  }

  const type = (upstream.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase()
  if (type && !ALLOWED_TYPE.test(type)) {
    upstream.resume()
    throw withMeta(new Error('bad type'), 415, 'that link is not an audio or video file')
  }

  const length = Number(upstream.headers['content-length'])
  if (Number.isFinite(length) && length > MAX_BYTES) {
    upstream.resume()
    throw oversize()
  }

  res.statusCode = 200
  if (upstream.headers['content-type']) res.setHeader('Content-Type', upstream.headers['content-type'])
  if (Number.isFinite(length) && length > 0) res.setHeader('Content-Length', String(length))
  res.setHeader('Cache-Control', 'no-store')

  let received = 0
  upstream.on('data', (chunk) => {
    received += chunk.length
    if (received > MAX_BYTES) {
      // Headers are already out, so there is no clean error to send; cut it.
      upstream.destroy()
      res.destroy()
      return
    }
    if (!res.write(chunk)) upstream.pause()
  })
  res.on('drain', () => upstream.resume())
  upstream.on('end', () => res.end())
  upstream.on('error', () => {
    if (!res.writableEnded) res.destroy()
  })
}

function oversize() {
  return withMeta(
    new Error('too large'),
    413,
    `that file is over ${Math.round(MAX_BYTES / 1024 / 1024)} MB, which is more than this can take`,
  )
}

function fail(res, status, reason) {
  if (res.headersSent) {
    res.destroy()
    return
  }
  res.statusCode = status
  res.setHeader('Content-Type', 'text/plain; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')
  res.end(reason)
}

/** Stream the media at `rawUrl` to `res`, or answer it with a plain-text error. */
export async function proxyMedia(rawUrl, res) {
  if (!rawUrl) return fail(res, 400, 'no link was given')
  let target
  try {
    target = new URL(rawUrl)
  } catch {
    return fail(res, 400, 'that is not a valid link')
  }
  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    return fail(res, 400, 'only http and https links work')
  }

  try {
    await stream(target, res, 0)
  } catch (error) {
    fail(res, error?.status ?? 502, error?.reason ?? 'that link could not be reached')
  }
}
