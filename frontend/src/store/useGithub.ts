/**
 * Who is signed in, and the device flow while they are signing in.
 *
 * The token lives in localStorage so a reload does not mean typing another
 * code. This page serves no third-party scripts, which is what makes that an
 * acceptable place for it, and signing out removes it.
 */

import { create } from 'zustand'
import {
  type DeviceCode,
  type GithubUser,
  fetchClientId,
  fetchUser,
  startDeviceFlow,
  waitForToken,
} from '../lib/github'

const TOKEN_KEY = 'github-token'

type AuthStatus =
  /** Nothing known yet; checking the stored token if there is one. */
  | 'checking'
  /** This copy has no client id configured; sign-in cannot be offered. */
  | 'unconfigured'
  | 'signed-out'
  /** Waiting for the user to type the code on github.com. */
  | 'authorizing'
  | 'signed-in'

interface GithubState {
  status: AuthStatus
  user: GithubUser | null
  token: string | null
  device: DeviceCode | null
  error: string | null

  /** Validate the stored token, if any, and settle the initial status. */
  init: () => Promise<void>
  signIn: () => Promise<void>
  cancelSignIn: () => void
  signOut: () => void
}

let cancel: AbortController | null = null

export const useGithub = create<GithubState>((set, get) => ({
  status: 'checking',
  user: null,
  token: null,
  device: null,
  error: null,

  async init() {
    if (get().status !== 'checking') return
    const clientId = await fetchClientId()
    if (!clientId) {
      set({ status: 'unconfigured' })
      return
    }

    const stored = localStorage.getItem(TOKEN_KEY)
    if (!stored) {
      set({ status: 'signed-out' })
      return
    }
    try {
      const user = await fetchUser(stored)
      set({ status: 'signed-in', token: stored, user })
    } catch {
      // Revoked or expired; the stored value is only a stale nuisance now.
      localStorage.removeItem(TOKEN_KEY)
      set({ status: 'signed-out' })
    }
  },

  async signIn() {
    const clientId = await fetchClientId()
    if (!clientId) return

    cancel?.abort()
    cancel = new AbortController()
    set({ error: null })

    try {
      const device = await startDeviceFlow(clientId)
      set({ status: 'authorizing', device })

      const token = await waitForToken(clientId, device, cancel.signal)
      const user = await fetchUser(token)
      localStorage.setItem(TOKEN_KEY, token)
      set({ status: 'signed-in', token, user, device: null })
    } catch (error) {
      if (cancel.signal.aborted) {
        set({ status: 'signed-out', device: null })
        return
      }
      set({
        status: 'signed-out',
        device: null,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  },

  cancelSignIn() {
    cancel?.abort()
    set({ status: 'signed-out', device: null })
  },

  signOut() {
    localStorage.removeItem(TOKEN_KEY)
    set({ status: 'signed-out', user: null, token: null, error: null })
  },
}))
