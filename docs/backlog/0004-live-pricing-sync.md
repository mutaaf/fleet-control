---
id: 0004
title: Live Anthropic pricing sync into pricing table
status: in-progress
priority: P1
area: observability
created: 2026-05-26
owner: gtm-innovation
---

## User story

As a fleet operator, I want fleet-control to refresh Anthropic's published
pricing automatically, so that the cost numbers in the portal are real
instead of hardcoded estimates.

## Why now (four lenses)

### Product Owner
Today `src/pricing.ts` has token rates baked in. They drift the day
Anthropic adjusts pricing or adds a model. One fetch per day removes the
"estimates" disclaimer.

### Stakeholder
Widens the moat on `observability` honesty. Operators trust numbers that
update themselves.

### Operator
Portal shows "Pricing synced 4h ago"; the cost figures match the bill.

### Growth
"Real numbers, not estimates" is the kind of property a careful builder
checks for.

## Acceptance criteria

- [ ] `src/pricing.ts` gains `syncPricing(db)` that fetches a configured
      pricing source (default: a JSON file checked into the repo at
      `data/anthropic-pricing.json`, manually updated; the function reads
      it and writes/updates rows in the `pricing` table). A follow-up
      ticket can swap to a live HTTP fetch.
- [ ] `pricing` table gets a `fetched_at` column (ALTER TABLE if existing
      schema doesn't have it).
- [ ] `bin/fleetctl.ts pricing sync` invokes `syncPricing(db)`.
- [ ] `bin/fleetctl.ts pricing show` prints the current table.
- [ ] `src/server.ts` `/api/pricing` returns the table as JSON; the
      portal's footer shows "Pricing synced <relative-time>".
- [ ] If `fetched_at` is older than 24h, the cost figures in the portal
      get a small ⚠ icon with a tooltip "pricing may be stale".
- [ ] `tests/pricing-sync.test.ts` — write a fixture pricing JSON, call
      `syncPricing`, assert the table rows; call again with a changed
      value, assert the row updates and `fetched_at` advances.

## Out of scope

- Live HTTP fetch from Anthropic's pricing page (separate ticket; needs
  HTML parsing and a stability story).
- Multi-provider pricing (OpenAI, Gemini). Anthropic only in v1.

## Engineering notes

- `data/anthropic-pricing.json` — new file with the current rates as the
  bootstrap source of truth. Format:
  `{"models":[{"id":"claude-opus-4-7","input_per_mtok":15.00,
  "output_per_mtok":75.00,"cache_read_per_mtok":1.50,
  "cache_write_per_mtok":18.75}]}`
- `src/pricing.ts` — read the JSON, upsert the `pricing` table.
- `src/server.ts` — add the `/api/pricing` route.
- `web/app.js` — footer "Pricing synced X" line.
- No new deps.

## Implementation log

- 2026-05-26 — implementation-dev: branch `feat/0004-live-pricing-sync`
  opened; status flipped to `in-progress`. Plan: write failing tests
  first (fixture JSON → `syncPricing` upserts + `fetched_at` advances →
  `/api/pricing` shape), then add `data/anthropic-pricing.json`,
  `syncPricing(db)` + `pricingRows(db)` in `src/pricing.ts`, idempotent
  ALTER for `pricing.fetched_at`, `pricing sync|show` CLI subcommands,
  `/api/pricing` route, and a footer line in `web/app.js` with a stale-
  warning badge when `fetched_at` > 24h.
