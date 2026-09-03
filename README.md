# ai-creator

An autonomous system that creates, tests and scales internet personalities.

Phase 1 answers one question only: **can we take a virtual creator from zero to
real organic distribution?** Not a SaaS, not a posting bot, not a dashboard —
just enough machinery to put 30 videos in front of strangers and read the
result.

The experiment: 3 virtual creators × 10 Reels each, cross-posted to TikTok, run
for 7–14 days. The variables under test are `persona × niche × topic × hook ×
format`. The first milestone is a single video past 10k organic views; the
second is the same format doing it again.

## The format

An AI avatar reacting to real web pages. The avatar sits in a corner; the frame
is filled by actual footage of an Amazon listing, a Google Maps entry, a Product
Hunt launch — scrolling, pushing in on a price, spotlighting a one-star review.

This is the cheapest possible format that still looks intentional. No scene has
to be generated, because the web page *is* the B-roll, and it is more credible
than anything a video model would invent.

## Pipeline

```
topic → probe → script → B-roll → voiceover → avatar → assembly → review → publish → metrics
         └──────────────┘         └────────────────────────────┘      │        manual   manual
           authoring                       rendering                static page
```

`npm run make -- <topic.json>` runs the whole thing and drops a finished 9:16
mp4 plus a manifest. Every external service sits behind a provider, and each
provider has a stub, so **the pipeline runs end to end with no API keys** — the
shape of the result is real even when the voice is silence and the avatar is a
card.

One key covers the paid half: **`FAL_KEY`** drives both the voice and the
avatar. The vendor-specific keys are honoured when set and take precedence, but
only the fal path has been run against a live API.

| stage | with keys | without |
| --- | --- | --- |
| script | a hand-written `<topic>.script.json`, else Claude (`ANTHROPIC_API_KEY`) | rules over the page probe — formulaic but on-topic |
| voiceover | ElevenLabs, direct (`ELEVENLABS_API_KEY`) or via `FAL_KEY` | silence of the length the line takes to say |
| avatar | `FAL_KEY` + `AVATAR_TIER`, else HeyGen (`HEYGEN_API_KEY`) | a persona card in the same corner, same footprint |

`AVATAR_TIER` picks how much the face moves, and it is a 15× price difference:
`draft` (default) is SadTalker at roughly $0.05 a video — the mouth is in sync
but the head barely moves, which is fine while you are iterating on hooks.
`final` is Kling at roughly $0.75 — head turns, blinks, real expression range.
The difference is visible even at the 240px the corner actually uses, because
downscaling costs you sharpness and not motion.

```bash
npm install
npx playwright install chromium                    # not pulled in by npm install
npm run verify                                     # offline, covers the whole pipeline
npm run fixtures &                                 # serve the offline test page
npm run make -- topics/examples/nina-fan-hat.json
npm run review                                     # writes out/videos/index.html
```

### Writing a beat yourself

Drop `<topic>.script.json` next to a topic and the pipeline uses it instead of
a generator — `topics/examples/nina-fan-hat-authored.json` is the worked
example. It is the same shape the model emits (`beats[]` with `vo`, `caption`
and camera `actions`, plus `postCaption`), so you can fix one bad beat without
re-rolling the other three, and a hook that already works can be a fixed
control while the persona or the topic varies around it.

### Authoring vs rendering

The split that makes this work: **AI writes the spec, Playwright replays it.**

```
authoring   once per topic, slow and non-deterministic is fine
            probe the page → real selectors → script + camera plan

rendering   once per take, must be fast and identical every time
            spec → Playwright → frame-accurate footage
```

A vision agent driving the browser live would be the wrong tool for the second
half. The experiment holds format fixed and varies persona, topic and hook — if
the camera work changes on every run, there is no control group. It is also the
wrong tool for the first half's *output*: selectors drift, and the fix is to
re-run authoring and get new ones, not to re-derive them 30 times per video.

`npm run probe -- <url>` runs the authoring probe alone. It reports a headline,
a price, list items, quotes and section headings — each with a unique selector
and its rendered size — which is exactly what the script generator reasons over.

## What's here

`src/recorder` turns a **VisualSpec** — a JSON description of a page and how the
camera should move over it — into a 1080×1920 H.264 mp4. `src/authoring`
probes a page for anchors. `src/providers` wraps the three external services.
`src/pipeline` runs topic → video.

The point of the spec format is that the script generator emits it directly.
There is no human step translating "push in on the price" into browser
automation; the model writes the camera move next to the voiceover line it
belongs to.

```bash
npm run record -- specs/examples/product-amazon.json
npm run record -- specs/examples/*.json --out out/broll
```

Options: `--out <dir>`, `--url <url>` (retarget a spec at a different page),
`--keep-frames` (leave the raw jpegs next to the video to debug a bad shot).

### A spec

```json
{
  "id": "weird-hat",
  "url": "https://www.amazon.com/dp/...",
  "vo": "Amazon somehow sells this for twenty nine dollars.",
  "actions": [
    { "kind": "waitFor", "selector": "#productTitle" },
    { "kind": "wait", "ms": 800 },
    { "kind": "highlight", "selector": ".a-price", "style": "spotlight", "holdMs": 1100 },
    { "kind": "zoom", "selector": ".a-price", "fit": 0.7, "holdMs": 1000 },
    { "kind": "resetZoom" },
    { "kind": "scrollTo", "selector": "#feature-bullets", "durationMs": 1200 }
  ]
}
```

