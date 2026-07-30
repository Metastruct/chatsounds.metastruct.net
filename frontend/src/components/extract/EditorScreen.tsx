import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useHotkeys } from '../../hooks/useHotkeys'
import { usePlayer } from '../../hooks/usePlayer'
import { formatDuration, formatTime } from '../../lib/format'
import { freeSpot } from '../../lib/gaps'
import { toBlob } from '../../lib/blob'
import { type Segment, relativePaths, useJob } from '../../store/useJob'
import { useTabs } from '../../store/useTabs'
import { useUpload } from '../../store/useUpload'
import { HandOff } from './HandOff'
import { ClipEditor } from './ClipEditor'
import { SegmentRow } from './SegmentRow'
import { Waveform, type WaveRegion } from './Waveform'

export function EditorScreen() {
  const {
    name,
    durationS,
    master,
    envelope,
    segments,
    selectedId,
    backend,
    select,
    step,
    patch,
    nudge,
    create,
    split,
    merge,
    remove,
    retranscribe,
    setName,
    buildDownload,
    buildFiles,
    manifest,
    reset,
  } = useJob()

  const addFromExtract = useUpload((state) => state.addFromExtract)
  const setTab = useTabs((state) => state.setTab)

  const listRef = useRef<HTMLDivElement | null>(null)
  const [filter, setFilter] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [nameDraft, setNameDraft] = useState(name)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [handingOver, setHandingOver] = useState(false)
  const [sending, setSending] = useState(false)

  const player = usePlayer(master)
  const peaks = useJob((state) => state.peaks)()
  const paths = useMemo(() => relativePaths(segments), [segments])

  const selected = useMemo(
    () => segments.find((segment) => segment.id === selectedId) ?? null,
    [segments, selectedId],
  )

  useEffect(() => {
    if (!selectedId && segments.length) select(segments[0].id)
  }, [segments, selectedId, select])

  // The store drops anything a filename cannot carry, so the field has to show
  // what was kept rather than what was typed.
  useEffect(() => {
    setNameDraft(name)
  }, [name])

  const visible = useMemo(() => {
    const needle = filter.trim().toLowerCase()
    if (!needle) return segments
    return segments.filter(
      (segment) =>
        segment.trigger.includes(needle) || segment.transcript.toLowerCase().includes(needle),
    )
  }, [segments, filter])

  const regions: WaveRegion[] = useMemo(
    () =>
      segments.map((segment) => ({
        id: segment.id,
        start: segment.startS,
        end: segment.endS,
        selected: segment.id === selectedId,
        disabled: !segment.enabled,
      })),
    [segments, selectedId],
  )

  const play = useCallback(
    (segment: Segment) => {
      if (player.playing) {
        player.stop()
        return
      }
      player.playRange(segment.startS, segment.endS)
    },
    [player],
  )

  const selectAndScroll = useCallback(
    (id: string) => {
      select(id)
      document.querySelector(`[data-segment="${id}"]`)?.scrollIntoView({ block: 'nearest' })
    },
    [select],
  )

  const splitHere = useCallback(() => {
    if (!selected) return
    const at =
      player.time > selected.startS && player.time < selected.endS
        ? player.time
        : (selected.startS + selected.endS) / 2
    split(selected.id, at)
  }, [selected, player.time, split])

  const nameClip = useCallback(
    async (id: string) => {
      setBusy(id)
      try {
        await retranscribe(id)
      } finally {
        setBusy(null)
      }
    },
    [retranscribe],
  )

  // A clip drawn by hand has no words behind it, so it is listened to straight
  // away: an unnamed clip is the one thing in here that is of no use at all.
  const addClip = useCallback(
    (startS: number, endS: number) => {
      const id = create(startS, endS)
      selectAndScroll(id)
      void nameClip(id)
    },
    [create, nameClip, selectAndScroll],
  )

  // Where the button would put one. Dragging on the timeline says where itself,
  // but a button has to choose, and landing a clip on top of one that is already
  // there is never what was meant.
  const spot = useMemo(
    () => freeSpot(segments, player.time, durationS),
    [segments, player.time, durationS],
  )

  useHotkeys({
    ' ': () => selected && play(selected),
    j: () => step(1),
    k: () => step(-1),
    ArrowDown: () => step(1),
    ArrowUp: () => step(-1),
    '[': () => selected && nudge(selected.id, 'start', -0.05),
    ']': () => selected && nudge(selected.id, 'start', 0.05),
    '{': () => selected && nudge(selected.id, 'end', -0.05),
    '}': () => selected && nudge(selected.id, 'end', 0.05),
    s: splitHere,
    m: () => selected && merge(selected.id, 'next'),
    x: () => selected && remove(selected.id),
    n: () => spot && addClip(spot[0], spot[1]),
    Enter: () => {
      const input = listRef.current?.querySelector<HTMLInputElement>(
        `[data-segment="${selectedId}"] .segment-trigger`,
      )
      input?.focus()
      input?.select()
    },
  })

  // What would be written, which is the honest answer for whether there is
  // anything to write at all: a clip left out is no file.
  const files = useMemo(() => manifest().entries.length, [manifest, segments])

  /**
   * Carry the clips into the Upload tab and follow them there.
   *
   * They go across as encoded files rather than as a reference to this job, so
   * editing here afterwards does not quietly change what is queued to upload.
   */
  const handOver = async (realm: string) => {
    setSending(true)
    setSaveError(null)
    try {
      await addFromExtract(realm, await buildFiles())
      setHandingOver(false)
      setTab('upload')
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : String(error))
    } finally {
      setSending(false)
    }
  }

  const save = async () => {
    setSaving(true)
    setSaveError(null)
    try {
      const zip = await buildDownload()
      const url = URL.createObjectURL(toBlob(zip, 'application/zip'))
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = `${name}.zip`
      anchor.click()
      // Revoking immediately can cancel the download in some browsers.
      setTimeout(() => URL.revokeObjectURL(url), 30_000)
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : String(error))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="container is-wide editor">
      <div className="editor-head">
        <div>
          {/* Not a form field, just the heading, which starts as the recording's
              own name and can be corrected. It names the download. */}
          <input
            className="title is-4 set-name"
            value={nameDraft}
            spellCheck={false}
            aria-label="Name for these clips"
            title="Click to rename"
            onChange={(event) => setNameDraft(event.target.value)}
            onBlur={() => setName(nameDraft)}
            onKeyDown={(event) => event.key === 'Enter' && event.currentTarget.blur()}
          />
          <p className="muted">
            {formatDuration(durationS)} &middot; {segments.length}{' '}
            {segments.length === 1 ? 'clip' : 'clips'}
            {backend === 'webgpu' ? ' · used the graphics card' : ''}
          </p>
        </div>
        <span className="spacer" />
        <button type="button" className="button" onClick={reset}>
          ← New file
        </button>
      </div>

      <div className="card overview">
        <Waveform
          min={peaks?.min ?? []}
          max={peaks?.max ?? []}
          from={0}
          to={peaks?.duration ?? durationS ?? 1}
          height={110}
          regions={regions}
          // Shown after playback stops as well, not just during it: it is where
          // "add a clip" will put one, and a marker that vanishes would make that
          // look arbitrary.
          playhead={player.time > 0 ? player.time : null}
          onRegionClick={selectAndScroll}
          onScrub={(seconds) => player.playRange(seconds)}
          onTrim={(id, bounds) => patch(id, bounds)}
          onCreate={addClip}
        />
        <p className="help timeline-hint">
          Drag a clip's edges to trim it, drag an empty stretch to add one.
        </p>
      </div>

      <div className="editor-body">
        <div className="editor-list">
          <div className="row toolbar">
            <button
              type="button"
              className="button is-small"
              disabled={!spot}
              title={
                spot ? `Add a clip at ${formatTime(spot[0])} (n)` : 'There is no gap left'
              }
              onClick={() => spot && addClip(spot[0], spot[1])}
            >
              + add a clip
            </button>
            <input
              className="input is-small"
              placeholder="Search…"
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
            />
            <span className="spacer" />

            <button
              type="button"
              className="button is-small"
              disabled={sending || !files}
              onClick={() => setHandingOver(true)}
            >
              {sending ? 'Sending…' : 'Send to Upload'}
            </button>

            <button
              type="button"
              className="button is-small is-primary"
              disabled={saving || !files}
              title={`${files} ${files === 1 ? 'file' : 'files'}`}
              onClick={() => void save()}
            >
              {saving ? 'Getting the clips ready…' : `Download ${name}.zip`}
            </button>
          </div>

          {handingOver && (
            <HandOff
              files={files}
              busy={sending}
              onCancel={() => setHandingOver(false)}
              onSend={(realm) => void handOver(realm)}
            />
          )}

          {saveError && <p className="warning-line">{saveError}</p>}

          <div className="segment-list" ref={listRef}>
            {visible.map((segment) => (
              <div key={segment.id} data-segment={segment.id}>
                <SegmentRow
                  segment={segment}
                  relativePath={paths.get(segment.id) ?? ''}
                  selected={segment.id === selectedId}
                  playing={player.playing && segment.id === selectedId}
                  naming={busy === segment.id}
                  onSelect={() => selectAndScroll(segment.id)}
                  onPlay={() => {
                    selectAndScroll(segment.id)
                    play(segment)
                  }}
                />
              </div>
            ))}
            {!visible.length && (
              <p className="muted" style={{ padding: '2rem 0' }}>
                Nothing matches that search.
              </p>
            )}
          </div>
        </div>

        <aside className="editor-side">
          {selected && envelope ? (
            <div className="card">
              <div className="card-header">Clip {selected.position + 1}</div>
              <div className="card-content stack">
                <ClipEditor
                  segment={selected}
                  envelope={envelope}
                  duration={durationS}
                  playhead={player.time > 0 ? player.time : null}
                  onCommit={(bounds) => patch(selected.id, bounds)}
                  onScrub={(seconds) => player.playRange(seconds, selected.endS)}
                />

                <div className="row is-tight wrap">
                  <button
                    type="button"
                    className="button is-small"
                    title="Cut this clip in two at the playhead (s)"
                    onClick={splitHere}
                  >
                    cut in two
                  </button>
                  <button
                    type="button"
                    className="button is-small"
                    title="Join this clip to the one after it (m)"
                    onClick={() => merge(selected.id, 'next')}
                  >
                    join to next
                  </button>
                  <button
                    type="button"
                    className="button is-small"
                    title="Listen again and name it from what is said"
                    disabled={busy === selected.id}
                    onClick={() => void nameClip(selected.id)}
                  >
                    {busy === selected.id ? 'listening…' : 'name it for me'}
                  </button>
                  {/* Deleting lives on the clip's own row, next to saving it. */}
                </div>

                <div className="field">
                  <label className="label" htmlFor="gain">
                    Volume ({selected.gainDb > 0 ? '+' : ''}
                    {selected.gainDb.toFixed(1)} dB)
                  </label>
                  <input
                    id="gain"
                    type="range"
                    min={-20}
                    max={20}
                    step={0.5}
                    value={selected.gainDb}
                    onChange={(event) =>
                      patch(selected.id, { gainDb: Number(event.target.value) })
                    }
                  />
                </div>

                {selected.transcript && (
                  <p className="muted transcript">“{selected.transcript}”</p>
                )}
              </div>
            </div>
          ) : (
            <div className="card">
              <div className="card-content muted">Pick a clip to work on it.</div>
            </div>
          )}

          <div className="panel shortcuts">
            <p className="heading">Shortcuts</p>
            <ul>
              <li>
                <kbd>space</kbd> play the clip
              </li>
              <li>
                <kbd>j</kbd> / <kbd>k</kbd> next / previous
              </li>
              <li>
                <kbd>[</kbd> <kbd>]</kbd> move the start by 50 ms
              </li>
              <li>
                <kbd>{'{'}</kbd> <kbd>{'}'}</kbd> move the end by 50 ms
              </li>
              <li>
                <kbd>n</kbd> add a clip at the playhead
              </li>
              <li>
                <kbd>s</kbd> cut in two &middot; <kbd>m</kbd> join to next &middot;{' '}
                <kbd>x</kbd> delete
              </li>
              <li>
                <kbd>enter</kbd> rename
              </li>
            </ul>
          </div>
        </aside>
      </div>
    </div>
  )
}
