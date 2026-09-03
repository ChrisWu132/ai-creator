import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { persona as personaSchema, topic as topicSchema } from '../types.js'
import { make } from '../pipeline/make.js'
import { log } from '../lib/log.js'

const USAGE = `
Usage: npm run make -- <topic.json> [more.json ...] [options]

Options:
  --out <dir>       output directory (default: out/videos)
  --personas <dir>  persona bible directory (default: personas)
  --keep-work       keep the intermediate beat clips and audio
`

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  const topics: string[] = []
  let outDir = 'out/videos'
  let personaDir = 'personas'
  let keepWork = false

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    if (arg === '--out') outDir = argv[++i] ?? outDir
    else if (arg === '--personas') personaDir = argv[++i] ?? personaDir
    else if (arg === '--keep-work') keepWork = true
    else if (arg.startsWith('-')) { console.error(`unknown option: ${arg}`, USAGE); process.exit(2) }
    else topics.push(arg)
  }

  if (!topics.length) { console.error('no topic files given', USAGE); process.exit(2) }

  const failures: string[] = []
  for (const topicPath of topics) {
    const topic = topicSchema.parse(JSON.parse(await readFile(topicPath, 'utf8')))
    const persona = personaSchema.parse(
      JSON.parse(await readFile(join(personaDir, `${topic.personaId}.json`), 'utf8')),
    )
    try {
      await make(persona, topic, { outDir, keepWork, topicPath })
    } catch (err) {
      log.error(`${topic.id}: ${(err as Error).message}`)
      failures.push(topic.id)
    }
  }

  if (failures.length) {
    log.error(`${failures.length}/${topics.length} failed: ${failures.join(', ')}`)
    process.exit(1)
  }
}

main().catch((err) => { console.error(err); process.exit(1) })
