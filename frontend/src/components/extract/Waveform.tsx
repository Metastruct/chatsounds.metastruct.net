import { useEffect, useRef, useState } from 'react'

export interface WaveRegion {
  id: string
  start: number
  end: number
  selected?: boolean
  disabled?: boolean
}

interface Props {
  /**
   * Per-column trough and crest, already resampled to the width we draw.
   * `ArrayLike` so the Float32Arrays the envelope produces pass straight in
   * without being copied into plain arrays first.
   */
  min: ArrayLike<number>
  max: ArrayLike<number>
  /** Time range the columns cover. */
  from: number
  to: number
  regions?: WaveRegion[]
  playhead?: number | null
  height?: number
  onScrub?: (seconds: number) => void
  onRegionClick?: (id: string) => void
  /** Dragging an edge of the selected clip. Committed once, on release. */
  onTrim?: (id: string, bounds: { startS: number; endS: number }) => void
  /** Dragging across empty space. */
  onCreate?: (startS: number, endS: number) => void
  className?: string
}

const COLORS = {
  wave: '#6f6f6f',
  waveInRegion: '#09b387',
  waveSelected: '#0ce3ac',
  regionFill: 'rgba(9, 179, 135, 0.14)',
  regionSelectedFill: 'rgba(125, 59, 128, 0.35)',
  regionEdge: 'rgba(9, 179, 135, 0.55)',
  regionSelectedEdge: '#0ce3ac',
  disabled: 'rgba(120, 120, 120, 0.18)',
  playhead: '#ffe08a',
  axis: 'rgba(255, 255, 255, 0.10)',
}

/** How close to an edge counts as grabbing it. */
const GRAB_PX = 7
/** Below this, a drag was a click that wobbled. */
const MOVED_PX = 3
/** Shortest clip a drag is allowed to produce. */
const MIN_DRAG_S = 0.05

type Gesture =
  | { kind: 'trim'; id: string; edge: 'start' | 'end'; other: number; at: number }
  | { kind: 'create'; anchor: number; at: number }

/**
 * Waveform rendering for both the overview and the zoomed clip editor.
 *
 * Both views draw from precomputed min/max columns rather than decoded audio,
 * so a 90-minute upload costs the same as a 10-second one and the zoomed view
 * can show what lies *outside* a clip's current bounds -- which is what makes
 * extending a clip possible rather than just trimming it.
 *
 * The gestures are the editor's main interface: drag an edge of the selected clip
 * to trim or extend it, drag across empty space to make a new clip, click to
 * select or to play from there. Everything is previewed locally and committed on
 * release, so dragging never touches the store per frame.
 */
