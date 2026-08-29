import { useEffect, useRef, useState } from 'react'
import { MODELS } from '../../pipeline/asr'
import {
  type BackendChoice,
  type GpuStatus,
  browserFamily,
  gpuStatus,
  platformFamily,
} from '../../pipeline/gpu'
import { youtubeId } from '../../lib/fetchMedia'
import { ACCEPTED_EXTENSIONS, describeUnsupported } from '../../pipeline/decode'
import { DEFAULTS, useJob } from '../../store/useJob'
import type { AnalyzeOptions } from '../../workers/pipeline.worker'

const ACCEPT = ACCEPTED_EXTENSIONS.join(',')

export function StartScreen() {
  const start = useJob((state) => state.start)
  const startFromUrl = useJob((state) => state.startFromUrl)
  const inputRef = useRef<HTMLInputElement | null>(null)

  const [options, setOptions] = useState<AnalyzeOptions>({})
  const [url, setUrl] = useState('')
  const [dragging, setDragging] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [gpu, setGpu] = useState<GpuStatus | null>(null)
  const threaded = typeof SharedArrayBuffer !== 'undefined'

  useEffect(() => {
    void gpuStatus().then(setGpu)
  }, [])

  const send = (file: File) => {
    const unsupported = describeUnsupported(file.name)
    if (unsupported) {
      setError(unsupported)
      return
    }
    setError(null)
    void start(file, options)
  }

  const sendUrl = () => {
    const trimmed = url.trim()
    if (!trimmed) return

    let parsed: URL
    try {
      parsed = new URL(trimmed)
    } catch {
      setError('That does not look like a link.')
      return
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      setError('That does not look like a link.')
      return
    }

    // A known-bad extension deserves the good local error with the ffmpeg
    // hint; a path with no extension passes, the Content-Type decides later.
    if (!youtubeId(trimmed)) {
      let base = parsed.pathname.split('/').pop() ?? ''
      try {
        base = decodeURIComponent(base)
      } catch {
        /* keep it encoded */
      }
      if (/\.[^.]+$/.test(base)) {
        const unsupported = describeUnsupported(base)
        if (unsupported) {
          setError(unsupported)
          return
        }
      }
    }

    setError(null)
    void startFromUrl(trimmed, options)
  }

  return (
    <div className="container section">
      <div
        className={`dropzone${dragging ? ' is-dragging' : ''}`}
        onDragOver={(event) => {
          event.preventDefault()
          setDragging(true)
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          event.preventDefault()
          setDragging(false)
          const file = event.dataTransfer.files?.[0]
          if (file) send(file)
        }}
        onClick={() => inputRef.current?.click()}
      >
        <input
          ref={inputRef}
          type="file"
          accept={ACCEPT}
          hidden
          onChange={(event) => {
            const file = event.target.files?.[0]
            if (file) send(file)
            event.target.value = ''
          }}
        />
        <p className="title is-4">Drop a recording here</p>
        <p className="muted">
          Audio or video: mp3, wav, ogg, flac, m4a, opus, mp4, webm, mov.
        </p>
      </div>

      <div className="field" style={{ marginTop: '1rem' }}>
        <label className="label" htmlFor="url">
          Or paste a link
        </label>
        <div className="row is-tight">
          <input
            id="url"
            className="input"
            placeholder="https://youtube.com/watch?v=... or a direct file link"
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') sendUrl()
            }}
          />
          <button
            type="button"
            className="button is-primary"
            disabled={!url.trim()}
            onClick={sendUrl}
          >
            Fetch
          </button>
        </div>
        <p className="help">
          A YouTube video, or a direct link to an audio or video file.
        </p>
      </div>

      {error && (
        <div className="notification is-danger" style={{ marginTop: '1rem' }}>
          {error}
        </div>
      )}

      {gpu && !gpu.available && (
        <div className="notification is-warning" style={{ marginTop: '1rem' }}>
          <GpuNotice reason={gpu.reason} />
        </div>
      )}

      {gpu?.available && !threaded && (
        <div className="notification is-warning" style={{ marginTop: '1rem' }}>
          This page can only use one processor core, which makes everything slower.
          Opening it over <code>https://</code> (or at <code>localhost</code>) gives
          it the rest.
        </div>
      )}

      <div className="panel settings-grid">
        <div className="field">
          <label className="label" htmlFor="model">
            How carefully to listen
          </label>
          <div className="select">
            <select
              id="model"
              value={options.modelId ?? MODELS[1].id}
              onChange={(event) => setOptions((o) => ({ ...o, modelId: event.target.value }))}
            >
              {MODELS.map((model) => (
                <option key={model.id} value={model.id}>
                  {model.label} ({model.size})
                  {/* Naming the cost where the choice is made: without a
                      graphics card these two take several times the length of
                      the recording, which a download size does not hint at. */}
                  {model.wantsGpu && gpu && !gpu.available
                    ? ' (very slow without WebGPU)'
                    : ''}
                </option>
              ))}
            </select>
          </div>
          <p className="help">Bigger gets more names right, and takes longer.</p>
        </div>

        <div className="field">
          <label className="label" htmlFor="backend">
            Use the graphics card
          </label>
          <div className="select">
            <select
              id="backend"
              value={options.backend ?? DEFAULTS.backend}
              onChange={(event) =>
                setOptions((o) => ({ ...o, backend: event.target.value as BackendChoice }))
              }
            >
              <option value="auto">When it is known to work</option>
              <option value="webgpu">Always, even if it may fail</option>
              <option value="wasm">Never, use the processor</option>
            </select>
          </div>
          {/* Only said when there is something to know: the default quietly
              avoiding the graphics card is the one surprising case. */}
          {gpu?.available && browserFamily() === 'firefox' && (
            <p className="help">
              Firefox's WebGPU still fails partway through, so it is skipped by
              default. If you force it and it fails, the run starts again on the
              processor.
            </p>
          )}
        </div>

        <div className="field">
          <label className="label" htmlFor="lang">
            Language
          </label>
          <input
            id="lang"
            className="input"
            placeholder="work it out"
            value={options.language ?? ''}
            onChange={(event) => setOptions((o) => ({ ...o, language: event.target.value }))}
          />
          <p className="help">
            A two letter code such as <code>en</code>. Helps with noisy recordings.
          </p>
        </div>

        <Slider
          id="threshold"
          label="How quiet still counts as speech"
          value={options.vadThreshold ?? DEFAULTS.vadThreshold}
          min={0.1}
          max={0.9}
          step={0.05}
          format={(v) => v.toFixed(2)}
          help="Lower catches quiet speech, and more noise with it."
          onChange={(vadThreshold) => setOptions((o) => ({ ...o, vadThreshold }))}
        />

        <Slider
          id="silence"
          label="Pause between lines"
          value={options.vadMinSilenceMs ?? DEFAULTS.vadMinSilenceMs}
          min={50}
          max={1500}
          step={25}
          format={(v) => `${v} ms`}
          help="Raise it if single lines keep getting cut in half."
          onChange={(vadMinSilenceMs) => setOptions((o) => ({ ...o, vadMinSilenceMs }))}
        />

        <Slider
          id="maxline"
          label="Longest line"
          value={options.maxLineS ?? DEFAULTS.maxLineS}
          min={2}
          max={30}
          step={1}
          format={(v) => `${v}s`}
          help="Anything longer gets cut in two at its best pause."
          onChange={(maxLineS) => setOptions((o) => ({ ...o, maxLineS }))}
        />
      </div>
    </div>
  )
}

