import { useEffect, useMemo, useRef, useState } from 'react'
import { sanitizeRealm } from '../../pipeline/naming'

/**
 * The realm picker: an input with the repo's realms behind it.
 *
 * A plain `<datalist>` would nearly do, but it cannot distinguish "picked an
 * existing realm" from "typed a new one", and that distinction matters here: a
 * handful of grandfathered realms contain spaces, so picks are taken verbatim
 * while typed names get folded to the convention. The list itself is ~900
 * names, filtered as you type and capped, prefix matches first.
 */

interface Props {
  value: string
  realms: string[]
  onChange: (realm: string) => void
}

const MAX_SHOWN = 12

export function RealmInput({ value, realms, onChange }: Props) {
  const [draft, setDraft] = useState(value)
  const [open, setOpen] = useState(false)
  const [highlighted, setHighlighted] = useState(0)
  const boxRef = useRef<HTMLDivElement | null>(null)

  // Adopt a change made elsewhere (another area picked into this one's state).
  useEffect(() => {
    setDraft(value)
  }, [value])

  const needle = draft.trim().toLowerCase()
  const matches = useMemo(() => {
    if (!needle) return realms.slice(0, MAX_SHOWN)
    const starts: string[] = []
    const contains: string[] = []
    for (const realm of realms) {
      if (realm.startsWith(needle)) starts.push(realm)
      else if (realm.includes(needle)) contains.push(realm)
      if (starts.length >= MAX_SHOWN) break
    }
    return [...starts, ...contains].slice(0, MAX_SHOWN)
  }, [needle, realms])

  const folded = sanitizeRealm(draft)
  const exact = realms.includes(needle)
  // Offer creation only when the typed name folds to something usable and is
  // not already a realm under either spelling.
  const creatable = !exact && folded && !realms.includes(folded) ? folded : null

  const rows: { label: string; realm: string; isNew: boolean }[] = [
    ...matches.map((realm) => ({ label: realm, realm, isNew: false })),
    ...(creatable ? [{ label: `new realm "${creatable}"`, realm: creatable, isNew: true }] : []),
  ]

  const pick = (realm: string) => {
    onChange(realm)
    setDraft(realm)
    setOpen(false)
  }

  const commit = () => {
    // Leaving the field keeps whatever is defensible: the exact realm if it is
    // one, the folded name otherwise, the previous value when nothing survives.
    if (exact) pick(needle)
    else if (folded) pick(folded)
    else setDraft(value)
    setOpen(false)
  }

  return (
    <div
      ref={boxRef}
      className="realm-input"
      onBlur={(event) => {
        // Blur fires when focus moves to a row button; only commit on the way
        // out of the whole component.
        if (!boxRef.current?.contains(event.relatedTarget as Node)) commit()
      }}
    >
      <input
        className="input is-small"
        placeholder="realm, like portal_turret"
        value={draft}
        spellCheck={false}
        onChange={(event) => {
          setDraft(event.target.value)
          setOpen(true)
          setHighlighted(0)
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown') {
            event.preventDefault()
            setOpen(true)
            setHighlighted((i) => Math.min(i + 1, rows.length - 1))
          } else if (event.key === 'ArrowUp') {
            event.preventDefault()
            setHighlighted((i) => Math.max(i - 1, 0))
          } else if (event.key === 'Enter') {
            event.preventDefault()
            if (open && rows[highlighted]) pick(rows[highlighted].realm)
            else commit()
          } else if (event.key === 'Escape') {
            setDraft(value)
            setOpen(false)
          }
        }}
      />
      {open && rows.length > 0 && (
        <div className="realm-suggestions" role="listbox">
          {rows.map((row, index) => (
            <button
              key={row.realm + (row.isNew ? '+' : '')}
              type="button"
              role="option"
              aria-selected={index === highlighted}
              className={`realm-suggestion${index === highlighted ? ' is-highlighted' : ''}${
                row.isNew ? ' is-new' : ''
              }`}
              // Mouse down, not click: click fires after blur has closed the list.
              onMouseDown={(event) => {
                event.preventDefault()
                pick(row.realm)
              }}
              onMouseEnter={() => setHighlighted(index)}
            >
              {row.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
