import { useCallback, useMemo, useRef, useState } from 'react'
import { type Envelope, windowPeaks } from '../../pipeline/envelope'
import type { Segment } from '../../store/useJob'
import { formatTime } from '../../lib/format'
import { Waveform } from './Waveform'

interface Props {
  segment: Segment
  envelope: Envelope
  duration: number
  playhead: number | null
  onCommit: (bounds: { startS: number; endS: number }) => void
  onScrub: (seconds: number) => void
}

const BUCKETS = 900
/** How much of the surrounding recording to keep visible on each side. */
const CONTEXT_RATIO = 0.6
const MIN_CONTEXT_S = 0.4

/** Dragging an edge changes the length; sliding moves the whole clip. */
type Kind = 'edge' | 'slide'

export function ClipEditor({
  segment,
  envelope,
  duration,
  playhead,
  onCommit,
  onScrub,
}: Props) {
  const boxRef = useRef<HTMLDivElement | null>(null)
  const trackRef = useRef<HTMLDivElement | null>(null)
  const [drag, setDrag] = useState<{ start: number; end: number; kind: Kind } | null>(null)

  /**
   * The visible window follows a slide but not an edge drag.
   *
   * Holding an edge, the window has to stay put or the waveform slides around
   * under the handle you are holding. Sliding the whole clip is the opposite:
   * the point is to travel, so the view travels with it.
   */
  const anchorStart = drag?.kind === 'slide' ? drag.start : segment.startS
  const anchorEnd = drag?.kind === 'slide' ? drag.end : segment.endS
  const view = useMemo(() => {
    const length = Math.max(anchorEnd - anchorStart, 0.05)
    const context = Math.max(length * CONTEXT_RATIO, MIN_CONTEXT_S)
    return {
      from: Math.max(0, anchorStart - context),
      to: Math.min(duration || anchorEnd + context, anchorEnd + context),
    }
  }, [anchorStart, anchorEnd, duration])

  // No fetch: the envelope is already in memory, so the zoomed view is derived
  // on the spot at 5 ms resolution.
  const peaks = useMemo(
    () => windowPeaks(envelope, view.from, view.to, BUCKETS),
    [envelope, view.from, view.to],
  )

  const bounds = drag ?? { start: segment.startS, end: segment.endS }

  const timeAt = useCallback(
    (clientX: number) => {
      const box = boxRef.current
      if (!box) return 0
      const rect = box.getBoundingClientRect()
      const fraction = (clientX - rect.left) / rect.width
      const seconds = view.from + fraction * (view.to - view.from)
      return Math.min(Math.max(seconds, 0), duration || seconds)
    },
    [view.from, view.to, duration],
  )

  const beginDrag = (edge: 'start' | 'end') => (event: React.PointerEvent) => {
    event.preventDefault()
    event.stopPropagation()
    const target = event.currentTarget as HTMLElement
    target.setPointerCapture(event.pointerId)

    let latest = { start: segment.startS, end: segment.endS, kind: 'edge' as const }

    const onMove = (moveEvent: PointerEvent) => {
      const seconds = timeAt(moveEvent.clientX)
      latest =
        edge === 'start'
          ? { start: Math.min(seconds, latest.end - 0.02), end: latest.end, kind: 'edge' }
          : { start: latest.start, end: Math.max(seconds, latest.start + 0.02), kind: 'edge' }
      setDrag(latest)
    }

    const onUp = () => {
      target.releasePointerCapture(event.pointerId)
      target.removeEventListener('pointermove', onMove)
      target.removeEventListener('pointerup', onUp)
      setDrag(null)
      onCommit({
        startS: Number(latest.start.toFixed(4)),
        endS: Number(latest.end.toFixed(4)),
      })
    }

    target.addEventListener('pointermove', onMove)
    target.addEventListener('pointerup', onUp)
  }

  /**
   * Slide the whole clip along the recording, keeping its length.
   *
   * Moving a clip by dragging one edge and then the other is two gestures that
   * have to agree with each other, and any slip changes the length. This is the
   * one gesture that cannot: the length is fixed, only the position moves.
   */
  const beginSlide = (event: React.PointerEvent) => {
    event.preventDefault()
    const track = trackRef.current
    const total = duration || segment.endS
    if (!track || total <= 0) return

    const target = event.currentTarget as HTMLElement
    target.setPointerCapture(event.pointerId)

    const rect = track.getBoundingClientRect()
    const length = segment.endS - segment.startS
    // Where inside the thumb it was grabbed, so it does not jump on the first
    // pixel of movement.
    const grabbedAt = event.clientX - (rect.left + (segment.startS / total) * rect.width)

    let latest = { start: segment.startS, end: segment.endS, kind: 'slide' as const }

    const onMove = (moveEvent: PointerEvent) => {
      const x = moveEvent.clientX - grabbedAt - rect.left
      const start = Math.min(
        Math.max(0, (x / rect.width) * total),
        Math.max(0, total - length),
      )
      latest = { start, end: start + length, kind: 'slide' }
      setDrag(latest)
    }

    const onUp = () => {
      target.releasePointerCapture(event.pointerId)
      target.removeEventListener('pointermove', onMove)
      target.removeEventListener('pointerup', onUp)
      setDrag(null)
      onCommit({
        startS: Number(latest.start.toFixed(4)),
        endS: Number(latest.end.toFixed(4)),
      })
    }

    target.addEventListener('pointermove', onMove)
    target.addEventListener('pointerup', onUp)
  }

  const span = Math.max(view.to - view.from, 1e-6)
  const percent = (t: number) => `${((t - view.from) / span) * 100}%`

  const total = duration || Math.max(bounds.end, 1)
  const thumb = {
    left: `${(bounds.start / total) * 100}%`,
    width: `${((bounds.end - bounds.start) / total) * 100}%`,
  }

  return (
    <div className="clip-editor">
      <div ref={boxRef} className="clip-editor-canvas">
        <Waveform
          min={peaks.min}
          max={peaks.max}
          from={view.from}
          to={view.to}
          height={140}
          // Passing the clip as a selected region rather than a plain highlight
          // is what makes the audio inside the bounds render in the accent
          // colour -- so what you are about to export reads apart from the
          // context around it at a glance.
          regions={[{ id: segment.id, start: bounds.start, end: bounds.end, selected: true }]}
          playhead={playhead}
          onScrub={onScrub}
        />

        <div
          className="clip-handle"
          style={{ left: percent(bounds.start) }}
          onPointerDown={beginDrag('start')}
          role="slider"
          aria-label="clip start"
          aria-valuenow={bounds.start}
        >
          <span />
        </div>
        <div
          className="clip-handle is-end"
          style={{ left: percent(bounds.end) }}
          onPointerDown={beginDrag('end')}
          role="slider"
          aria-label="clip end"
          aria-valuenow={bounds.end}
        >
          <span />
        </div>
      </div>

      {/* The clip's place in the whole recording, and the way to move it there
          without touching either edge. */}
      <div className="clip-track" ref={trackRef} title="Drag to move the clip, keeping its length">
        <div
          className="clip-track-thumb"
          style={thumb}
          onPointerDown={beginSlide}
          role="slider"
          aria-label="clip position"
          aria-valuemin={0}
          aria-valuemax={Math.max(0, total - (bounds.end - bounds.start))}
          aria-valuenow={bounds.start}
          tabIndex={0}
        />
      </div>

      <div className="row clip-editor-times">
        <code>{formatTime(bounds.start)}</code>
        <span className="muted">to</span>
        <code>{formatTime(bounds.end)}</code>
        <span className="spacer" />
        <span className="muted">{(bounds.end - bounds.start).toFixed(3)}s</span>
      </div>
    </div>
  )
}
