import { useEffect, useState } from 'react'
import { fetchRealms } from '../../lib/realms'
import { RealmInput } from '../upload/RealmInput'

/**
 * Asking where the clips are going, before carrying them to the Upload tab.
 *
 * The warning is not boilerplate. Nothing in this tab survives a reload: the
 * decoded recording, the clips, the names, all of it lives in the page. Moving
 * on is the moment someone is most likely to lose an hour of naming to a stray
 * refresh, so this is where saying so is worth the words.
 */

interface Props {
  files: number
  busy: boolean
  onCancel: () => void
  onSend: (realm: string) => void
}

export function HandOff({ files, busy, onCancel, onSend }: Props) {
  const [realm, setRealm] = useState('')
  const [realms, setRealms] = useState<string[]>([])

  useEffect(() => {
    void fetchRealms().then(setRealms)
  }, [])

  return (
    <div className="hand-off">
      <p className="heading">
        Send {files} {files === 1 ? 'clip' : 'clips'} to Upload
      </p>

      <div className="field">
        <label className="label" htmlFor="handoff-realm">
          Which realm?
        </label>
        <RealmInput value={realm} realms={realms} onChange={setRealm} />
      </div>

      <p className="warning-line">
        Download the zip first if you want to keep a copy. Nothing here survives a
        reload, and this does not save anything to your computer.
      </p>

      <div className="row is-tight">
        <button
          type="button"
          className="button is-small is-primary"
          disabled={busy || !realm}
          onClick={() => onSend(realm)}
        >
          {busy ? 'Sending…' : 'Send'}
        </button>
        <button type="button" className="button is-small" disabled={busy} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  )
}
