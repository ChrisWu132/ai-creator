import { mkdir, writeFile, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { Persona, Topic, Script } from '../types.js'
import { visualSpec } from '../recorder/schema.js'
import { record } from '../recorder/record.js'
import { probePage } from '../authoring/probe.js'
import { scriptProvider } from '../providers/script.js'
import { ttsProvider, type Voiceover } from '../providers/tts.js'
import { avatarProvider } from '../providers/avatar.js'
import { renderCaptions } from '../assemble/captions.js'
import { fitClip, concatClips, concatAudio, compose, type Overlay } from '../lib/media.js'
import { stretchActions, nominalDurationMs } from './timing.js'
import { log } from '../lib/log.js'

export interface MakeResult {
  script: Script
  videoPath: string
  durationMs: number
}

/**
 * Topic in, finished 9:16 video out. Every external service sits behind a
 * provider, so this runs end to end with no API keys — the shape of the
 * result is real even when the voice is silence and the avatar is a card.
 */
export async function make(
  persona: Persona,
  topic: Topic,
  options: { outDir: string; keepWork?: boolean; topicPath?: string },
): Promise<MakeResult> {
  log.reset()
  const workDir = resolve(join(options.outDir, `${topic.id}--${persona.id}.work`))
  await mkdir(workDir, { recursive: true })

  log.info(`probing ${topic.url}`)
  const probe = await probePage(topic.url)

  const scripts = scriptProvider(options.topicPath)
  log.info(`writing script with the ${scripts.name} provider`)
  const script = await scripts.generate(persona, topic, probe)
  script.beats.forEach((beat, i) => log.step(`beat ${i} (${beat.role}): "${beat.vo}"`))

  // Voiceover first: its length is what every beat's footage gets fitted to.
  const tts = ttsProvider()
  const voiceovers: Voiceover[] = []
  for (const [i, beat] of script.beats.entries()) {
    voiceovers.push(await tts.speak(beat.vo, persona, join(workDir, `vo-${i}.m4a`)))
  }

  const fitted: string[] = []
  for (const [i, beat] of script.beats.entries()) {
    const target = voiceovers[i]!.durationMs
    const planned = visualSpec.parse({
      ...beat.visual,
      id: `${script.id}-beat${i}`,
      url: topic.url,
    })

    // Stretch the camera plan to the line before shooting, so the clip is
    // paced to the voiceover rather than frozen at the end of it.
    const spec = { ...planned, actions: stretchActions(planned.actions, target) }
    log.step(
      `beat ${i}: plan ${nominalDurationMs(planned.actions)}ms → ` +
      `${nominalDurationMs(spec.actions)}ms for a ${target}ms line`,
    )

    const raw = join(workDir, `broll-${i}.mp4`)
    await record(spec, { outPath: raw })

    const cut = join(workDir, `broll-${i}-fit.mp4`)
    await fitClip(raw, target, cut)
    fitted.push(cut)
  }

  const brollPath = join(workDir, 'broll.mp4')
  await concatClips(fitted, brollPath)
  const audioPath = join(workDir, 'voiceover.m4a')
  await concatAudio(voiceovers.map((v) => v.audioPath), audioPath)

  const avatars = avatarProvider()
  log.info(`avatar via the ${avatars.name} provider`)
  const avatar = await avatars.render(persona, audioPath, join(workDir, 'avatar'))

  const captionPaths = await renderCaptions(
    script.beats.map((beat) => beat.caption ?? beat.vo),
    join(workDir, 'captions'),
    persona.visual.accent,
  )

  // A cut-out figure stands on the page at full height in the corner; a boxed
  // clip or a card is small and sits in it. The captions clear whichever it is.
  const overlays: Overlay[] = []
  const captionY = avatar.alpha ? 'H-h-620' : 'H-h-340'
  let cursor = 0
  captionPaths.forEach((imagePath, i) => {
    const length = voiceovers[i]!.durationMs
    overlays.push({
      imagePath,
      width: 900,
      x: '(W-w)/2',
      y: captionY,
      fromMs: cursor,
      toMs: cursor + length,
    })
    cursor += length
  })

  const avatarSource = avatar.videoPath ?? avatar.imagePath
  if (avatarSource && avatar.alpha) {
    // Sized for what `final` returns: Kling reframes the portrait into a bust
    // with air around it, so the whole clip composites with no edge showing.
    // `draft` inherits the portrait's own crop instead, and a tight selfie
    // leaves a visible line where the photo cut through her arms — one more
    // reason draft is for iterating on hooks, not for looking at.
    overlays.push({ imagePath: avatarSource, width: 560, x: '24', y: 'H-h' })
  } else if (avatarSource) {
    // An un-matted clip is a full portrait with its own background, so it gets
    // cropped to a head and boxed; the stub card is already the right shape.
    overlays.push({
      imagePath: avatarSource,
      width: 240,
      cropSquare: avatar.videoPath !== undefined,
      x: '48',
      y: 'H-h-56',
    })
  }

  const videoPath = resolve(join(options.outDir, `${script.id}.mp4`))
  await compose({ video: brollPath, audio: audioPath, overlays, output: videoPath })

  const durationMs = voiceovers.reduce((sum, v) => sum + v.durationMs, 0)
  await writeFile(
    join(options.outDir, `${script.id}.json`),
    JSON.stringify(
      {
        script,
        topic,
        personaId: persona.id,
        providers: { script: scripts.name, tts: tts.name, avatar: avatars.name },
        durationMs,
        videoPath,
      },
      null,
      2,
    ),
  )

  if (!options.keepWork) await rm(workDir, { recursive: true, force: true })
  log.done(`${videoPath}  (${(durationMs / 1000).toFixed(1)}s, ${script.beats.length} beats)`)

  return { script, videoPath, durationMs }
}
