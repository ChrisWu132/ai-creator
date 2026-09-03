// End-to-end check, offline: serve the fixture page, run the recorder against
// it, then run the whole topic-to-video pipeline on stub providers. Asserts
// both encodes are real 1080x1920 h264 of a plausible length.
import { spawn } from 'node:child_process'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { rm, stat } from 'node:fs/promises'
import { createRequire } from 'node:module'

const exec = promisify(execFile)
const require = createRequire(import.meta.url)
const RECORDER_OUT = 'out/verify/fixture-product.mp4'
const PIPELINE_OUT = 'out/verify/nina-fan-hat--nina.mp4'

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: 'inherit', ...opts })
    child.on('error', reject)
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`))))
  })
}

async function check(file, { minSeconds, audio }) {
  const info = await stat(file)
  if (info.size < 100_000) throw new Error(`${file} suspiciously small: ${info.size} bytes`)

  const ffmpeg = require('ffmpeg-static')
  const { stderr } = await exec(ffmpeg, ['-hide_banner', '-i', file]).catch((e) => e)
  if (!/1080x1920/.test(stderr)) throw new Error(`${file} is not 1080x1920`)
  if (!/Video: h264/.test(stderr)) throw new Error(`${file} is not h264`)
  if (audio && !/Audio: aac/.test(stderr)) throw new Error(`${file} has no aac audio track`)

  const duration = /Duration: 00:00:(\d+\.\d+)/.exec(stderr)?.[1]
  if (!duration || Number(duration) < minSeconds) {
    throw new Error(`${file} too short: ${duration}s (want >= ${minSeconds}s)`)
  }
  return { duration, size: `${(info.size / 1e6).toFixed(1)}MB` }
}

const server = spawn(process.execPath, ['scripts/serve-fixtures.mjs'], { stdio: 'ignore' })
const shutdown = () => server.kill()
process.on('exit', shutdown)

try {
  await new Promise((r) => setTimeout(r, 800))
  await rm('out/verify', { recursive: true, force: true })
  await run('npx', ['tsx', 'src/cli/record.ts', 'specs/examples/fixture-product.json', '--out', 'out/verify'])

  const recorder = await check(RECORDER_OUT, { minSeconds: 5, audio: false })

  await run('npx', ['tsx', 'src/cli/make.ts', 'topics/examples/nina-fan-hat.json', '--out', 'out/verify'])
  const pipeline = await check(PIPELINE_OUT, { minSeconds: 8, audio: true })

  console.log(`\nverify ok`)
  console.log(`  recorder  ${RECORDER_OUT} (${recorder.duration}s, ${recorder.size})`)
  console.log(`  pipeline  ${PIPELINE_OUT} (${pipeline.duration}s, ${pipeline.size})`)
} finally {
  shutdown()
}
