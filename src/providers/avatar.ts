import { writeFile } from 'node:fs/promises'
import type { Persona } from '../types.js'
import { renderHtmlToPng } from '../lib/render-html.js'
import { durationMs } from '../lib/media.js'
import { log } from '../lib/log.js'

export interface AvatarClip {
  /** A talking-head clip, when the provider makes one. */
  videoPath?: string
  /** A still card, when it does not. Either way the assembler composites it. */
  imagePath?: string
  durationMs?: number
}

export interface AvatarProvider {
  readonly name: string
  render(persona: Persona, audioPath: string, outPathBase: string): Promise<AvatarClip>
}

const CARD_CSS = `
  body { margin: 0; background: transparent; font-family: -apple-system, BlinkMacSystemFont,
         'Segoe UI', Roboto, 'DejaVu Sans', sans-serif; }
  .card { width: 300px; border-radius: 26px; padding: 20px; color: #fff;
          background: linear-gradient(160deg, var(--a), #12141a 78%);
          box-shadow: 0 18px 44px rgba(0,0,0,.45); }
  .face { width: 108px; height: 108px; border-radius: 50%; margin: 0 auto 14px;
          background: rgba(255,255,255,.14); display: grid; place-items: center;
          font-size: 46px; font-weight: 700; letter-spacing: -1px;
          border: 3px solid rgba(255,255,255,.32); }
  .name { text-align: center; font-size: 25px; font-weight: 700; letter-spacing: -.4px; }
  .handle { text-align: center; font-size: 17px; opacity: .72; margin-top: 3px; }
  .tag { text-align: center; font-size: 13px; opacity: .62; margin-top: 12px;
         text-transform: uppercase; letter-spacing: 1.4px; }
`

/**
 * A persona card standing in for the talking head. It keeps the composite's
 * geometry honest — same corner, same footprint as a real avatar clip — so
 * swapping HeyGen in later changes one provider and nothing else.
 */
export class StubAvatarProvider implements AvatarProvider {
  readonly name = 'stub'

  async render(persona: Persona, _audioPath: string, outPathBase: string): Promise<AvatarClip> {
    const imagePath = `${outPathBase}.png`
    await renderHtmlToPng({
      html:
        `<style>${CARD_CSS}</style>` +
        `<div class="card" style="--a:${persona.visual.accent}">` +
        `<div class="face">${persona.name.slice(0, 1)}</div>` +
        `<div class="name">${persona.name}</div>` +
        `<div class="handle">${persona.handle}</div>` +
        `<div class="tag">AI-generated</div>` +
        `</div>`,
      selector: '.card',
      outPath: imagePath,
      width: 360,
    })
    return { imagePath }
  }
}

/**
 * NOT VERIFIED AGAINST A LIVE API — written from documentation that this
 * environment cannot reach (docs.heygen.com is blocked here). Check the
 * request and polling shapes against HeyGen's current API reference before
 * the first real run; the error paths below deliberately echo raw responses
 * so a shape mismatch shows up immediately rather than as a silent null.
 */
export class HeyGenAvatarProvider implements AvatarProvider {
  readonly name = 'heygen'

  constructor(private readonly apiKey: string) {}

  async render(persona: Persona, audioPath: string, outPathBase: string): Promise<AvatarClip> {
    const avatarId = persona.providers.heygenAvatarId
    if (!avatarId) {
      throw new Error(`persona ${persona.id} has no providers.heygenAvatarId — add one to its bible`)
    }
    void audioPath // Audio is driven by HeyGen's own voice until an upload step exists.

    const created = await this.post('https://api.heygen.com/v2/video/generate', {
      video_inputs: [
        {
          character: { type: 'avatar', avatar_id: avatarId, avatar_style: 'normal' },
          voice: { type: 'text', input_text: '...', voice_id: persona.providers.elevenVoiceId },
        },
      ],
      dimension: { width: 720, height: 1280 },
    })

    const videoId = (created as { data?: { video_id?: string } }).data?.video_id
    if (!videoId) throw new Error(`heygen returned no video_id: ${JSON.stringify(created).slice(0, 400)}`)

    const url = await this.pollForDownload(videoId)
    const videoPath = `${outPathBase}.mp4`
    const download = await fetch(url)
    if (!download.ok) throw new Error(`heygen download ${download.status}`)
    await writeFile(videoPath, Buffer.from(await download.arrayBuffer()))

    return { videoPath, durationMs: await durationMs(videoPath) }
  }

  private async post(url: string, body: unknown): Promise<unknown> {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'X-Api-Key': this.apiKey, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!response.ok) {
      throw new Error(`heygen ${response.status}: ${(await response.text()).slice(0, 400)}`)
    }
    return response.json()
  }

  private async pollForDownload(videoId: string): Promise<string> {
    for (let attempt = 0; attempt < 60; attempt++) {
      await new Promise((r) => setTimeout(r, 5000))
      const response = await fetch(
        `https://api.heygen.com/v1/video_status.get?video_id=${encodeURIComponent(videoId)}`,
        { headers: { 'X-Api-Key': this.apiKey } },
      )
      const payload = (await response.json()) as {
        data?: { status?: string; video_url?: string; error?: unknown }
      }
      const status = payload.data?.status
      if (status === 'completed' && payload.data?.video_url) return payload.data.video_url
      if (status === 'failed') {
        throw new Error(`heygen render failed: ${JSON.stringify(payload.data?.error ?? payload).slice(0, 400)}`)
      }
      log.step(`heygen ${videoId}: ${status ?? 'unknown'}`)
    }
    throw new Error(`heygen render did not finish within 5 minutes (${videoId})`)
  }
}

export function avatarProvider(): AvatarProvider {
  const key = process.env.HEYGEN_API_KEY
  if (key) return new HeyGenAvatarProvider(key)
  log.warn('no HEYGEN_API_KEY — compositing a persona card instead of a talking head')
  return new StubAvatarProvider()
}
