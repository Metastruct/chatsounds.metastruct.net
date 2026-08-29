import { useJob } from '../../store/useJob'

const STAGES = [
  // Only shown when the run began with a pasted link.
  { key: 'fetching', label: 'Getting the recording', note: 'bringing it in from the link' },
  { key: 'decoding', label: 'Opening the file', note: 'pulling the audio out of it' },
  { key: 'analyzing', label: 'Looking at the sound', note: 'drawing the waveform' },
  { key: 'detecting', label: 'Finding the lines', note: 'spotting where someone speaks' },
  {
    key: 'downloading',
    label: 'Getting the speech model',
    note: 'first time only, your browser keeps it afterwards',
  },
  {
    key: 'transcribing',
    label: 'Listening',
    note: 'the slow part, and where the names come from',
  },
  { key: 'segmenting', label: 'Cutting the clips', note: 'tidying up the edges' },
]

function megabytes(bytes: number): string {
  return bytes >= 1024 * 1024
    ? `${(bytes / 1024 / 1024).toFixed(1)} MB`
    : `${Math.max(1, Math.round(bytes / 1024))} KB`
}

export function ProcessingScreen() {
  const { status, progress, error, notice, filename, viaUrl, reset } = useJob()

  // A local file never fetched anything; showing that stage as already done
  // would be a small lie at the top of every run.
  const stages = viaUrl ? STAGES : STAGES.slice(1)
  const stage = progress?.stage ?? 'decoding'
  const fraction = progress?.fraction ?? 0
  const current = stages.findIndex((item) => item.key === stage)
  const failed = status === 'failed'

  const loaded = progress?.loaded ?? 0
  const total = progress?.total ?? 0
  // Until a file reports its size there is nothing honest to divide by.
  const haveBytes = total > 0

  return (
    <>
      <div
        className="page-progress"
        style={{ width: `${Math.round(fraction * 100)}%`, opacity: failed ? 0 : 1 }}
      />
      <div className="container section processing">
        <h1 className="title is-4">{filename}</h1>

        {failed ? (
          <div className="notification is-danger" style={{ marginTop: '2rem' }}>
            <p>
              <strong>This file did not work out.</strong>
            </p>
            <p style={{ marginTop: '0.5rem' }}>{error}</p>
            <div className="row" style={{ marginTop: '1rem' }}>
              <button type="button" className="button" onClick={reset}>
                Start over
              </button>
            </div>
          </div>
        ) : (
          <>
            <div className="bar" style={{ marginTop: '2rem' }}>
              <div style={{ width: `${Math.round(fraction * 100)}%` }} />
            </div>
            <p className="muted" style={{ marginTop: '0.5rem' }}>
              {progress?.message || 'starting up'}
            </p>

            {/* Stays put once shown: the stage list rewinding to the top with no
                explanation looks like a bug rather than a recovery. */}
            {notice && (
              <p className="warning-line" style={{ marginTop: '0.5rem' }}>
                {notice}
              </p>
            )}

            <ol className="stage-list">
              {stages.map((item, index) => {
                const state =
                  current > index ? 'done' : current === index ? 'active' : 'todo'
                return (
                  <li key={item.key} className={`stage is-${state}`}>
                    <span className="stage-dot" />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <p className="stage-label">{item.label}</p>
                      <p className="muted">{item.note}</p>

                      {/* The downloads get their own bar in bytes. A percentage
                          alone is not reassuring when a fetch can be 800 MB. */}
                      {(item.key === 'downloading' || item.key === 'fetching') &&
                        state === 'active' && (
                        <div className="download-detail">
                          {haveBytes ? (
                            <>
                              <div className="bar">
                                <div
                                  style={{
                                    width: `${Math.round((loaded / total) * 100)}%`,
                                  }}
                                />
                              </div>
                              <p className="download-figures">
                                <strong>{megabytes(loaded)}</strong> of{' '}
                                {megabytes(total)}
                                <span className="muted">
                                  {' '}
                                  ({Math.round((loaded / total) * 100)}%)
                                </span>
                              </p>
                            </>
                          ) : (
                            <p className="muted is-loading-pulse">connecting…</p>
                          )}
                          {/* True of the model's shards, not of one file. */}
                          {item.key === 'downloading' && (
                            <p className="muted download-note">
                              The total grows as more parts turn up.
                            </p>
                          )}
                        </div>
                      )}
                    </div>
                  </li>
                )
              })}
            </ol>

            <p className="muted" style={{ marginTop: '2rem' }}>
              Keep this tab open and in front, browsers slow background tabs down.
            </p>
          </>
        )}
      </div>
    </>
  )
}
