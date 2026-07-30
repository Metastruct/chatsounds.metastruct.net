import { useEffect, useState } from 'react'
import { sanitizeTrigger } from '../../pipeline/naming'
import type { Segment } from '../../store/useJob'
import { useJob } from '../../store/useJob'
import { FLAG_LABELS, formatTime } from '../../lib/format'
import { Icon } from '../Icon'

interface Props {
  segment: Segment
  relativePath: string
  selected: boolean
  playing: boolean
  /** Transcription is running over this clip to name it. */
  naming?: boolean
  onSelect: () => void
  onPlay: () => void
}

export function SegmentRow({
  segment,
  relativePath,
  selected,
  playing,
  naming = false,
  onSelect,
  onPlay,
}: Props) {
  const patch = useJob((state) => state.patch)
  const remove = useJob((state) => state.remove)
  const clipUrl = useJob((state) => state.clipUrl)
  const maxTriggerLength = useJob((state) => state.options.maxTriggerLength ?? 100)

  const [draft, setDraft] = useState(segment.trigger)
  const [downloading, setDownloading] = useState(false)

  // Adopt changes made elsewhere (a retranscribe, a merge) rather than pinning
  // the field to a stale value.
  useEffect(() => {
    setDraft(segment.trigger)
  }, [segment.trigger])

  const preview = sanitizeTrigger(draft, maxTriggerLength)
  const willChange = preview !== draft.trim()

  /**
   * The second line, when there is anything to put on it.
   *
   * The field above already shows the name, and the name *is* the filename, so
   * printing the path underneath said the same thing twice. It only earns a line
   * when it differs from what is in the field: while the clip is being listened
   * to, when it is being left out, when saving will change the name, or
   * when it shares a name and lands in a numbered folder.
   */
  const note = naming
    ? 'working out what is said…'
    : !segment.enabled
      ? 'not included'
      : willChange
        ? `saved as ${preview}.ogg`
        : relativePath.includes('/')
          ? relativePath
          : null

  const commit = () => {
    const cleaned = sanitizeTrigger(draft, maxTriggerLength)
    if (cleaned && cleaned !== segment.trigger) patch(segment.id, { trigger: cleaned })
    else setDraft(segment.trigger)
  }

  // The clip is encoded on demand, so the download is a click handler rather
  // than an href: there is no URL until the bytes exist.
  const download = async () => {
    setDownloading(true)
    try {
      const url = await clipUrl(segment.id)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = relativePath ? relativePath.replace(/\//g, ' ') : `${preview}.ogg`
      anchor.click()
    } finally {
      setDownloading(false)
    }
  }

  return (
    <div
      className={`card segment-row${selected ? ' is-selected' : ''}${
        segment.enabled ? '' : ' is-disabled'
      }`}
      onClick={onSelect}
    >
      {/* Leftmost, in space the row was wasting on padding anyway, and the first
          thing read rather than the last: whether this clip is being kept at all
          is what every other value on the row is conditional on. */}
      <div className="segment-keep" onClick={(event) => event.stopPropagation()}>
        <label className="checkbox" title="Keep this clip">
          <input
            type="checkbox"
            checked={segment.enabled}
            onChange={(event) => patch(segment.id, { enabled: event.target.checked })}
          />
        </label>
      </div>

      <div className="segment-index">{segment.position + 1}</div>

      <button
        type="button"
        className={`button is-small is-icon segment-play${playing ? ' is-active' : ''}`}
        title="Play this clip (space)"
        onClick={(event) => {
          event.stopPropagation()
          onPlay()
        }}
      >
        <Icon name={playing ? 'pause' : 'play'} size={14} />
      </button>

      <div className="segment-main">
        <input
          className="input segment-trigger"
          value={naming ? '' : draft}
          placeholder={naming ? 'listening…' : undefined}
          disabled={naming}
          spellCheck={false}
          onChange={(event) => setDraft(event.target.value)}
          // The click deliberately reaches the row: this input covers most of
          // its width, so swallowing it would leave almost nowhere to click to
          // select a clip.
          onFocus={onSelect}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === 'Enter') event.currentTarget.blur()
            if (event.key === 'Escape') {
              setDraft(segment.trigger)
              event.currentTarget.blur()
            }
          }}
        />
        {note && <p className="segment-path muted">{note}</p>}
      </div>

      <div className="segment-flags">
        {(segment.flags ?? []).map((flag) => {
          const meta = FLAG_LABELS[flag]
          return (
            <span key={flag} className={`tag ${meta?.tone ?? ''}`} title={meta?.hint ?? flag}>
              {meta?.label ?? flag}
            </span>
          )
        })}
      </div>

      <div className="segment-times muted">
        <span>{formatTime(segment.startS)}</span>
        <span>{(segment.endS - segment.startS).toFixed(2)}s</span>
      </div>

      <div className="segment-actions" onClick={(event) => event.stopPropagation()}>
        <button
          type="button"
          className="button is-small is-icon"
          title="Save just this clip"
          disabled={downloading}
          onClick={() => void download()}
        >
          <Icon name="download" size={15} />
        </button>
        <button
          type="button"
          className="button is-small is-icon is-danger"
          title="Delete this clip (x)"
          onClick={() => remove(segment.id)}
        >
          <Icon name="trash" size={15} />
        </button>
      </div>
    </div>
  )
}
