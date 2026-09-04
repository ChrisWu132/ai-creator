import { readFile, writeFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { extname, join } from 'node:path'
import { cacheDir } from './cache.js'
import { log } from './log.js'

/**
 * Minimal fal.ai client: upload a local file, run a model, download a result.
 *
 * Everything goes through the queue rather than the synchronous endpoint.
 * Node's fetch gives up after 300s with a bare "fetch failed", and an avatar
 * render takes longer than that — the queue hands back a request id
 * immediately and each poll is its own short request.
 */

const QUEUE_BASE = 'https://queue.fal.run'
const POLL_MS = 3000
const MAX_POLLS = 400
const TRANSPORT_TRIES = 5
const STORAGE_INITIATE = 'https://rest.alpha.fal.ai/storage/upload/initiate?storage_type=fal-cdn-v3'

const CONTENT_TYPES: Record<string, string> = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp',
  '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.wav': 'audio/wav', '.aac': 'audio/aac',
  '.mp4': 'video/mp4',
}

export function falKey(): string {
  const key = process.env.FAL_KEY
  if (!key) throw new Error('FAL_KEY is not set')
  return key
}

function auth(): Record<string, string> {
  return { Authorization: `Key ${falKey()}` }
}

/**
 * Retries the *transport*, and only the transport.
 *
 * A render can take minutes, which is minutes of polling, and one dropped
 * connection in there used to throw a bare "fetch failed" and abandon a job
 * that was already finished and already billed. A refused connection is not
 * an answer, so it is worth asking again; an HTTP response, including an
 * error one, is an answer and goes straight back to the caller.
 */
async function fetchOrRetry(url: string, init?: RequestInit): Promise<Response> {
  let last: unknown
  for (let attempt = 1; attempt <= TRANSPORT_TRIES; attempt++) {
    try {
      return await fetch(url, init)
    } catch (err) {
      last = err
      log.warn(`fal: ${(err as Error).message} (attempt ${attempt}/${TRANSPORT_TRIES})`)
      await new Promise((r) => setTimeout(r, attempt * 2000))
    }
  }
  throw new Error(`fal unreachable after ${TRANSPORT_TRIES} tries: ${(last as Error).message}`)
}

/**
 * fal's models take URLs, not data URIs — a base64 audio payload is rejected
 * with "Failed to download the file from the provided URL". Local files have
 * to go through storage first.
 */
export async function falUpload(path: string): Promise<string> {
  const contentType = CONTENT_TYPES[extname(path).toLowerCase()]
  if (!contentType) throw new Error(`no content type known for ${path}`)

  const initiated = await fetch(STORAGE_INITIATE, {
    method: 'POST',
    headers: { ...auth(), 'content-type': 'application/json' },
    body: JSON.stringify({ content_type: contentType, file_name: path.split(/[\\/]/).pop() }),
  })
  if (!initiated.ok) {
    throw new Error(`fal upload initiate ${initiated.status}: ${(await initiated.text()).slice(0, 400)}`)
  }
  const { file_url: fileUrl, upload_url: uploadUrl } = (await initiated.json()) as {
    file_url: string
    upload_url: string
  }

  const put = await fetch(uploadUrl, {
    method: 'PUT',
    headers: { 'content-type': contentType },
    body: await readFile(path),
  })
  if (!put.ok) throw new Error(`fal upload ${put.status}: ${(await put.text()).slice(0, 400)}`)

  return fileUrl
}

interface Queued {
  request_id: string
  /** Absolute URLs from fal — following them avoids rebuilding the model path,
   *  which differs from the submit path for nested model ids. */
  status_url: string
  response_url: string
}

/**
 * A note on disk saying "this job is already paid for".
 *
 * Retrying the transport survives a dropped connection but not a dead process:
 * the render keeps going on fal's side and keeps being billed, while the id
 * that could collect it dies with the run. The note is written before the
 * first poll and removed only when the job reaches an end.
 */
interface Pending extends Queued {
  model: string
}

function pendingPath(resumeKey: string): string {
  return join(cacheDir(), `pending-${resumeKey}.json`)
}

/** The job named by a note, if there is one. Whether fal still has it is not
 *  asked here — a forgotten request answers 200 on its status and only 404s on
 *  its result, so the only honest test is trying to collect it. */
