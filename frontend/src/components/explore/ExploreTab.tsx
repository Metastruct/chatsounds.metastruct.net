import { useCallback, useDeferredValue, useEffect, useMemo, useState } from 'react'
import { countSounds, filterExploreTree } from '../../lib/exploreTree'
import { useExplore } from '../../store/useExplore'
import { useGithub } from '../../store/useGithub'
import { useTabs } from '../../store/useTabs'
import { ExploreTree } from './ExploreTree'

/**
 * What is already in the repo, so nobody has to guess.
 *
 * The other tabs make sounds; this one answers the question that comes before
 * making one. Does this trigger exist, what is in this realm, what does it
 * already sound like. Signing in is not required -- the repo is public and the
 * whole tab reads -- it only raises how many sounds an hour can be played.
 */
export function ExploreTab() {
  const tab = useTabs((state) => state.tab)
  const token = useGithub((state) => state.token)
  const init = useGithub((state) => state.init)

  // Field by field rather than the whole store: playback changes state on every
  // click, and the tab has no reason to redraw its heading when a sound starts.
  const status = useExplore((state) => state.status)
  const realms = useExplore((state) => state.realms)
  const soundCount = useExplore((state) => state.soundCount)
  const truncated = useExplore((state) => state.truncated)
  const error = useExplore((state) => state.error)
  const playError = useExplore((state) => state.playError)
  const load = useExplore((state) => state.load)
  const stop = useExplore((state) => state.stop)

  useEffect(() => {
    void init()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Every tab is mounted from the start, so this waits for someone to actually
  // open Explore rather than spending a 2 MB fetch on a page nobody looked at.
  useEffect(() => {
    if (tab === 'explore') void load(token)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, token])

  // Leaving with a sound playing should leave it behind.
  useEffect(() => {
    if (tab !== 'explore') stop()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab])

  const [draft, setDraft] = useState('')
  // React's own debounce: the input takes the keystroke immediately and the
  // refilter of 42,000 rows catches up behind it.
  const query = useDeferredValue(draft)
  const searching = query.trim().length > 0

  const matched = useMemo(
    () => (query.trim() ? filterExploreTree(realms, query) : null),
    [realms, query],
  )
  const shown = matched ?? realms

  // Browsing and searching want opposite defaults, so each keeps its own set of
  // exceptions. Closed is right for browsing: 915 realm names is a list you can
  // read, where the sounds under them are 42,000 rows nobody asked for. Open is
  // right for searching, because a match hidden inside a folded realm looks
  // exactly like no match at all. Searching therefore never disturbs what you
  // had open, and clearing the search puts it back.
  const [openedWhileBrowsing, setOpenedWhileBrowsing] = useState<ReadonlySet<string>>(
    () => new Set(),
  )
  const [closedWhileSearching, setClosedWhileSearching] = useState<ReadonlySet<string>>(
    () => new Set(),
  )
  useEffect(() => setClosedWhileSearching(new Set()), [query])

  const expanded = useMemo(() => {
    if (!searching) return openedWhileBrowsing
    const open = new Set<string>()
    for (const realm of shown) if (!closedWhileSearching.has(realm.name)) open.add(realm.name)
    return open
  }, [searching, openedWhileBrowsing, closedWhileSearching, shown])

  // Each set records the exception, so the same toggle serves both.
  const setExceptions = searching ? setClosedWhileSearching : setOpenedWhileBrowsing
  const toggleRealm = useCallback(
    (name: string) =>
      setExceptions((previous) => {
        const next = new Set(previous)
        if (!next.delete(name)) next.add(name)
        return next
      }),
    [setExceptions],
  )

  const allExpanded = shown.length > 0 && shown.every((realm) => expanded.has(realm.name))
  const setAllExpanded = (open: boolean) => {
    const names = shown.map((realm) => realm.name)
    if (searching) setClosedWhileSearching(open ? new Set() : new Set(names))
    else setOpenedWhileBrowsing(open ? new Set(names) : new Set())
  }

  return (
    <div className="container is-wide section explore-tab">
      <h1 className="title is-4">Explore</h1>

      {status === 'loading' && (
        <p className="muted is-loading-pulse explore-status">loading the sound list…</p>
      )}

      {status === 'failed' && (
        <p className="warning-line explore-status">The sound list could not be loaded: {error}</p>
      )}

      {status === 'ready' && (
        <>
          <div className="row explore-toolbar">
            <input
              className="input is-small explore-search"
              type="search"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              placeholder="filter by trigger or realm"
              spellCheck={false}
              autoComplete="off"
            />
            <button
              type="button"
              className="button is-small"
              onClick={() => setAllExpanded(!allExpanded)}
            >
              {allExpanded ? 'collapse all' : 'expand all'}
            </button>
          </div>

          <p className="muted explore-status">
            {matched
              ? `${countSounds(matched).toLocaleString()} sounds in ${matched.length.toLocaleString()} realms match`
              : `${soundCount.toLocaleString()} sounds in ${realms.length.toLocaleString()} realms`}
            {truncated && ' (the repo was too large to list in full, some sounds are missing)'}
          </p>

          {playError && (
            <p className="warning-line explore-status">
              {playError.path}: {playError.message}
              {!token && ' (signing in raises the limit from 60 sounds an hour to 5000)'}
            </p>
          )}

          <ExploreTree
            realms={realms}
            query={query}
            token={token}
            expanded={expanded}
            onToggleRealm={toggleRealm}
          />
        </>
      )}
    </div>
  )
}
