import { ICONS, type IconName } from '../lib/icons'

/** MDI glyph at metastruct's navbar size (their `mdi-24px`). */
export function Icon({ name, size = 24 }: { name: IconName; size?: number }) {
  return (
    <span className="icon" aria-hidden="true">
      <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
        <path d={ICONS[name]} />
      </svg>
    </span>
  )
}