/**
 * Why there is no graphics card, and what to do about it in *this* browser.
 *
 * The one part of the interface that stays technical on purpose: everything here
 * is something the user has to go and change, and the exact setting name is the
 * whole value of the message. A friendly "enable WebGPU" would be no help at all.
 */
function GpuNotice({ reason }: { reason: 'insecure-origin' | 'unsupported' | 'no-adapter' }) {
  const slow = (
    // Measured rather than guessed: base on four cores of a Ryzen 3700X, with no
    // graphics card at all, ran a 58 second recording in about a minute. The
    // earlier "several times the recording" was pessimistic enough to talk people
    // out of a model that would have been fine.
    <p style={{ marginTop: '0.5rem' }}>
      It will still work on the processor. <strong>base</strong> takes roughly the
      length of the recording there, and the larger models a good deal longer.
    </p>
  )

  if (reason === 'insecure-origin') {
    return (
      <>
        <p>
          <strong>This page is not on a secure address, so the browser hides the
          graphics card from it.</strong>
        </p>
        <p style={{ marginTop: '0.5rem' }}>
          No browser gives WebGPU to a plain <code>http://</code> page, and no setting
          changes that. Open it at <code>http://localhost:8080</code> on the machine
          hosting it, or set it up behind <code>https://</code>.
        </p>
        {slow}
      </>
    )
  }

  const family = browserFamily()
  const platform = platformFamily()

  if (family === 'firefox') {
    return (
      <>
        <p>
          <strong>
            {reason === 'unsupported'
              ? 'Firefox is not offering WebGPU here.'
              : 'Firefox has WebGPU, but no graphics card came back.'}
          </strong>
        </p>
        <p style={{ marginTop: '0.5rem' }}>
          {reason === 'unsupported' ? (
            platform === 'windows' ? (
              <>
                Firefox has it on by default on Windows, so this is unusual. Check{' '}
                <code>dom.webgpu.enabled</code> in <code>about:config</code>, and
                whether the graphics driver is current.
              </>
            ) : (
              <>
                Firefox has it on by default on Windows only. Here, open{' '}
                <code>about:config</code>, set <code>dom.webgpu.enabled</code> to{' '}
                <code>true</code>, and restart Firefox.
              </>
            )
          ) : platform === 'linux' ? (
            <>
              Usually a graphics driver Firefox does not trust rather than the card
              itself. It wants a working Vulkan driver, so check that{' '}
              <code>vulkaninfo</code> runs before changing anything in the browser.
            </>
          ) : (
            <>
              Usually a graphics driver Firefox does not trust rather than the card
              itself, and a virtual machine rarely has one it will take.
            </>
          )}
        </p>
        <p style={{ marginTop: '0.5rem' }}>
          <code>about:support</code> says what it settled on, under Graphics.
        </p>
        {slow}
      </>
    )
  }

  if (family === 'chromium') {
    return (
      <>
        <p>
          <strong>
            {reason === 'unsupported'
              ? 'This browser has no WebGPU.'
              : 'This browser has WebGPU, but no graphics card came back.'}
          </strong>
        </p>
        <p style={{ marginTop: '0.5rem' }}>
          {platform === 'linux' ? (
            <>
              On Linux this is usually not the card. Turn on both{' '}
              <code>chrome://flags/#enable-unsafe-webgpu</code> and{' '}
              <code>chrome://flags/#enable-vulkan</code>, then restart the browser.
              Brave also blocks it under Shields.
            </>
          ) : platform === 'windows' ? (
            <>
              Windows normally has it on, so the card or its driver is the usual
              suspect, and a virtual machine rarely has one that qualifies. Updating
              the graphics driver is the first thing to try.
            </>
          ) : (
            <>
              The card or its driver is the usual suspect, and a virtual machine
              rarely has one that qualifies.
            </>
          )}{' '}
          <code>chrome://gpu</code> gives the real reason under WebGPU, which is worth
          reading first.
        </p>
        {slow}
      </>
    )
  }

  return (
    <>
      <p>
        <strong>
          {reason === 'unsupported'
            ? 'This browser is not offering WebGPU.'
            : 'This browser has WebGPU, but no graphics card came back.'}
        </strong>{' '}
        {family === 'safari'
          ? 'In Safari it is under Develop, Feature Flags, WebGPU.'
          : 'Chrome, Edge, and Firefox on Windows have it on by default.'}
      </p>
      {slow}
    </>
  )
}

interface SliderProps {
  id: string
  label: string
  value: number
  min: number
  max: number
  step: number
  format: (value: number) => string
  help: string
  onChange: (value: number) => void
}

function Slider({ id, label, value, min, max, step, format, help, onChange }: SliderProps) {
  return (
    <div className="field">
      <label className="label" htmlFor={id}>
        {label} ({format(value)})
      </label>
      <input
        id={id}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
      />
      <p className="help">{help}</p>
    </div>
  )
}
