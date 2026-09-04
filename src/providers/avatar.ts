import { writeFile, rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { Persona } from '../types.js'
import { renderHtmlToPng } from '../lib/render-html.js'
import { durationMs, flattenOnto, chromaKey } from '../lib/media.js'
import { falRun, falUpload, falDownload } from '../lib/fal.js'
import { cached } from '../lib/cache.js'
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
 * BROKEN, not merely unverified — and it takes precedence over the fal path,
 * so setting HEYGEN_API_KEY today gets you a worse video, not an error. Three
 * concrete defects, all in `render`:
 *
 *   - `input_text` is the literal string '...', so the avatar says nothing.
 *   - `audioPath` — the voiceover the pipeline just paid for — is discarded,
 *     and HeyGen is asked to speak with its own voice instead.
 *   - `voice_id` is handed an ElevenLabs id, which is not a HeyGen voice id.
 *
 * Fixing it means uploading our own audio as the character's audio source.
 * Until someone does that, this is a placeholder shaped like a provider; the
 * request and polling shapes were written from documentation this environment
 * cannot reach (docs.heygen.com is blocked here) and are also unverified.
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
 * clip out. `draft` is about five cents a video against `final`'s dollar-forty
 * for twenty-five seconds, and is what you want while iterating on hooks;
 * `final` moves the head and the eyes, which is visible even scaled down to
 * the corner, and is what ships.
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

    const plate = await greenScreenPlate(resolve(portrait), `${outPathBase}-plate.png`)
    const { model, input } = TIERS[this.tier]

    // Cache the render, not the key: the render is what costs money, and the
    // keying thresholds are exactly the kind of thing you want to re-tune
    // without paying for the clip again. It is also two orders of magnitude
    // smaller on disk than the ProRes it becomes.
    const raw = `${outPathBase}.raw.mp4`
    await cached('avatar', [model, { file: plate }, { file: audioPath }], raw, async (path, id) => {
      // fal takes URLs, not data URIs, so both halves go to storage first.
      const [imageUrl, audioUrl] = await Promise.all([
        falUpload(plate),
        falUpload(resolve(audioPath)),
      ])
      log.step(`${model}: rendering ${persona.id} against ${audioPath}`)
      // The cache entry's id doubles as the resume key: this is the one call
      // in the pipeline long enough and dear enough to be worth rejoining
      // rather than repeating.
      const result = await falRun<{ video: { url: string } }>(model, input(imageUrl, audioUrl), id)
      await falDownload(result.video.url, path)
    })

    // The raw render is left in the work directory rather than deleted: it is
    // what --keep-work is for, and it is the only way to see whether the model
    // actually kept the green before the key had its way with it.
    const videoPath = `${outPathBase}.mov`
    await chromaKey(raw, CHROMA, videoPath)

    return { videoPath, alpha: true, durationMs: await durationMs(videoPath) }
  }
}

/** Broadcast green — far enough from skin, hair and the personas' accent
 *  colours that keying it out does not eat the subject. */
const CHROMA = '00B140'

/**
 * The creator, cut out of her room and stood on a green screen.
 *
 * The avatar model paints whatever background the portrait was shot in, and a
 * rectangle of someone else's room pasted onto a web page is the single
 * loudest tell that a video was assembled. Cutting the *clip* out afterwards
 * works but is billed by the second, and comes to more than the render it is
 * matting. Cutting the *portrait* out instead is one image, once per persona,
 * for less than two cents — the model then generates against green and the
 * key happens locally for nothing.
 */
async function greenScreenPlate(portraitPath: string, outPath: string): Promise<string> {
  return cached('plate', [{ file: portraitPath }], outPath, async (path) => {
    log.step('cutting the portrait out of its room (once per persona, then reused)')
    const { image } = await falRun<{ image: { url: string } }>(
      'fal-ai/bria/background/remove',
      { image_url: await falUpload(portraitPath) },
    )
    const cutout = `${path}.cutout.png`
    await falDownload(image.url, cutout)
    await flattenOnto(cutout, CHROMA, path)
    await rm(cutout, { force: true })
  })
}

export function avatarProvider(): AvatarProvider {
  // A vendor key is an explicit choice and wins; FAL_KEY is often just present
  // in the environment for something else, so it is the default, not an
  // override.
  const heygen = process.env.HEYGEN_API_KEY
  if (heygen) return new HeyGenAvatarProvider(heygen)
  if (process.env.FAL_KEY) {
    const tier = process.env.AVATAR_TIER === 'final' ? 'final' : 'draft'
    if (tier === 'draft') {
      log.warn('AVATAR_TIER is draft — a 28th of the price, a fraction of the expression; set it to final to ship')
    }
    return new FalAvatarProvider(tier)
  }
  log.warn('no FAL_KEY or HEYGEN_API_KEY — compositing a persona card instead of a talking head')
  return new StubAvatarProvider()
}
