import { expect, test } from 'vitest'
import { type Attempt, nextAttempt } from './attempts'

test('the GPU falls back to the CPU on the same weights', () => {
  expect(nextAttempt({ backend: 'webgpu', precision: 'fast' })).toEqual({
    backend: 'wasm',
    precision: 'fast',
  })
})

test('quantised weights the runtime rejects fall back to full precision', () => {
  expect(nextAttempt({ backend: 'wasm', precision: 'fast' })).toEqual({
    backend: 'wasm',
    precision: 'full',
  })
})

test('the CPU at full precision is the end of the line', () => {
  expect(nextAttempt({ backend: 'wasm', precision: 'full' })).toBeNull()
})

test('every ladder terminates, from every starting point', () => {
  const starts: Attempt[] = [
    { backend: 'webgpu', precision: 'fast' },
    { backend: 'webgpu', precision: 'full' },
    { backend: 'wasm', precision: 'fast' },
    { backend: 'wasm', precision: 'full' },
  ]

  for (const start of starts) {
    const seen = new Set<string>()
    let at: Attempt | null = start
    // Each rung has to be new, or the store would keep restarting the worker on
    // settings it has already watched fail.
    while (at) {
      const key = `${at.backend}:${at.precision}`
      expect(seen.has(key), `${key} was offered twice from ${JSON.stringify(start)}`).toBe(false)
      seen.add(key)
      at = nextAttempt(at)
    }
    expect(seen.size).toBeLessThanOrEqual(4)
  }
})
