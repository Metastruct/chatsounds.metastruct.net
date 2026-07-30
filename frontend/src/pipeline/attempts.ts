/**
 * What to try next when transcription fails, and when to stop trying.
 *
 * Kept apart from both the worker and the model code because it is the one part
 * of the recovery that is pure decision -- and because a wrong step here is an
 * infinite loop rather than a wrong answer.
 *
 * Every rung has to change something, and the ladder has to end. The order is
 * the GPU first (several times faster when it works), then the CPU on quantised
 * weights, then the CPU at full precision -- which is the combination nothing has
 * been observed to reject, and also the slowest and largest, hence last.
 */

import type { Backend } from './gpu'

/** How heavy a set of weights to ask for. */
export type Precision = 'fast' | 'full'

export interface Attempt {
  backend: Backend
  precision: Precision
}

export function nextAttempt({ backend, precision }: Attempt): Attempt | null {
  if (backend === 'webgpu') return { backend: 'wasm', precision: 'fast' }
  if (precision === 'fast') return { backend: 'wasm', precision: 'full' }
  return null
}
