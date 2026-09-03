import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Persona } from '../types.js'
import { renderHtmlToPng } from '../lib/render-html.js'

/** Instagram crops profile pictures to a circle, so nothing lives in a corner. */
const AVATAR_CSS = `
  body { margin:0; background:transparent; font-family:-apple-system,BlinkMacSystemFont,
         'Segoe UI',Roboto,'DejaVu Sans',sans-serif; }
  .pfp { width:320px; height:320px; display:grid; place-items:center; position:relative;
         background:radial-gradient(circle at 32% 26%, var(--a), #101218 76%); }
  .mark { font-size:150px; font-weight:800; color:#fff; letter-spacing:-6px;
          text-shadow:0 6px 30px rgba(0,0,0,.4); line-height:1; }
  .ring { position:absolute; inset:18px; border-radius:50%;
          border:3px solid rgba(255,255,255,.28); }
`

export interface ProfileAssets {
  avatarPath: string
  bio: string
  handle: string
}

/**
 * The profile side of a persona: a picture and a bio that states outright that
 * the account is AI-generated. The disclosure is not decoration — the whole
 * approach depends on these creators being openly synthetic rather than
 * passing as people.
 */
export async function buildProfileAssets(persona: Persona, outDir: string): Promise<ProfileAssets> {
  await mkdir(outDir, { recursive: true })

  const avatarPath = join(outDir, `${persona.id}-pfp.png`)
  await renderHtmlToPng({
    html:
      `<style>${AVATAR_CSS}</style>` +
      `<div class="pfp" style="--a:${persona.visual.accent}">` +
      `<div class="ring"></div><div class="mark">${persona.name.slice(0, 1)}</div></div>`,
    selector: '.pfp',
    outPath: avatarPath,
    width: 320,
    scale: 2,
  })

  const bio = [
    'Virtual creator ✦ AI-generated',
    persona.thesis,
    persona.city,
  ].filter(Boolean).join('\n')

  await writeFile(join(outDir, `${persona.id}-bio.txt`), `${bio}\n`)
  return { avatarPath, bio, handle: persona.handle }
}
