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
| 0001 | Ingest events.jsonl from each project | P0 | shipped | ingest |
| 0002 | SSE live tool-call stream from active transcripts | P0 | shipped | portal |
| 0003 | Per-user scoped tokens with audit log | P1 | shipped | control |
| 0004 | Live Anthropic pricing sync into pricing table | P1 | shipped | observability |
| 0005 | 30-day cost forecast per project | P1 | shipped | observability |
| 0006 | Stale-checkout janitor with disk view | P1 | shipped | infra |
| 0007 | Inline PR diff with sticky action bar | P1 | shipped | portal |
| 0008 | Anomaly detection on run duration and cost | P2 | shipped | observability |
| 0009 | ntfy push notifications for high-priority events | P2 | shipped | observability |
| 0010 | One-click GitHub-URL project import | P2 | shipped | control |
| 0011 | Mobile-first portal pass for home and project pages | P1 | shipped | portal |
| 0012 | Weekly "what shipped" digest with wins and trends | P2 | in-progress | observability |
| 0013 | Shareable read-only fleet snapshot with anonymized slugs | P2 | proposed | portal |
| 0014 | Cross-project tool-call leaderboard | P2 | proposed | observability |
