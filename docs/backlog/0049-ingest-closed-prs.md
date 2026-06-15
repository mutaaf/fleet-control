---
id: 0049
title: Ingest closed (non-merged) PRs into the pr table so the autopsy card lights up in production
status: shipped
priority: P1
area: ingest
created: 2026-06-09
owner: implementation-dev
spawned-from: 0047
---

## User story

Today `src/ingest/prs.ts` calls `gh pr list --state open`
and hard-codes `state='open'` on every INSERT. The 0047 PR
autopsy card reads `pr.state = 'CLOSED' AND pr.closed_at IS
NOT NULL` — those rows never land in production today, so
the card stays empty even when PRs die in the wild. This
ticket extends the ingester to also fetch closed (non-
merged) PRs and populate `state` + `closed_at` (and the
closer identity once the GraphQL surface is widened) so the
autopsy lights up against real fleet data.

## Why now

0047 added the helper, the route, the cache, the SPA card,
and the additive `closed_at` column. The remaining gap is
the producer — the ingester does not write 'CLOSED' or
populate `closed_at`. Closing this gap is mechanically
small but worth its own PR because:
1. It changes the producer contract for `pr.state` (a new
   value lands), which other helpers (riskiestOpenPr,
   stuckPrTaxonomy, costPerMergedPr) MUST tolerate. Each
   helper already restricts via `state = 'open'` or
   `state = 'MERGED'` so a third value is structurally
   safe — but the regression risk warrants an isolated
   review.
2. The "human_rejected" cause cascade in 0047 AC2 needs a
   `closed_by` signal. gh's `--json closedAt,mergedAt`
   surface carries `mergedBy.login` but not
   `closedBy.login` directly; a GraphQL widening or a
   `gh pr view <n> --json` fallback is required. Worth
   landing inside this PR with its own tests.

## Acceptance criteria

- [ ] `src/ingest/prs.ts` fetches `--state closed` (which
      gh returns including merged) and INSERTs rows with
      the verbatim gh state (`'CLOSED'` or `'MERGED'`),
      not the hardcoded `'open'`. Open-PR rows continue
      to write the hardcoded `'open'` so existing readers
      remain unchanged.
- [ ] `closed_at` is populated from gh's `closedAt`
      field on every closed/merged row. `gh_created_at`
      is populated from gh's `createdAt` (already wired).
- [ ] A new test in `tests/prs-ingest.test.ts` (or a new
      `tests/prs-ingest-closed.test.ts`) seeds the
      `_setPrRunnerForTests` runner with a fixture that
      includes CLOSED + MERGED rows and asserts the
      `pr` table after `ingestProjectPRs()` has the new
      rows with correct casing and `closed_at` populated.
- [ ] No regression in the 0040 riskiest-PR, 0044 spend-
      efficiency, 0045 stuck-PR taxonomy, or 0019
      `prs_merged_7d` helpers — each restricts by a
      single state value and is structurally unaffected.
      Test: re-run the existing helper suites against
      the new fixture to confirm.
- [ ] (Stretch) `closed_by` column added via ALTER + the
      ingester populates it from `gh pr view <n>
      --json closedBy` (one-shot per closed PR per tick).
      The autopsy's `human_rejected` cascade rule lights
      up when `closed_by` is not `claude-fleet-bot` /
      `agent`.

## Out of scope

- Schema migrations beyond additive ALTERs.
- Re-ingesting historical closed PRs from before this
  ticket lands. The ingester is forward-looking.
- An LLM-driven "rejection reason" classifier — the
  autopsy stays deterministic.

## Engineering notes

- The existing `DELETE FROM pr WHERE project_id=?` at
  the top of `ingestProjectPRs` already wipes every
  state per pass, so adding the second fetch is a pure
  additive — no idempotency churn.
- gh's `--json state` returns uppercase `OPEN`,
  `CLOSED`, `MERGED`. For OPEN rows we keep the
  hardcoded `'open'` lowercase per the 0040 LESSON;
  for CLOSED + MERGED we write the gh value verbatim
  (matches the existing `state = 'MERGED'` reader
  convention).

## Implementation log

- 2026-06-10 — implementation-dev picked up; flipped status to
  in-progress on `feat/0049-ingest-closed-prs`. Also folded the
  0048 drift fix on this branch (PR #112 merged 2026-06-10 but
  the frontmatter + README index row still read `in-progress`).
  Verified producer/reader state casings: existing readers
  scattered across `src/views.ts`, `src/server.ts`,
  `src/receipts.ts`, `src/correlate.ts` only ever filter by
  `'open'` (lowercase), `'MERGED'` (uppercase), or `'CLOSED'`
  (uppercase). Writing gh's verbatim CLOSED/MERGED tokens is
  structurally safe; open rows continue to write `'open'`
  lowercase per the 0040 LESSON.
- 2026-06-10 — stretch AC (closed_by + human_rejected cascade)
  is OUT of scope for this PR. Reasoning: gh's `--json closedBy`
  is not a documented field on `gh pr list`; surfacing it
  requires a per-PR `gh pr view <n>` shell-out per closed PR
  per tick. That is a meaningful new shell-out budget AND a
  schema migration (ALTER TABLE pr ADD COLUMN closed_by). The
  ticket's own Engineering Notes flag this as "Worth landing
  inside this PR with its own tests" but per AGENTS.md
  "Don't exceed scope to chase a stretch goal" — landing the
  primary fetch + writer change in this PR, deferring the
  closed_by column to a follow-up ticket.
