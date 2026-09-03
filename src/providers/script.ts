import Anthropic from '@anthropic-ai/sdk'
import type { Persona, Topic, Script, BeatInput } from '../types.js'
import { script as scriptSchema } from '../types.js'
import type { PageProbe } from '../authoring/probe.js'
import { log } from '../lib/log.js'

export interface ScriptProvider {
  readonly name: string
  generate(persona: Persona, topic: Topic, probe: PageProbe): Promise<Script>
}

/**
 * Rules over the probe. Writes serviceable, formulaic lines and a camera plan
 * that always covers the page's real anchors — enough to exercise the whole
 * pipeline and to see the format on screen, not enough to carry an account.
 * The real generator is the Anthropic one below.
 */
export class StubScriptProvider implements ScriptProvider {
  readonly name = 'stub'

  async generate(persona: Persona, topic: Topic, probe: PageProbe): Promise<Script> {
    const beats: BeatInput[] = [
      { role: 'hook', vo: hookLine(topic, probe), visual: { actions: hookActions(probe) } },
    ]

    // One body beat per fact, pinned to whichever anchor comes next.
    const anchors = [...(probe.bullets?.items ?? []), ...probe.quotes, ...probe.sections]
    topic.facts.slice(0, 2).forEach((fact, i) => {
      const anchor = anchors[Math.min(i, anchors.length - 1)]
      beats.push({
        role: 'body',
        vo: fact,
        visual: {
          actions: anchor
            ? [
                { kind: 'scrollTo', selector: anchor.selector, align: 'center', durationMs: 1000 },
                { kind: 'highlight', selector: anchor.selector, style: 'box', holdMs: 1200 },
              ]
            : [{ kind: 'scrollBy', dy: 700, durationMs: 1600, easing: 'linear' }],
        },
      })
    })

    const closer = probe.quotes.at(-1) ?? probe.bullets?.items.at(-1)
    beats.push({
      role: 'payoff',
      vo: topic.angle,
      visual: { actions: closerActions(closer) },
    })

    return scriptSchema.parse({
      id: `${topic.id}--${persona.id}`,
      personaId: persona.id,
      topicId: topic.id,
      beats,
      postCaption: `${topic.angle} ${persona.handle} · AI-generated virtual creator`,
      hashtags: [],
    })
  }
}

/** A target already filling the width has nowhere to zoom to — spotlight it. */
function canZoom(anchor: { width: number }, viewportWidth = 432): boolean {
  return anchor.width < viewportWidth * 0.8
}

function closerActions(closer: PageProbe['quotes'][number] | undefined): BeatInput['visual']['actions'] {
  if (!closer) {
    return [{ kind: 'scrollBy', dy: 500, durationMs: 1400 }, { kind: 'wait', ms: 900 }]
  }
  const actions: BeatInput['visual']['actions'] = [
    { kind: 'scrollTo', selector: closer.selector, align: 'center', durationMs: 1000 },
  ]
  if (canZoom(closer)) {
    actions.push(
      { kind: 'zoom', selector: closer.selector, fit: 0.9, durationMs: 650, holdMs: 1200 },
      { kind: 'resetZoom', durationMs: 380 },
    )
  } else {
    actions.push({ kind: 'highlight', selector: closer.selector, style: 'spotlight', holdMs: 1800 })
  }
  return actions
}

function hookLine(topic: Topic, probe: PageProbe): string {
  return probe.price ? `${topic.title}. ${probe.price.text}.` : `${topic.title}.`
}

/** Open on whatever the page makes loudest: a price, else the headline. */
function hookActions(probe: PageProbe): BeatInput['visual']['actions'] {
  const open: BeatInput['visual']['actions'] = [
    { kind: 'wait', ms: 900, comment: 'hero frame' },
  ]
  if (probe.price) {
    open.push(
      { kind: 'highlight', selector: probe.price.selector, style: 'spotlight', holdMs: 1000 },
      { kind: 'zoom', selector: probe.price.selector, fit: 0.62, durationMs: 650, holdMs: 800 },
      { kind: 'resetZoom', durationMs: 380 },
    )
  } else if (probe.headline) {
    open.push(
      { kind: 'zoom', selector: probe.headline.selector, fit: 0.88, durationMs: 700, holdMs: 1100 },
      { kind: 'resetZoom', durationMs: 380 },
    )
  } else {
    open.push({ kind: 'scrollBy', dy: 320, durationMs: 900 })
  }
  return open
}

