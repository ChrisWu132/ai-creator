// Minimal static server for fixtures/, so the recorder has a deterministic
// page to run against without touching the network.
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'

// fileURLToPath, not .pathname: on Windows the latter yields '/C:/...%20...',
// which never matches the back-slashed path join() builds — every request 403s.
const ROOT = fileURLToPath(new URL('../fixtures/', import.meta.url))
const PORT = Number(process.env.FIXTURE_PORT ?? 4321)
const TYPES = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript',
                '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml' }

const server = createServer(async (req, res) => {
  // normalize() turns '/' into '\' on Windows, so compare after normalizing
  // rather than against the literal slash.
  const path = normalize(decodeURIComponent((req.url ?? '/').split('?')[0]))
  const file = join(ROOT, path === normalize('/') ? 'index.html' : path)
  if (!file.startsWith(ROOT)) { res.writeHead(403).end('forbidden'); return }
  try {
    const body = await readFile(file)
    res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' })
    res.end(body)
  } catch {
    res.writeHead(404).end('not found')
  }
})

server.listen(PORT, '127.0.0.1', () => console.log(`fixtures on http://127.0.0.1:${PORT}`))
