import { readFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { parseSpec } from '../recorder/schema.js'
import { record } from '../recorder/record.js'
import { log } from '../lib/log.js'

const USAGE = `
Usage: npm run record -- <spec.json> [more.json ...] [options]

Options:
  --out <dir>      output directory (default: out/broll)
  --keep-frames    leave the raw jpeg frames next to the video
  --url <url>      override the spec's url (handy for retargeting one spec)
`

interface Cli { specs: string[]; outDir: string; keepFrames: boolean; url?: string }

function parseArgv(argv: string[]): Cli {
  const cli: Cli = { specs: [], outDir: 'out/broll', keepFrames: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    if (arg === '--out') cli.outDir = argv[++i] ?? cli.outDir
    else if (arg === '--url') cli.url = argv[++i]
    else if (arg === '--keep-frames') cli.keepFrames = true
    else if (arg.startsWith('-')) throw new Error(`unknown option: ${arg}`)
    else cli.specs.push(arg)
  }
  if (!cli.specs.length) throw new Error('no spec files given')
  return cli
}

async function main(): Promise<void> {
  let cli: Cli
  try {
    cli = parseArgv(process.argv.slice(2))
  } catch (err) {
    console.error((err as Error).message)
    console.error(USAGE)
    process.exit(2)
  }

  const failures: string[] = []
  for (const specPath of cli.specs) {
    const raw = JSON.parse(await readFile(specPath, 'utf8')) as Record<string, unknown>
    if (cli.url) raw.url = cli.url
    if (!raw.id) raw.id = basename(specPath).replace(/\.json$/, '')

    const spec = parseSpec(raw)
    const outPath = resolve(join(cli.outDir, `${spec.id}.mp4`))

    try {
      await record(spec, { outPath, keepFrames: cli.keepFrames })
    } catch (err) {
      log.error(`${spec.id}: ${(err as Error).message}`)
      failures.push(spec.id)
    }
  }

  if (failures.length) {
    log.error(`${failures.length}/${cli.specs.length} failed: ${failures.join(', ')}`)
    process.exit(1)
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
