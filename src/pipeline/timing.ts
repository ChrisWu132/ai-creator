import type { Action } from '../recorder/schema.js'

/** Fields that consume screen time. `waitFor` blocks but is not a beat. */
function timeOf(action: Action): number {
  switch (action.kind) {
    case 'wait': return action.ms
    case 'scrollTo':
    case 'scrollBy':
    case 'resetZoom': return action.durationMs
    case 'zoom': return action.durationMs + action.holdMs
    case 'highlight': return action.holdMs
    case 'click': return action.waitAfterMs
    default: return 0
  }
}

export function nominalDurationMs(actions: Action[]): number {
  return actions.reduce((sum, action) => sum + timeOf(action), 0)
}

/**
 * Stretches or compresses a camera plan to fill a voiceover.
 *
 * Without this, a long line over a short plan freezes on the last frame for
 * seconds — the single most obvious tell that a video was assembled rather
 * than shot. The clamp keeps a stretch from turning into slow motion; the
 * remainder is still absorbed by fitClip.
 */
export function stretchActions(actions: Action[], targetMs: number): Action[] {
  const nominal = nominalDurationMs(actions)
  if (nominal <= 0) return actions

  const factor = Math.min(2.5, Math.max(0.7, targetMs / nominal))
  const scale = (ms: number) => Math.round(ms * factor)

  return actions.map((action) => {
    switch (action.kind) {
      case 'wait': return { ...action, ms: scale(action.ms) }
      case 'scrollTo':
      case 'scrollBy':
      case 'resetZoom': return { ...action, durationMs: scale(action.durationMs) }
      case 'zoom': return { ...action, durationMs: scale(action.durationMs), holdMs: scale(action.holdMs) }
      case 'highlight': return { ...action, holdMs: scale(action.holdMs) }
      case 'click': return { ...action, waitAfterMs: scale(action.waitAfterMs) }
      default: return action
    }
  })
}
