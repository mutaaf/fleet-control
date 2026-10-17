#!/bin/bash
# review-gate — the reviewer agent's verdict as a REQUIRED check (ticket 0070).
#
# Copied into each fleet repo as scripts/review-gate.sh and run by
# .github/workflows/review-gate.yml. Passes only when the fleet reviewer has
# posted `FLEET-VERDICT: clean` on the PR's CURRENT head commit. Fails on no
# review yet, a review of an older commit, a missing marker, or `blocking`.
# Human PRs (non-agent branch prefixes) pass untouched.
#
# Why a check and not --request-changes: the reviewer runs as the PR author, and
# GitHub forbids self-approve AND self-request-changes, so verdicts can only be
# comments — which auto-merge ignores. A required check is the one thing
# auto-merge must wait for.
#
# Env: REPO, PR, HEAD_SHA, BRANCH, REVIEWER (gh login whose verdicts count),
#      AGENT_BRANCH_RE (optional; defaults to the canonical queues).
set -euo pipefail

AGENT_BRANCH_RE="${AGENT_BRANCH_RE:-^(feat/|eng/|chore/gtm-)}"

if ! printf '%s' "$BRANCH" | grep -Eq "$AGENT_BRANCH_RE"; then
  echo "review-gate: $BRANCH is not an agent branch — pass"
  exit 0
fi

# Newest verdict-bearing review by REVIEWER on exactly this commit.
# (One page of 100 reviews covers any realistic PR; --paginate would split the array.)
VERDICT="$(gh api "repos/$REPO/pulls/$PR/reviews?per_page=100" \
  --jq "[.[] | select(.user.login == \"$REVIEWER\" and .commit_id == \"$HEAD_SHA\")
           | (.body // \"\") | capture(\"FLEET-VERDICT:[[:space:]]*(?<v>[A-Za-z]+)\"; \"i\") | .v | ascii_downcase]
         | last // \"\"" 2>/dev/null || true)"

case "$VERDICT" in
  clean)
    echo "review-gate: reviewer signed off on ${HEAD_SHA:0:7} — pass"; exit 0 ;;
  blocking)
    echo "::error::review-gate: reviewer BLOCKED ${HEAD_SHA:0:7}. Address the review, push, and the reviewer re-grades the new head."
    exit 1 ;;
  "")
    echo "::error::review-gate: no FLEET-VERDICT from $REVIEWER on ${HEAD_SHA:0:7} yet — waiting for the reviewer."
    exit 1 ;;
  *)
    echo "::error::review-gate: unrecognised verdict '$VERDICT' — failing closed."
    exit 1 ;;
esac
