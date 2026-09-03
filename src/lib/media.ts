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

function rgb(hex: string): [number, number, number] {
  const match = /^([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex)
  if (!match) throw new Error(`not a six-digit hex colour: ${hex}`)
  return [parseInt(match[1]!, 16), parseInt(match[2]!, 16), parseInt(match[3]!, 16)]
}

/**
 * Puts a transparent cutout on a solid colour.
 *
 * `lutrgb` paints a copy of the frame a flat colour, which gives a backdrop of
 * exactly the right size without anyone having to read the image's dimensions
 * first.
 */
export async function flattenOnto(input: string, hex: string, output: string): Promise<void> {
  const [r, g, b] = rgb(hex)
  await runFfmpeg([
    '-y', '-i', input,
    '-filter_complex',
    `[0]format=rgba,split[a][b];[a]lutrgb=r=${r}:g=${g}:b=${b},format=rgb24[bg];` +
    `[bg][b]overlay=format=auto,format=rgb24`,
    '-frames:v', '1', output,
  ])
}

/**
 * Turns a solid-colour background back into a real alpha channel.
 *
 * This is the cheap half of the cut-out: matting a *video* is billed per
 * second and costs more than the render it is matting, but if the avatar model
 * is handed a subject already standing on green it hands one back, and keying
 * that out is local and free.
 *
 * `despill` removes the green that bounced onto hair and shoulders — without
 * it the edge stays faintly lime against a light web page. ProRes 4444 because
 * VP9 comes back yuv420p with the transparency flattened; it is a big
 * intermediate, deleted with the work directory.
 */
export async function chromaKey(input: string, hex: string, output: string): Promise<void> {
  await runFfmpeg([
    '-y', '-i', input, '-an',
    '-vf', `chromakey=0x${hex}:0.12:0.04,despill=type=green:mix=0.5:expand=0.3,format=yuva444p10le`,
    '-c:v', 'prores_ks', '-profile:v', '4444', '-pix_fmt', 'yuva444p10le',
    output,
  ])
}
