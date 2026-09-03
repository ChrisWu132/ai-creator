import { readdir, readFile, writeFile } from 'node:fs/promises'
import { join, basename } from 'node:path'

/**
 * The human approval step, as one static file. Phase 1 approves 30 videos;
 * that does not need a dashboard, it needs every clip on one page next to the
 * script it was made from.
 */
const CSS = `
  :root { color-scheme: dark; }
  body { margin:0; background:#0b0c0f; color:#e7e9ee; font:15px/1.55 -apple-system,
         BlinkMacSystemFont,'Segoe UI',Roboto,'DejaVu Sans',sans-serif; padding:32px; }
  h1 { font-size:22px; margin:0 0 4px; letter-spacing:-.4px; }
  .sub { color:#8b90a0; margin-bottom:28px; font-size:13px; }
  .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(320px,1fr)); gap:26px; }
  .card { background:#14161c; border:1px solid #22252e; border-radius:14px; overflow:hidden; }
  video { width:100%; display:block; background:#000; }
  .body { padding:14px 16px 16px; }
  .who { font-weight:650; font-size:14px; }
  .meta { color:#8b90a0; font-size:12px; margin:2px 0 10px; }
  .beat { border-left:2px solid #2f3542; padding:2px 0 2px 10px; margin-bottom:8px; font-size:13px; }
  .role { color:#6f7686; font-size:11px; text-transform:uppercase; letter-spacing:.9px; }
  .stub { color:#d9a441; font-size:11px; }
`

interface Manifest {
  script: { id: string; beats: { role: string; vo: string }[]; postCaption: string }
  topic: { title: string; url: string; source: string }
  personaId: string
  providers: Record<string, string>
  durationMs: number
}

const escape = (s: string) =>
  s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)

async function main(): Promise<void> {
  const dir = process.argv[2] ?? 'out/videos'
  const files = (await readdir(dir)).filter((f) => f.endsWith('.json'))

  const cards: string[] = []
  for (const file of files.sort()) {
    const manifest = JSON.parse(await readFile(join(dir, file), 'utf8')) as Manifest
    const video = `${basename(file, '.json')}.mp4`
    const stubbed = Object.entries(manifest.providers)
      .filter(([, name]) => name === 'stub')
      .map(([stage]) => stage)

    cards.push(`
      <div class="card">
        <video src="${escape(video)}" controls preload="metadata"></video>
        <div class="body">
          <div class="who">${escape(manifest.topic.title)}</div>
          <div class="meta">
            ${escape(manifest.personaId)} · ${(manifest.durationMs / 1000).toFixed(1)}s ·
            ${escape(manifest.topic.source)}
            ${stubbed.length ? `<br><span class="stub">stubbed: ${stubbed.join(', ')}</span>` : ''}
          </div>
          ${manifest.script.beats
            .map((b) => `<div class="beat"><div class="role">${escape(b.role)}</div>${escape(b.vo)}</div>`)
            .join('')}
        </div>
      </div>`)
  }

  const html = `<!doctype html><meta charset="utf-8">
<title>ai-creator — review</title>
<style>${CSS}</style>
<h1>Review queue</h1>
<div class="sub">${cards.length} video${cards.length === 1 ? '' : 's'} in ${escape(dir)}</div>
<div class="grid">${cards.join('')}</div>`

  const outPath = join(dir, 'index.html')
  await writeFile(outPath, html)
  console.log(`${outPath} — ${cards.length} video(s)`)
}

main().catch((err) => { console.error(err); process.exit(1) })
