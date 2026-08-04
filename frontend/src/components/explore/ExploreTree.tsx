import { type CSSProperties, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  type ExploreRealm,
  type ExploreRow,
  REALM_PAD,
  filterExploreTree,
  flattenRows,
} from '../../lib/exploreTree'
import { soundSharePath } from '../../lib/github'
import { useExplore } from '../../store/useExplore'
import { Icon } from '../Icon'

/**
 * The whole repo as one scrolling list, drawn a screenful at a time.
 *
 * Fully expanded, this is about 42,000 rows. Handing that to the browser as
 * 42,000 elements makes the tab take seconds to open and every keystroke in the
 * search bar stutter, so only the rows in view exist: the scroll box is padded
 * to the height the full list would have, and the slice inside it is pushed
 * down to where it belongs. Around eighty elements are alive at any scroll
 * position, whether the filter matched four sounds or all of them.
 *
 * Rows are not all the same height (a realm header is taller, and a realm's
 * first and last rows carry its padding), so the offset of every row is summed
 * up front and the row at a scroll position is found by bisecting that. One
 * pass over 42,000 numbers costs well under a millisecond and only happens when
 * the list itself changes, which is a filter or an accordion opening.
 */

/** Rows drawn past each edge, so a fast scroll does not show empty space. */
const OVERSCAN = 10

interface Props {
  realms: ExploreRealm[]
  query: string
  token: string | null
  /** The realms to show the contents of; the rest are one header row. */
  expanded: ReadonlySet<string>
  onToggleRealm: (name: string) => void
}

