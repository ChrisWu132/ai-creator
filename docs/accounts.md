# Account setup

Three accounts, roughly 40 minutes. Do it once, correctly — every step here
exists because skipping it breaks something silently later.

`npm run accounts -- check` is the source of truth. Work until all three read
`api-ready`.

## Why this is manual

Instagram and TikTok both prohibit programmatic signup, and accounts minted in
a batch from one fingerprint get actioned as a group rather than individually.
There is no tooling in this repo for automated registration and there will not
be. Three accounts by hand is half an hour; the ban risk of the alternative is
the entire experiment.

Phase 1 needs three. Instagram natively holds five accounts per login, so the
account count is not the constraint anyone thinks it is.

## The two things people get wrong

**Business, not Creator.** Reels publishing through the Graph API works only
with Instagram *Business* accounts. Creator accounts get insights and comment
moderation but are rejected for content publishing. Most "set up your creator
account" advice points the wrong way for this use case.

**App review is not required.** To post to accounts you control, keep the Meta
app in development mode and give each account the *Instagram Tester* role. The
2–4 week review only starts when other people's accounts connect to your app.
Nothing here needs it.

## Order of operations

Do these in order — the professional switch asks for the Page, so the Page has
to exist first.

### 1. Identities

Each account needs its own email. A domain you own with catch-all addressing is
cleanest; one inbox, three addresses, no aliasing rules to trip over.

Handles are in the persona bibles (`personas/*.json`). Reserve all three before
building anything on them.

### 2. Facebook Page per persona

One Page each, named for the persona. It never needs content — it exists so the
Graph API has something to hang the Instagram account off.

### 3. Instagram account per persona

Create the account, then: Settings → Account type and tools → Switch to
professional → **Business** → link the Page from step 2.

Set the profile picture and bio from `npm run accounts -- assets`, which writes
`out/profiles/`. The bio states the account is AI-generated; keep that line.

### 4. Meta app, in development mode

One app covers all three accounts.

- Add the Instagram product, request `instagram_basic` and
  `instagram_content_publish`.
- App roles → Roles → add each account as an **Instagram Tester**.
- Accept each invite from the account itself: Settings → Website permissions →
  Tester invites.

### 5. Record the ids

Graph API Explorer:

```
GET /me/accounts                                  → the Page ids
GET /{page-id}?fields=instagram_business_account  → the IG user id
```

Put them in `accounts/<persona>.json`, flip `accountType` to `business` and
`testerRoleAccepted` to true, then re-run the check.

### 6. TikTok

Reserve the handles. TikTok's Content Posting API only posts privately until an
app audit clears, so cross-posting is a manual upload in phase 1. That is fine —
the same file must not go to both platforms anyway (see below).

## Publishing limits and one policy that shapes everything

The Graph API allows 100 published posts per rolling 24 hours per account —
far above anything phase 1 will do.

Since April 2026 Meta's original-content policy covers photos and carousels as
well as Reels, and **posting the same file across several accounts is treated as
duplication**: those accounts lose eligibility for algorithmic recommendation.
Copying a winning *format* to a new account is fine. Copying the *file* is not.
The pipeline regenerates every video from its own topic, so it is the right
shape by construction — but it does rule out render-once-post-everywhere.

## Disclosure

Every account says it is AI-generated in the bio, in the post caption, and on
the video itself. The personas are fictional and presented as fictional. This is
not a compliance checkbox to optimise away — an account that gets caught passing
a synthetic creator off as a person loses the account and the format with it.

## Still placeholder

`out/profiles/*.png` are monogram cards. A real persona needs a consistent face
across every video and its profile picture — that comes from the avatar provider
once `providers.heygenAvatarId` is filled in, and the profile picture should be
a still from the same character.
