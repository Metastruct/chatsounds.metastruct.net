import { useEffect, useRef } from 'react'

type Handler = (event: KeyboardEvent) => void

function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  const tag = target.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || target.isContentEditable
}

/**
 * Global shortcuts, suspended while a field has focus.
 *
 * `x` deleting the selected clip would be alarming if it fired while renaming
 * one, so anything typed into an input is left entirely alone.
 */
export function useHotkeys(map: Record<string, Handler>, enabled = true) {
  const mapRef = useRef(map)
  mapRef.current = map

  useEffect(() => {
    if (!enabled) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return
      if (isTyping(event.target)) return
      const handler = mapRef.current[event.key]
      if (!handler) return
      event.preventDefault()
      handler(event)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [enabled])
}
