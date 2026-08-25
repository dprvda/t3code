#!/usr/bin/env bash
# Carbon Studio machine setup — reproducible, idempotent.
# Run this on any box (dev PC now, the studio linux box later) after cloning
# the repo and running `pnpm install`. Moving the app to a new machine is:
#   git clone <repo> && cd carbon-studio && pnpm install && carbon/setup/setup.sh
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CARBON_HOME="${CARBON_HOME:-$HOME/.carbon-studio}"
CODEX_HOME="${CARBON_CODEX_HOME:-$CARBON_HOME/codex-home}"
STATE_DIR="$CARBON_HOME/userdata"

echo "== Carbon Studio setup =="
echo "repo:       $REPO_ROOT"
echo "app home:   $CARBON_HOME"
echo "codex home: $CODEX_HOME"

# 1. Directories. The app itself creates what it needs under CARBON_HOME on
#    first run; we pre-create only what setup writes into. Dev runs read
#    <home>/dev/settings.json, prod/desktop runs read <home>/userdata/ — seed both.
mkdir -p "$STATE_DIR" "$CARBON_HOME/dev" "$CODEX_HOME"

# 2. Provider instance: the app's own codex, pointed at its own codex home so
#    it can hold a separate codex account from any other codex on the machine.
#    Only written if settings.json doesn't exist yet — never clobber live state.
write_settings() {
  local settings="$1"
  if [[ ! -f "$settings" ]]; then
    cat > "$settings" <<EOF
{
  "providerInstances": {
    "codex_carbon": {
      "driver": "codex",
      "displayName": "Carbon Codex",
      "enabled": true,
      "config": {
        "binaryPath": "codex",
        "homePath": "$CODEX_HOME"
      }
    }
  }
}
EOF
    echo "wrote $settings (codex_carbon provider instance)"
  else
    echo "kept existing $settings (not overwritten; check codex_carbon exists)"
  fi
}
write_settings "$STATE_DIR/settings.json"
write_settings "$CARBON_HOME/dev/settings.json"

# 3. Skills — global for this codex home.
"$REPO_ROOT/carbon/setup/install-skills.sh"

# 4. Codex login for the separate account (interactive, once per machine).
if [[ ! -f "$CODEX_HOME/auth.json" ]]; then
  echo
  echo "NEXT STEP (once): log the app's codex account in:"
  echo "  CODEX_HOME=$CODEX_HOME codex login"
else
  echo "codex auth present."
fi

echo
echo "Start the app:   pnpm dev          (local)"
echo "Share on tailnet: pnpm dev:share   (remote browsers; each person needs a"
echo "                  pairing link from Settings -> Connections -> Create Link)"
