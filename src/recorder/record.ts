import { mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { openSession, preparePage } from './browser.js'
import { Screencast } from './screencast.js'
import { runAction } from './actions.js'
import type { VisualSpec } from './schema.js'
import { log } from '../lib/log.js'

export interface RecordResult {
  specId: string
  videoPath: string
  frames: number
  durationMs: number
}

export interface RecordOptions {
  outPath: string
  /** Keep the jpeg frames next to the video for debugging a bad shot. */
  keepFrames?: boolean
}

export async function record(spec: VisualSpec, options: RecordOptions): Promise<RecordResult> {
  log.reset()
  log.info(`recording ${spec.id} → ${spec.url}`)

  const outDir = dirname(options.outPath)
  await mkdir(outDir, { recursive: true })
  const frameDir = join(outDir, `.frames-${spec.id}`)

  const size = {
    width: Math.round(spec.viewport.width * spec.scale),
    height: Math.round(spec.viewport.height * spec.scale),
  }
  log.step(`${spec.viewport.width}x${spec.viewport.height} @${spec.scale}x → ${size.width}x${size.height}`)

  const { browser, context, page } = await openSession(spec)
  const screencast = new Screencast(page, context, frameDir, size)

  try {
    await preparePage(page, spec)
    log.step('page ready, rolling')

    await screencast.start()

    const budget = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`spec exceeded maxDurationMs (${spec.maxDurationMs}ms)`)),
        spec.maxDurationMs),
    )
    const script = (async () => {
      for (const action of spec.actions) await runAction(page, action)
    })()

    await Promise.race([script, budget])

    // One extra beat so the closing frame is not cut mid-tween.
    await page.waitForTimeout(250)
    await screencast.stop()

    log.step(`captured ${screencast.frameCount} frames over ${screencast.durationMs}ms`)
    await screencast.encode(options.outPath, spec.fps)

    const result: RecordResult = {
      specId: spec.id,
      videoPath: options.outPath,
      frames: screencast.frameCount,
      durationMs: screencast.durationMs,
    }
    log.done(`${options.outPath}  (${(result.durationMs / 1000).toFixed(1)}s)`)
    return result
  } finally {
    await screencast.stop().catch(() => {})
    if (!options.keepFrames) await screencast.cleanup().catch(() => {})
    await context.close().catch(() => {})
    await browser.close().catch(() => {})
  }
}
