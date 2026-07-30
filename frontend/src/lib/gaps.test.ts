import { expect, test } from 'vitest'
import { type Span, freeSpot } from './gaps'

const span = (startS: number, endS: number): Span => ({ startS, endS })

test('takes the playhead itself when nothing is there', () => {
  expect(freeSpot([span(0, 2), span(5, 7)], 3, 10)).toEqual([3, 4])
})

test('never lands on top of an existing clip', () => {
  // Playhead at 1, inside the first clip, so the gap after it is the answer.
  expect(freeSpot([span(0, 2), span(5, 7)], 1, 10)).toEqual([2, 3])
})

test('is cut short by the next clip rather than overlapping it', () => {
  const spot = freeSpot([span(0, 2), span(2.5, 7)], 1, 10)
  expect(spot).toEqual([2, 2.5])
})

test('skips a gap too small to be worth having', () => {
  // 2 to 2.1 is under the floor, so the search moves past it.
  const spot = freeSpot([span(0, 2), span(2.1, 4)], 0, 10)
  expect(spot).toEqual([4, 5])
})

test('falls back to the tail of the recording', () => {
  expect(freeSpot([span(0, 9.5)], 0, 10)).toEqual([9.5, 10])
})

test('looks before the playhead once everything after it is taken', () => {
  const spans = [span(0, 1), span(4, 10)]
  // From 5 there is nothing left, so it wraps and finds 1 to 4.
  expect(freeSpot(spans, 5, 10)).toEqual([1, 2])
})

test('gives up when the recording is covered end to end', () => {
  expect(freeSpot([span(0, 10)], 4, 10)).toBeNull()
  expect(freeSpot([span(0, 5), span(5, 10)], 0, 10)).toBeNull()
})

test('handles overlapping clips without going backwards', () => {
  // A clip extended over its neighbour leaves one covered stretch, not two.
  expect(freeSpot([span(0, 6), span(2, 4)], 0, 10)).toEqual([6, 7])
})
