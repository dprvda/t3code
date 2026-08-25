#!/usr/bin/env bash
# Install (or refresh) all repo-authored skills into the app's codex home.
# Idempotent: rsync --delete per skill dir, so the codex home mirrors the repo.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CODEX_HOME="${CARBON_CODEX_HOME:-$HOME/.carbon-studio/codex-home}"
SKILLS_SRC="$REPO_ROOT/carbon/skills"
SKILLS_DST="$CODEX_HOME/skills"

mkdir -p "$SKILLS_DST"

for skill in "$SKILLS_SRC"/*/; do
  id="$(basename "$skill")"
  rsync -a --delete "$skill" "$SKILLS_DST/$id/"
  chmod +x "$SKILLS_DST/$id/scripts/"* 2>/dev/null || true
  echo "installed skill: $id"
done

echo "skills installed into $SKILLS_DST"
