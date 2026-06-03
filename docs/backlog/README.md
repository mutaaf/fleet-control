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
| 0037 | Friday wrap - one weekly card recaps the fleet's week so the operator closes the laptop on a high | P2 | in-progress | portal |
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