export function Waveform({
  min,
  max,
  from,
  to,
  regions = [],
  playhead = null,
  height = 96,
  onScrub,
  onRegionClick,
  onTrim,
  onCreate,
  className,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const boxRef = useRef<HTMLDivElement | null>(null)
  const [gesture, setGesture] = useState<Gesture | null>(null)

  // What to draw: the committed regions, with the gesture laid over the top.
  const drawn: WaveRegion[] = (() => {
    if (!gesture) return regions
    if (gesture.kind === 'create') {
      const [start, end] = ordered(gesture.anchor, gesture.at)
      return [...regions, { id: '__new', start, end, selected: true }]
    }
    const [start, end] = ordered(gesture.other, gesture.at)
    return regions.map((region) =>
      region.id === gesture.id ? { ...region, start, end } : region,
    )
  })()

  useEffect(() => {
    const canvas = canvasRef.current
    const box = boxRef.current
    if (!canvas || !box) return

    const draw = () => {
      const width = box.clientWidth
      if (width === 0) return
      const dpr = window.devicePixelRatio || 1
      canvas.width = Math.floor(width * dpr)
      canvas.height = Math.floor(height * dpr)
      canvas.style.width = `${width}px`
      canvas.style.height = `${height}px`

      const ctx = canvas.getContext('2d')
      if (!ctx) return
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, width, height)

      const span = Math.max(to - from, 1e-6)
      const xOf = (t: number) => ((t - from) / span) * width
      const mid = height / 2

      // Region bodies first, so the waveform sits on top of them.
      for (const region of drawn) {
        const x1 = xOf(region.start)
        const x2 = xOf(region.end)
        if (x2 < 0 || x1 > width) continue
        ctx.fillStyle = region.disabled
          ? COLORS.disabled
          : region.selected
            ? COLORS.regionSelectedFill
            : COLORS.regionFill
        ctx.fillRect(x1, 0, Math.max(x2 - x1, 1), height)
        ctx.fillStyle = region.selected ? COLORS.regionSelectedEdge : COLORS.regionEdge
        ctx.fillRect(x1, 0, 1, height)
        ctx.fillRect(x2 - 1, 0, 1, height)
      }

      ctx.fillStyle = COLORS.axis
      ctx.fillRect(0, mid, width, 1)

      // The columns arrive already matched to the drawn width, but a resize
      // between fetch and paint means they may not be -- so map by index.
      const columns = Math.min(min.length, max.length)
      if (columns > 0) {
        const step = width / columns
        for (let index = 0; index < columns; index += 1) {
          const x = index * step
          const time = from + (index / columns) * span
          const inside = drawn.find((region) => time >= region.start && time <= region.end)
          ctx.fillStyle = inside
            ? inside.selected
              ? COLORS.waveSelected
              : inside.disabled
                ? COLORS.wave
                : COLORS.waveInRegion
            : COLORS.wave
          const top = mid - Math.max(max[index], 0) * mid
          const bottom = mid - Math.min(min[index], 0) * mid
          ctx.fillRect(x, top, Math.max(step, 1), Math.max(bottom - top, 1))
        }
      }

      if (playhead !== null && playhead >= from && playhead <= to) {
        ctx.fillStyle = COLORS.playhead
        ctx.fillRect(xOf(playhead), 0, 1.5, height)
      }
    }

    draw()
    const observer = new ResizeObserver(draw)
    observer.observe(box)
    return () => observer.disconnect()
  }, [min, max, from, to, drawn, playhead, height])

  const timeAt = (clientX: number) => {
    const box = boxRef.current
    if (!box) return from
    const rect = box.getBoundingClientRect()
    const fraction = (clientX - rect.left) / rect.width
    return from + Math.min(Math.max(fraction, 0), 1) * (to - from)
  }

  const perPixel = () => {
    const width = boxRef.current?.clientWidth || 1
    return (to - from) / width
  }

  /** The edge of the selected clip under the pointer, if any. */
  const edgeAt = (seconds: number) => {
    const slack = GRAB_PX * perPixel()
    const selected = regions.find((region) => region.selected)
    if (!selected) return null
    if (Math.abs(seconds - selected.start) <= slack) {
      return { id: selected.id, edge: 'start' as const, other: selected.end }
    }
    if (Math.abs(seconds - selected.end) <= slack) {
      return { id: selected.id, edge: 'end' as const, other: selected.start }
    }
    return null
  }

  const onPointerDown = (event: React.PointerEvent) => {
    if (event.button !== 0) return
    const seconds = timeAt(event.clientX)
    const startX = event.clientX
    const box = event.currentTarget as HTMLElement
    box.setPointerCapture(event.pointerId)

    const edge = onTrim ? edgeAt(seconds) : null
    const inside = regions.find(
      (region) => seconds >= region.start && seconds <= region.end,
    )
    // Only empty space starts a new clip; dragging inside an existing one would
    // otherwise bury it under a duplicate.
    const canCreate = Boolean(onCreate) && !edge && !inside

    let live: Gesture | null = edge
      ? { kind: 'trim', ...edge, at: seconds }
      : canCreate
        ? { kind: 'create', anchor: seconds, at: seconds }
        : null
    let moved = false

    const onMove = (move: PointerEvent) => {
      if (Math.abs(move.clientX - startX) > MOVED_PX) moved = true
      if (!live || !moved) return
      live = { ...live, at: timeAt(move.clientX) }
      setGesture(live)
    }

    const finish = () => {
      box.releasePointerCapture(event.pointerId)
      box.removeEventListener('pointermove', onMove)
      box.removeEventListener('pointerup', finish)
      box.removeEventListener('pointercancel', finish)
      setGesture(null)

      if (live && moved) {
        const [start, end] = ordered(
          live.kind === 'create' ? live.anchor : live.other,
          live.at,
        )
        if (end - start >= MIN_DRAG_S) {
          if (live.kind === 'create') onCreate?.(start, end)
          else onTrim?.(live.id, { startS: start, endS: end })
          return
        }
      }

      // Not a drag: a plain click selects the clip under it, or plays from there.
      if (inside && onRegionClick) onRegionClick(inside.id)
      else onScrub?.(seconds)
    }

    box.addEventListener('pointermove', onMove)
    box.addEventListener('pointerup', finish)
    box.addEventListener('pointercancel', finish)
  }

  const interactive = Boolean(onScrub || onRegionClick || onCreate)

  return (
    <div
      ref={boxRef}
      className={className}
      style={{
        position: 'relative',
        width: '100%',
        height,
        touchAction: 'none',
        cursor: gesture?.kind === 'trim' ? 'ew-resize' : interactive ? 'crosshair' : 'default',
      }}
      onPointerDown={onPointerDown}
    >
      <canvas ref={canvasRef} style={{ display: 'block' }} />
    </div>
  )
}

function ordered(a: number, b: number): [number, number] {
  return a <= b ? [a, b] : [b, a]
}
