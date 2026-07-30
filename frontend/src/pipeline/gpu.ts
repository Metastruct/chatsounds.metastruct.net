/**
 * Whether this browser will hand us a GPU, and why not when it will not.
 *
 * Worth being precise about: "WebGPU is not available" has four causes that need
 * four different answers, and none of them are things the page can fix by
 * itself -- so the only useful thing it can do is name the right one.
 *
 * The answer is also cached. `requestAdapter` is not free, it is asked for by
 * the upload screen and again by the worker for every transcription, and the
 * answer cannot change without a reload.
 */

export type GpuStatus =
  /** WebGPU is available and an adapter was granted. */
  | {
      available: true
      /**
       * Whether the adapter supports `shader-f16`. Half-precision weights are
       * the fast path for the Whisper encoder, and an adapter without the
       * feature fails to load them rather than emulating.
       */
      f16: boolean
    }
  /**
   * `navigator.gpu` is missing entirely. WebGPU is `[SecureContext]`-gated, so
   * on a plain-HTTP origin that is not localhost the browser hides it no matter
   * what hardware or flags are present -- and no browser flag brings it back.
   * This is by far the most common reason it "does not work".
   */
  | { available: false; reason: 'insecure-origin' }
  /** Secure page, but this browser build does not expose WebGPU at all. */
  | { available: false; reason: 'unsupported' }
  /** WebGPU exists but no adapter was granted (no GPU, blocklisted driver). */
  | { available: false; reason: 'no-adapter' }

export type BrowserFamily = 'firefox' | 'chromium' | 'safari' | 'other'

/**
 * Which browser this is, only ever used to name the right settings page.
 *
 * Sniffing the user agent to decide *behaviour* would be wrong; the enable-it
 * instructions genuinely differ per browser, and there is nothing to feature
 * detect when the feature is the one that is missing.
 */
export function browserFamily(): BrowserFamily {
  const agent = globalThis.navigator?.userAgent ?? ''
  if (/Firefox\/|FxiOS/.test(agent)) return 'firefox'
  if (/Edg\/|Chrome\/|Chromium\//.test(agent)) return 'chromium'
  if (/Safari\//.test(agent)) return 'safari'
  return 'other'
}

export type PlatformFamily = 'windows' | 'macos' | 'linux' | 'other'

/**
 * Which desktop this is, for the same reason as `browserFamily`: the way to turn
 * WebGPU on, and the usual reason it is off, both differ per platform. Telling a
 * Windows user to enable a Linux Vulkan flag is worse than saying nothing.
 */
export function platformFamily(): PlatformFamily {
  const nav = globalThis.navigator as Navigator & { userAgentData?: { platform?: string } }
  // userAgentData is the honest source where it exists; the agent string is the
  // fallback, and is all Firefox and Safari offer.
  const hint = nav?.userAgentData?.platform ?? nav?.userAgent ?? ''
  if (/Windows/i.test(hint)) return 'windows'
  if (/macOS|Mac OS X|Macintosh/i.test(hint)) return 'macos'
  if (/Linux|X11|CrOS/i.test(hint)) return 'linux'
  return 'other'
}

interface Gpu {
  requestAdapter(): Promise<{ features: { has(feature: string): boolean } } | null>
}

async function probe(): Promise<GpuStatus> {
  const gpu = (globalThis.navigator as Navigator & { gpu?: Gpu }).gpu

  if (!gpu) {
    return {
      available: false,
      reason: globalThis.isSecureContext ? 'unsupported' : 'insecure-origin',
    }
  }
  try {
    const adapter = await gpu.requestAdapter()
    if (!adapter) return { available: false, reason: 'no-adapter' }
    return { available: true, f16: adapter.features.has('shader-f16') }
  } catch {
    return { available: false, reason: 'no-adapter' }
  }
}

let cached: Promise<GpuStatus> | null = null

export function gpuStatus(): Promise<GpuStatus> {
  cached ??= probe()
  return cached
}

export async function hasWebGpu(): Promise<boolean> {
  return (await gpuStatus()).available
}

/** Where the model runs. */
export type Backend = 'webgpu' | 'wasm'

/** What the user asked for. `auto` is the default and is described below. */
export type BackendChoice = 'auto' | Backend

/**
 * Turn a preference into the backend to actually use.
 *
 * `auto` deliberately does not take Firefox's WebGPU. It grants an adapter and
 * loads the model, then fails partway through inference inside onnxruntime's own
 * buffer manager -- "Failed to download data from buffer: Mapping WebGPU buffer
 * failed: Invalid buffer". Whisper is where that shows up, being the only model
 * here big enough to reach it; the failure is recoverable (the store starts over
 * on the CPU) but it costs a fresh download of a different set of weights, so it
 * is not a good default. Choosing `webgpu` explicitly still tries -- the
 * implementation is moving quickly, and this is a preference, not a lockout.
 */
export async function resolveBackend(choice: BackendChoice = 'auto'): Promise<Backend> {
  if (choice === 'wasm') return 'wasm'
  if (!(await gpuStatus()).available) return 'wasm'
  if (choice === 'auto' && browserFamily() === 'firefox') return 'wasm'
  return 'webgpu'
}
