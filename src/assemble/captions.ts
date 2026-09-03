import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { renderHtmlToPng } from '../lib/render-html.js'

const CAPTION_CSS = `
  body { margin: 0; background: transparent; font-family: -apple-system, BlinkMacSystemFont,
         'Segoe UI', Roboto, 'DejaVu Sans', sans-serif; }
  .cap { display: inline-block; max-width: 840px; padding: 20px 30px;
         background: rgba(10,11,14,.82); border-radius: 18px;
         font-size: 46px; line-height: 1.22; font-weight: 700; color: #fff;
         text-align: center; letter-spacing: -.5px;
         text-shadow: 0 2px 10px rgba(0,0,0,.45); }
`

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
}

/**
 * One PNG per beat. Word-level karaoke timing needs per-word timestamps from
 * the TTS provider, so until that exists a caption holds for its whole beat.
 */
export async function renderCaptions(
  captions: string[],
  outDir: string,
  accent: string,
): Promise<string[]> {
  await mkdir(outDir, { recursive: true })
  const paths: string[] = []

  for (const [i, text] of captions.entries()) {
    const outPath = join(outDir, `caption-${String(i).padStart(2, '0')}.png`)
    await renderHtmlToPng({
      html: `<style>${CAPTION_CSS}
        .cap { border-bottom: 5px solid ${accent}; }
      </style><div class="cap">${escapeHtml(text)}</div>`,
      selector: '.cap',
      outPath,
      width: 900,
    })
    paths.push(outPath)
  }
  return paths
}
