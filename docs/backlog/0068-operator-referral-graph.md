---
id: 0068
title: Operator-to-operator referral graph - each operator declares who introduced them to fleet-control and their public profile shows "introduced N operators" so every share becomes a measurable acquisition node and the strongest evangelists get rewarded with a visible downstream tree
status: groomed
priority: P1
area: portal
created: 2026-06-19
owner: gtm-innovation
---

## User story

As a fleet operator who shared my /pulse and /operator/<handle> URLs in
three Slack threads last quarter, watched two friends install
fleet-control on my recommendation, and now wants the same compounding
viral surface my favourite open-source projects have (npm's "weekly
downloads", GitHub's "starred by N other repos you watch"), I want a
single optional config field `operator.referredBy` that NAMES the
upstream operator who introduced me, AND a public page
`/referrals/<handle>` that renders an anonymised one-level downstream
tree ("3 operators have credited <handle> as their fleet-control
introduction since 2026-01-01"), AND a new stat block on
`/operator/<handle>` reading "introduced N operators to fleet-control"
that links to `/referrals/<handle>`, so that I get an explicit growth
counter for the people I have onboarded and the operator who first
told me about fleet-control gets visible credit they can paste back
into their own LinkedIn — turning every share into a measurable
acquisition node instead of a one-way silent impression.

## Why now (four lenses)

### Product Owner

0065 ships the operator profile. 0067 ships the paste-ready CLI
blurb. 0061 ships the OG image. Every existing acquisition surface
is ONE-WAY: the operator shares, a reader installs, and the
operator never knows whether the share landed. Today the operator
who introduced 3 friends to fleet-control has zero feedback that
this happened — and the 3 friends have no way to thank them
publicly or close the loop.

The smallest meaningful unit of value: ONE optional config field
+ ONE public page + ONE stat block on the existing profile page.

1. Config: `operator.referredBy?: { handle: string,
   acknowledgedAt: string }`. The new operator sets `handle` to
   the upstream operator's handle and `acknowledgedAt` to the
   ISO date they decided to credit them. The field is OPTIONAL —
   an operator who installed from a search engine simply omits
   it. The field is OPERATOR-AUTHORED: there is no central
   registry, no handshake, no peer-to-peer call. The new
   operator's decision to credit upstream is purely a config
   line they choose to write.

2. New public page `/referrals/<handle>` reads every snapshot
   row of kind `referral_ack` whose payload `.upstream === handle`
   and renders the count + anonymised tile per downstream
   operator (downstream handles are HASHED unless the downstream
   operator also published a `referredBy` ack pointing at the
   upstream with `payload.consentPublicCredit: true` — in which
   case the downstream handle is rendered in full so the chain
   is browseable).

3. Issuing a ref ack: when the new operator's local
   fleet-control loads with `operator.referredBy.handle` set, the
   daemon (per LESSONS 2026-06-05 on globalThis invalidation
   hooks) writes ONE local snapshot row of kind `referral_ack`
   carrying `{ upstream: <handle>, downstream: <localHandle>,
   acknowledgedAt, consentPublicCredit: bool }`. The row is
   LOCAL to the new operator's DB — there is no network call to
   the upstream operator's instance. The upstream operator's
   `/referrals/<handle>` page is therefore a LOCAL VIEW of the
   upstream operator's OWN referrals — but the v1 surface
   recognises that an operator can only see referrals from
   downstream operators who push their referral_ack snapshot
   payload into the upstream operator's instance (via a future
   federation ticket — out of scope for v1; v1 is single-
   instance so the upstream operator's `/referrals/<handle>`
   surfaces ONLY the rows the upstream operator's own DB
   carries, which the v1 helper composes from `pr.author`
   matches against the operator handle as a proxy).

PRODUCER-VS-SPEC NOTE: the v1 visible-graph implementation uses
`pr.author` matches on the upstream operator's local DB as the
PROXY for downstream operators. The upstream operator who
introduced 3 friends to fleet-control will see those 3 friends
as `pr.author` rows ONLY IF they collaborated on the same
project (the upstream sees the downstream's PRs). The "no
upstream-side data" case fallback: the upstream operator who
introduced 3 friends to OTHER projects sees 0 referrals in v1
— and the helper renders the empty-state copy "no referrals
visible from this instance yet — referrals appear when a
downstream operator opens a PR on a project this fleet
ingests". The empty state is honest, not misleading.

Per LESSONS 2026-06-13 the helper lives in `src/views.ts`
alongside `operatorProfilePayload` (no new module, no cycle
risk).

Per LESSONS 2026-06-15 on first-meaningful-month pivots —
the empty-state branch fires when the operator has 0
referral_ack rows visible AND the operator's `since_date` is
< 3 months old (a "your fleet is too new to have seeded
referrals yet" framing). Older operators with 0 visible
referrals get the "no referrals visible from this instance"
honest empty state.

### Stakeholder

Widens the moat on the EVANGELIST-LOOP axis. Hosted SaaS
observability tools have no notion of "operator A introduced
operator B" because they don't have a stable operator handle
the network browses around. fleet-control's `/operator/<handle>`
is already the stable handle. Adding the referral graph turns
the handle into a NODE in a graph the network can browse —
which is how every viral developer tool (npm packages, GitHub
stars, Bluesky follows) compounds.

The hosted-competitor structural gap: a hosted tool COULD add a
"refer a friend" feature, but it would have to be a TRACKED
LINK (UTM params, server-side join) that the operator clicks
to share. That's a separate funnel, not the operator's natural
share surface. fleet-control's referral is just a config field
the new operator writes; no link tracking, no funnel.

The "show me" moment worth a screenshot: the upstream
operator's `/operator/mutaaf` page renders "introduced 4
operators to fleet-control" with the link to `/referrals/
mutaaf`. The reader clicks; sees 4 anonymised tiles ("operator
since 2026-03-01 — 23 PRs shipped"); thinks "I want to be on
this tree"; installs fleet-control with `referredBy: mutaaf`.

Pairs with 0065 (operator profile - the new stat block lives
on the existing page), 0067 (share CLI - the new operator's
first share might include their referral chain), 0064 (rate-
limit - the new public route inherits the throttle).

### User (operator at 9am, looking at the portal)

Three operator scenarios:

1. **The new operator installing because of a friend** (one-
   time setup, < 60 seconds): the new operator edits their
   `fleet-control.config.json` to add
   `operator.referredBy: { handle: "mutaaf",
   acknowledgedAt: "2026-06-19", consentPublicCredit: true }`.
   Restarts the server. On next portal load, a small toast
   confirms "credit recorded — your install is now counted
   against mutaaf's introductions". The toast is INFORMATIONAL;
   the operator does nothing else.

2. **The upstream operator's daily glance** (zero impact): the
   home page is UNCHANGED. The `/operator/<handle>` stat block
   grows ONE new "introduced N" line per the existing profile
   layout. No new home-page card; this is portfolio-shaped
   data that lives on the portfolio surface.

3. **The browse moment** (the high-leverage acquisition
   moment): a cold reader on LinkedIn clicks the operator's
   profile URL, sees "introduced 4 operators", clicks through
   to `/referrals/mutaaf`, sees 4 tiles. They click into one
   of the downstream handles whose owner consented to public
   credit, sees that operator's profile, then clicks "install
   yours" on either page. The graph itself is the demo.

Per LESSONS 2026-06-11 the renderer-direct seam
`_renderReferralGraphForTests(payload, opts)` exercises the
consent / empty-state / age branches without cwd config
mutation. The boot-path test exercises the integration shape
(route mounted before /api/, content-type, og meta tags).

### Growth

The growth bet: every operator profile becomes a NODE in a
LIGHTWEIGHT GRAPH. The "introduced N operators" number is the
single most clickable line on the profile page (humans are
wired to click "N other things" links — the same instinct that
drives "starred by 30k repos" on GitHub). Per the cross-fleet
courtiq lesson "every share is a node; every credit is an
edge; the operator's profile becomes more valuable as the
graph grows" (CROSS_LESSONS section courtiq Entries 2026-05-
21 family on attribution-as-acquisition), the referral
surface is the first time fleet-control invests in EDGES
between operators rather than NODES alone.

A subtle moat property: the referral graph cannot be
back-filled by a competitor. An operator who has been on
fleet-control for 12 months and introduced 7 friends has a
"7" on their profile that a NEW competing tool's profile
cannot show even if the same operator switches — because the
edges live in the LOCAL DB the operator has been accumulating.
Accumulated history IS the moat.

Pairs with 0065 (operator profile), 0067 (share CLI), 0064
(rate-limit), 0061 (OG infra - the existing OG card
COULD grow a "introduced N" line in a future ticket, out of
scope here).

## Acceptance criteria

Each box maps 1:1 to a test scenario.

- [ ] New optional config field `operator.referredBy: {
      handle: string, acknowledgedAt: string,
      consentPublicCredit?: boolean }` in
      `src/config.ts`'s `FleetConfig.operator` shape. Defaults:
      undefined for the field as a whole;
      `consentPublicCredit` defaults to `false` so an operator
      who sets the field without thinking about consent stays
      anonymised in the upstream's `/referrals/<handle>`
      page. Test: load a config with `operator.referredBy:
      { handle: "mutaaf", acknowledgedAt: "2026-06-19" }`;
      assert `loadConfig()` returns the field populated AND
      `consentPublicCredit === false` by default.

- [ ] New helper `referralGraphPayload(db, cfg, handle, now)`
      in `src/views.ts` returns `{ handle, totalIntroduced:
      number, since: string | null, tiles: [{ handleAnon:
      string, displayHandle: string | null, sinceDate: string,
      prsShipped: number, consentPublicCredit: boolean }],
      asOf: string, version: 1 }`. The helper composes the
      tiles from `snapshot` rows where `kind = 'referral_ack'`
      AND `payload.upstream === handle`. PRODUCER-VS-SPEC
      NOTE per LESSONS 2026-06-05: grep `src/snapshot.ts` for
      the existing `payload_json` column name and the
      `kind` discriminator literal so the SELECT matches
      producer casing. The `handleAnon` field is the
      SHA-256-hex first 8 chars of the downstream handle
      (stable per downstream so a reload renders the same
      placeholder). `displayHandle` is non-null ONLY when
      `payload.consentPublicCredit === true`. Test: seed 3
      `referral_ack` snapshot rows with mixed consent values
      (true, false, true); assert `totalIntroduced === 3`,
      `tiles.length === 3`, the 2 consented tiles have
      `displayHandle` populated and the 1 anonymous tile has
      `displayHandle === null`.

- [ ] New helper `recordReferralAck(db, cfg, now)` in
      `src/views.ts` writes ONE `referral_ack` snapshot row
      per local startup when `cfg.operator?.referredBy
      ?.handle` is set AND no prior ack with the same
      `(upstream, downstream)` exists in the DB. Idempotent
      on subsequent startups. The helper is called from
      `src/server.ts` on startup (per the existing
      `__fleet_operator_profile_invalidate__` registration
      pattern per LESSONS 2026-06-05). The snapshot.kind is
      the literal `'referral_ack'`. The payload_json carries
      `{ upstream, downstream, acknowledgedAt,
      consentPublicCredit, version: 1 }`. The snapshot row's
      `name` is `referral-ack-<upstream>-<downstream>` (so
      `snapshot list` surfaces it readably). The snapshot
      row's `expires_at` is `acknowledgedAt + 100 years` (the
      ack is intentionally long-lived; the operator revokes
      it manually if they want to retract). Test: seed cfg
      with referredBy + a fresh DB; call
      `recordReferralAck`; assert ONE `referral_ack` row
      lands. Call again; assert STILL one row. Update
      cfg.consentPublicCredit; call again; assert the
      payload's consentPublicCredit was UPDATED in-place
      (re-INSERT-OR-REPLACE by the (upstream, downstream)
      tuple).

- [ ] New public route `GET /referrals/<handle>` in
      `src/server.ts` renders the graph page when the handle
      is non-empty (the route does NOT require the visitor
      to BE the upstream operator — anyone can browse the
      page; the consent gate on `displayHandle` protects
      anonymity). 404s when the rendered payload has
      `totalIntroduced === 0` AND the upstream operator's
      `cfg.operator?.handle !== handle` (a stranger
      browsing a non-existent referral graph gets 404; the
      upstream operator browsing their own empty graph
      gets a 200 with the honest empty-state copy). Route
      is mounted BEFORE the `/api/` auth gate per LESSONS
      2026-06-15 (the ordering grep anchors on
      `if (path.startsWith("/api/"))` NOT a comment). Test:
      hit `/referrals/mutaaf` with 0 seeded acks and
      `cfg.operator.handle = 'mutaaf'`; assert 200 + the
      empty-state copy. Hit `/referrals/stranger` with 0
      seeded acks and `cfg.operator.handle = 'mutaaf'`;
      assert 404. Hit `/referrals/mutaaf` with 3 seeded
      acks; assert 200 + the 3 tiles rendered.

- [ ] Rate-limit prefix: add `/referrals/` to the
      `isRateLimitedPath` prefix list in `src/rate_limit.ts`
      alongside the existing `/embed/` / `/og/` / `/share/` /
      `/operator/` family. PRODUCER-VS-SPEC NOTE: grep the
      existing prefix list and ADD `path.startsWith
      ("/referrals/")` to the OR chain. Test: hit
      `/referrals/mutaaf` 61 times from a simulated remote
      IP; assert the 61st returns 429.

- [ ] Profile stat block extension: the
      `operatorProfilePayload` helper grows ONE new field
      `referralsIntroduced: number` populated by reading
      the `totalIntroduced` from `referralGraphPayload(db,
      cfg, cfg.operator.handle, now)`. The
      `renderOperatorProfilePage` helper grows ONE new stat
      block "introduced N operators to fleet-control"
      ONLY when `referralsIntroduced > 0`; when zero the
      block is OMITTED (the profile page already has 4
      stat blocks; the 5th is conditional on signal). The
      stat block carries `data-testid="operator-profile-
      referrals"` and links to `/referrals/<handle>`.
      Test: render the profile with 0 referrals; assert
      the testid is ABSENT. Render with 3 referrals;
      assert the testid is PRESENT and the rendered text
      contains "3 operators".

- [ ] OG card extension is OUT OF SCOPE for v1 (the
      `/og/operator/<handle>.svg` card stays at 4 stat
      blocks; a future ticket can decide whether to add a
      5th). Test: confirm the OG SVG is byte-identical
      between a 0-referral and a 3-referral seed (the OG
      renderer ignores the new field).

- [ ] Consent toggle round-trip: when the new operator
      first sets `referredBy.consentPublicCredit: true`,
      the upstream operator's `/referrals/<handle>` page
      renders their `displayHandle`. When the new operator
      flips the consent back to `false` and restarts, the
      page renders the anonymised handle on next render
      (the cache invalidates via the
      `__fleet_referral_invalidate__` globalThis slot per
      LESSONS 2026-06-05). Test: seed an ack with
      consent=true; render and assert displayHandle
      populated. Update the row's payload to consent=false
      and trigger the invalidation hook; render and assert
      displayHandle is null.

- [ ] Quiet-hours posture: when
      `quietHoursActiveAnywhere(cfg, now)` per the 0030
      helper returns true, the `/referrals/<handle>` page
      renders normally BUT the footer "install yours" CTA
      is replaced with a softer "powered by fleet-control"
      caption (matching the 0065 quiet-hours posture). Per
      LESSONS 2026-06-11 drive the branch via
      `_renderReferralGraphForTests(payload,
      { quietHoursActive: true })` NOT cwd mutation. Test:
      render with quietHoursActive true; assert
      `data-testid="install-cta"` absent.

- [ ] Cache + invalidation: the referral graph payload is
      memo-cached for 60 seconds keyed by `handle`. Per
      LESSONS 2026-06-07 the invalidation tuple uses
      `(MAX(snapshot.created_at WHERE kind='referral_ack'),
      COUNT(*) FROM snapshot WHERE kind='referral_ack')` -
      no surrogate id needed. The hook lives on
      `globalThis.__fleet_referral_invalidate__`
      registered from `src/server.ts` on module load. Test:
      render the page, insert a new `referral_ack` row,
      assert the next render reflects the new tile within
      the next invalidation tick.

- [ ] tsc --noEmit clean. No new runtime deps. No shell-
      string composition. No JSON-shape break to
      `/api/...` routes (`/api/fleet/referrals` is NEW; no
      existing route changes). No schema migration -
      `referral_ack` rides on the existing `snapshot`
      table's `kind` TEXT column (extended by 0066,
      tolerated as a new enum value per the existing no-
      CHECK posture). Per LESSONS 2026-06-11 character-
      window source greps - the new helper's leading
      comment block uses PLAIN PROSE for sibling-helper-
      grep-vulnerable identifiers. Per LESSONS 2026-06-15
      static "route mounted before /api/" greps anchor on
      `if (path.startsWith("/api/"))` NOT a comment.

## Out of scope

- A FEDERATED referral network where the upstream operator's
  instance is notified via webhook when a downstream
  operator records the ack. Requires multi-instance
  coordination; the v1 surface is single-instance and
  uses `pr.author` as the local proxy for downstream
  visibility. A future v2 ticket can add a
  `FLEET_PEERS` push channel.
- A LEADERBOARD of operators ranked by referral count.
  Public ranking creates gaming incentives and feels
  hostile to a tool whose first principle is local
  privacy.
- A NOTIFICATION when an upstream operator receives a new
  referral. The upstream operator browses the page when
  curious; we do NOT page them.
- A PEER-TO-PEER ENDORSEMENT mechanic ("operator A
  publicly thanks operator B for a lesson"). The
  referral surface is the install-attribution graph
  ONLY; lesson-attribution is the existing 0042 / 0052
  ledger.
- A MULTI-HOP downstream tree ("operator A introduced
  operator B who introduced operator C"). v1 is one-
  level (immediate downstream of `<handle>` only).
  Multi-hop adds graph-traversal complexity for ~0%
  marginal lift at v1 fleet sizes.
- A REVOKE-FROM-UPSTREAM mechanic (the upstream
  operator wants to remove a downstream tile). The
  downstream operator authored the ack; only they can
  revoke it by editing their own config. Letting the
  upstream operator unilaterally remove a downstream
  tile breaks the consent model.
- A `/discover` public index of opted-in operators.
  Cross-instance discovery requires a curated central
  list; the v1 surface is per-instance-local. Future
  ticket if/when a curated `docs/discover.json` is
  worth the editorial overhead.

## Engineering notes

- `src/config.ts` - extend `FleetConfig.operator` with the
  new optional `referredBy: { handle: string,
  acknowledgedAt: string, consentPublicCredit?: boolean }`
  field. Defaulting pattern matches the existing
  `attribution` / `publicHost` optional fields. The
  `consentPublicCredit` falsy default surfaces in
  `referralGraphPayload` as `false`.
- `src/views.ts` - new helpers `referralGraphPayload(db,
  cfg, handle, now)`, `recordReferralAck(db, cfg, now)`,
  `renderReferralGraphPage(payload, opts)`,
  `_renderReferralGraphForTests(payload, opts)`. Per
  LESSONS 2026-06-13 the helpers live ALONGSIDE the
  existing `operatorProfilePayload` / sibling helpers
  inside `src/views.ts` - no new module. The handle-anon
  hash is computed via `createHash('sha256')` (the same
  primitive `src/snapshot.ts` uses; no new import needed,
  the helper can import the existing `hash` if exported
  or recompute inline).
- `src/views.ts` - extend `operatorProfilePayload` to
  populate the new `referralsIntroduced` field by
  calling `referralGraphPayload` with the operator's own
  handle. The extension is purely additive: existing
  consumers that ignore the field stay correct. Extend
  `renderOperatorProfilePage` to emit the new stat block
  ONLY when `referralsIntroduced > 0`.
- `src/server.ts` - new public route handler `GET
  /referrals/<handle>` mounted BEFORE the `/api/` auth
  gate alongside the `/operator/` / `/share/` / `/embed/`
  family. Per LESSONS 2026-06-15 the route ordering
  static-grep anchors on `if (path.startsWith("/api/"))`.
  The route handler memo-caches per handle and registers
  the `__fleet_referral_invalidate__` globalThis hook
  per LESSONS 2026-06-05. Also wire the startup-time
  `recordReferralAck` call into the existing module-load
  initialiser path (same place
  `__fleet_operator_profile_invalidate__` is registered).
- `src/rate_limit.ts` - add `path.startsWith
  ("/referrals/")` to the `isRateLimitedPath` OR chain
  alongside `/operator/` etc. Single-line edit.
- `tests/operator-referral-graph.test.ts` (NEW) - one
  `test(...)` per AC checkbox above. Per LESSONS
  2026-05-29 every test pins `now` and seeds timestamps
  off the same anchor. Per LESSONS 2026-06-11 the
  branch tests use the renderer-direct seam, NOT cwd
  config mutation. The integration shape test uses the
  empty-roots config + savedConfigText snapshot
  pattern.
- `README.md` - one new subsection "Operator referrals"
  under the public-pages family documents the new
  config field, the `/referrals/<handle>` route, and the
  consent trade-off.
- Schema migration: NO. The `referral_ack` row rides on
  the existing `snapshot` table whose `kind` TEXT
  column was added by 0066 with NO CHECK constraint.
  Per the 0066 schema comment the dispatcher already
  tolerates new kind values.
- No new runtime deps. Lean on
  `node:crypto.createHash` for the handle anonymisation
  (already imported by `src/snapshot.ts`). Pairs with
  0065 (operator profile), 0067 (share CLI), 0064
  (rate-limit), 0061 (OG infra), 0066 (snapshot.kind
  precedent).

## Implementation log

(Appended by the implementation-dev agent during execution.)
