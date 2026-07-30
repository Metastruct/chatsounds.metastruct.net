/**
 * Which tab is showing.
 *
 * In a store rather than `App`'s own state because the tabs are not only chosen
 * from the navbar: finishing in Extract offers to carry the clips over to
 * Upload, and that hand-off has to be able to move the user with them.
 */

import { create } from 'zustand'

export type Tab = 'extract' | 'upload' | 'review'

interface TabState {
  tab: Tab
  setTab: (tab: Tab) => void
}

export const useTabs = create<TabState>((set) => ({
  tab: 'extract',
  setTab: (tab) => set({ tab }),
}))
