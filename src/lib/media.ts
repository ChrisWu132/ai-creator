import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { writeFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { ffmpegPath, runFfmpeg } from './ffmpeg.js'

const exec = promisify(execFile)

/** ffprobe is not bundled with ffmpeg-static, so read the duration ffmpeg prints. */
export async function durationMs(file: string): Promise<number> {
  const result = await exec(ffmpegPath(), ['-hide_banner', '-i', file]).catch(
    (e: { stderr?: string }) => e,
  )
  const stderr = (result as { stderr?: string }).stderr ?? ''
  const match = /Duration: (\d+):(\d+):(\d+\.\d+)/.exec(stderr)
  if (!match) throw new Error(`could not read duration of ${file}`)
  const [, h, m, s] = match
  return Math.round((Number(h) * 3600 + Number(m) * 60 + Number(s)) * 1000)
}

/**
 * Makes a clip exactly `targetMs` long: trimmed if it overruns, or held on its
 * last frame if it comes up short. Beat footage and beat voiceover are
 * produced independently, so one of the two always has to give.
 */
export async function fitClip(input: string, targetMs: number, output: string): Promise<void> {
  const actual = await durationMs(input)
  const padSeconds = Math.max(0, targetMs - actual) / 1000
  await runFfmpeg([
    '-y', '-i', input,
    '-vf', `tpad=stop_mode=clone:stop_duration=${padSeconds.toFixed(3)}`,
    '-t', (targetMs / 1000).toFixed(3),
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
    '-an', output,
  ])
}

export async function concatClips(inputs: string[], output: string): Promise<void> {
  if (!inputs.length) throw new Error('nothing to concatenate')
  const listPath = join(dirname(output), 'concat.txt')
  await writeFile(listPath, inputs.map((f) => `file '${f}'`).join('\n'))
  await runFfmpeg([
    '-y', '-f', 'concat', '-safe', '0', '-i', listPath,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
    '-an', output,
  ])
}

export interface Overlay {
  imagePath: string
  /** ffmpeg overlay expressions, evaluated against main (W,H) and overlay (w,h). */
  x: string
  y: string
  /** Resize to this pixel width before compositing. Overlays are authored at
   *  2x and scaled down here, which stays sharp; authoring at final size and
   *  scaling up does not. */
  width?: number
  /** Crop to a square around the upper third before scaling. Avatar clips come
   *  back as full portraits; the corner wants a head, not a torso. */
  cropSquare?: boolean
  /** Omit to show for the whole video. */
  fromMs?: number
  toMs?: number
}

/** Burns overlays onto a video and muxes an audio track in one pass. */
export async function compose(options: {
  video: string
  audio?: string
  overlays: Overlay[]
  output: string
}): Promise<void> {
  const { video, audio, overlays, output } = options

  const args = ['-y', '-i', video]
  for (const overlay of overlays) args.push('-i', overlay.imagePath)
  if (audio) args.push('-i', audio)

  const steps: string[] = []
  let label = '0:v'
  overlays.forEach((overlay, i) => {
    let source = `${i + 1}:v`
    const chain: string[] = []
    if (overlay.cropSquare) chain.push(`crop='min(iw,ih)':'min(iw,ih)':0:'(ih-min(iw,ih))/3'`)
    if (overlay.width) {
      const height = overlay.cropSquare ? overlay.width : -1
      chain.push(`scale=${overlay.width}:${height}:flags=lanczos`)
    }
    if (chain.length) {
      steps.push(`[${source}]${chain.join(',')}[ov${i}]`)
      source = `ov${i}`
    }
    const next = `v${i}`
    const enable =
      overlay.fromMs !== undefined && overlay.toMs !== undefined
        ? `:enable='between(t,${(overlay.fromMs / 1000).toFixed(3)},${(overlay.toMs / 1000).toFixed(3)})'`
        : ''
    steps.push(`[${label}][${source}]overlay=x=${overlay.x}:y=${overlay.y}${enable}[${next}]`)
    label = next
  })
  // A filter_complex needs at least one step; the trailing copy keeps the
  // output label uniform whether or not there were overlays.
  steps.push(`[${label}]null[vout]`)

  args.push('-filter_complex', steps.join(';'), '-map', '[vout]')
  if (audio) {
    args.push('-map', `${overlays.length + 1}:a`, '-c:a', 'aac', '-b:a', '160k', '-shortest')
  }
  args.push(
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '19',
    '-pix_fmt', 'yuv420p', '-movflags', '+faststart', output,
  )
  await runFfmpeg(args)
}

/** A silent track of a known length — the placeholder when there is no TTS. */
export async function silentAudio(durationMsValue: number, output: string): Promise<void> {
  await runFfmpeg([
    '-y', '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=mono',
    '-t', (durationMsValue / 1000).toFixed(3),
    '-c:a', 'aac', '-b:a', '128k', output,
  ])
}

export async function concatAudio(inputs: string[], output: string): Promise<void> {
  const listPath = join(dirname(output), 'concat-audio.txt')
  await writeFile(listPath, inputs.map((f) => `file '${f}'`).join('\n'))
  await runFfmpeg(['-y', '-f', 'concat', '-safe', '0', '-i', listPath, '-c:a', 'aac', '-b:a', '160k', output])
}
