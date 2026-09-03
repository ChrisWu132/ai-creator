import { mkdir, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { CDPSession, Page, BrowserContext } from 'playwright'
import { runFfmpeg } from '../lib/ffmpeg.js'
import { log } from '../lib/log.js'

interface Frame { file: string; ts: number }

/**
 * Captures the page with CDP's screencast rather than Playwright's built-in
 * video, for two reasons: frames come out at the device pixel ratio (so a
 * 432x768 @2.5 viewport yields true 1080x1920), and each frame carries a
 * timestamp, which lets us rebuild exact timing instead of trusting a
 * variable-framerate webm.
 *
 * Chrome only emits a frame when the page repaints, so a two-second hold on a
 * still page costs one frame. The concat list restores the real duration.
 */
export class Screencast {
  private cdp: CDPSession | null = null
  private frames: Frame[] = []
  private writes: Promise<unknown>[] = []
  private index = 0
  private startedAt = 0
  private stoppedAt = 0

  constructor(
    private readonly page: Page,
    private readonly context: BrowserContext,
    private readonly frameDir: string,
    private readonly size: { width: number; height: number },
  ) {}

  async start(): Promise<void> {
    await mkdir(this.frameDir, { recursive: true })
    this.cdp = await this.context.newCDPSession(this.page)

    this.cdp.on('Page.screencastFrame', (event) => {
      const { data, metadata, sessionId } = event as {
        data: string
        metadata: { timestamp?: number }
        sessionId: number
      }
      // Ack first: Chrome will not send the next frame until this returns.
      this.cdp?.send('Page.screencastFrameAck', { sessionId }).catch(() => {})

      const ts = metadata.timestamp ?? Date.now() / 1000
      const file = `f${String(this.index++).padStart(6, '0')}.jpg`
      this.frames.push({ file, ts })
      this.writes.push(writeFile(join(this.frameDir, file), Buffer.from(data, 'base64')))
    })

    await this.cdp.send('Page.startScreencast', {
      format: 'jpeg',
      quality: 92,
      maxWidth: this.size.width,
      maxHeight: this.size.height,
      everyNthFrame: 1,
    })
    this.startedAt = Date.now() / 1000
  }

  async stop(): Promise<void> {
    if (!this.cdp) return
    await this.cdp.send('Page.stopScreencast').catch(() => {})
    this.stoppedAt = Date.now() / 1000
    await Promise.all(this.writes)
    await this.cdp.detach().catch(() => {})
    this.cdp = null
  }

  get frameCount(): number { return this.frames.length }

  get durationMs(): number {
    if (!this.frames.length) return 0
    return Math.round((this.stoppedAt - this.frames[0]!.ts) * 1000)
  }

  /**
   * Builds a concat list where each frame is held for the gap until the next
   * one, then encodes to a constant-framerate H.264 mp4.
   */
  async encode(outPath: string, fps: number): Promise<void> {
    if (this.frames.length < 2) {
      throw new Error(
        `only ${this.frames.length} frame(s) captured — the page probably never painted. ` +
        'Check the URL loads and that the first action is not an instant wait.',
      )
    }

    const lines = ['ffconcat version 1.0']
    for (let i = 0; i < this.frames.length; i++) {
      const frame = this.frames[i]!
      const next = i + 1 < this.frames.length ? this.frames[i + 1]!.ts : this.stoppedAt
      const duration = Math.max(1 / fps / 2, next - frame.ts)
      lines.push(`file '${frame.file}'`, `duration ${duration.toFixed(4)}`)
    }
    // The concat demuxer drops the final entry's duration unless the last file
    // is repeated, which would otherwise clip the closing hold.
    lines.push(`file '${this.frames.at(-1)!.file}'`)

    const listPath = join(this.frameDir, 'frames.ffconcat')
    await writeFile(listPath, lines.join('\n'))

    const { width, height } = this.size
    await runFfmpeg([
      '-y',
      '-f', 'concat', '-safe', '0', '-i', listPath,
      '-vf', [
        `fps=${fps}`,
        `scale=${width}:${height}:force_original_aspect_ratio=decrease:flags=lanczos`,
        `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black`,
        'format=yuv420p',
      ].join(','),
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
      '-movflags', '+faststart',
      outPath,
    ])
    log.step(`encoded ${this.frames.length} frames → ${fps}fps h264`)
  }

  async cleanup(): Promise<void> {
    await rm(this.frameDir, { recursive: true, force: true })
  }
}
