import { useEffect, useRef, useState } from 'react'
import { describeAudit } from '../../pipeline/audit'
import { formatDuration } from '../../lib/format'
import type { ReviewSound } from '../../store/useReview'
import { useReview } from '../../store/useReview'
import { Icon } from '../Icon'

/**
 * The pull request's sounds, realm by realm, each playable and deniable.
 *
 * The checks are advisory: a flagged sound can still be approved and a clean
 * one denied. The reviewer's ears outrank the numbers, which is why every row
 * has a play button before it has anything else.
 */

interface Props {
  token: string
  myLogin: string
}

/** One context for the whole tab; sounds are tiny and play one at a time. */
let sharedContext: AudioContext | null = null

export function PrTree({ token, myLogin }: Props) {
  const sounds = useReview((state) => state.sounds)
  const others = useReview((state) => state.others)

  const [playing, setPlaying] = useState<string | null>(null)
  const sourceRef = useRef<AudioBufferSourceNode | null>(null)

  const stop = () => {
    try {
      sourceRef.current?.stop()
    } catch {
      /* already ended */
    }
    sourceRef.current = null
    setPlaying(null)
  }

  const play = (sound: ReviewSound) => {
    if (playing === sound.path) {
      stop()
      return
    }
    if (!sound.buffer) return
    stop()
    const context = (sharedContext ??= new AudioContext())
    void context.resume()
    const source = context.createBufferSource()
    source.buffer = sound.buffer
    source.connect(context.destination)
    source.onended = () => {
      if (sourceRef.current === source) stop()
    }
    source.start()
    sourceRef.current = source
    setPlaying(sound.path)
  }

  // Leaving the tab or the PR should not leave audio running.
  useEffect(() => stop, [])

  const realms = [...new Set(sounds.map((sound) => sound.realm))].sort()

  return (
    <div className="review-tree">
      {realms.map((realm) => (
        <div key={realm} className="review-realm">
          <p className="review-realm-name">▸ {realm}/</p>
          {sounds
            .filter((sound) => sound.realm === realm)
            .map((sound) => (
              <SoundRow
                key={sound.path}
                sound={sound}
                playing={playing === sound.path}
                onPlay={() => play(sound)}
                token={token}
                myLogin={myLogin}
              />
            ))}
        </div>
      ))}

      {others.length > 0 && (
        <div className="review-realm">
          <p className="review-realm-name">not sounds</p>
          {others.map((file) => (
            <div key={file.path} className="review-file is-other">
              <span />
              <span className="review-file-name">{file.path}</span>
              <span className="muted">
                {file.status}, this page cannot check it, look at it on GitHub
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function SoundRow({
  sound,
  playing,
  onPlay,
  token,
  myLogin,
}: {
  sound: ReviewSound
  playing: boolean
  onPlay: () => void
  token: string
  myLogin: string
}) {
  const deny = useReview((state) => state.deny)
  const busy = useReview((state) => state.busy)
  const rights = useReview((state) => state.rights)
  // Selected whole, then narrowed during render. Filtering inside the selector
  // returns a new array every call, which the store reads as a change every
  // time it is asked, and React gives up with "maximum update depth exceeded".
  const allComments = useReview((state) => state.comments)
  const comments = allComments.filter((entry) => entry.path === sound.path)

  const [denying, setDenying] = useState(false)
  const [comment, setComment] = useState('')

  const auditNote = sound.audit ? describeAudit(sound.audit) : null

  const send = async () => {
    if (!comment.trim()) return
    await deny(token, sound.path, comment.trim(), myLogin)
    setDenying(false)
    setComment('')
  }

  return (
    <div className={`review-file${sound.denied ? ' is-denied' : ''}`}>
      <button
        type="button"
        className={`button is-small is-icon${playing ? ' is-active' : ''}`}
        title="Play this sound"
        disabled={!sound.buffer}
        onClick={onPlay}
      >
        <Icon name={playing ? 'pause' : 'play'} size={13} />
      </button>

      <span className="review-file-name" title={sound.path}>
        {sound.name}
      </span>

      <span className="review-file-meta muted">
        {sound.state === 'pending' && 'checking…'}
        {sound.state === 'failed' && (sound.error ?? 'could not be fetched')}
        {sound.state === 'ready' && sound.audit && formatDuration(sound.audit.durationS)}
      </span>

      <span className="review-file-tags">
        {sound.formatProblem && (
          <span className="tag is-danger" title={sound.formatProblem}>
            bad file
          </span>
        )}
        {sound.audit?.flags.includes('too_long') && (
          <span className="tag is-warning" title={auditNote ?? undefined}>
            long
          </span>
        )}
        {sound.audit?.flags.includes('much_silence') && (
          <span className="tag is-warning" title={auditNote ?? undefined}>
            silence
          </span>
        )}
        {sound.denied && <span className="tag is-danger">denied</span>}
      </span>

      {!sound.denied && rights === 'reviewer' ? (
        <button
          type="button"
          className="button is-small"
          disabled={busy}
          onClick={() => setDenying((value) => !value)}
        >
          deny
        </button>
      ) : (
        <span />
      )}

      {/* Whatever has been said about this file, under the file it is about. */}
      {comments.length > 0 && (
        <div className="file-comments">
          {comments.map((entry) => (
            <p key={entry.id} className="file-comment">
              <a href={entry.url} target="_blank" rel="noreferrer">
                {entry.author}
              </a>{' '}
              <span className="muted">{entry.body}</span>
            </p>
          ))}
        </div>
      )}

      {denying && (
        <div className="deny-box">
          <input
            className="input is-small"
            placeholder="What is wrong with it?"
            value={comment}
            autoFocus
            onChange={(event) => setComment(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void send()
              if (event.key === 'Escape') setDenying(false)
            }}
          />
          <button
            type="button"
            className="button is-small is-danger"
            disabled={busy || !comment.trim()}
            onClick={() => void send()}
          >
            send
          </button>
        </div>
      )}
    </div>
  )
}
