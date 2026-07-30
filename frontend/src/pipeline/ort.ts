/**
 * One onnxruntime for the whole app, with its WebAssembly pinned to our origin.
 *
 * Two separate problems live here, and both of them surface as the same useless
 * message -- "no available backend found. ERR: [wasm] ... failed to match magic
 * number":
 *
 *  1. onnxruntime works out where its `.wasm` is by resolving the filename
 *     against the module that loaded it. Under a bundler that lands on a path
 *     nothing serves: Vite's dev server answers it with `index.html`, which the
 *     runtime then tries to compile as WebAssembly and rejects at the magic
 *     number. Naming both files explicitly, as URLs Vite emits as real assets,
 *     is the fix -- and it is the same code path in dev and in the build.
 *  2. transformers.js, finding `wasmPaths` unset, points it at jsdelivr. That
 *     turns a binary we already ship into a third-party download of tens of
 *     megabytes, which the rest of this app goes out of its way to avoid.
 *
 * The VAD and Whisper both reach onnxruntime through `onnxruntime-web/webgpu`
 * so that there is a single runtime, with a single `env` and a single copy of
 * that binary. Importing the plain `onnxruntime-web` entry point instead -- as
 * the VAD used to -- gets a second runtime whose wasm has a different filename
 * (`.jsep` rather than `.asyncify`), so the app compiled 50 MB of WebAssembly to
 * do the work of 24.
 */

import { env } from 'onnxruntime-web/webgpu'
// The binary has to match the execution provider we intend to use. The asyncify
// build is the one that can drive WebGPU; the plain build is CPU-only, and at
// half the size and without asyncify's instrumentation it is the better choice
// when there is no GPU to reach anyway.
import asyncifyWasm from 'onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm?url'
import asyncifyMjs from 'onnxruntime-web/ort-wasm-simd-threaded.asyncify.mjs?url'
import cpuWasm from 'onnxruntime-web/ort-wasm-simd-threaded.wasm?url'
import cpuMjs from 'onnxruntime-web/ort-wasm-simd-threaded.mjs?url'
import { type Backend, resolveBackend } from './gpu'

let configured: Promise<void> | null = null

/**
 * Must be awaited before the first `InferenceSession.create`.
 *
 * Idempotent, and the first call is the one that counts: the binary cannot be
 * swapped once it is loaded. So the caller that knows which backend was asked
 * for -- the worker, before it starts anything -- passes it, and the VAD then
 * inherits whatever was decided rather than voting for the CPU build first.
 */
export function configureOrt(backend?: Backend): Promise<void> {
  configured ??= (async () => {
    const resolved = backend ?? (await resolveBackend())

    env.wasm.wasmPaths =
      resolved === 'webgpu'
        ? { mjs: asyncifyMjs, wasm: asyncifyWasm }
        : { mjs: cpuMjs, wasm: cpuWasm }

    // Threads need SharedArrayBuffer, which only cross-origin-isolated pages
    // are given. Left to guess on a page without it, onnxruntime still counts
    // `hardwareConcurrency`, then fails to start the pool -- and reports that,
    // too, as "no available backend found".
    if (typeof SharedArrayBuffer === 'undefined') env.wasm.numThreads = 1

    // We are already inside a worker, so proxying to another one would only add
    // a hop. (transformers.js sets this as well; being explicit keeps the two
    // from depending on module evaluation order.)
    env.wasm.proxy = false
  })()

  return configured
}
