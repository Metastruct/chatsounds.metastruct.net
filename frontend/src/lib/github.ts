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
 * comes from a fork: make sure one exists, branch from upstream's head (forks
 * share their network's object store, so a stale fork is no obstacle), commit
 * the sounds via the Git data API (they are binary, so blobs from base64), and
 * open the PR across repos. Every step is idempotent or freshly named, so a
 * failed run can simply be retried.
 */

export const UPSTREAM = { owner: 'Metastruct', repo: 'garrysmod-chatsounds', branch: 'master' }

/** Where a realm's sounds live in the repo. */
export const REALM_ROOT = 'sound/chatsounds/autoadd'

/**
 * Where one sound is shared from and streamed from, given its path under
 * REALM_ROOT. Both are paths on this origin, to be resolved against it.
 *
 * Not a raw.githubusercontent.com link, which is the obvious answer and the
 * wrong one: GitHub serves every .ogg as `content-disposition: attachment`, so
 * such a link downloads the file rather than playing it, and a chat client
 * offers no player and no name for it. This origin answers /s/ with a page
 * carrying that sound's Open Graph tags and /stream/ with the same bytes minus
 * the attachment header. Both are served by nginx, and by the dev server in
 * development; see docker/nginx.conf.template.
 */
export function soundSharePath(pathUnderRealmRoot: string): string {
  return `/s/${encodePathSegments(pathUnderRealmRoot)}`
}

export function soundStreamPath(pathUnderRealmRoot: string): string {
  return `/stream/${encodePathSegments(pathUnderRealmRoot)}`
}

/** Per segment, so the slashes survive but a space or a # does not end the path. */
function encodePathSegments(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/')
}

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

/**
 * One REST call. `allow` lists non-2xx statuses the caller wants to inspect
 * rather than have thrown, e.g. the 409 a fork sync answers when histories
 * diverged, or the 405 a merge answers when a method is disallowed.
 *
 * A null token means an anonymous call. Everything that writes needs a token,
 * but reading public repo data does not, and Explore reads plenty of it before
 * anyone signs in. The only cost is the rate limit: 60 an hour instead of 5000.
 */
