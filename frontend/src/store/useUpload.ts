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
import { sanitizeTrigger } from '../pipeline/naming'

export interface RealmFile {
  id: string
  /** The name the file arrived with. */
  name: string
  /**
   * The name it will have in the repo: the filename is the trigger phrase, so
   * it goes through the same rules as every other trigger, plus `.ogg`. The
   * legacy preprocessor rejects paths with uppercase in them outright, so this
   * is not cosmetic.
   */
  targetName: string
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
  /**
   * Take clips straight from the Extract tab, already encoded and already
   * named. Returns the area they landed in.
   *
   * Separate from `addFiles` because these names are finished: they came out of
   * the trigger rules, and clips sharing a name carry the `name/01.ogg` folder
   * that makes them variations. Folding them again would flatten exactly that
   * distinction and quietly drop all but one.
   */
  addFromExtract: (realm: string, clips: { file: File; targetName: string }[]) => Promise<string>
  /** Back to one empty area, once a pull request has taken the files. */
  reset: () => void
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

      const trigger = sanitizeTrigger(file.name.replace(/\.ogg$/i, ''))
      if (!trigger) {
        rejected.push({
          name: file.name,
          reason: `${file.name} has no letters or digits to name a sound with. Rename it to what it says.`,
        })
        continue
      }
      accepted.push({
        id: nextId(),
        name: file.name,
        targetName: `${trigger}.ogg`,
        file,
        sampleRate: info.sampleRate,
        channels: info.channels,
      })
    }

    // Two dropped files can fold to the same name ("Hello!.ogg", "hello.ogg");
    // last one wins, same as the drop-over-existing rule below.
    const byTarget = new Map(accepted.map((file) => [file.targetName, file]))
    accepted.length = 0
    accepted.push(...byTarget.values())

    set((state) => ({
      areas: state.areas.map((area) => {
        if (area.id !== id) return area
        // Dropping a name that is already there replaces it, the way copying
        // into a folder would. Compared on the folded name, since that is the
        // one that has to be unique in the repo.
        const names = new Set(accepted.map((file) => file.targetName))
        return {
          ...area,
          files: [...area.files.filter((file) => !names.has(file.targetName)), ...accepted],
          rejected,
        }
      }),
    }))
  },

  async addFromExtract(realm, clips) {
    const files: RealmFile[] = []
    const rejected: { name: string; reason: string }[] = []

    for (const clip of clips) {
      // Checked like anything else, even though this app encoded them: a
      // regression in the encoder should surface here rather than in a pull
      // request.
      const head = new Uint8Array(await clip.file.slice(0, OGG_PROBE_BYTES).arrayBuffer())
      const info = identifyOgg(head)
      const reason = describeOggProblem(clip.targetName, info)
      if (reason || info.kind !== 'vorbis') {
        rejected.push({ name: clip.targetName, reason: reason ?? 'not a Vorbis file' })
        continue
      }
      files.push({
        id: nextId(),
        name: clip.targetName,
        targetName: clip.targetName,
        file: clip.file,
        sampleRate: info.sampleRate,
        channels: info.channels,
      })
    }

    const area: RealmArea = { id: nextId(), realm, files, rejected }
    set((state) => ({
      // An untouched first area is a placeholder, not work; replace it rather
      // than leaving an empty one above the clips that just arrived.
      areas: [
        ...state.areas.filter((existing) => existing.realm || existing.files.length),
        area,
      ],
    }))
    return area.id
  },

  reset() {
    set({ areas: [emptyArea()] })
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
