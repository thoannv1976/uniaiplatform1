#!/bin/bash
# Prepares a Claude Code on the web session: installs dependencies and builds the
# workspace packages so lint, typecheck and tests can run immediately.
set -euo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "$CLAUDE_PROJECT_DIR"

if [ -n "${CLAUDE_ENV_FILE:-}" ]; then
  echo 'export TURBO_TELEMETRY_DISABLED=1' >> "$CLAUDE_ENV_FILE"
  # Use the pre-installed Chromium for Playwright instead of downloading browsers.
  if [ -x /opt/pw-browsers/chromium ]; then
    echo 'export PLAYWRIGHT_CHROMIUM_EXECUTABLE=/opt/pw-browsers/chromium' >> "$CLAUDE_ENV_FILE"
  fi
fi

export TURBO_TELEMETRY_DISABLED=1
pnpm install --frozen-lockfile
pnpm build
