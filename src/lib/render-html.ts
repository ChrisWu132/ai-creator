import { chromium } from 'playwright'

/**
 * Screenshots one element of an inline HTML document to a transparent PNG.
 *
 * Captions and the placeholder avatar card are typography, and the browser is
 * already a dependency — laying them out in CSS beats fighting ffmpeg's
 * drawtext for line breaking, web fonts and rounded corners.
 */
export async function renderHtmlToPng(options: {
  html: string
  selector: string
  outPath: string
  width: number
  scale?: number
}): Promise<void> {
  const { html, selector, outPath, width, scale = 2 } = options

  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || undefined,
  })
  try {
    const context = await browser.newContext({
      viewport: { width, height: 600 },
      deviceScaleFactor: scale,
    })
    const page = await context.newPage()
    await page.setContent(html, { waitUntil: 'load' })
    await page.locator(selector).first().screenshot({ path: outPath, omitBackground: true })
    await context.close()
  } finally {
    await browser.close().catch(() => {})
  }
}
