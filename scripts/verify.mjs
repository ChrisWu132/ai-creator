// End-to-end check: serve the fixture page, record it, and assert the encode
// actually produced 1080x1920 h264 of a plausible length. Runs offline.
import { spawn } from 'node:child_process'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { rm, stat } from 'node:fs/promises'
import { createRequire } from 'node:module'

const exec = promisify(execFile)
const require = createRequire(import.meta.url)
const OUT = 'out/verify/fixture-product.mp4'

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: 'inherit', ...opts })
    child.on('error', reject)
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`))))
  })
}

const server = spawn(process.execPath, ['scripts/serve-fixtures.mjs'], { stdio: 'ignore' })
const shutdown = () => server.kill()
process.on('exit', shutdown)

try {
  await new Promise((r) => setTimeout(r, 800))
  await rm('out/verify', { recursive: true, force: true })
  await run('npx', ['tsx', 'src/cli/record.ts', 'specs/examples/fixture-product.json', '--out', 'out/verify'])

  const info = await stat(OUT)
  if (info.size < 100_000) throw new Error(`output suspiciously small: ${info.size} bytes`)

  const ffmpeg = require('ffmpeg-static')
  const { stderr } = await exec(ffmpeg, ['-hide_banner', '-i', OUT]).catch((e) => e)
  if (!/1080x1920/.test(stderr)) throw new Error('output is not 1080x1920')
  if (!/Video: h264/.test(stderr)) throw new Error('output is not h264')
  const duration = /Duration: 00:00:(\d+\.\d+)/.exec(stderr)?.[1]
  if (!duration || Number(duration) < 5) throw new Error(`output too short: ${duration}s`)

  console.log(`\nverify ok — ${OUT} (${duration}s, 1080x1920 h264, ${(info.size / 1e6).toFixed(1)}MB)`)
} finally {
  shutdown()
}
