import { useEffect, useState } from 'react'
import { fetchRealms } from '../../lib/realms'
import { useUpload } from '../../store/useUpload'
import { RealmSection } from './RealmSection'

/**
 * The Upload form: realms, and the sounds going into each.
 *
 * This is the start of the real pipeline into the repo. The end of it, signing
 * in with GitHub and opening the pull request, is not built yet, and the form
 * says so instead of pretending a download is the goal.
 */
export function UploadTab() {
  const areas = useUpload((state) => state.areas)
  const addArea = useUpload((state) => state.addArea)

  const [realms, setRealms] = useState<string[]>([])

  useEffect(() => {
    void fetchRealms().then(setRealms)
  }, [])

  const total = areas.reduce((sum, area) => sum + area.files.length, 0)
  const named = areas.every((area) => area.realm || !area.files.length)

  return (
    <div className="container section upload-tab">
      <h1 className="title is-4">Upload sounds</h1>
      <p className="muted">
        Sort your sounds into realms, the group they belong to in game.
      </p>

      <div className="realm-list">
        {areas.map((area) => (
          <RealmSection key={area.id} area={area} realms={realms} />
        ))}
      </div>

      <button type="button" className="button" onClick={addArea}>
        + add a realm
      </button>

      <div className="upload-foot">
        <button type="button" className="button is-primary" disabled>
          Continue with GitHub
        </button>
        <p className="help">
          {total > 0 && !named
            ? 'Name every realm that has sounds in it. '
            : total > 0
              ? `${total} ${total === 1 ? 'sound' : 'sounds'} ready. `
              : ''}
          Signing in with GitHub is coming soon.
        </p>
      </div>
    </div>
  )
}