const SYSTEM = `You write 10-25 second vertical video scripts for a disclosed AI-generated
virtual creator. You are given the creator's persona, a topic sourced from a real signal,
and a probe of the actual web page the footage will be shot from.

Rules:
- The first line is the hook. No wind-up, no greeting, no "in this video".
- Every claim must come from the supplied facts or the page probe. Invent nothing.
- Each beat gets camera actions that point at selectors from the probe. Never invent a selector.
- The last beat is an opinion or a payoff, in the persona's voice.
- Total voiceover across all beats: 35-70 words.
- Write in the persona's voice and never use their banned phrases.`

const EMIT_SCRIPT_TOOL: Anthropic.Tool = {
  name: 'emit_script',
  description: 'Return the finished script for this topic.',
  strict: true,
  input_schema: {
    type: 'object',
    additionalProperties: false,
    required: ['beats', 'postCaption', 'hashtags'],
    properties: {
      beats: {
        type: 'array',
        minItems: 3,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['role', 'vo', 'caption', 'actions'],
          properties: {
            role: { type: 'string', enum: ['hook', 'body', 'payoff'] },
            vo: { type: 'string', description: 'The spoken line for this beat.' },
            caption: { type: 'string', description: 'On-screen text. Usually the same as vo.' },
            actions: {
              type: 'array',
              minItems: 1,
              description:
                'Camera actions. Each is one of: {"kind":"wait","ms":N}; ' +
                '{"kind":"scrollTo","selector":S,"align":"center","durationMs":N}; ' +
                '{"kind":"scrollBy","dy":N,"durationMs":N}; ' +
                '{"kind":"zoom","selector":S,"fit":0.6-0.95,"durationMs":N,"holdMs":N}; ' +
                '{"kind":"resetZoom","durationMs":N}; ' +
                '{"kind":"highlight","selector":S,"style":"spotlight"|"box","holdMs":N}. ' +
                'Selectors must come from the page probe. Always resetZoom after a zoom.',
              items: { type: 'object', additionalProperties: true },
            },
          },
        },
      },
      postCaption: { type: 'string' },
      hashtags: { type: 'array', items: { type: 'string' } },
    },
  },
}

/** The real generator. Reads the probe, writes lines and camera moves together. */
export class AnthropicScriptProvider implements ScriptProvider {
  readonly name = 'anthropic'
  private readonly client = new Anthropic()

  async generate(persona: Persona, topic: Topic, probe: PageProbe): Promise<Script> {
    const response = await this.client.messages.create({
      model: 'claude-opus-5',
      max_tokens: 8000,
      thinking: { type: 'adaptive' },
      system: SYSTEM,
      tools: [EMIT_SCRIPT_TOOL],
      tool_choice: { type: 'tool', name: 'emit_script' },
      messages: [
        {
          role: 'user',
          content:
            `<persona>\n${JSON.stringify(persona, null, 2)}\n</persona>\n\n` +
            `<topic>\n${JSON.stringify(topic, null, 2)}\n</topic>\n\n` +
            `<page_probe>\n${JSON.stringify(probe, null, 2)}\n</page_probe>`,
        },
      ],
    })

    if (response.stop_reason === 'refusal') {
      throw new Error(`script generation refused: ${response.stop_details?.explanation ?? 'no reason given'}`)
    }

    const call = response.content.find(
      (block): block is Anthropic.ToolUseBlock => block.type === 'tool_use',
    )
    if (!call) throw new Error('model returned no emit_script call')

    const emitted = call.input as {
      beats: { role: string; vo: string; caption: string; actions: unknown[] }[]
      postCaption: string
      hashtags: string[]
    }

    return scriptSchema.parse({
      id: `${topic.id}--${persona.id}`,
      personaId: persona.id,
      topicId: topic.id,
      beats: emitted.beats.map((b) => ({
        role: b.role,
        vo: b.vo,
        caption: b.caption,
        visual: { actions: b.actions },
      })),
      postCaption: emitted.postCaption,
      hashtags: emitted.hashtags,
    })
  }
}

export function scriptProvider(): ScriptProvider {
  if (process.env.ANTHROPIC_API_KEY) return new AnthropicScriptProvider()
  log.warn('no ANTHROPIC_API_KEY — using the stub script provider (formulaic lines)')
  return new StubScriptProvider()
}
