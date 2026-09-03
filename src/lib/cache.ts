import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, copyFile, readFile } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { log } from './log.js'

/**
 * Skips a paid step whose inputs have not changed.
 *
 * The pipeline's steps are pure functions of their inputs — the same portrait
 * and the same audio always want the same talking clip — but a run rebuilds
 * everything from the topic down, so fixing one selector in one beat used to
 * re-render the avatar and re-speak every line. That is the whole cost of a
 * video paid again to change something that costs nothing.
 *
 * Keyed on content, not on paths or timestamps: a step re-runs when its
 * inputs actually differ, and only then.
 */

/** Repo-root, not `out/`: the cache has to survive `--out` pointing elsewhere. */
const CACHE_DIR = fileURLToPath(new URL('../../.cache/', import.meta.url))

/** A literal, or a file whose *contents* are part of the key. */
export type CacheKeyPart = string | { file: string }

async function digest(parts: CacheKeyPart[]): Promise<string> {
  const hash = createHash('sha256')
  for (const part of parts) {
    if (typeof part === 'string') hash.update(`s:${part}\0`)
    else hash.update(await readFile(part.file))
  }
  return hash.digest('hex').slice(0, 16)
}

/**
 * Runs `produce` into `outPath`, unless an identical result is already on
 * disk — in which case it is copied out and nothing is spent.
 *
 * `produce` writes to the real destination rather than to the cache, so a
 * provider's own scratch files (a downloaded mp3, a raw render) stay in the
 * work directory and get cleaned up with it.
 *
 * `NO_CACHE=1` forces a fresh run and replaces the entry, which is how you
 * ask a non-deterministic model for a different take of the same line.
 */
export async function cached(
  kind: string,
  key: CacheKeyPart[],
  outPath: string,
  produce: (outPath: string) => Promise<void>,
): Promise<string> {
  await mkdir(CACHE_DIR, { recursive: true })
  const cachePath = join(CACHE_DIR, `${kind}-${await digest(key)}${extname(outPath)}`)

  if (!process.env.NO_CACHE && existsSync(cachePath)) {
    log.step(`${kind}: unchanged since the last run, reusing it`)
    await copyFile(cachePath, outPath)
    return outPath
  }

  await produce(outPath)
  await copyFile(outPath, cachePath)
  return outPath
}
