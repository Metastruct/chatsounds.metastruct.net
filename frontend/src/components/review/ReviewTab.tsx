import { useEffect, useState } from 'react'
import { timeAgo } from '../../lib/format'
import type { PrStatus } from '../../lib/github'
import { Icon } from '../Icon'
import { useGithub } from '../../store/useGithub'
import { useReview } from '../../store/useReview'
import { GithubAccount, GithubSignIn } from '../GithubSignIn'
import { PrTree } from './PrTree'

/**
 * Looking over pull requests before they land.
 *
 * Reading is open to anyone signed in, including their own pull requests, since
 * hearing what you sent and what others said about it needs no privilege.
 * Ruling on one does: approve, deny and merge appear only with push access on
 * the repo, rather than as buttons that would fail on use.
 */
export function ReviewTab() {
  const github = useGithub()
  const review = useReview()

  useEffect(() => {
    void github.init()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (github.status === 'signed-in' && github.token) {
      void review.checkAccess(github.token)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [github.status, github.token])

  useEffect(() => {
    // Onlookers get the list too, so this waits only for the rights to settle,
    // not for them to come back in our favour.
    const settled = review.rights === 'reviewer' || review.rights === 'onlooker'
    if (settled && github.token && review.prs === null) {
      void review.loadPrs(github.token)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [review.rights, github.token])

  if (github.status !== 'signed-in') {
    return (
      <div className="container section">
        <h1 className="title is-4">Review</h1>
        <p className="muted">Sign in to look over waiting pull requests.</p>
        <div style={{ marginTop: '1.5rem' }}>
          <GithubSignIn />
        </div>
      </div>
    )
  }

  if (review.rights === 'unknown' || review.rights === 'checking' || !github.token || !github.user) {
    return (
      <div className="container section">
        <h1 className="title is-4">Review</h1>
        <p className="muted is-loading-pulse">loading…</p>
      </div>
    )
  }

  return review.detail ? (
    <PrView token={github.token} myLogin={github.user.login} />
  ) : (
    <PrList token={github.token} myLogin={github.user.login} />
  )
}

/** Where a pull request stands, as one glyph at the start of its row. */
function StatusMark({ status }: { status?: PrStatus }) {
  const shown = status ?? 'waiting'
  const label =
    shown === 'approved' ? 'approved' : shown === 'changes' ? 'changes needed' : 'waiting'
  return (
    <span className={`pr-status is-${shown}`} title={label} aria-label={label}>
      <Icon name={shown} size={18} />
    </span>
  )
}

function PrList({ token, myLogin }: { token: string; myLogin: string }) {
  const review = useReview()

  const mine = review.prs?.filter((pr) => pr.author === myLogin) ?? []
  const others = review.prs?.filter((pr) => pr.author !== myLogin) ?? []

  const row = (pr: (typeof mine)[number]) => (
    <button
      key={pr.number}
      type="button"
      className="pr-row"
      onClick={() => void review.open(token, pr.number)}
    >
      <StatusMark status={pr.status} />
      <span className="muted">#{pr.number}</span>
      <span className="pr-title">{pr.title}</span>
      <span className="muted">
        {pr.author} · {timeAgo(pr.createdAt)}
      </span>
    </button>
  )

  return (
    <div className="container section review-tab">
      <div className="row">
        <h1 className="title is-4">Open pull requests</h1>
        <span className="spacer" />
        <GithubAccount />
        <button
          type="button"
          className="button is-small"
          onClick={() => void review.loadPrs(token)}
        >
          refresh
        </button>
      </div>

      {review.rights === 'onlooker' && (
        <p className="muted">
          You can look through anything here. Approving, turning down and merging
          need push access on the repo.
        </p>
      )}

      {review.prs === null ? (
        <p className="muted is-loading-pulse">loading…</p>
      ) : review.prs.length === 0 ? (
        <p className="muted">Nothing is waiting. Well done.</p>
      ) : (
        <>
          {/* Your own first: it is the one you came to check on. */}
          {mine.length > 0 && (
            <>
              <p className="heading pr-group">Yours</p>
              <div className="pr-list">{mine.map(row)}</div>
            </>
          )}
          {others.length > 0 && (
            <>
              <p className="heading pr-group">{mine.length ? 'Everyone else' : 'Waiting'}</p>
              <div className="pr-list">{others.map(row)}</div>
            </>
          )}
        </>
      )}

      {review.error && <p className="warning-line">{review.error}</p>}
    </div>
  )
}

function PrView({ token, myLogin }: { token: string; myLogin: string }) {
  const review = useReview()
  const detail = review.detail
  const [denyAllOpen, setDenyAllOpen] = useState(false)
  const [denyAllComment, setDenyAllComment] = useState('')

  if (!detail) return null

  // The newest word from each reviewer is the one that stands.
  const verdicts = new Map<string, string>()
  for (const entry of review.reviews) {
    if (entry.state === 'APPROVED' || entry.state === 'CHANGES_REQUESTED') {
      verdicts.set(entry.reviewer, entry.state)
    }
  }

  const soundCount = review.sounds.length

  return (
    <div className="container section review-tab">
      <div className="row">
        <button type="button" className="button is-small" onClick={review.close}>
          ← all pull requests
        </button>
        <h1 className="title is-5 pr-heading">
          #{detail.number} {detail.title}
        </h1>
        <span className="spacer" />
        <span className="muted">
          {detail.author} · {soundCount} {soundCount === 1 ? 'sound' : 'sounds'}
        </span>
        <a
          className="button is-small"
          href={`https://github.com/Metastruct/garrysmod-chatsounds/pull/${detail.number}`}
          target="_blank"
          rel="noreferrer"
        >
          on GitHub
        </a>
        <GithubAccount />
      </div>

      {review.loading && <p className="muted is-loading-pulse">{review.loading}</p>}

      <PrTree token={token} myLogin={myLogin} />

      <div className="review-foot">
        {verdicts.size > 0 && (
          <p className="review-trail">
            {[...verdicts.entries()].map(([who, state]) => (
              <span
                key={who}
                className={`tag ${state === 'APPROVED' ? 'is-accent' : 'is-danger'}`}
              >
                {who} {state === 'APPROVED' ? 'approved' : 'wants changes'}
              </span>
            ))}
          </p>
        )}

        {/* Said about the pull request rather than any one sound, which is where
            the reason behind a Deny all ends up. */}
        {review.messages.length > 0 && (
          <div className="pr-messages">
            {review.messages.map((message) => (
              <p key={message.id} className="pr-message">
                <a href={message.url} target="_blank" rel="noreferrer">
                  {message.author}
                </a>
                {message.state === 'CHANGES_REQUESTED' && (
                  <span className="tag is-danger">wants changes</span>
                )}
                {message.state === 'APPROVED' && <span className="tag is-accent">approved</span>}
                <span className="muted">{message.body}</span>
              </p>
            ))}
          </div>
        )}

        {review.rights === 'onlooker' && (
          <p className="muted">
            Ruling on this needs push access on the repo. You can still listen to
            everything and read what others have said.
          </p>
        )}

        <div className="row wrap" hidden={review.rights !== 'reviewer'}>
          <button
            type="button"
            className="button is-danger"
            disabled={review.busy}
            onClick={() => setDenyAllOpen((value) => !value)}
          >
            Deny all
          </button>
          <button
            type="button"
            className="button"
            disabled={review.busy}
            onClick={() => void review.approveAll(token, myLogin)}
          >
            Approve all
          </button>
          <button
            type="button"
            className="button is-primary"
            disabled={review.busy || review.merged || detail.mergeable === false}
            title={
              detail.mergeable === false
                ? 'GitHub says this cannot be merged as it stands'
                : undefined
            }
            onClick={() => void review.merge(token)}
          >
            {review.merged ? 'Merged' : 'Merge'}
          </button>
        </div>

        {denyAllOpen && !review.merged && (
          <div className="deny-box">
            <input
              className="input is-small"
              placeholder="Why is the whole thing being turned away?"
              value={denyAllComment}
              autoFocus
              onChange={(event) => setDenyAllComment(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && denyAllComment.trim()) {
                  void review.denyAll(token, denyAllComment.trim(), myLogin)
                  setDenyAllOpen(false)
                }
                if (event.key === 'Escape') setDenyAllOpen(false)
              }}
            />
            <button
              type="button"
              className="button is-small is-danger"
              disabled={review.busy || !denyAllComment.trim()}
              onClick={() => {
                void review.denyAll(token, denyAllComment.trim(), myLogin)
                setDenyAllOpen(false)
              }}
            >
              send
            </button>
          </div>
        )}

        {review.merged && <p className="pr-done">Merged. The sounds are in.</p>}
        {review.error && <p className="warning-line">{review.error}</p>}
      </div>
    </div>
  )
}
