import { z } from 'zod'
import { visualSpecBase } from './recorder/schema.js'

/** A creator's fixed identity. Everything downstream reads from this. */
export const persona = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  handle: z.string(),
  name: z.string(),
  /** One sentence saying why this account is worth following. Every script
   *  has to serve it — this is the content thesis. */
  thesis: z.string(),
  city: z.string().optional(),
  personality: z.array(z.string()).min(1),
  voice: z.object({
    pace: z.string(),
    tone: z.string(),
    saysOften: z.array(z.string()).default([]),
    neverSays: z.array(z.string()).default([]),
  }),
  visual: z.object({
    /** Drives the placeholder card, and later the HeyGen avatar. */
    accent: z.string().regex(/^#[0-9a-f]{6}$/i),
    hair: z.string().optional(),
    clothing: z.string().optional(),
  }),
  /** Provider-side voice/avatar ids, filled in once accounts exist. */
  providers: z.object({
    heygenAvatarId: z.string().optional(),
    elevenVoiceId: z.string().optional(),
  }).default({}),
})
export type Persona = z.infer<typeof persona>

/** A candidate subject, sourced from a real signal rather than brainstormed. */
export const topic = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9._-]*$/i),
  personaId: z.string(),
  title: z.string(),
  url: z.string().url(),
  source: z.string(),
  /** Why this is interesting — the raw material for the hook. */
  angle: z.string(),
  /** Facts the script may use. Keeps the model from inventing them. */
  facts: z.array(z.string()).default([]),
})
export type Topic = z.infer<typeof topic>

export const beat = z.object({
  role: z.enum(['hook', 'body', 'payoff']),
  /** The line the creator says over this shot. */
  vo: z.string(),
  /** The caption burned on screen. Defaults to the voiceover. */
  caption: z.string().optional(),
  /** How the camera covers the page for this line. `id` and `url` are filled
   *  in by the pipeline, so the script generator only writes the actions. */
  /** Validated fully once the pipeline has filled in the missing fields. */
  visual: visualSpecBase.partial({ id: true, url: true }),
})
export type Beat = z.infer<typeof beat>
/** What an author writes, before defaults are applied. Providers build this. */
export type BeatInput = z.input<typeof beat>

export const script = z.object({
  id: z.string(),
  personaId: z.string(),
  topicId: z.string(),
  beats: z.array(beat).min(2),
  /** The post caption, not the on-screen text. */
  postCaption: z.string(),
  hashtags: z.array(z.string()).default([]),
})
export type Script = z.infer<typeof script>
export type ScriptInput = z.input<typeof script>
