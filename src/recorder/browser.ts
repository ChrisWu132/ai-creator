import { chromium, type Browser, type BrowserContext, type Page } from 'playwright'
import { PAGE_RUNTIME } from './page-runtime.js'
import type { VisualSpec } from './schema.js'
import { log } from '../lib/log.js'

/** Hosts that only ever add noise to a shot. Matched as substrings. */
const NOISE_HOSTS = [
  'doubleclick.net', 'googlesyndication.com', 'googletagmanager.com',
  'google-analytics.com', 'googleadservices.com', 'adservice.google',
  'facebook.net', 'connect.facebook', 'scorecardresearch.com',
  'quantserve.com', 'taboola.com', 'outbrain.com', 'criteo',
  'amazon-adsystem.com', 'adnxs.com', 'hotjar', 'segment.io',
  'sentry.io', 'newrelic.com', 'branch.io', 'onetrust.com',
]

/** Consent and newsletter overlays, in rough order of how often they appear. */
const BANNER_BUTTONS = [
  '#onetrust-accept-btn-handler',
  '#sp-cc-accept',
  'button[aria-label*="Accept" i]',
  'button[title*="Accept" i]',
  '[data-testid*="accept" i]',
  '.fc-cta-consent',
  'button:has-text("Accept all")',
  'button:has-text("Accept All")',
  'button:has-text("I agree")',
  'button:has-text("Got it")',
  'button:has-text("Allow all")',
  'button[aria-label*="close" i]',
]

const MOBILE_UA =
  'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/125.0.0.0 Mobile Safari/537.36'

export interface Session {
  browser: Browser
  context: BrowserContext
  page: Page
}

/**
 * Chromium does not pick up HTTPS_PROXY on its own, so hand it over
 * explicitly when the environment defines one (CI sandboxes, egress proxies).
 */
function proxyFromEnv(): { server: string; bypass?: string } | undefined {
  const server = process.env.HTTPS_PROXY ?? process.env.https_proxy
  if (!server) return undefined
  const noProxy = process.env.NO_PROXY ?? process.env.no_proxy
  return { server, ...(noProxy ? { bypass: noProxy } : {}) }
}

export async function openSession(spec: VisualSpec): Promise<Session> {
  const browser = await chromium.launch({
    // Sandboxes and CI images often ship a Chromium that does not match the
    // installed Playwright's expected build. CHROMIUM_PATH points at theirs.
    executablePath: process.env.CHROMIUM_PATH || undefined,
    proxy: proxyFromEnv(),
    args: [
      '--disable-features=IsolateOrigins,site-per-process',
      '--hide-scrollbars',
      '--mute-audio',
      '--disable-blink-features=AutomationControlled',
    ],
  })

  const context = await browser.newContext({
    viewport: spec.viewport,
    deviceScaleFactor: spec.scale,
    isMobile: true,
    hasTouch: true,
    userAgent: MOBILE_UA,
    locale: 'en-US',
    timezoneId: 'America/Los_Angeles',
    reducedMotion: 'reduce',
  })

  if (spec.prepare.blockAds) {
    await context.route('**/*', (route) => {
      const url = route.request().url()
      if (NOISE_HOSTS.some((h) => url.includes(h))) return route.abort()
      return route.continue()
    })
  }

  const page = await context.newPage()
  return { browser, context, page }
}

/**
 * Everything between "page loaded" and "start rolling": get the page into a
 * clean, still state so the first recorded frame is already presentable.
 */
export async function preparePage(page: Page, spec: VisualSpec): Promise<void> {
  const { prepare } = spec

  await page.goto(spec.url, { waitUntil: prepare.waitUntil, timeout: 45_000 })

  if (prepare.dismissBanners) {
    for (const selector of BANNER_BUTTONS) {
      try {
        const button = page.locator(selector).first()
        if (await button.isVisible({ timeout: 250 })) {
          await button.click({ timeout: 1000, noWaitAfter: true })
          log.step(`dismissed banner via ${selector}`)
          await page.waitForTimeout(300)
          break
        }
      } catch {
        // Selector missing or not clickable — that is the common case.
      }
    }
  }

  await page.evaluate(PAGE_RUNTIME)

  if (prepare.freezeAnimations) await page.evaluate('window.__aic.freezeAnimations()')

  const pinned = (await page.evaluate('window.__aic.unstick()')) as number
  if (pinned) log.step(`unstuck ${pinned} fixed/sticky element(s)`)

  if (prepare.hideSelectors.length) {
    const hidden = await page.evaluate(
      (sels) => (window as never as AicWindow).__aic.hide(sels),
      prepare.hideSelectors,
    )
    log.step(`hid ${hidden} element(s) from ${prepare.hideSelectors.length} selector(s)`)
  }

  // Force lazy images above and just below the fold to decode before rolling.
  await page.evaluate(`
    document.querySelectorAll('img[loading="lazy"]').forEach(function (img) { img.loading = 'eager' })
    window.scrollTo(0, 1); window.scrollTo(0, 0)
  `)
  await page.waitForTimeout(prepare.settleMs)
}

/** Shape of the injected runtime, for the few evaluates that pass arguments. */
export interface AicWindow {
  __aic: {
    hide(selectors: string[]): number
    zoomed(): boolean
  }
}
