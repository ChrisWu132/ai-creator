# Handoff — 2026-09-03

`README.md` explains what this thing is and how it works. This file is only
about the state of the work: what has actually been run, what turned out to be
wrong, and what is waiting on a decision.

## Goal

Phase 1 answers one question: **can a virtual creator get real organic
distribution?** 3 personas × 10 Reels, cross-posted to TikTok, 7–14 days. First
milestone is one video past 10k organic views; second is the same format doing
it again. Not a SaaS, not a posting bot.

Chris's hard requirements, settled over the build:

- A digital human is mandatory, and **the mouth has to move**.
- Voice quality first; picture quality can be bad.
- The agent writes the scripts itself — no `ANTHROPIC_API_KEY` needed.
- The figure is cut out, not a rectangle, and must not read as AI.

## Where it is

**The pipeline runs end to end against real APIs and produces a finished
video.** One exists: `out/final/nina-fan-hat-authored--nina.mp4` — 22s, Nina, a
solar fan hat, Kokoro voice, Kling avatar, cut out and standing on the page.

Repo is `github.com/ChrisWu132/ai-creator`; `main` and
`claude/new-repository-70l09q` are both at `a22b342`. Working tree clean.

To run it: `FAL_KEY` is **line 2 of the workspace root `.env`** (agents may read
it, never write it). `npm run fixtures` must be up for the fixture topics.
`AVATAR_TIER=final` is what ships.

```bash
npm run verify                                    # offline, no keys, must stay green
npm run make -- topics/examples/nina-fan-hat-authored.json --out out/final
```

`npx playwright install chromium` is not pulled in by `npm install` and the
recorder dies without it.

### Money

Chris topped up **$10 on 2026-09-03**; roughly **$2.6** of it is spent.

A finished video costs **$1.245**, and **99.3% of that is Kling**
($0.0562/s × 22s = $1.236). Kokoro is $0.008, the persona's green plate is
$0.018 once. Thirty videos ≈ $37.

**`.cache/` holds paid renders — deleting it means buying them again.** It is
gitignored, currently ~21MB.

## What worked

- **Cut the still, not the clip.** Matting the finished video is billed per
  second and cost more than the render it was matting — 46% of the bill. Cutting
  the *portrait* out once ($0.018), standing it on broadcast green, letting the
  avatar model generate against green, then keying locally in ffmpeg does the
  same job for nothing. Verified: Kling returns clean green and the key is
  clean through hair. **$37 saved across 30 videos.**
- **Content-hash caching of every paid step.** Re-running after a framing change
  cost $0 and 30 seconds instead of $1.24 and six minutes. This is worth more
  than any per-unit price.
- **Resuming an interrupted render.** The request is written to `.cache/` on
  submit and rejoined next run. Tested against the live API on all three
  branches: written on submit, rejoined when abandoned, recovered when the id
  is dead.
- **Kokoro over ElevenLabs v3** as the default voice — a fifth of the price, and
  the writing is what decides whether a line sounds human. `TTS_MODEL=eleven`
  still buys v3 when a take needs a `[laughs]`.
- **FLUX Krea for portraits.** `flux/schnell` is distilled and produces the
  poreless, symmetric AI face; Krea is trained specifically against that.
- **Writing the script like speech.** Fragments, self-interruption, "you know",
  an ellipsis that becomes a breath. Half of "sounds like TTS" is the script
  being too tidy, and no engine fixes that.

## What did not work

Do not re-try these.

- **Bria *video* background removal.** Works, but costs more than the render.
  Also: `webm_vp9` comes back `yuv420p` with the transparency flattened to
  white — $1.63 burned before noticing. Only `mov_proresks` carries alpha.
  Superseded entirely by the green plate.
- **Padding the plate to hide the frame edge.** The hard edge is *in the source
  photo* — the selfie's frame cuts through her arms, and Bria faithfully cuts
  out the clipped body. Padding the canvas just moves the edge inward.
- **Cropping the composite to head-and-shoulders** (`cropTop`, now removed).
  Correct for SadTalker, which inherits the portrait's tight crop; wrong for
  Kling, which reframes into a bust with air around it — cropping it left a
  floating head.
- **Probing fal's status endpoint to validate a resume note.** A request fal has
  forgotten answers **200 on its status and only 404s on its result**, so the
  probe passes and the collection fails, leaving the note in place to fail
  every future run forever. The only honest test is trying to collect it.
- **The HeyGen provider.** Structurally broken, not merely unverified: it sends
  the literal string `'...'` as the script, discards the voiceover, and passes
  an ElevenLabs voice id to HeyGen. It also takes precedence over the fal path.
  Left in tree, marked `BROKEN` in its doc comment.
- **The Anthropic key on line 1 of the root `.env`** returns 401. Moot — Chris's
  decision is that the agent writes the scripts.

Environment traps already paid for: Node's fetch gives up at 300s so long
renders must use fal's queue; Node 22 refuses to spawn `.cmd`, so run CLIs as
`node --import tsx`; `new URL().pathname` on Windows yields `/C:/...` and 403'd
every fixture request; fal rejects data URIs for audio, so files go through
storage first.

## Next steps

**Two questions are open with Chris and nothing should be spent until he
answers:**

1. **Kling LipSync plate reuse** — `kling-video/lipsync/audio-to-video` is
   $0.014/s against the avatar model's $0.0562/s. Render one talking plate per
   persona, then lip-sync new audio onto it: **$1.24 → $0.31 a video, $37 → $12
   for the experiment.** Untested. Risk: identical body motion across all 10
   videos of a persona may read as a loop. Costs ~$1 to find out.
2. **The face still reads slightly uncanny** (Chris, 2026-09-03). Three causes,
   none of them code: the portrait's expression is flat and faintly unhappy and
   a still-driven avatar can only interpolate from it; the gaze is locked to
   camera; and Kling invents a blue-grey object near her hands that the key
   cannot remove. The cheap fix is a new portrait — relaxed, engaged, mid-shot —
   for $0.03 plus $1.24 to re-render, which also kills the blue artifact and the
   draft-tier framing problem. **The cost is that the face changes**, and Chris
   reacted positively to the current one.

Then, in rough order:

3. Decide whether to fix or delete the HeyGen and direct-ElevenLabs paths. As
   written, setting `HEYGEN_API_KEY` silently produces a worse video.
4. Write the practical multi-profile procedure into `docs/accounts.md`. The doc
   covers creating one Business account per persona and the Meta app wiring, but
   not how to *operate* several without tripping spam heuristics. Instagram
   holds five per login natively, which covers phase 1. **Do not automate
   account creation** — both platforms prohibit it and Chris was told so.
5. `.env.example` is stale and **agents cannot write any `.env*`** — the hook
   refuses with no escape hatch. It needs `FAL_KEY`, `AVATAR_TIER`, `TTS_MODEL`,
   `NO_CACHE` added by hand.
6. Everything in the README's own "Next" list: topic source adapters, word-level
   caption timing, a metrics sheet keyed by manifest ids.

## Things that will bite you

- `tmp/check-alpha.ts` and `tmp/check-resume.ts` verify the two riskiest paths —
  alpha compositing and render resumption — and `tmp/` is gitignored, so they do
  not survive a clone. Neither is wired into `npm run verify`.
- `.cache/` has no eviction. ~400MB by the end of 30 videos.
- The ProRes intermediate is ~1GB for a 22s clip. It lives in the work directory
  and is deleted with it unless `--keep-work` is passed.
