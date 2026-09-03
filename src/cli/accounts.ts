import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { persona as personaSchema } from '../types.js'
import { account as accountSchema, gaps, readiness, type Account } from '../accounts/schema.js'
import { buildProfileAssets } from '../accounts/assets.js'

const USAGE = `
Usage: npm run accounts -- <command>

  init     write an account record per persona (does not overwrite)
  assets   render a profile picture and bio per persona
  check    report what each account still needs before it can publish
`

const RED = (s: string) => `\x1b[31m${s}\x1b[0m`
const YELLOW = (s: string) => `\x1b[33m${s}\x1b[0m`
const GREEN = (s: string) => `\x1b[32m${s}\x1b[0m`
const DIM = (s: string) => `\x1b[2m${s}\x1b[0m`

const PERSONA_DIR = 'personas'
const ACCOUNT_DIR = 'accounts'

async function loadPersonas() {
  const files = (await readdir(PERSONA_DIR)).filter((f) => f.endsWith('.json'))
  return Promise.all(
    files.map(async (f) => personaSchema.parse(JSON.parse(await readFile(join(PERSONA_DIR, f), 'utf8')))),
  )
}

async function init(): Promise<void> {
  await mkdir(ACCOUNT_DIR, { recursive: true })
  for (const persona of await loadPersonas()) {
    const path = join(ACCOUNT_DIR, `${persona.id}.json`)
    if (existsSync(path)) {
      console.log(DIM(`kept    ${path}`))
      continue
    }
    const record: Account = accountSchema.parse({ personaId: persona.id, handle: persona.handle })
    await writeFile(path, `${JSON.stringify(record, null, 2)}\n`)
    console.log(GREEN(`created ${path}`))
  }
}

async function assets(): Promise<void> {
  for (const persona of await loadPersonas()) {
    const built = await buildProfileAssets(persona, 'out/profiles')
    console.log(`${persona.handle}  →  ${built.avatarPath}`)
    console.log(DIM(built.bio.split('\n').map((l) => `    ${l}`).join('\n')))
  }
}

async function check(): Promise<void> {
  if (!existsSync(ACCOUNT_DIR)) {
    console.error(`no ${ACCOUNT_DIR}/ — run: npm run accounts -- init`)
    process.exit(1)
  }
  const files = (await readdir(ACCOUNT_DIR)).filter((f) => f.endsWith('.json'))
  let blocked = 0

  for (const file of files.sort()) {
    const record = accountSchema.parse(JSON.parse(await readFile(join(ACCOUNT_DIR, file), 'utf8')))
    const state = readiness(record)
    const badge = state === 'api-ready' ? GREEN('api-ready')
      : state === 'manual-only' ? YELLOW('manual-only') : RED('not-created')

    console.log(`\n${record.handle}  ${badge}`)
    const found = gaps(record)
    if (!found.length) { console.log(DIM('    nothing outstanding')); continue }

    for (const gap of found) {
      if (gap.severity === 'blocker') blocked++
      const mark = gap.severity === 'blocker' ? RED('✗') : YELLOW('·')
      console.log(`  ${mark} ${gap.what}`)
      console.log(DIM(`      ${gap.action}`))
    }
  }

  console.log(
    `\n${files.length} account(s), ${blocked} blocker(s). ` +
    DIM('Publishing stays manual until every account reads api-ready.'),
  )
}

const command = process.argv[2]
const commands: Record<string, () => Promise<void>> = { init, assets, check }
const handler = command ? commands[command] : undefined

if (!handler) {
  console.error(command ? `unknown command: ${command}` : 'no command given')
  console.error(USAGE)
  process.exit(2)
}
await handler()
