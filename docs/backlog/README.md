# Backlog — fleet-control

The control plane's backlog. Tickets here ship via the kit dogfooded on
this repo: `implementation-dev` picks the top groomed row, `gtm-innovation`
proposes new ones, `review` grades them.

## Conventions

- `id` is a 4-digit zero-padded integer; the filename is `NNNN-kebab-title.md`.
- `status` is one of: `proposed`, `groomed`, `in-progress`, `shipped`,
  `rejected`, `needs-discovery`.
- `priority` is `P0` (oncall-now), `P1` (this week), `P2` (next), `P3` (later).
- `area` is one of: `ingest`, `portal`, `control`, `infra`, `observability`,
  `docs`.
- The table below MUST stay in sync with the frontmatter of each ticket file.
  CI gate `validate` runs `node scripts/check-backlog.mjs` and rejects drift.

## Index

| id | title | priority | status | area |
|----|-------|----------|--------|------|
| 0053 | Project graveyard - paused / sunset projects get a memorial page tallying lifetime ROI and what they taught the fleet | P2 | proposed | portal |
| 0052 | Lesson-pays-for-itself ledger - each cross-fleet lesson grows a $$ saved tally from the heal-credit attributions | P1 | proposed | observability |
| 0051 | Pre-install ROI calculator - public /calculator page projects fleet-control's value before any install | P1 | shipped | portal |
| 0050 | Fleet year-in-review - one shareable annual page only the local SQLite can author | P1 | shipped | portal |
| 0049 | Ingest closed (non-merged) PRs into the pr table so the autopsy card lights up in production | P1 | shipped | ingest |
| 0048 | Per-project worth-it verdict - each project card emits a yearly-trajectory "keep, watch, or sunset" call | P2 | shipped | observability |
| 0047 | PR autopsy card - surface why each non-merged PR died and which signal would have predicted it | P2 | shipped | observability |
| 0046 | fleetctl onboard wizard - one command from zero-state to first ingested project in under three minutes | P1 | shipped | infra |
| 0045 | Stuck-PR taxonomy card - label every open agent PR so the operator knows whether to intervene or wait | P1 | shipped | observability |
| 0044 | Spend-efficiency ranking - rank projects by $/merged-PR and diagnose the laggard | P2 | shipped | observability |
| 0043 | New-since-last-visit diff - mark every home-page item the operator has not yet seen | P1 | shipped | portal |
| 0042 | Lesson credit ledger - attribute heal saves to the cross-fleet lesson that caught them | P2 | shipped | observability |
| 0041 | Fleet receipts - public monthly artifact at a stable URL the prospective operator sees first | P1 | shipped | portal |
| 0040 | Riskiest open PR badge - one home-page line names the PR most likely to hurt the operator next | P1 | shipped | observability |
| 0039 | Fleet changelog - one chronological page of every merged PR across every project, ticket-linked | P1 | shipped | portal |
| 0038 | Monday morning catch-up - bridges the weekend gap between Friday wrap and Yesterday glance | P1 | shipped | portal |
| 0037 | Friday wrap - one weekly card recaps the fleet's week so the operator closes the laptop on a high | P2 | shipped | portal |
| 0036 | Cross-fleet lessons portal view - the file the operator never sees becomes a daily surface | P1 | shipped | portal |
| 0035 | Cost per merged PR - the single number that frames spend in value terms | P1 | shipped | observability |
| 0032 | Welcome banner prints LAN URL + ASCII-QR so the phone is paired in 60 seconds | P1 | shipped | infra |
| 0033 | Yesterday at a glance - single morning card recaps shipped, spent, broken | P1 | shipped | portal |
| 0034 | Self-baseline drift detector - flag when a project diverges from its OWN 14-day shape | P2 | shipped | observability |
| 0029 | PWA installable portal with offline shell and stale-snapshot banner | P1 | shipped | portal |
| 0030 | Quiet hours - sleep-window suppress non-critical pushes and demote inbox kinds | P1 | shipped | control |
| 0031 | Per-project tool-mix sparkline - where this project's tokens actually went | P2 | shipped | observability |
| 0025 | fleetctl demo - one-command sandbox boots portal against seeded fixture fleet | P1 | shipped | infra |
| 0026 | Merge streak counter and 90-day calendar heatmap on portal home | P1 | shipped | portal |
| 0027 | Cross-project failure correlation - same error in N projects fires a fleet alert | P1 | shipped | observability |
| 0028 | Project card shows month-to-date budget burndown with projection line | P2 | shipped | observability |
| 0020 | keep-running and eng-toggle clobber installed manifest when working tree is stale | P1 | shipped | control |
| 0021 | Soft daily budget with autopause when a project blows the cap | P1 | shipped | control |
| 0017 | Today's inbox — cross-project "what needs me" view | P1 | shipped | portal |
| 0022 | Fleet temperature — single per-project health score on the home page | P1 | shipped | observability |
| 0018 | Backlog-ticket → merged-commit auto-link via git log | P2 | shipped | ingest |
| 0023 | PR card shows heal-attempts and first-fail reason inline | P2 | shipped | portal |
| 0024 | First-run welcome — printed checklist after fleetctl serve cold start | P2 | shipped | infra |
| 0014 | Cross-project tool-call leaderboard | P1 | shipped | observability |
| 0015 | Embeddable status badge SVG per project | P1 | shipped | portal |
| 0016 | fleetctl doctor — one-shot install + ingest diagnostic | P2 | shipped | infra |
| 0001 | Ingest events.jsonl from each project | P0 | shipped | ingest |
| 0002 | SSE live tool-call stream from active transcripts | P0 | shipped | portal |
| 0003 | Per-user scoped tokens with audit log | P1 | shipped | control |
| 0004 | Live Anthropic pricing sync into pricing table | P1 | shipped | observability |
| 0005 | 30-day cost forecast per project | P1 | shipped | observability |
| 0006 | Stale-checkout janitor with disk view | P1 | shipped | infra |
| 0007 | Inline PR diff with sticky action bar | P1 | shipped | portal |
| 0011 | Mobile-first portal pass for home and project pages | P1 | shipped | portal |
| 0008 | Anomaly detection on run duration and cost | P2 | shipped | observability |
| 0009 | ntfy push notifications for high-priority events | P2 | shipped | observability |
| 0010 | One-click GitHub-URL project import | P2 | shipped | control |
| 0012 | Weekly "what shipped" digest with wins and trends | P2 | shipped | observability |
| 0013 | Shareable read-only fleet snapshot with anonymized slugs | P2 | shipped | portal |
| 0019 | prs_merged count reads from runs not control_audit | P1 | shipped | portal |
