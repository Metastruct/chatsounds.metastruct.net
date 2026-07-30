import { useRef, useState } from 'react'
import type { RealmArea } from '../../store/useUpload'
import { useUpload } from '../../store/useUpload'
import { Icon } from '../Icon'
import { RealmInput } from './RealmInput'

/**
 * One realm: its name, and the drop area for the sounds going into it.
 *
 * Everything accepted is listed with what the header said about it, and
 * everything refused is listed with the exact line that fixes it. A file
 * silently not appearing is indistinguishable from the drop not working.
 */

interface Props {
  area: RealmArea
  realms: string[]
}

export function RealmSection({ area, realms }: Props) {
  const setRealm = useUpload((state) => state.setRealm)
  const addFiles = useUpload((state) => state.addFiles)
  const removeFile = useUpload((state) => state.removeFile)
  const removeArea = useUpload((state) => state.removeArea)

  const inputRef = useRef<HTMLInputElement | null>(null)
  const [dragging, setDragging] = useState(false)

  return (
    <div className="card realm-area">
      <div className="realm-head">
        <RealmInput
          value={area.realm}
          realms={realms}
          onChange={(realm) => setRealm(area.id, realm)}
        />
        {area.files.length > 0 && (
          <span className="muted realm-count">
            {area.files.length} {area.files.length === 1 ? 'file' : 'files'}
          </span>
        )}
        <span className="spacer" />
        <button
          type="button"
          className="button is-small is-icon is-danger"
          title="Remove this realm"
          onClick={() => removeArea(area.id)}
        >
          <Icon name="trash" size={15} />
        </button>
      </div>

      <div
        className={`dropzone is-compact${dragging ? ' is-dragging' : ''}`}
        onDragOver={(event) => {
          event.preventDefault()
          setDragging(true)
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          event.preventDefault()
          setDragging(false)
          if (event.dataTransfer.files?.length) void addFiles(area.id, event.dataTransfer.files)
        }}
        onClick={() => inputRef.current?.click()}
      >
        <input
          ref={inputRef}
          type="file"
          accept=".ogg"
          multiple
          hidden
          onChange={(event) => {
            if (event.target.files?.length) void addFiles(area.id, event.target.files)
            event.target.value = ''
          }}
        />
        <p className="muted">
          Drop sounds here: <code>.ogg</code> at 44.1 kHz, mono or stereo
        </p>
      </div>

      {area.files.length > 0 && (
        <ul className="realm-files">
          {area.files.map((file) => (
            <li key={file.id} className="realm-file">
              <span className="realm-file-name">{file.name}</span>
              <span className="muted">
                44.1 kHz · {file.channels === 1 ? 'mono' : 'stereo'}
                {/* The filename is the trigger phrase, so it gets the trigger
                    rules. Only said when that changes anything. */}
                {file.targetName !== file.name.toLowerCase() && ` · saved as ${file.targetName}`}
              </span>
              <button
                type="button"
                className="button is-small is-icon"
                title="Take this file out"
                onClick={() => removeFile(area.id, file.id)}
              >
                <Icon name="trash" size={13} />
              </button>
            </li>
          ))}
        </ul>
      )}

      {area.rejected.map((reject) => (
        <p key={reject.name} className="warning-line">
          {reject.reason}
        </p>
      ))}
    </div>
  )
}
