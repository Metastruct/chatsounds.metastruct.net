/**
 * Everything GitHub: signing in, and turning realm areas into a pull request.
 *
 * ## Why the device flow
 *
 * This app is static files on whatever host someone runs it on. The usual OAuth
 * web flow needs two things a static page cannot have: a client secret held
 * somewhere, and a redirect URL registered in advance, which self-hosters on
 * `localhost`, LAN addresses and their own domains could never share. The
 * device flow needs neither: the page shows a short code, the user types it at
 * github.com/login/device, and the page polls for its token with nothing but
 * the public client id.
 *
 * The one wrinkle is that GitHub's OAuth endpoints send no CORS headers, so the
 * browser cannot call them cross-origin. The two calls therefore go to
 * same-origin paths (`/github/device/code`, `/github/oauth/token`) that nginx,
 * and Vite in development, forward verbatim to github.com. The forwarder holds
 * no secret and no state; it exists only because of the missing header. The
 * REST API proper (api.github.com) does send CORS headers and is called
 * directly.
 *
 * ## Why a fork
 *
 * Nearly nobody has push access to the chatsounds repo, so the pull request
 * comes from a fork: make sure one exists, bring its default branch up to date,
 * branch, commit the sounds via the Git data API (they are binary, so blobs
 * from base64), and open the PR across repos. Every step is idempotent or
 * freshly named, so a failed run can simply be retried.
 */

export const UPSTREAM = { owner: 'Metastruct', repo: 'garrysmod-chatsounds', branch: 'master' }

/** Where a realm's sounds live in the repo. */
export const REALM_ROOT = 'sound/chatsounds/autoadd'

const API = 'https://api.github.com'

// ---------------------------------------------------------------------------
// Client id

let clientIdPromise: Promise<string> | null = null

/**
 * The OAuth app's public client id, from whoever hosts this copy.
 *
 * In the container, nginx answers `/github/app.json` from the
 * `GITHUB_CLIENT_ID` environment variable. In development the file does not
 * exist and `VITE_GITHUB_CLIENT_ID` fills in. An empty id means this copy was
 * never connected to GitHub, and the UI says so instead of failing later.
 */
export function fetchClientId(): Promise<string> {
  clientIdPromise ??= (async () => {
    try {
      const response = await fetch('/github/app.json')
      if (response.ok) {
        const parsed = (await response.json()) as { clientId?: string }
        if (parsed.clientId) return parsed.clientId
      }
    } catch {
      // No forwarder here (plain dev server); fall through to the env.
    }
    return (import.meta.env.VITE_GITHUB_CLIENT_ID as string | undefined) ?? ''
  })()
  return clientIdPromise
}

// ---------------------------------------------------------------------------
// Device flow

export interface DeviceCode {
  userCode: string
  verificationUri: string
  deviceCode: string
  intervalS: number
  expiresInS: number
}

export async function startDeviceFlow(clientId: string): Promise<DeviceCode> {
  const response = await fetch('/github/device/code', {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    // public_repo is enough to fork, push to the fork, and open the PR.
    body: JSON.stringify({ client_id: clientId, scope: 'public_repo' }),
  })
  if (!response.ok) {
    throw new Error(`GitHub did not hand out a sign-in code (${response.status}).`)
  }
  const data = (await response.json()) as {
    device_code: string
    user_code: string
    verification_uri: string
    interval?: number
    expires_in?: number
  }
  return {
    userCode: data.user_code,
    verificationUri: data.verification_uri,
    deviceCode: data.device_code,
    intervalS: data.interval ?? 5,
    expiresInS: data.expires_in ?? 900,
  }
}

/**
 * Poll until the user has typed the code, the code expires, or `signal` aborts.
 */
export async function waitForToken(
  clientId: string,
  device: DeviceCode,
  signal?: AbortSignal,
): Promise<string> {
  const deadline = Date.now() + device.expiresInS * 1000
  let intervalS = device.intervalS

  while (Date.now() < deadline) {
    await sleep(intervalS * 1000, signal)
    if (signal?.aborted) throw new Error('cancelled')

    const response = await fetch('/github/oauth/token', {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: clientId,
        device_code: device.deviceCode,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      }),
    })
    const data = (await response.json()) as {
      access_token?: string
      error?: string
      interval?: number
    }

    if (data.access_token) return data.access_token
    if (data.error === 'authorization_pending') continue
    if (data.error === 'slow_down') {
      intervalS = data.interval ?? intervalS + 5
      continue
    }
    if (data.error === 'expired_token') break
    if (data.error === 'access_denied') throw new Error('You said no on GitHub.')
    if (data.error) throw new Error(`GitHub sign-in failed (${data.error}).`)
  }
  throw new Error('The code expired before it was used. Try signing in again.')
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => {
      clearTimeout(timer)
      resolve()
    })
  })
}

// ---------------------------------------------------------------------------
// REST

async function api<T>(
  token: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; data: T }> {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  let data: unknown = null
  try {
    data = await response.json()
  } catch {
    // 204s and friends have no body.
  }
  if (!response.ok && response.status !== 409) {
    const message = (data as { message?: string })?.message
    throw new Error(message ? `GitHub: ${message}` : `GitHub answered ${response.status}.`)
  }
  return { status: response.status, data: data as T }
}

export interface GithubUser {
  login: string
  avatarUrl: string
}

export async function fetchUser(token: string): Promise<GithubUser> {
  const { data } = await api<{ login: string; avatar_url: string }>(token, 'GET', '/user')
  return { login: data.login, avatarUrl: data.avatar_url }
}

