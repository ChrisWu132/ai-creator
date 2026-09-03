import { readFile, writeFile } from 'node:fs/promises'
import { extname } from 'node:path'

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

export async function falRun<T>(model: string, input: unknown): Promise<T> {
  const submitted = await fetch(`${QUEUE_BASE}/${model}`, {
    method: 'POST',
    headers: { ...auth(), 'content-type': 'application/json' },
    body: JSON.stringify(input),
  })
  if (!submitted.ok) {
    throw new Error(`fal ${model} ${submitted.status}: ${(await submitted.text()).slice(0, 600)}`)
  }
  const queued = (await submitted.json()) as Queued

  for (let attempt = 0; attempt < MAX_POLLS; attempt++) {
    await new Promise((r) => setTimeout(r, POLL_MS))
    const polled = await fetch(queued.status_url, { headers: auth() })
    if (!polled.ok) {
      throw new Error(`fal ${model} status ${polled.status}: ${(await polled.text()).slice(0, 400)}`)
    }
    const { status } = (await polled.json()) as { status: string }

    if (status === 'COMPLETED') {
      const result = await fetch(queued.response_url, { headers: auth() })
      if (!result.ok) {
        throw new Error(`fal ${model} result ${result.status}: ${(await result.text()).slice(0, 600)}`)
      }
      return (await result.json()) as T
    }
    if (status !== 'IN_QUEUE' && status !== 'IN_PROGRESS') {
      throw new Error(`fal ${model} ended as ${status} (${queued.request_id})`)
    }
  }
  throw new Error(`fal ${model} did not finish in ${(MAX_POLLS * POLL_MS) / 1000}s (${queued.request_id})`)
}

export async function falDownload(url: string, outPath: string): Promise<string> {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`fal download ${response.status} for ${url}`)
  await writeFile(outPath, Buffer.from(await response.arrayBuffer()))
  return outPath
}