async function rejoin(model: string, resumeKey: string): Promise<Queued | undefined> {
  const path = pendingPath(resumeKey)
  if (!existsSync(path)) return undefined

  const pending = JSON.parse(await readFile(path, 'utf8')) as Pending
  if (pending.model !== model) return undefined

  log.step(`fal ${model}: rejoining ${pending.request_id}, already submitted and already billed`)
  return pending
}

/**
 * fal has no record of this request — there is nothing to collect and no
 * reason not to submit a fresh one.
 *
 * Kept distinct from every other failure on purpose: resubmitting after a
 * dropped connection or a slow queue is exactly how you pay for one render
 * twice, so only this error is allowed to start a new job.
 */
class RequestGone extends Error {}

function forgotten(status: number): boolean {
  return status === 404 || status === 410
}

/** Waits out a submitted job and returns its result. */
async function collect<T>(model: string, queued: Queued, resumeKey?: string): Promise<T> {
  for (let attempt = 0; attempt < MAX_POLLS; attempt++) {
    await new Promise((r) => setTimeout(r, POLL_MS))
    const polled = await fetchOrRetry(queued.status_url, { headers: auth() })
    if (!polled.ok) {
      const detail = `fal ${model} status ${polled.status}: ${(await polled.text()).slice(0, 400)}`
      if (forgotten(polled.status)) throw new RequestGone(detail)
      throw new Error(detail)
    }
    const { status } = (await polled.json()) as { status: string }

    if (status === 'COMPLETED') {
      const result = await fetchOrRetry(queued.response_url, { headers: auth() })
      if (!result.ok) {
        const detail = `fal ${model} result ${result.status}: ${(await result.text()).slice(0, 600)}`
        if (forgotten(result.status)) throw new RequestGone(detail)
        throw new Error(detail)
      }
      const value = (await result.json()) as T
      if (resumeKey) await rm(pendingPath(resumeKey), { force: true })
      return value
    }
    if (status !== 'IN_QUEUE' && status !== 'IN_PROGRESS') {
      // An ending, so there is nothing left to rejoin. The timeout below is
      // not an ending, and that note deliberately stays.
      if (resumeKey) await rm(pendingPath(resumeKey), { force: true })
      throw new Error(`fal ${model} ended as ${status} (${queued.request_id})`)
    }
  }
  throw new Error(`fal ${model} did not finish in ${(MAX_POLLS * POLL_MS) / 1000}s (${queued.request_id})`)
}

/**
 * Submits a job and waits for it. Pass `resumeKey` — a stable name for this
 * exact piece of work — and an interrupted run picks the job back up instead
 * of paying for it a second time.
 */
export async function falRun<T>(model: string, input: unknown, resumeKey?: string): Promise<T> {
  const rejoined = resumeKey ? await rejoin(model, resumeKey) : undefined
  if (rejoined && resumeKey) {
    try {
      return await collect<T>(model, rejoined, resumeKey)
    } catch (err) {
      if (!(err instanceof RequestGone)) throw err
      log.warn(`fal ${model}: ${rejoined.request_id} is gone — submitting a new one`)
      await rm(pendingPath(resumeKey), { force: true })
    }
  }

  const submitted = await fetchOrRetry(`${QUEUE_BASE}/${model}`, {
    method: 'POST',
    headers: { ...auth(), 'content-type': 'application/json' },
    body: JSON.stringify(input),
  })
  if (!submitted.ok) {
    throw new Error(`fal ${model} ${submitted.status}: ${(await submitted.text()).slice(0, 600)}`)
  }
  const queued = (await submitted.json()) as Queued
  // Recorded and printed before the wait, not after: from here on the render is
  // running and billable whatever happens to this process.
  log.step(`fal ${model} queued as ${queued.request_id}`)
  if (resumeKey) {
    await writeFile(pendingPath(resumeKey), JSON.stringify({ ...queued, model } satisfies Pending))
  }

  return collect<T>(model, queued, resumeKey)
}

export async function falDownload(url: string, outPath: string): Promise<string> {
  const response = await fetchOrRetry(url)
  if (!response.ok) throw new Error(`fal download ${response.status} for ${url}`)
  await writeFile(outPath, Buffer.from(await response.arrayBuffer()))
  return outPath
}