// ---------------------------------------------------------------------------
// The pull request

export interface PrFile {
  /** Path inside the repo, `sound/chatsounds/autoadd/<realm>/<name>.ogg`. */
  path: string
  file: File
}

export interface PrProgress {
  message: string
  /** 0..1 across the whole run. */
  fraction: number
}

export interface PrResult {
  url: string
  number: number
}

/** Where one realm file lands in the repo. Exported for the store and tests. */
export function repoPath(realm: string, filename: string): string {
  return `${REALM_ROOT}/${realm}/${filename}`
}

/**
 * Title and body for the pull request, from what is being sent.
 *
 * Pure, so the wording is testable: reviewers see this before they see the
 * files, and a wrong count here reads as a wrong upload.
 */
export function prSummary(
  realms: { realm: string; filenames: string[] }[],
): { title: string; body: string } {
  const total = realms.reduce((sum, entry) => sum + entry.filenames.length, 0)
  const names = realms.map((entry) => entry.realm)
  const title =
    realms.length === 1
      ? `Add ${total} ${total === 1 ? 'sound' : 'sounds'} to ${names[0]}`
      : `Add ${total} sounds to ${realms.length} realms`

  const sections = realms.map(
    (entry) =>
      `**${entry.realm}**\n` + entry.filenames.map((name) => `- \`${name}\``).join('\n'),
  )
  const body =
    sections.join('\n\n') +
    '\n\n---\nOpened with [chatsounds.metastruct.net](https://chatsounds.metastruct.net).'
  return { title, body }
}

export async function openPullRequest(
  token: string,
  files: PrFile[],
  summary: { title: string; body: string },
  onProgress: (progress: PrProgress) => void,
): Promise<PrResult> {
  const say = (message: string, fraction: number) => onProgress({ message, fraction })

  say('checking who you are', 0.02)
  const me = (await api<{ login: string }>(token, 'GET', '/user')).data.login

  // Forking is idempotent: POST returns the existing fork as happily as it
  // creates one, but creation is asynchronous, so poll until the repo answers.
  say('making sure you have a fork', 0.06)
  const fork = (
    await api<{ name: string; owner: { login: string }; default_branch: string }>(
      token,
      'POST',
      `/repos/${UPSTREAM.owner}/${UPSTREAM.repo}/forks`,
      { default_branch_only: true },
    )
  ).data

  const forkPath = `/repos/${fork.owner.login}/${fork.name}`
  for (let attempt = 0; ; attempt += 1) {
    try {
      await api(token, 'GET', `${forkPath}/git/ref/heads/${fork.default_branch}`)
      break
    } catch (error) {
      if (attempt >= 15) throw error
      await sleep(2000)
    }
  }

  // Best effort: a stale fork makes the PR diff carry unrelated history. A 409
  // (conflict) is let through by `api` and simply means we branch from where
  // the fork is.
  say('bringing the fork up to date', 0.12)
  try {
    await api(token, 'POST', `${forkPath}/merge-upstream`, { branch: fork.default_branch })
  } catch {
    /* the branch from the fork's own head still works */
  }

  const baseSha = (
    await api<{ object: { sha: string } }>(
      token,
      'GET',
      `${forkPath}/git/ref/heads/${fork.default_branch}`,
    )
  ).data.object.sha

  const branch = `add-sounds-${Date.now().toString(36)}`
  say('starting a branch', 0.16)
  await api(token, 'POST', `${forkPath}/git/refs`, {
    ref: `refs/heads/${branch}`,
    sha: baseSha,
  })

  // One blob per file. The tree API only takes text content inline, so binary
  // goes up as base64 blobs first.
  const entries: { path: string; mode: '100644'; type: 'blob'; sha: string }[] = []
  for (const [index, item] of files.entries()) {
    say(`uploading ${item.path.split('/').pop()} (${index + 1}/${files.length})`, 0.2 + 0.6 * (index / files.length))
    const blob = (
      await api<{ sha: string }>(token, 'POST', `${forkPath}/git/blobs`, {
        content: await asBase64(item.file),
        encoding: 'base64',
      })
    ).data
    entries.push({ path: item.path, mode: '100644', type: 'blob', sha: blob.sha })
  }

  say('committing', 0.84)
  const tree = (
    await api<{ sha: string }>(token, 'POST', `${forkPath}/git/trees`, {
      base_tree: baseSha,
      tree: entries,
    })
  ).data
  const commit = (
    await api<{ sha: string }>(token, 'POST', `${forkPath}/git/commits`, {
      message: summary.title,
      tree: tree.sha,
      parents: [baseSha],
    })
  ).data
  await api(token, 'PATCH', `${forkPath}/git/refs/heads/${branch}`, { sha: commit.sha })

  say('opening the pull request', 0.94)
  const pr = (
    await api<{ html_url: string; number: number }>(
      token,
      'POST',
      `/repos/${UPSTREAM.owner}/${UPSTREAM.repo}/pulls`,
      {
        title: summary.title,
        body: summary.body,
        head: `${me}:${branch}`,
        base: UPSTREAM.branch,
        maintainer_can_modify: true,
      },
    )
  ).data

  say('done', 1)
  return { url: pr.html_url, number: pr.number }
}

async function asBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer())
  // Chunked to stay under the argument-count limit `String.fromCharCode(...big)`
  // would hit on files past a few hundred kilobytes.
  let binary = ''
  const CHUNK = 0x8000
  for (let at = 0; at < bytes.length; at += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(at, at + CHUNK))
  }
  return btoa(binary)
}