async function api<T>(
  token: string | null,
  method: string,
  path: string,
  body?: unknown,
  allow: number[] = [409],
): Promise<{ status: number; data: T }> {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: {
      Accept: 'application/vnd.github+json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
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
  if (!response.ok && !allow.includes(response.status)) {
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

  // Cosmetic only: fast-forward the fork's default branch when possible so the
  // user's fork looks current. Correctness does not depend on it; the branch
  // below is cut from upstream's head, not the fork's. A 409 (histories
  // diverged) is let through by `api`, other failures are swallowed here.
  say('bringing the fork up to date', 0.12)
  try {
    await api(token, 'POST', `${forkPath}/merge-upstream`, { branch: fork.default_branch })
  } catch {
    /* fine, the fork stays as it is */
  }

  // Branch from upstream's head. Forks share the object store of their network,
  // so the fork accepts a ref to an upstream commit even when it has never been
  // synced; branching from the fork's own head instead would make a stale
  // fork's PR carry old history or phantom deletions.
  const upstreamSha = (
    await api<{ object: { sha: string } }>(
      token,
      'GET',
      `/repos/${UPSTREAM.owner}/${UPSTREAM.repo}/git/ref/heads/${UPSTREAM.branch}`,
    )
  ).data.object.sha

  const branch = `add-sounds-${Date.now().toString(36)}`
  say('starting a branch', 0.16)
  let baseSha = upstreamSha
  try {
    await api(token, 'POST', `${forkPath}/git/refs`, {
      ref: `refs/heads/${branch}`,
      sha: baseSha,
    })
  } catch {
    // A fork detached from the network rejects upstream shas (422); fall back
    // to its own head.
    baseSha = (
      await api<{ object: { sha: string } }>(
        token,
        'GET',
        `${forkPath}/git/ref/heads/${fork.default_branch}`,
      )
    ).data.object.sha
    await api(token, 'POST', `${forkPath}/git/refs`, {
      ref: `refs/heads/${branch}`,
      sha: baseSha,
    })
  }

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

// ---------------------------------------------------------------------------
// Reviewing

/**
 * Whether this user can review and merge in the upstream repo.
 *
 * `GET /repos/...` includes a `permissions` object for whoever asks; `push` is
 * the right a merge needs. No `permissions` at all means the token could not
 * see the repo that way, which for this purpose is the same as no.
 */
export async function canPush(token: string): Promise<boolean> {
  const { data } = await api<{ permissions?: { push?: boolean } }>(
    token,
    'GET',
    `/repos/${UPSTREAM.owner}/${UPSTREAM.repo}`,
  )
  return data.permissions?.push === true
}

export interface PrSummary {
  number: number
  title: string
  author: string
  createdAt: string
}

export async function listOpenPrs(token: string): Promise<PrSummary[]> {
  const { data } = await api<
    { number: number; title: string; user: { login: string }; created_at: string }[]
  >(token, 'GET', `/repos/${UPSTREAM.owner}/${UPSTREAM.repo}/pulls?state=open&per_page=100`)
  return data.map((pr) => ({
    number: pr.number,
    title: pr.title,
    author: pr.user.login,
    createdAt: pr.created_at,
  }))
}

export interface PrDetail {
  number: number
  title: string
  author: string
  headOwner: string
  headRepo: string
  /** The commit a file comment has to be anchored to. */
  headSha: string
  /** null while GitHub is still computing it. */
  mergeable: boolean | null
  mergeableState: string
  merged: boolean
  /** `open` or `closed`, so one closed elsewhere does not look actionable. */
  state: string
}

export async function getPrDetail(token: string, number: number): Promise<PrDetail> {
  const { data } = await api<{
    number: number
    title: string
    user: { login: string }
    head: { sha: string; repo: { name: string; owner: { login: string } } | null }
    mergeable: boolean | null
    mergeable_state: string
    merged: boolean
    state: string
  }>(token, 'GET', `/repos/${UPSTREAM.owner}/${UPSTREAM.repo}/pulls/${number}`)
  return {
    number: data.number,
    title: data.title,
    author: data.user.login,
    // A deleted fork leaves head.repo null; the files are then unreachable.
    headOwner: data.head.repo?.owner.login ?? '',
    headRepo: data.head.repo?.name ?? '',
    headSha: data.head.sha,
    mergeable: data.mergeable,
    mergeableState: data.mergeable_state,
    merged: data.merged,
    state: data.state,
  }
}

export interface PrChangedFile {
  path: string
  status: string
  sha: string
}

export async function listPrFiles(token: string, number: number): Promise<PrChangedFile[]> {
  const files: PrChangedFile[] = []
  for (let page = 1; ; page += 1) {
    const { data } = await api<{ filename: string; status: string; sha: string }[]>(
      token,
      'GET',
      `/repos/${UPSTREAM.owner}/${UPSTREAM.repo}/pulls/${number}/files?per_page=100&page=${page}`,
    )
    files.push(...data.map((f) => ({ path: f.filename, status: f.status, sha: f.sha })))
    if (data.length < 100) return files
  }
}

/**
 * A file's bytes, via its blob.
 *
 * The blobs API rather than the raw URL because it is served from
 * api.github.com, which sends the CORS headers this cross-origin-isolated page
 * needs, and because a token raises the limit from 60 calls an hour to 5000.
 * The token is optional: Explore plays sounds for signed-out visitors too, and
 * a public repo's blobs are readable without one.
 */
export async function fetchBlobBytes(
  token: string | null,
  owner: string,
  repo: string,
  sha: string,
): Promise<Uint8Array> {
  const { data } = await api<{ content: string; encoding: string }>(
    token,
    'GET',
    `/repos/${owner}/${repo}/git/blobs/${sha}`,
  )
  if (data.encoding !== 'base64') throw new Error(`GitHub sent a ${data.encoding} blob.`)
  // The content arrives base64 with newlines every 60 characters.
  const binary = atob(data.content.replace(/\n/g, ''))
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  return bytes
}

export interface ReviewEntry {
  id: number
  reviewer: string
  state: string
  body: string
  submittedAt: string
  url: string
}

/** Every submitted review, oldest first, as GitHub returns them. */
export async function listReviews(token: string, number: number): Promise<ReviewEntry[]> {
  const { data } = await api<
    {
      id: number
      user: { login: string }
      state: string
      body: string
      submitted_at: string
      html_url: string
    }[]
  >(token, 'GET', `/repos/${UPSTREAM.owner}/${UPSTREAM.repo}/pulls/${number}/reviews?per_page=100`)
  return data
    .filter((review) => review.state !== 'PENDING')
    .map((review) => ({
      id: review.id,
      reviewer: review.user.login,
      state: review.state,
      body: review.body ?? '',
      submittedAt: review.submitted_at,
      url: review.html_url,
    }))
}

export async function submitReview(
  token: string,
  number: number,
  event: 'APPROVE' | 'REQUEST_CHANGES',
  body: string,
): Promise<void> {
  await api(token, 'POST', `/repos/${UPSTREAM.owner}/${UPSTREAM.repo}/pulls/${number}/reviews`, {
    event,
    body,
  })
}

/** What the reviews so far add up to, for the list. */
export type PrStatus = 'approved' | 'changes' | 'waiting'

export function statusFrom(reviews: ReviewEntry[]): PrStatus {
  // Only the newest verdict from each reviewer counts, the way GitHub itself
  // reads them, and one request for changes outweighs any number of approvals.
  const latest = new Map<string, string>()
  for (const review of reviews) {
    if (review.state === 'APPROVED' || review.state === 'CHANGES_REQUESTED') {
      latest.set(review.reviewer, review.state)
    }
  }
  const verdicts = [...latest.values()]
  if (verdicts.includes('CHANGES_REQUESTED')) return 'changes'
  if (verdicts.includes('APPROVED')) return 'approved'
  return 'waiting'
}

export interface FileComment {
  /** Prefixed by source, so a review and a comment cannot collide. */
  id: string
  path: string
  body: string
  author: string
  url: string
  /**
   * Where it was left. `conversation` means it could not be attached to the
   * file, so it names the file in its first line instead.
   */
  origin: 'file' | 'conversation' | 'review'
}

/**
 * The `realm/name.ogg` a conversation comment is about, if it says so.
 *
 * Denying a sound writes the objection onto the file itself, but when that is
 * refused it falls back to the conversation and spells the file out first. This
 * reads that convention back, so those comments still appear under the sound
 * they are about rather than only on GitHub.
 *
 * Deliberately strict: only a leading backtick-quoted path followed by a colon
 * counts. Anything looser would start attributing ordinary discussion to files
 * because someone happened to mention a filename.
 */
export function fileRefFromComment(body: string): { ref: string; text: string } | null {
  const match = /^\s*`([^`\n]+\.ogg)`\s*:\s*([\s\S]+)$/i.exec(body)
  if (!match) return null
  return { ref: match[1].trim(), text: match[2].trim() }
}

export interface PrComment {
  id: number
  body: string
  author: string
  url: string
}

/** Comments on the pull request's conversation, as opposed to on its files. */
export async function listPrComments(token: string, number: number): Promise<PrComment[]> {
  const { data } = await api<
    { id: number; body: string; user: { login: string }; html_url: string }[]
  >(token, 'GET', `/repos/${UPSTREAM.owner}/${UPSTREAM.repo}/issues/${number}/comments?per_page=100`)
  return data.map((comment) => ({
    id: comment.id,
    body: comment.body ?? '',
    author: comment.user.login,
    url: comment.html_url,
  }))
}

/** Review comments left on files, as opposed to the conversation. */
export async function listFileComments(token: string, number: number): Promise<FileComment[]> {
  const { data } = await api<
    { id: number; path: string; body: string; user: { login: string }; html_url: string }[]
  >(token, 'GET', `/repos/${UPSTREAM.owner}/${UPSTREAM.repo}/pulls/${number}/comments?per_page=100`)
  return data.map((comment) => ({
    id: `f${comment.id}`,
    path: comment.path,
    body: comment.body,
    author: comment.user.login,
    url: comment.html_url,
    origin: 'file' as const,
  }))
}

/**
 * Comment on one file rather than on the pull request as a whole.
 *
 * `subject_type: 'file'` is what makes this land on the file itself instead of
 * a line in its diff, which matters here because these are `.ogg` files: they
 * have no diff to point at, so there is no line number to anchor to.
 */
export async function postFileComment(
  token: string,
  number: number,
  commitSha: string,
  path: string,
  body: string,
): Promise<FileComment> {
  const { data } = await api<{
    id: number
    path: string
    body: string
    user: { login: string }
    html_url: string
  }>(token, 'POST', `/repos/${UPSTREAM.owner}/${UPSTREAM.repo}/pulls/${number}/comments`, {
    body,
    commit_id: commitSha,
    path,
    subject_type: 'file',
  })
  return {
    id: `f${data.id}`,
    path: data.path,
    body: data.body,
    author: data.user.login,
    url: data.html_url,
    origin: 'file',
  }
}

/** A plain comment on the PR's conversation. */
export async function postPrComment(token: string, number: number, body: string): Promise<void> {
  await api(token, 'POST', `/repos/${UPSTREAM.owner}/${UPSTREAM.repo}/issues/${number}/comments`, {
    body,
  })
}

/**
 * Turn a pull request away without merging it.
 *
 * Separate from a denial: a denial asks for changes and leaves the request
 * open, this ends it. The author can still reopen on GitHub, which is why this
 * is not treated as destruction, but it is the one action here that stops
 * someone else's work, so the interface asks first.
 */
export async function closePr(token: string, number: number): Promise<void> {
  await api(token, 'PATCH', `/repos/${UPSTREAM.owner}/${UPSTREAM.repo}/pulls/${number}`, {
    state: 'closed',
  })
}

export async function mergePr(token: string, number: number): Promise<void> {
  const path = `/repos/${UPSTREAM.owner}/${UPSTREAM.repo}/pulls/${number}/merge`
  // The repo decides which methods it allows; a plain merge refused with a 405
  // is retried as a squash rather than surfaced.
  const first = await api<{ message?: string }>(token, 'PUT', path, { merge_method: 'merge' }, [405, 409])
  if (first.status < 300) return
  if (first.status === 405) {
    await api(token, 'PUT', path, { merge_method: 'squash' })
    return
  }
  throw new Error(first.data.message ? `GitHub: ${first.data.message}` : 'The merge was refused.')
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
