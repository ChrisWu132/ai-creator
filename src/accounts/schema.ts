import { z } from 'zod'

/**
 * What a live account needs before the pipeline can publish to it.
 *
 * Accounts are created by hand — Instagram and TikTok both prohibit
 * programmatic signup, and several accounts minted from one fingerprint get
 * treated as a spam ring. What is worth automating is making sure each one was
 * set up in the exact shape the publishing API requires, because the failure
 * mode is silent until you try to post.
 */
export const account = z.object({
  personaId: z.string(),
  handle: z.string().regex(/^@[a-z0-9._]+$/, 'handle must look like @name'),

  instagram: z.object({
    /** Reels publishing requires a Business account. Creator accounts are
     *  accepted for insights but rejected for content publishing — the single
     *  most common way this setup goes wrong. */
    accountType: z.enum(['personal', 'creator', 'business']).default('personal'),
    /** Business accounts must be linked to a Facebook Page. */
    facebookPageId: z.string().optional(),
    /** The IG user id the Graph API addresses, not the handle. */
    igUserId: z.string().optional(),
    /** The app stays in development mode; the account needs the Tester role on
     *  it. That is what makes app review unnecessary for own-account posting. */
    testerRoleAccepted: z.boolean().default(false),
  }).default({}),

  tiktok: z.object({
    username: z.string().optional(),
    /** Unaudited apps can only post privately, so this gates real publishing. */
    contentPostingAudited: z.boolean().default(false),
  }).default({}),

  notes: z.string().optional(),
})
export type Account = z.infer<typeof account>

export interface Gap {
  severity: 'blocker' | 'todo'
  what: string
  action: string
}

/** Everything standing between this record and a published Reel. */
export function gaps(record: Account): Gap[] {
  const found: Gap[] = []
  const ig = record.instagram

  if (ig.accountType !== 'business') {
    found.push({
      severity: 'blocker',
      what: `Instagram account is ${ig.accountType}, not business`,
      action:
        'Instagram app → Settings → Account type and tools → Switch to professional → ' +
        'Business (NOT Creator — Creator accounts cannot publish Reels via the API)',
    })
  }
  if (!ig.facebookPageId) {
    found.push({
      severity: 'blocker',
      what: 'no Facebook Page linked',
      action:
        'Create a Facebook Page for the persona and link it during the professional-account ' +
        'switch, then record its id here',
    })
  }
  if (!ig.igUserId) {
    found.push({
      severity: 'blocker',
      what: 'no Instagram user id recorded',
      action:
        'Graph API Explorer → GET /me/accounts → GET /{page-id}?fields=instagram_business_account ' +
        '→ copy the id into instagram.igUserId',
    })
  }
  if (!ig.testerRoleAccepted) {
    found.push({
      severity: 'blocker',
      what: 'Instagram Tester role not accepted',
      action:
        'Meta app dashboard → App roles → Roles → add the account as an Instagram Tester, then ' +
        'accept the invite from the account itself (Settings → Website permissions → Tester invites). ' +
        'With this, the app stays in development mode and needs no app review to post to itself',
    })
  }

  if (!record.tiktok.username) {
    found.push({ severity: 'todo', what: 'no TikTok account', action: 'Reserve the handle; cross-posting is manual in phase 1' })
  } else if (!record.tiktok.contentPostingAudited) {
    found.push({
      severity: 'todo',
      what: 'TikTok Content Posting API not audited',
      action: 'Unaudited apps can only post privately. Manual upload until the audit clears',
    })
  }

  return found
}

export function readiness(record: Account): 'api-ready' | 'manual-only' | 'not-created' {
  const blockers = gaps(record).filter((g) => g.severity === 'blocker')
  if (!blockers.length) return 'api-ready'
  if (record.instagram.accountType === 'personal') return 'not-created'
  return 'manual-only'
}
