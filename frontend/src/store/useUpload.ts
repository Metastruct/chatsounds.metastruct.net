/**
 * The Upload form's state: realm areas and the files dropped into them.
 *
 * Files are held as the `File` objects the drop handed over, not copies. A
 * `File` is an immutable handle, the browser reads it lazily, and the eventual
 * pull request wants the original bytes anyway. Only the first kilobyte is read
 * here, to check the header.
 *
 * Validation happens on the way in, so everything in `files` is already known
 * to be Vorbis at 44.1 kHz, mono or stereo. What failed lands in `rejected`
 * with the reason, kept until the next drop into the same area: an invalid
 * file silently not appearing reads as the drop not working.
 */

import { create } from 'zustand'
import { OGG_PROBE_BYTES, describeOggProblem, identifyOgg } from '../pipeline/ogg'

export interface RealmFile {
  id: string
  name: string
  file: File
  sampleRate: number
  channels: number
}

export interface RealmArea {
  id: string
  /** '' until the user picks or types one. */
  realm: string
  files: RealmFile[]
  /** The last drop's failures, with the reason each cannot go in. */
  rejected: { name: string; reason: string }[]
}

interface UploadState {
  areas: RealmArea[]
  addArea: () => void
  removeArea: (id: string) => void
  setRealm: (id: string, realm: string) => void
  addFiles: (id: string, files: FileList | File[]) => Promise<void>
  removeFile: (areaId: string, fileId: string) => void
}

let uid = 0
const nextId = () => `u${++uid}`

const emptyArea = (): RealmArea => ({ id: nextId(), realm: '', files: [], rejected: [] })

export const useUpload = create<UploadState>((set) => ({
  areas: [emptyArea()],

  addArea() {
    set((state) => ({ areas: [...state.areas, emptyArea()] }))
  },

  removeArea(id) {
    set((state) => {
      const areas = state.areas.filter((area) => area.id !== id)
      // The form always shows at least one area; an empty page with only an
      // "add" button would look broken.
      return { areas: areas.length ? areas : [emptyArea()] }
    })
  },

  setRealm(id, realm) {
    set((state) => ({
      areas: state.areas.map((area) => (area.id === id ? { ...area, realm } : area)),
    }))
  },

  async addFiles(id, dropped) {
    const accepted: RealmFile[] = []
    const rejected: { name: string; reason: string }[] = []

    for (const file of Array.from(dropped)) {
      if (!file.name.toLowerCase().endsWith('.ogg')) {
        rejected.push({
          name: file.name,
          reason: `${file.name} is not an .ogg file. Convert it first:  ffmpeg -i "${file.name}" -c:a libvorbis -ar 44100 out.ogg`,
        })
        continue
      }
      const head = new Uint8Array(await file.slice(0, OGG_PROBE_BYTES).arrayBuffer())
      const info = identifyOgg(head)
      const reason = describeOggProblem(file.name, info)
      if (reason) {
        rejected.push({ name: file.name, reason })
        continue
      }
      if (info.kind !== 'vorbis') continue // unreachable; narrows the type
      accepted.push({
        id: nextId(),
        name: file.name,
        file,
        sampleRate: info.sampleRate,
        channels: info.channels,
      })
    }

    set((state) => ({
      areas: state.areas.map((area) => {
        if (area.id !== id) return area
        // Dropping a filename that is already there replaces it, the way
        // copying into a folder would.
        const names = new Set(accepted.map((file) => file.name))
        return {
          ...area,
          files: [...area.files.filter((file) => !names.has(file.name)), ...accepted],
          rejected,
        }
      }),
    }))
  },

  removeFile(areaId, fileId) {
    set((state) => ({
      areas: state.areas.map((area) =>
        area.id === areaId
          ? { ...area, files: area.files.filter((file) => file.id !== fileId) }
          : area,
      ),
    }))
  },
}))
