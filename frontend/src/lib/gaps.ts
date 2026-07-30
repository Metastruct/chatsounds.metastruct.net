/**
 * Finding somewhere to put a new clip.
 *
 * Dragging on the timeline says where itself. A button has to choose, and the two
 * ways of choosing badly are landing a clip on top of one that already exists, and
 * claiming there is room when there is not.
 */

/** Only the bounds matter here, so this takes less than a `Segment`. */
export interface Span {
  startS: number
  endS: number
}

/** How long a clip to make, before its edges get dragged. */
export const NEW_CLIP_S = 1
/** A gap shorter than this is not worth offering. */
export const LEAST_GAP_S = 0.2

/**
 * The first stretch from `after` onwards that no span covers, or null if there is
 * none worth having.
 *
 * Searching forward from the playhead rather than appending at the end, because
 * the playhead is where the user last listened, which is where they noticed the
 * line nothing picked up. If everything after it is taken, the gaps before it are
 * still fair game.
 *
 * `spans` must be in start order, which is how the store keeps segments, so this
 * is a single pass.
 */
export function freeSpot(spans: Span[], after: number, durationS: number): [number, number] | null {
  const search = (at: number): [number, number] | null => {
    let cursor = Math.max(0, at)
    for (const span of spans) {
      if (span.endS <= cursor) continue
      if (span.startS - cursor >= LEAST_GAP_S) {
        return [cursor, Math.min(cursor + NEW_CLIP_S, span.startS)]
      }
      cursor = Math.max(cursor, span.endS)
    }
    return durationS - cursor >= LEAST_GAP_S
      ? [cursor, Math.min(cursor + NEW_CLIP_S, durationS)]
      : null
  }

  return search(after) ?? (after > 0 ? search(0) : null)
}
