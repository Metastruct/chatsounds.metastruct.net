/**
 * The app spent a while unable to process anything at all because onnxruntime
 * was left to find its own `.wasm`, resolved it against a path nothing serves,
 * got `index.html` back and reported "no available backend found ... failed to
 * match magic number". Nothing type-checks that, so it is checked here: both
 * halves of the pair have to be named, and they have to be a matching pair.
 */

import { expect, test } from 'vitest'
import { env } from 'onnxruntime-web/webgpu'
import { configureOrt } from './ort'

test('onnxruntime is told where both halves of its wasm are', async () => {
  await configureOrt()

  const paths = env.wasm.wasmPaths
  expect(typeof paths, 'a bare prefix leaves the filename up to onnxruntime').toBe('object')

  const { mjs, wasm } = paths as { mjs?: string | URL; wasm?: string | URL }
  expect(String(mjs)).toMatch(/ort-wasm-simd-threaded[\w.]*\.mjs$/)
  expect(String(wasm)).toMatch(/ort-wasm-simd-threaded[\w.]*\.wasm$/)

  // The glue and the binary are built together and are not interchangeable
  // across variants: `.asyncify.mjs` cannot start the plain binary.
  const variant = (name: string) => name.replace(/\.(mjs|wasm)$/, '')
  expect(variant(String(mjs))).toBe(variant(String(wasm)))
})
