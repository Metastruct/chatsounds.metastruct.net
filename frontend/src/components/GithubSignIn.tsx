import { useGithub } from '../store/useGithub'

/**
 * Who is signed in, with the way out. Renders nothing while signed out.
 *
 * Lives next to `GithubSignIn` because they are two halves of one answer: any
 * screen that can ask you to sign in should also show who you already are.
 */
export function GithubAccount() {
  const user = useGithub((state) => state.user)
  const status = useGithub((state) => state.status)
  const signOut = useGithub((state) => state.signOut)

  if (status !== 'signed-in' || !user) return null
  return (
    <>
      <span className="signed-in">
        <img src={user.avatarUrl} alt="" className="gh-avatar" />
        {user.login}
      </span>
      <button type="button" className="button is-small" onClick={signOut}>
        sign out
      </button>
    </>
  )
}

/**
 * Every state of being signed out, in one place.
 *
 * Renders nothing once signed in; what a signed-in user sees is each tab's own
 * business. Callers must have called `useGithub.init()` themselves.
 */
export function GithubSignIn() {
  const github = useGithub()

  if (github.status === 'unconfigured') {
    return (
      <p className="help">
        This copy is not connected to GitHub. Whoever hosts it can set{' '}
        <code>GITHUB_CLIENT_ID</code> to turn sign-in on.
      </p>
    )
  }

  if (github.status === 'authorizing' && github.device) {
    return (
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
    )
  }

  if (github.status === 'signed-in') return null

  return (
    <>
      <button
        type="button"
        className="button is-primary"
        disabled={github.status === 'checking'}
        onClick={() => void github.signIn()}
      >
        Continue with GitHub
      </button>
      {github.error && <p className="warning-line">{github.error}</p>}
    </>
  )
}
