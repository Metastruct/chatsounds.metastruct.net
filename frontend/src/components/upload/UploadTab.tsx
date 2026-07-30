import { useEffect, useState } from 'react'
import {
  type PrProgress,
  type PrResult,
  openPullRequest,
  prSummary,
  repoPath,
} from '../../lib/github'
import { fetchRealms } from '../../lib/realms'
import { useGithub } from '../../store/useGithub'
import { useUpload } from '../../store/useUpload'
import { RealmSection } from './RealmSection'

/**
 * The Upload form: realms, the sounds going into each, and the pull request.
 *
 * The form's output is a PR against the chatsounds repo, opened from the
 * user's fork. Signing in uses GitHub's device flow, so the page never sees a
 * password and this host never holds a secret; the user types a short code on
 * github.com and comes back.
 */
export function UploadTab() {
  const areas = useUpload((state) => state.areas)
  const addArea = useUpload((state) => state.addArea)
  const resetAreas = useUpload((state) => state.reset)

  const github = useGithub()

  const [realms, setRealms] = useState<string[]>([])
  const [progress, setProgress] = useState<PrProgress | null>(null)
  const [result, setResult] = useState<PrResult | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void fetchRealms().then(setRealms)
    void github.init()
    // init() settles once; the store ignores repeat calls.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const total = areas.reduce((sum, area) => sum + area.files.length, 0)
  const named = areas.every((area) => area.realm || !area.files.length)

  const submit = async () => {
    if (!github.token) return
    const filled = areas.filter((area) => area.realm && area.files.length)
    const files = filled.flatMap((area) =>
      area.files.map((file) => ({ path: repoPath(area.realm, file.targetName), file: file.file })),
    )
    const summary = prSummary(
      filled.map((area) => ({
        realm: area.realm,
        filenames: area.files.map((file) => file.targetName),
      })),
    )

    setError(null)
    setResult(null)
    setProgress({ message: 'starting', fraction: 0 })
    try {
      const pr = await openPullRequest(github.token, files, summary, setProgress)
      setResult(pr)
      resetAreas()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setProgress(null)
    }
  }

  const submitting = progress !== null

  return (
    <div className="container section upload-tab">
      <h1 className="title is-4">Upload sounds</h1>
      <p className="muted">
        Sort your sounds into realms, the group they belong to in game.
      </p>

      <div className="realm-list">
        {areas.map((area) => (
          <RealmSection key={area.id} area={area} realms={realms} />
        ))}
      </div>

      <button type="button" className="button" onClick={addArea}>
        + add a realm
      </button>

      <div className="upload-foot">
        {github.status === 'signed-in' && github.user ? (
          <>
            <button
              type="button"
              className="button is-primary"
              disabled={submitting || !total || !named}
              onClick={() => void submit()}
            >
              {submitting ? 'Sending…' : 'Open the pull request'}
            </button>
            <span className="signed-in">
              <img src={github.user.avatarUrl} alt="" className="gh-avatar" />
              {github.user.login}
            </span>
            <button type="button" className="button is-small" onClick={github.signOut}>
              sign out
            </button>
          </>
        ) : github.status === 'authorizing' && github.device ? (
          <div className="device-panel">
            <p>
              Enter this code at{' '}
              <a href={github.device.verificationUri} target="_blank" rel="noreferrer">
                {github.device.verificationUri.replace('https://', '')}
              </a>
            </p>
            <p className="device-code">{github.device.userCode}</p>
            <p className="muted is-loading-pulse">waiting for you to enter it…</p>
            <button type="button" className="button is-small" onClick={github.cancelSignIn}>
              cancel
            </button>
          </div>
        ) : github.status === 'unconfigured' ? (
          <p className="help">
            This copy is not connected to GitHub. Whoever hosts it can set{' '}
            <code>GITHUB_CLIENT_ID</code> to turn sign-in on.
          </p>
        ) : (
          <button
            type="button"
            className="button is-primary"
            disabled={github.status === 'checking'}
            onClick={() => void github.signIn()}
          >
            Continue with GitHub
          </button>
        )}

        <p className="help">
          {total > 0 && !named ? 'Name every realm that has sounds in it.' : ''}
          {total > 0 && named && !submitting ? `${total} ${total === 1 ? 'sound' : 'sounds'} ready.` : ''}
        </p>
      </div>

      {progress && (
        <div className="pr-progress">
          <div className="bar">
            <div style={{ width: `${Math.round(progress.fraction * 100)}%` }} />
          </div>
          <p className="muted">{progress.message}</p>
        </div>
      )}

      {result && (
        <p className="pr-done">
          Your sounds are on their way:{' '}
          <a href={result.url} target="_blank" rel="noreferrer">
            pull request #{result.number}
          </a>
        </p>
      )}

      {(error || github.error) && <p className="warning-line">{error ?? github.error}</p>}
    </div>
  )
}
