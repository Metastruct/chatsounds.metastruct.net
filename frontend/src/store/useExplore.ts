/**
 * The Explore tab's state: the whole repo as a tree, and one sound playing.
 *
 * The index arrives in a single request and is turned into the tree once, on
 * first open. That is the expensive part (38,000 paths through `checkPath`,
 * around 50ms) and it never has to happen again while the page is up, so the
 * search bar can filter a fully built tree on every keystroke.
 *
 * Audio is the opposite of the Review tab's approach. Review decodes every
 * sound in a pull request up front because a reviewer will hear all of them;
 * nobody plays 38,000 sounds, so bytes are fetched on the click and kept in a
 * small cache in case the same one is played twice. Signed out that is 60
 * fetches an hour, which is enough to browse with and the reason the tab says
 * so when the limit bites.
 */

import { create } from 'zustand'
import type { ExploreRealm, ExploreSound } from '../lib/exploreTree'
import { buildExploreTree, countSounds } from '../lib/exploreTree'
import { UPSTREAM, fetchBlobBytes } from '../lib/github'
import { fetchSoundIndex } from '../lib/soundIndex'

/** One context for the tab; sounds are tiny and play one at a time. */
let sharedContext: AudioContext | null = null
let currentSource: AudioBufferSourceNode | null = null

// Decoded audio, capped because a long browse would otherwise hold every sound
// it touched. Chatsounds are seconds long, so this is a few tens of megabytes
// at worst, and insertion order makes the oldest the one to drop.
const BUFFER_CACHE_MAX = 40
const buffers = new Map<string, AudioBuffer>()

function remember(path: string, buffer: AudioBuffer): void {
  buffers.set(path, buffer)
  if (buffers.size > BUFFER_CACHE_MAX) {
    const oldest = buffers.keys().next()
    if (!oldest.done) buffers.delete(oldest.value)
  }
}

interface ExploreState {
  status: 'idle' | 'loading' | 'ready' | 'failed'
  realms: ExploreRealm[]
  soundCount: number
  /** GitHub cut the tree short, so the list on screen is incomplete. */
  truncated: boolean
  error: string | null

  /** The sound being heard, and the one whose bytes are still coming. */
  playingPath: string | null
  pendingPath: string | null
  playError: { path: string; message: string } | null

  load: (token: string | null) => Promise<void>
  play: (token: string | null, sound: ExploreSound) => Promise<void>
  stop: () => void
}

export const useExplore = create<ExploreState>((set, get) => ({
  status: 'idle',
  realms: [],
  soundCount: 0,
  truncated: false,
  error: null,
  playingPath: null,
  pendingPath: null,
  playError: null,

  load: async (token) => {
    if (get().status !== 'idle') return
    set({ status: 'loading', error: null })
    try {
      const index = await fetchSoundIndex(token)
      const realms = buildExploreTree(index.files)
      set({
        status: 'ready',
        realms,
        soundCount: countSounds(realms),
        truncated: index.truncated,
      })
    } catch (error) {
      // fetchSoundIndex already falls back to a stale copy, so reaching here
      // means there was never one: no network on a first visit.
      set({
        status: 'failed',
        error: error instanceof Error ? error.message : 'the sound list could not be loaded',
      })
    }
  },

  stop: () => {
    try {
      currentSource?.stop()
    } catch {
      /* already ended */
    }
    currentSource = null
    set({ playingPath: null, pendingPath: null })
  },

  play: async (token, sound) => {
    if (get().playingPath === sound.path) {
      get().stop()
      return
    }
    get().stop()
    set({ playError: null })

    let buffer = buffers.get(sound.path)
    if (!buffer) {
      set({ pendingPath: sound.path })
      try {
        const bytes = await fetchBlobBytes(token, UPSTREAM.owner, UPSTREAM.repo, sound.sha)
        const context = (sharedContext ??= new AudioContext())
        buffer = await context.decodeAudioData(bytes.slice().buffer as ArrayBuffer)
        remember(sound.path, buffer)
      } catch (error) {
        if (get().pendingPath !== sound.path) return
        set({
          pendingPath: null,
          playError: {
            path: sound.path,
            message: error instanceof Error ? error.message : 'the sound could not be played',
          },
        })
        return
      }
      // Something else was clicked while the bytes were in the air. The buffer
      // is cached either way, so the click that beat this one keeps its sound.
      if (get().pendingPath !== sound.path) return
    }

    const context = (sharedContext ??= new AudioContext())
    void context.resume()
    const source = context.createBufferSource()
    source.buffer = buffer
    source.connect(context.destination)
    source.onended = () => {
      if (currentSource === source) get().stop()
    }
    source.start()
    currentSource = source
    set({ playingPath: sound.path, pendingPath: null })
  },
}))
