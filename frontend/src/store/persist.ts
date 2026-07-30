/**
 * A breadcrumb of the last job, so a reload is not silently confusing.
 *
 * Deliberately *not* a full session restore. The decoded audio for a long
 * recording is hundreds of megabytes and re-deriving it would mean re-running
 * transcription, so instead of pretending work can be resumed we record what was
 * open and say plainly that it needs re-opening.
 */

import { type DBSchema, openDB } from 'idb'

interface Schema extends DBSchema {
  jobs: {
    key: string
    value: LastJob
  }
}

export interface LastJob {
  filename: string
  durationS: number
  segmentCount: number
  savedAt?: number
}

const KEY = 'last'

const db = () =>
  openDB<Schema>('make-chatsounds', 1, {
    upgrade(database) {
      database.createObjectStore('jobs')
    },
  })

export async function saveJob(job: LastJob): Promise<void> {
  try {
    ;(await db()).put('jobs', { ...job, savedAt: Date.now() }, KEY)
  } catch {
    // Private-browsing modes reject IndexedDB outright; the breadcrumb is a
    // nicety, so losing it must never break the run.
  }
}

export async function loadJob(): Promise<LastJob | null> {
  try {
    const stored = await (await db()).get('jobs', KEY)
    // A row written by an older version carries fields this one does not read and
    // may be missing `filename`, which is the only one worth showing.
    return stored?.filename ? stored : null
  } catch {
    return null
  }
}

export async function deleteStoredJob(): Promise<void> {
  try {
    await (await db()).delete('jobs', KEY)
  } catch {
    /* nothing to clean up */
  }
}
