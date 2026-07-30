import { useEffect, useRef, useState } from 'react'
import { MODELS } from '../pipeline/asr'
import {
  type BackendChoice,
  type GpuStatus,
  browserFamily,
  gpuStatus,
} from '../pipeline/gpu'
import { ACCEPTED_EXTENSIONS, describeUnsupported } from '../pipeline/decode'
import { type LastJob, loadJob } from '../store/persist'
import { DEFAULTS, useJob } from '../store/useJob'
import type { AnalyzeOptions } from '../workers/pipeline.worker'

const ACCEPT = ACCEPTED_EXTENSIONS.join(',')

export function UploadScreen() {
  const start = useJob((state) => state.start)
  const inputRef = useRef<HTMLInputElement | null>(null)

  const [showSettings, setShowSettings] = useState(false)
  const [options, setOptions] = useState<AnalyzeOptions>({})
  const [dragging, setDragging] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [gpu, setGpu] = useState<GpuStatus | null>(null)
  const threaded = typeof SharedArrayBuffer !== 'undefined'
  const [last, setLast] = useState<LastJob | null>(null)

  useEffect(() => {
    void gpuStatus().then(setGpu)
    void loadJob().then(setLast)
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
          Audio or video: mp3, wav, ogg, flac, m4a, opus, mp4, webm, mov. Nothing
          leaves your computer, it all happens in this tab.
        </p>
      </div>

      {error && (
        <div className="notification is-danger" style={{ marginTop: '1rem' }}>
          {error}
        </div>
      )}

      {last && (
        <p className="muted" style={{ marginTop: '1rem' }}>
          Last time you opened <strong>{last.filename}</strong> and got{' '}
          {last.segmentCount} clips. Since nothing was saved anywhere, open that file
          again to carry on.
        </p>
      )}

      <div className="upload-options">
        <button
          type="button"
          className="button"
          onClick={() => setShowSettings((value) => !value)}
        >
          {showSettings ? 'Hide' : 'Show'} more settings
        </button>
      </div>

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

      {showSettings && (
        <div className="panel settings-grid fade-in">
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
            <p className="help">
              Downloaded once, then kept by your browser. The bigger ones get more
              names right and take longer.
            </p>
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
            <p className="help">
              {!gpu
                ? 'The graphics card is several times faster where it works.'
                : !gpu.available
                  ? 'There is no graphics card available here, so this runs on the processor either way.'
                  : browserFamily() === 'firefox'
                    ? "Firefox's WebGPU still gives out partway through this model, so it is skipped by default. You can insist on it, and if it does give out the run simply starts again on the processor."
                    : 'The graphics card is several times faster. If it gives out, the run starts again on the processor.'}
            </p>
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
              A two letter code such as <code>en</code>. Setting it helps with short or
              noisy recordings.
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
            help="Lower picks up quiet speech, and more background noise with it. Higher keeps only clear speech."
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
            help="How much quiet it takes to end a line. Raise it if single lines keep getting cut in half."
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
      )}
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
    <p style={{ marginTop: '0.5rem' }}>
      It will still work, on the processor, but expect it to take several times the
      length of the recording. The smaller models (<strong>tiny.en</strong> or{' '}
      <strong>base</strong>) are the usual answer.
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
            <>
              Firefox has it on by default on Windows only. On Linux and macOS, open{' '}
              <code>about:config</code>, set <code>dom.webgpu.enabled</code> to{' '}
              <code>true</code>, and restart Firefox.
            </>
          ) : (
            <>
              Usually a graphics driver Firefox does not trust rather than the card
              itself. On Linux it wants a working Vulkan driver, so check that{' '}
              <code>vulkaninfo</code> runs before changing anything in the browser.
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
          On <strong>Linux</strong> this is usually not the card. Turn on both{' '}
          <code>chrome://flags/#enable-unsafe-webgpu</code> and{' '}
          <code>chrome://flags/#enable-vulkan</code>, then restart the browser.{' '}
          <code>chrome://gpu</code> gives the real reason under WebGPU, which is worth
          reading first. Brave also blocks it under Shields.
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
