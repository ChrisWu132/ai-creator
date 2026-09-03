import { openSession, preparePage } from '../recorder/browser.js'
import { visualSpec } from '../recorder/schema.js'
import { log } from '../lib/log.js'
import { PROBE_SCRIPT, type PageProbe } from './probe-script.js'

export type { PageProbe, Anchor } from './probe-script.js'

/**
 * Opens a page and reports what a camera could point at: a headline, a price,
 * a list, quotable blocks, plus a shallow text digest.
 *
 * This is the authoring half of the split. It runs once per topic and its
 * output is what a script generator reasons over, so the rendering half stays
 * a deterministic replay of concrete selectors rather than a live agent
 * poking at the page every time we need the same clip.
 */
export async function probePage(url: string): Promise<PageProbe> {
  const spec = visualSpec.parse({
    id: 'probe',
    url,
    prepare: { settleMs: 1200 },
    actions: [{ kind: 'wait', ms: 1 }],
  })

  const { browser, context, page } = await openSession(spec)
  try {
    await preparePage(page, spec)
    const probe = (await page.evaluate(PROBE_SCRIPT)) as PageProbe
    log.step(
      `probe: headline=${probe.headline ? 'yes' : 'no'} price=${probe.price ? 'yes' : 'no'} ` +
      `bullets=${probe.bullets?.count ?? 0} quotes=${probe.quotes.length} sections=${probe.sections.length}`,
    )
    return { ...probe, url }
  } finally {
    await context.close().catch(() => {})
    await browser.close().catch(() => {})
  }
}
