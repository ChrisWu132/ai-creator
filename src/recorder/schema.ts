import { z } from 'zod'

/**
 * A VisualSpec is what the script generator emits alongside the voiceover for
 * one beat of a video. It says which page to open and how the camera should
 * move over it, so there is no human translation step between "write the
 * script" and "record the footage".
 */

export const easing = z.enum(['linear', 'easeInOut', 'easeOut'])
export type Easing = z.infer<typeof easing>

const base = { comment: z.string().optional() }

export const action = z.discriminatedUnion('kind', [
  /** Hold on whatever is currently on screen. */
  z.object({ ...base, kind: z.literal('wait'), ms: z.number().int().positive() }),

  /** Block until a selector shows up (does not consume screen time by itself). */
  z.object({
    ...base,
    kind: z.literal('waitFor'),
    selector: z.string(),
    timeoutMs: z.number().int().positive().default(15_000),
  }),

  /** Hide page chrome that would ruin the shot (cookie bars, sticky headers). */
  z.object({ ...base, kind: z.literal('hide'), selectors: z.array(z.string()).min(1) }),

  /** Smooth-scroll so a target sits at `align` in the viewport. */
  z.object({
    ...base,
    kind: z.literal('scrollTo'),
    selector: z.string().optional(),
    y: z.number().optional(),
    align: z.enum(['top', 'center']).default('center'),
    durationMs: z.number().int().nonnegative().default(900),
    easing: easing.default('easeInOut'),
  }),

  /** Relative smooth scroll — the "keep reading" shot. */
  z.object({
    ...base,
    kind: z.literal('scrollBy'),
    dy: z.number(),
    durationMs: z.number().int().nonnegative().default(900),
    easing: easing.default('linear'),
  }),

  /** Push in on a detail (a price, a headline, a review count). */
  z.object({
    ...base,
    kind: z.literal('zoom'),
    selector: z.string().optional(),
    /** Literal magnification. */
    scale: z.number().min(1).max(6).optional(),
    /** Or: how much of the frame the target should fill (0-1). Derives the
     *  scale from the element's real size, which is what you actually want
     *  for a push-in on text of unknown width. Requires `selector`. */
    fit: z.number().min(0.1).max(1).optional(),
    durationMs: z.number().int().nonnegative().default(700),
    holdMs: z.number().int().nonnegative().default(0),
  }),

  z.object({
    ...base,
    kind: z.literal('resetZoom'),
    durationMs: z.number().int().nonnegative().default(500),
  }),

  /** Draw attention without moving the camera. */
  z.object({
    ...base,
    kind: z.literal('highlight'),
    selector: z.string(),
    style: z.enum(['box', 'spotlight']).default('spotlight'),
    holdMs: z.number().int().nonnegative().default(900),
    /** Leave it on screen for the following actions instead of clearing. */
    keep: z.boolean().default(false),
  }),

  z.object({ ...base, kind: z.literal('clearHighlight') }),

  z.object({ ...base, kind: z.literal('hover'), selector: z.string() }),

  z.object({
    ...base,
    kind: z.literal('click'),
    selector: z.string(),
    waitAfterMs: z.number().int().nonnegative().default(1200),
  }),

  z.object({
    ...base,
    kind: z.literal('type'),
    selector: z.string(),
    text: z.string(),
    delayMs: z.number().int().nonnegative().default(60),
    pressEnter: z.boolean().default(false),
  }),
])
export type Action = z.infer<typeof action>

const visualSpecShape = z.object({
  /** Stable id — becomes the output filename. */
  id: z.string().regex(/^[a-z0-9][a-z0-9._-]*$/i, 'id must be filename-safe'),
  url: z.string().url(),

  /** Voiceover this footage sits under. Not used by the recorder; carried
   *  through so one JSON file fully describes a beat. */
  vo: z.string().optional(),

  /** CSS-pixel viewport. Default is a plausible phone at 9:16. */
  viewport: z.object({ width: z.number().int(), height: z.number().int() })
    .default({ width: 432, height: 768 }),
  /** Device pixel ratio. 432x768 @2.5 lands exactly on 1080x1920. */
  scale: z.number().min(1).max(4).default(2.5),
  fps: z.number().int().min(15).max(60).default(30),

  /** Where the camera treats as the middle of frame, as a fraction of height.
   *  Below 0.5 leaves room at the bottom for burned-in captions. */
  focusY: z.number().min(0.2).max(0.8).default(0.42),

  /** Hard stop, so a hung page can never eat the whole render budget. */
  maxDurationMs: z.number().int().positive().default(60_000),

  prepare: z.object({
    waitUntil: z.enum(['load', 'domcontentloaded', 'networkidle']).default('load'),
    /** Extra settle time after load, for lazy images and web fonts. */
    settleMs: z.number().int().nonnegative().default(1200),
    /** Best-effort cookie/consent dismissal before recording starts. */
    dismissBanners: z.boolean().default(true),
    /** Drop ad and analytics requests. Faster, and keeps ads out of frame. */
    blockAds: z.boolean().default(true),
    hideSelectors: z.array(z.string()).default([]),
    /** Stop CSS animations and GIFs from adding noise to the encode. */
    freezeAnimations: z.boolean().default(true),
    /** Append empty space below the page so elements near its end can still
     *  be scrolled up to the focus point. */
    scrollPadding: z.boolean().default(true),
  }).default({}),

  actions: z.array(action).min(1),
})

/** The object form, for callers that need `.partial()` — a spec under
 *  construction, before the pipeline fills in `id` and `url`. */
export const visualSpecBase = visualSpecShape

export const visualSpec = visualSpecShape.superRefine((spec, ctx) => {
  // `.refine` on a union member would erase the discriminant, so the one
  // cross-field rule lives here instead.
  spec.actions.forEach((a, i) => {
    if (a.kind === 'scrollTo' && a.selector === undefined && a.y === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['actions', i],
        message: 'scrollTo needs either `selector` or `y`',
      })
    }
    if (a.kind === 'zoom') {
      if ((a.scale === undefined) === (a.fit === undefined)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['actions', i],
          message: 'zoom needs exactly one of `scale` or `fit`',
        })
      }
      if (a.fit !== undefined && a.selector === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['actions', i],
          message: 'zoom with `fit` needs a `selector` to measure',
        })
      }
    }
  })
})
export type VisualSpec = z.infer<typeof visualSpec>

export function parseSpec(input: unknown): VisualSpec {
  return visualSpec.parse(input)
}
