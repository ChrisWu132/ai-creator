import type { Page } from 'playwright'
import type { Action } from './schema.js'
import { log } from '../lib/log.js'

/** How long the auto-unzoom takes when an action needs true viewport coords. */
const UNZOOM_MS = 250

/** Actions whose meaning depends on untransformed viewport geometry. */
const NEEDS_UNZOOM = new Set([
  'scrollTo', 'scrollBy', 'highlight', 'hover', 'click', 'type',
])

function describe(action: Action): string {
  switch (action.kind) {
    case 'wait': return `wait ${action.ms}ms`
    case 'waitFor': return `waitFor ${action.selector}`
    case 'hide': return `hide ${action.selectors.length} selector(s)`
    case 'scrollTo': return `scrollTo ${action.selector ?? `y=${action.y}`} (${action.durationMs}ms)`
    case 'scrollBy': return `scrollBy ${action.dy}px (${action.durationMs}ms)`
    case 'zoom': return action.fit !== undefined
      ? `zoom fit ${action.fit} ${action.selector}`
      : `zoom ${action.scale}x ${action.selector ?? 'center'}`
    case 'resetZoom': return 'resetZoom'
    case 'highlight': return `highlight ${action.style} ${action.selector}`
    case 'clearHighlight': return 'clearHighlight'
    case 'hover': return `hover ${action.selector}`
    case 'click': return `click ${action.selector}`
    case 'type': return `type "${action.text}"`
  }
}

async function call(page: Page, expression: string): Promise<void> {
  await page.evaluate(expression)
}

const json = (value: unknown) => JSON.stringify(value)

export async function runAction(page: Page, action: Action): Promise<void> {
  log.action(describe(action) + (action.comment ? `  — ${action.comment}` : ''))

  if (NEEDS_UNZOOM.has(action.kind)) {
    const zoomed = (await page.evaluate('window.__aic.zoomed()')) as boolean
    if (zoomed) await call(page, `window.__aic.unzoom(${UNZOOM_MS})`)
  }

  switch (action.kind) {
    case 'wait':
      await page.waitForTimeout(action.ms)
      return

    case 'waitFor':
      await page.locator(action.selector).first()
        .waitFor({ state: 'visible', timeout: action.timeoutMs })
      return

    case 'hide':
      await call(page, `window.__aic.hide(${json(action.selectors)})`)
      return

    case 'scrollTo':
      if (action.selector !== undefined) {
        await call(page, `window.__aic.scrollToSelector(${json(action.selector)},` +
          `${json(action.align)},${action.durationMs},${json(action.easing)})`)
      } else {
        await call(page, `window.__aic.scrollToY(${action.y},${action.durationMs},${json(action.easing)})`)
      }
      return

    case 'scrollBy':
      await call(page, `window.__aic.scrollBy(${action.dy},${action.durationMs},${json(action.easing)})`)
      return

    case 'zoom': {
      const scale = action.scale ?? (await page.evaluate(
        `window.__aic.scaleToFit(${json(action.selector)},${action.fit})`,
      )) as number
      if (action.fit !== undefined && scale <= 1.01) {
        log.warn(`fit ${action.fit} on ${action.selector} resolves to 1.0x — ` +
          'the target already fills the frame, so this zoom is a no-op')
      } else {
        log.step(`resolved scale ${scale.toFixed(2)}x`)
      }
      await call(page, `window.__aic.zoomTo(${json(action.selector ?? null)},` +
        `${scale},${action.durationMs})`)
      if (action.holdMs) await page.waitForTimeout(action.holdMs)
      return
    }

    case 'resetZoom':
      await call(page, `window.__aic.unzoom(${action.durationMs})`)
      return

    case 'highlight':
      await call(page, `window.__aic.highlight(${json(action.selector)},${json(action.style)})`)
      if (action.holdMs) await page.waitForTimeout(action.holdMs)
      if (!action.keep) await call(page, 'window.__aic.clearHighlight()')
      return

    case 'clearHighlight':
      await call(page, 'window.__aic.clearHighlight()')
      return

    case 'hover':
      await page.locator(action.selector).first().hover({ timeout: 5000 })
      return

    case 'click':
      await page.locator(action.selector).first().click({ timeout: 5000 })
      if (action.waitAfterMs) await page.waitForTimeout(action.waitAfterMs)
      return

    case 'type':
      await page.locator(action.selector).first()
        .pressSequentially(action.text, { delay: action.delayMs, timeout: 10_000 })
      if (action.pressEnter) await page.keyboard.press('Enter')
      return
  }
}