| action | what it does |
| --- | --- |
| `wait` / `waitFor` | hold on frame / block until a selector appears |
| `scrollTo` | smooth-scroll a target to the focus point, or to `top` |
| `scrollBy` | relative scroll — the "keep reading" shot |
| `zoom` | push in, either at a literal `scale` or a `fit` fraction of the frame |
| `resetZoom` | pull back out |
| `highlight` | `spotlight` (dim everything else) or `box` (red ring) |
| `hide` | drop page chrome that would ruin the shot |
| `hover` / `click` / `type` | drive the page |

Every field has a default; the full schema with per-field notes is
`src/recorder/schema.ts`.

Prefer `fit` over `scale`. `fit: 0.8` means "the target should fill 80% of the
frame" and derives the multiplier from the element's real text bounds, which is
what you want when the script generator has no idea how wide a headline is. A
target that already fills the frame logs a warning instead of silently
producing a zoom that does nothing.

### How it works

Frames come from CDP's screencast rather than Playwright's built-in video, for
two reasons: they arrive at the device pixel ratio, so a 432×768 @2.5 viewport
yields a true 1080×1920 with no upscaling; and each frame carries a timestamp,
so the concat list rebuilds exact timing instead of trusting a
variable-framerate webm. Chrome only emits a frame when the page repaints, so a
two-second hold costs one frame and stays two seconds long.

Camera moves are `requestAnimationFrame` tweens running inside the page
(`src/recorder/page-runtime.ts`), not stepped from Node, so motion is smooth.
The camera is a single transform on the root element anchored at the document
origin, which lets scale and pan compose without a jump between shots.

"Centre of frame" is 42% of the way down, not 50%: vertical video is always
captioned, and a subject framed at the true middle ends up under the text. For
the same reason the page gets empty padding appended below it, so an element
near the end of the document can still be scrolled up to the focus point.

Beat footage and beat voiceover are produced independently, so the camera plan
is stretched to the length of the line before the take (`src/pipeline/timing.ts`)
and the remainder is absorbed by trimming or a held last frame. Without that, a
long line over a short plan freezes for seconds — the most obvious tell that a
video was assembled rather than shot.

Before recording starts the page is scrubbed: ad and analytics hosts blocked,
consent banners dismissed, CSS animations frozen, sticky headers unpinned, lazy
images forced to decode.

## Environment notes

- `CHROMIUM_PATH` — set when the environment ships a Chromium that doesn't match
  the installed Playwright's expected build. See `.env.example`.
- `HTTPS_PROXY` / `NO_PROXY` are passed through to Chromium automatically.
- Real-site specs need egress to those sites, and a residential IP: Amazon
  serves a captcha to datacenter ranges. Run those locally.
- `fixtures/product.html` plus the `nina-fan-hat` topic run the recorder *and*
  the full pipeline offline. That is what `npm run verify` uses.
- Selectors in the real-site examples will drift. They are starting points, not
  contracts — that is what the authoring probe is for.
- The ElevenLabs and HeyGen adapters are **written but never executed against a
  live API**; the vendor docs are not reachable from the environment they were
  written in. Verify the request shapes before the first paid run. Their error
  paths echo raw responses so a shape mismatch surfaces immediately.

## Deliberately not built

Per the phase-1 plan, and in a couple of cases permanently:

- **Automated account creation.** Instagram and TikTok both prohibit it, and
  several accounts created from one fingerprint get treated as a spam ring.
  Create them by hand — Instagram natively holds five per login, which covers
  phase 1 and most of phase 2.
- **Auto-posting.** Publishing is manual in phase 1 — the thing being validated
  is whether the content gets distribution, not whether an API can upload. The
  approval paths are slow, though: Instagram Reels publishing needs a
  Business/Creator account, a linked Facebook Page and `instagram_content_publish`
  review, and TikTok's Content Posting API can only post privately until an app
  audit clears. Start that paperwork on day one and it is ready when phase 2 is.
- **Dashboards, analytics ingestion, multi-account management, agent
  frameworks.** 30 videos fit in a spreadsheet; `npm run review` is one static
  page.

Every creator is labelled as AI-generated in bio, in caption and on the video
itself. The personas are fictional and presented as fictional — no impersonation
of real people.

**One constraint that shapes the scaling plan:** since April 2026 Meta's
original-content policy covers photos and carousels as well as Reels, and
posting the same file across several accounts is treated as duplication —
those accounts stop being eligible for algorithmic recommendation. Copying a
*format* across a forked account is fine; copying the *file* is not. This
pipeline regenerates every video from its own topic, which is the compliant
shape by construction, but it rules out the "render once, post everywhere"
shortcut.

## Next

1. Topic source adapters (Reddit, Hacker News, Product Hunt, Atlas Obscura) into
   a ranked queue, so topics come from real signals rather than by hand.
2. Word-level caption timing — the TTS provider returns per-word timestamps, and
   the caption renderer already takes a list.
3. Verify the HeyGen and ElevenLabs adapters against the live APIs, and pin each
   persona's avatar and voice ids into its bible.
4. A metrics sheet keyed by the manifest ids, so a winner can be traced back to
   its persona, hook, format and duration.