export function ExploreTree({ realms, query, token, expanded, onToggleRealm }: Props) {
  const rows = useMemo(
    () => flattenRows(filterExploreTree(realms, query), expanded),
    [realms, query, expanded],
  )

  /** The top of each row, plus the full height at the end. */
  const offsets = useMemo(() => {
    const tops = new Float64Array(rows.length + 1)
    for (let i = 0; i < rows.length; i++) tops[i + 1] = tops[i] + rows[i].height
    return tops
  }, [rows])

  const scrollRef = useRef<HTMLDivElement | null>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [viewport, setViewport] = useState(600)

  useEffect(() => {
    const element = scrollRef.current
    if (!element) return
    const observer = new ResizeObserver(() => setViewport(element.clientHeight))
    observer.observe(element)
    setViewport(element.clientHeight)
    return () => observer.disconnect()
  }, [])

  // A new query means a different list; staying at the old offset would land
  // somewhere arbitrary in it, usually past its end. Collapsing is deliberately
  // not in here: it happens under the pointer, and the row clicked on should
  // stay where it was clicked.
  useLayoutEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = 0
    setScrollTop(0)
  }, [query])

  // Leaving the tab should not leave a sound running.
  const stop = useExplore((state) => state.stop)
  useEffect(() => stop, [stop])

  const start = Math.max(0, rowAt(offsets, rows.length, scrollTop) - OVERSCAN)
  const end = Math.min(rows.length, rowAt(offsets, rows.length, scrollTop + viewport) + 1 + OVERSCAN)
  const visible = rows.slice(start, end)

  return (
    <div
      className="explore-scroll"
      ref={scrollRef}
      onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
    >
      {/* The box stays mounted even with nothing in it. Swapping it for the
          message would detach the element the size observer is watching, and
          the next query that did match would be drawn to a stale height. */}
      {rows.length === 0 ? (
        <p className="muted explore-empty">No realm or trigger matches that.</p>
      ) : (
        <div className="explore-spacer" style={{ height: offsets[rows.length] }}>
          <div className="explore-window" style={{ transform: `translateY(${offsets[start]}px)` }}>
            {visible.map((row) => (
              <Row key={row.key} row={row} token={token} onToggleRealm={onToggleRealm} />
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

/** The last row starting at or before `y`. */
function rowAt(offsets: Float64Array, count: number, y: number): number {
  let low = 0
  let high = count - 1
  while (low < high) {
    const mid = (low + high + 1) >> 1
    if (offsets[mid] <= y) low = mid
    else high = mid - 1
  }
  return low
}

/**
 * Text onto the clipboard, by whichever route the browser allows.
 *
 * navigator.clipboard is the one to use and it refuses on an insecure origin or
 * an unfocused document, which a self-hosted copy on plain http hits every
 * time. The old selection-and-execCommand dance still works in that case. What
 * is deliberately not here is a window.prompt fallback: it is modal, so a
 * browser that refused the clipboard would freeze the tab instead of failing.
 */
async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    /* fall through */
  }
  const scratch = document.createElement('textarea')
  scratch.value = text
  scratch.setAttribute('readonly', '')
  scratch.style.cssText = 'position:fixed;top:-1000px;opacity:0'
  document.body.append(scratch)
  scratch.select()
  try {
    return document.execCommand('copy')
  } catch {
    return false
  } finally {
    scratch.remove()
  }
}

/** A row's own height and the share of its realm's padding it carries. */
function boxOf(row: ExploreRow): CSSProperties {
  if (row.kind === 'realm') return { height: row.height }
  return {
    height: row.height,
    paddingTop: row.pad.top ? REALM_PAD : undefined,
    paddingBottom: row.pad.bottom ? REALM_PAD : undefined,
  }
}

function Row({
  row,
  token,
  onToggleRealm,
}: {
  row: ExploreRow
  token: string | null
  onToggleRealm: (name: string) => void
}) {
  const playingPath = useExplore((state) => state.playingPath)
  const pendingPath = useExplore((state) => state.pendingPath)
  const play = useExplore((state) => state.play)
  const [copied, setCopied] = useState(false)

  if (row.kind === 'realm') {
    return (
      <button
        type="button"
        className="explore-row is-realm"
        style={boxOf(row)}
        onClick={() => onToggleRealm(row.name)}
        aria-expanded={!row.collapsed}
        title={row.collapsed ? `show ${row.name}` : `hide ${row.name}`}
      >
        <span className="explore-mark">{row.collapsed ? '▸' : '▾'}</span>
        <span className="explore-name">{row.name}/</span>
        <span className="explore-count muted">
          {row.triggerCount.toLocaleString()} {row.triggerCount === 1 ? 'trigger' : 'triggers'},{' '}
          {row.soundCount.toLocaleString()} {row.soundCount === 1 ? 'sound' : 'sounds'}
        </span>
      </button>
    )
  }

  if (row.kind === 'group') {
    return (
      <div className="explore-row is-group is-depth-1" style={boxOf(row)}>
        <span className="explore-mark">▾</span>
        <span className="explore-name">{row.label}</span>
        <span className="explore-count muted">{row.count} variations</span>
      </div>
    )
  }

  const playing = playingPath === row.sound.path
  const pending = pendingPath === row.sound.path

  return (
    <div className={`explore-row is-sound is-depth-${row.depth}`} style={boxOf(row)}>
      <button
        type="button"
        className={`button is-small is-icon${pending ? ' is-loading-pulse' : ''}`}
        onClick={() => void play(token, row.sound)}
        title={playing ? 'stop' : `play ${row.sound.path}`}
        aria-label={playing ? 'stop' : `play ${row.sound.path}`}
      >
        <Icon name={playing ? 'pause' : 'play'} size={13} />
      </button>
      <span className="explore-name">{row.label}</span>
      <button
        type="button"
        className={`button is-small is-icon explore-copy${copied ? ' is-copied' : ''}`}
        onClick={() => {
          // Absolute, because the point of it is to be pasted somewhere else.
          const url = new URL(soundSharePath(row.sound.path), window.location.href).href
          void copyText(url).then((ok) => {
            if (!ok) return
            setCopied(true)
            setTimeout(() => setCopied(false), 1200)
          })
        }}
        title={copied ? 'copied' : `copy a link to ${row.sound.path}`}
        aria-label={copied ? 'copied' : `copy a link to ${row.sound.path}`}
      >
        <Icon name={copied ? 'check' : 'copy'} size={13} />
      </button>
    </div>
  )
}
