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
  topic sourcing  →  ranking  →  script  →  web B-roll  →  VO + avatar  →  assembly  →  review  →  publish  →  metrics
        ·              ·           ·        ◄ built ►         ·              ·           ·         manual      manual
```

Only the recorder exists today. It is the piece with the most technical risk and
the one that decides whether the format is viable at all, so it went first.

## What's here

`src/recorder` turns a **VisualSpec** — a JSON description of a page and how the
camera should move over it — into a 1080×1920 H.264 mp4.

The point of the spec format is that the script generator emits it directly.
There is no human step translating "push in on the price" into browser
automation; the LLM writes the camera move next to the voiceover line it belongs
to, and the recorder executes it.

```bash
npm install
npm run verify                                    # offline end-to-end check
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
| `scrollTo` | smooth-scroll a target to `center` or `top` |
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
what you want when the script generator has no idea how wide a headline is.

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

Before recording starts the page is scrubbed: ad and analytics hosts blocked,
consent banners dismissed, CSS animations frozen, sticky headers unpinned, lazy
images forced to decode.

## Environment notes

- `CHROMIUM_PATH` — set when the environment ships a Chromium that doesn't match
  the installed Playwright's expected build. See `.env.example`.
- `HTTPS_PROXY` / `NO_PROXY` are passed through to Chromium automatically.
- Real-site specs need egress to those sites. The `fixture-product` spec runs
  fully offline against `fixtures/product.html`, which is what `npm run verify`
  uses.
- Selectors in the real-site examples will drift. They are starting points, not
  contracts.

## Deliberately not built

Per the phase-1 plan, and in a couple of cases permanently:

- **Automated account creation.** Instagram and TikTok both prohibit it, and
  three accounts created from one fingerprint get treated as a spam ring. Create
  the accounts by hand.
- **Auto-posting.** Publishing is manual in phase 1 — the thing being validated
  is whether the content gets distribution, not whether an API can upload. That
  said, the approval paths are slow: Instagram Reels publishing needs a
  Business/Creator account, a linked Facebook Page and `instagram_content_publish`
  review, and TikTok's Content Posting API can only post privately until an app
  audit clears. Start that paperwork on day one and it'll be ready when phase 2 is.
- **Dashboards, analytics ingestion, multi-account management, agent
  frameworks.** 30 videos fit in a spreadsheet.

Every creator is labelled as AI-generated in bio and captions. The personas are
fictional and presented as fictional — no impersonation of real people.

## Next

1. Persona Bibles for the three creators as structured files the script
   generator loads.
2. Topic source adapters (Reddit, Hacker News, Product Hunt, Atlas Obscura) into
   a ranked queue.
3. Script generation emitting `{ vo, visual }` beats — the recorder already
   consumes the `visual` half.
4. VO + avatar (HeyGen), then assembly and a static review page.
