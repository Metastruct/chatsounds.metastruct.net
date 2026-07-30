export function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00.000'
  const minutes = Math.floor(seconds / 60)
  const rest = seconds - minutes * 60
  return `${minutes}:${rest.toFixed(3).padStart(6, '0')}`
}

export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds)) return '--'
  if (seconds < 60) return `${seconds.toFixed(2)}s`
  const minutes = Math.floor(seconds / 60)
  return `${minutes}m ${Math.round(seconds - minutes * 60)}s`
}

export const FLAG_LABELS: Record<string, { label: string; tone: string; hint: string }> = {
  no_speech: {
    label: 'no words',
    tone: 'is-warning',
    hint: 'Nothing was heard here, so this one still needs a name.',
  },
  too_long: {
    label: 'long',
    tone: 'is-info',
    hint: 'Long, with no pause to cut it at. It may hold more than one line.',
  },
  very_short: {
    label: 'short',
    tone: 'is-warning',
    hint: 'Very short. This may be a click rather than a word.',
  },
}
