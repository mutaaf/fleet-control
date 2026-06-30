# agents.config.sh — fleet-control fleet manifest (plumbing only).
# Semantics (gating checks, branch prefixes, local gate, hard NOs) live in
# AGENTS.md § Agent parameters. After editing, redeploy:
#   bash ../agent-fleet/lib/install.sh /Users/mutaafaziz/Desktop/projects/fleet-control

PROJECT_NAME="Fleet Control"
SLUG="fleet-control"
NAMESPACE="com.fleet-control"
REPO_URL="https://github.com/mutaaf/fleet-control"
MODEL="claude-opus-4-7"

GIT_AUTHOR_NAME="Fleet Control Agent"
GIT_AUTHOR_EMAIL="noreply@anthropic.com"

SELF_CANCEL="20260730"

SHIP_MINUTE="41"
GROOM_HOURS="0"
GROOM_MINUTE="17"
REVIEW_INTERVAL="1800"

ENG_ENABLED=0
ENG_HOURS="0"
ENG_MINUTE="23"
SHIP_HOURS="0 6 12 18"
