import { writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { Persona } from '../types.js'
import { renderHtmlToPng } from '../lib/render-html.js'
import { durationMs } from '../lib/media.js'
import { falRun, falUpload, falDownload } from '../lib/fal.js'
import { log } from '../lib/log.js'

export interface AvatarClip {
  /** A talking-head clip, when the provider makes one. */
  videoPath?: string
  /** A still card, when it does not. Either way the assembler composites it. */
  imagePath?: string
  /** The clip carries an alpha channel, so it composites as a cut-out figure
   *  standing on the page rather than as a rectangle with its own background. */
  alpha?: boolean
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

/**
 * Two tiers of the same shape: a portrait plus our own audio in, a talking
 * clip out. `draft` is roughly fifteen times cheaper and is what you want
 * while iterating on hooks; `final` moves the head and the eyes, which is
 * visible even scaled down to the corner, and is what ships.
 */
const TIERS = {
  draft: {
    model: 'fal-ai/sadtalker',
    input: (image: string, audio: string) => ({
      source_image_url: image,
      driven_audio_url: audio,
      face_enhancer: 'gfpgan',
      preprocess: 'full',
      still_mode: false,
    }),
  },
  final: {
    model: 'fal-ai/kling-video/ai-avatar/v2/standard',
    input: (image: string, audio: string) => ({ image_url: image, audio_url: audio }),
  },
} as const

export type AvatarTier = keyof typeof TIERS

export class FalAvatarProvider implements AvatarProvider {
  readonly name: string

  constructor(private readonly tier: AvatarTier) {
    this.name = `fal-${tier}`
  }

  async render(persona: Persona, audioPath: string, outPathBase: string): Promise<AvatarClip> {
    const portrait = persona.providers.portrait
    if (!portrait) {
      throw new Error(
        `persona ${persona.id} has no providers.portrait — point it at the face that is this ` +
        'creator, e.g. "personas/portraits/nina.jpg"',
      )
    }

    // fal takes URLs, so both halves go to storage first. The portrait is
    // re-uploaded per run rather than cached: it is ~500KB and a stale URL
    // would fail much later, inside the model.
    const [imageUrl, audioUrl] = await Promise.all([
      falUpload(resolve(portrait)),
      falUpload(resolve(audioPath)),
    ])

    const { model, input } = TIERS[this.tier]
    log.step(`${model}: rendering ${persona.id} against ${audioPath}`)
    const result = await falRun<{ video: { url: string } }>(model, input(imageUrl, audioUrl))

    const matted = await matte(result.video.url)
    const videoPath = `${outPathBase}.mov`
    await falDownload(matted, videoPath)
    return { videoPath, alpha: true, durationMs: await durationMs(videoPath) }
  }
}

/**
 * Cuts the figure out of its background.
 *
 * The avatar model paints whatever room the portrait was shot in, and a
 * rectangle of someone else's room pasted onto a web page is the single
 * loudest tell that a video was assembled. Cut out, the same clip reads as a
 * person standing on the page.
 *
 * ProRes 4444 rather than the smaller VP9: fal's webm output comes back
 * yuv420p with the transparency flattened to white, and only the ProRes
 * container actually carries the alpha channel. It is a ~1GB intermediate for
 * a 30s clip, deleted with the work directory.
 */
async function matte(videoUrl: string): Promise<string> {
  log.step('cutting the figure out of its background')
  const { video } = await falRun<{ video: { url: string } }>(
    'bria/video/background-removal/v3',
    {
      video_url: videoUrl,
      background_color: 'Transparent',
      output_container_and_codec: 'mov_proresks',
      preserve_audio: false,
    },
  )
  return video.url
}

export function avatarProvider(): AvatarProvider {
  // A vendor key is an explicit choice and wins; FAL_KEY is often just present
  // in the environment for something else, so it is the default, not an
  // override.
  const heygen = process.env.HEYGEN_API_KEY
  if (heygen) return new HeyGenAvatarProvider(heygen)
  if (process.env.FAL_KEY) {
    const tier = process.env.AVATAR_TIER === 'final' ? 'final' : 'draft'
    if (tier === 'draft') log.warn('AVATAR_TIER is draft — cheap and stiff; set it to final to ship')
    return new FalAvatarProvider(tier)
  }
  log.warn('no FAL_KEY or HEYGEN_API_KEY — compositing a persona card instead of a talking head')
  return new StubAvatarProvider()
}
