import { writeFile, rm } from 'node:fs/promises'
import type { Persona } from '../types.js'
import { silentAudio, durationMs } from '../lib/media.js'
import { runFfmpeg } from '../lib/ffmpeg.js'
import { falRun, falDownload } from '../lib/fal.js'
import { cached } from '../lib/cache.js'
import { log } from '../lib/log.js'

export interface Voiceover {
  audioPath: string
  durationMs: number
}

export interface TtsProvider {
  readonly name: string
  speak(text: string, persona: Persona, outPath: string): Promise<Voiceover>
}

/** Roughly conversational delivery for a short-form script. */
const WORDS_PER_SECOND = 2.7
const MIN_BEAT_MS = 1400

export function estimateSpeechMs(text: string): number {
  const words = text.trim().split(/\s+/).filter(Boolean).length
  return Math.max(MIN_BEAT_MS, Math.round((words / WORDS_PER_SECOND) * 1000))
}

/**
 * Silence of the length the line would take to say. Nothing to listen to, but
 * it gives the assembly step a real timeline, which is what everything
 * downstream actually depends on.
 */
export class StubTtsProvider implements TtsProvider {
  readonly name = 'stub'

  async speak(text: string, _persona: Persona, outPath: string): Promise<Voiceover> {
    const estimated = estimateSpeechMs(text)
    await silentAudio(estimated, outPath)
    return { audioPath: outPath, durationMs: estimated }
  }
}

/**
 * NOT VERIFIED AGAINST A LIVE API — written from documentation that this
 * environment cannot reach. Check the request shape against
 * elevenlabs.io/docs before the first real run.
 */
export class ElevenLabsTtsProvider implements TtsProvider {
  readonly name = 'elevenlabs'

  constructor(private readonly apiKey: string) {}

  async speak(text: string, persona: Persona, outPath: string): Promise<Voiceover> {
    const voiceId = persona.providers.elevenVoiceId
    if (!voiceId) {
      throw new Error(`persona ${persona.id} has no providers.elevenVoiceId — add one to its bible`)
    }

    const response = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}`,
      {
        method: 'POST',
        headers: {
          'xi-api-key': this.apiKey,
          'content-type': 'application/json',
          accept: 'audio/mpeg',
        },
        body: JSON.stringify({
          text,
          model_id: 'eleven_multilingual_v2',
          voice_settings: { stability: 0.45, similarity_boost: 0.8 },
        }),
      },
    )

    if (!response.ok) {
      throw new Error(`elevenlabs ${response.status}: ${(await response.text()).slice(0, 400)}`)
    }

    await writeFile(outPath, Buffer.from(await response.arrayBuffer()))
    return { audioPath: outPath, durationMs: await durationMs(outPath) }
  }
}

/**
 * Two voice engines of the same shape, about five cents a video apart.
 *
 * `kokoro` is the default: five cents times thirty videos is not a number
 * worth optimising, and what decides whether a line sounds like a person is
 * the writing, not the engine. `eleven` is v3, which performs inline audio
 * tags — [laughs], [sighs] — and turns an ellipsis into a real breath; set
 * TTS_MODEL=eleven for a take that has to carry one.
 */
const MODELS = {
  kokoro: {
    model: 'fal-ai/kokoro/american-english',
    audioTags: false,
    voice: (persona: Persona) => persona.providers.kokoroVoice ?? 'af_heart',
    input: (text: string, voice: string) => ({ prompt: text, voice, speed: 1.05 }),
  },
  eleven: {
    model: 'fal-ai/elevenlabs/tts/eleven-v3',
    audioTags: true,
    voice: (persona: Persona) => persona.providers.falVoice ?? 'Jessica',
    input: (text: string, voice: string) => ({
      text,
      voice,
      stability: 0.4,
      similarity_boost: 0.8,
      speed: 1.05,
    }),
  },
} as const

export type TtsModel = keyof typeof MODELS

/** An engine that does not perform these reads them out loud instead. */
const AUDIO_TAG = /\s*\[[^\]\n]{1,24}\]\s*/g

export class FalTtsProvider implements TtsProvider {
  readonly name: string

  constructor(private readonly choice: TtsModel) {
    this.name = `fal-${choice}`
  }

  async speak(text: string, persona: Persona, outPath: string): Promise<Voiceover> {
    const { model, audioTags, voice, input } = MODELS[this.choice]
    const spoken = audioTags ? text : text.replace(AUDIO_TAG, ' ').replace(/\s+/g, ' ').trim()
    if (spoken !== text) log.step(`${this.name} cannot perform audio tags — dropping them`)

    const voiceId = voice(persona)
    await cached('vo', [model, voiceId, spoken], outPath, async (path) => {
      const { audio } = await falRun<{ audio: { url: string } }>(model, input(spoken, voiceId))

      // Both engines return mp3; the pipeline concatenates aac, so transcode on
      // the way in rather than leaving a container mismatch for concat to trip on.
      const mp3Path = `${path}.mp3`
      await falDownload(audio.url, mp3Path)
      await runFfmpeg(['-y', '-i', mp3Path, '-c:a', 'aac', '-b:a', '160k', path])
      await rm(mp3Path, { force: true })
    })

    return { audioPath: outPath, durationMs: await durationMs(outPath) }
  }
}

export function ttsProvider(): TtsProvider {
  // Same rule as the avatar provider: an explicit vendor key wins over an
  // ambient FAL_KEY.
  const key = process.env.ELEVENLABS_API_KEY
  if (key) return new ElevenLabsTtsProvider(key)
  if (process.env.FAL_KEY) {
    return new FalTtsProvider(process.env.TTS_MODEL === 'eleven' ? 'eleven' : 'kokoro')
  }
  log.warn('no FAL_KEY or ELEVENLABS_API_KEY — voiceover will be silence of the right length')
  return new StubTtsProvider()
}
