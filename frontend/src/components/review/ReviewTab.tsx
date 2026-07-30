import { useEffect, useState } from 'react'
import { timeAgo } from '../../lib/format'
import { useGithub } from '../../store/useGithub'
import { useReview } from '../../store/useReview'
import { GithubAccount, GithubSignIn } from '../GithubSignIn'
import { PrTree } from './PrTree'

/**
 * Looking over pull requests before they land, for people who can merge them.
 *
 * The gate is the repo's own permissions: push access is what merging needs, so
 * push access is what seeing this page needs. Everyone else gets told it is
 * restricted rather than a page of buttons that would all fail.
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
    if (review.gate === 'allowed' && github.token && review.prs === null) {
      void review.loadPrs(github.token)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [review.gate, github.token])

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

  if (review.gate === 'restricted') {
    return (
      <div className="container section">
        <h1 className="title is-4">Review</h1>
        <p className="muted">
          This page is restricted to the people who look after the repo.
        </p>
        {/* Who was refused matters here: the usual fix is the other account. */}
        <div className="row" style={{ marginTop: '1.5rem' }}>
          <GithubAccount />
        </div>
      </div>
    )
  }

  if (review.gate !== 'allowed' || !github.token || !github.user) {
    return (
      <div className="container section">
        <h1 className="title is-4">Review</h1>
        <p className="muted is-loading-pulse">checking your access…</p>
      </div>
    )
  }

  return review.detail ? (
    <PrView token={github.token} myLogin={github.user.login} />
  ) : (
    <PrList token={github.token} />
  )
}

function PrList({ token }: { token: string }) {
  const review = useReview()

  return (
    <div className="container section review-tab">
      <div className="row">
        <h1 className="title is-4">Waiting pull requests</h1>
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

      {review.prs === null ? (
        <p className="muted is-loading-pulse">loading…</p>
      ) : review.prs.length === 0 ? (
        <p className="muted">Nothing is waiting. Well done.</p>
      ) : (
        <div className="pr-list">
          {review.prs.map((pr) => (
            <button
              key={pr.number}
              type="button"
              className="pr-row"
              onClick={() => void review.open(token, pr.number)}
            >
              <span className="muted">#{pr.number}</span>
              <span className="pr-title">{pr.title}</span>
              <span className="muted">
                {pr.author} · {timeAgo(pr.createdAt)}
              </span>
            </button>
          ))}
        </div>
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

        <div className="row wrap">
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
            onClick={() => void review.approveAll(token)}
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
                  void review.denyAll(token, denyAllComment.trim())
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
                void review.denyAll(token, denyAllComment.trim())
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
