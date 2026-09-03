import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'

const exec = promisify(execFile)
const require = createRequire(import.meta.url)

let cached: string | null = null

/**
 * Prefer a full ffmpeg. Playwright ships one, but that build is compiled
 * without libx264 — it can only produce webm, which is not what we hand to
 * the editor step.
 */
export function ffmpegPath(): string {
  if (cached) return cached

  const fromEnv = process.env.FFMPEG_PATH
  if (fromEnv && existsSync(fromEnv)) return (cached = fromEnv)

  try {
    const staticPath = require('ffmpeg-static') as string | null
    if (staticPath && existsSync(staticPath)) return (cached = staticPath)
  } catch {
    // ffmpeg-static is a devDependency; fall through to a system binary.
  }

  return (cached = 'ffmpeg')
}

export async function runFfmpeg(args: string[]): Promise<void> {
  try {
    await exec(ffmpegPath(), args, { maxBuffer: 32 * 1024 * 1024 })
  } catch (err) {
    const e = err as { stderr?: string; message?: string }
    const tail = (e.stderr ?? e.message ?? '').split('\n').slice(-12).join('\n')
    throw new Error(`ffmpeg failed:\n${tail}`)
  }
}
