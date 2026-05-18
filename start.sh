#!/usr/bin/env bash
# Local launcher for BD-Platform.
#   - Loads ./.env into the environment
#   - Finds Node even when nvm isn't loaded by your shell profile
#   - Frees port 3001 if a previous server is still bound to it
#   - Verifies the INTERNAL_TOKEN env var matches the constant in index.html
#     so the desk app's auth-gated calls don't silently 401
set -euo pipefail
cd "$(dirname "$0")"

# 1. Load .env if present
if [[ -f .env ]]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
else
  echo "warning: no .env file found (copy .env.example → .env and fill in)" >&2
fi

# 2. Locate node (try PATH first, then common nvm install)
NODE_BIN="${NODE_BIN:-$(command -v node 2>/dev/null || true)}"
if [[ -z "$NODE_BIN" || ! -x "$NODE_BIN" ]]; then
  for v in $(ls -1 "$HOME/.nvm/versions/node" 2>/dev/null | sort -rV); do
    if [[ -x "$HOME/.nvm/versions/node/$v/bin/node" ]]; then
      NODE_BIN="$HOME/.nvm/versions/node/$v/bin/node"
      break
    fi
  done
fi
if [[ -z "$NODE_BIN" || ! -x "$NODE_BIN" ]]; then
  echo "error: node not found. Install via nvm or add to PATH." >&2
  exit 1
fi

# 3. Token-mismatch check (this was the bug that caused the blank internal page)
if [[ -n "${INTERNAL_TOKEN:-}" && -f index.html ]]; then
  HTML_TOKEN=$(grep -oE "const INTERNAL_TOKEN = '[^']+'" index.html | head -1 | sed -E "s/const INTERNAL_TOKEN = '([^']+)'/\1/")
  if [[ -n "$HTML_TOKEN" && "$HTML_TOKEN" != "$INTERNAL_TOKEN" ]]; then
    echo "error: INTERNAL_TOKEN in .env does not match index.html" >&2
    echo "       .env       : ${INTERNAL_TOKEN:0:12}…" >&2
    echo "       index.html : ${HTML_TOKEN:0:12}…" >&2
    echo "Fix one of them so they match, then re-run." >&2
    exit 2
  fi
fi

# 4. Free port if still bound (e.g. a previous server didn't shut down cleanly)
PORT_NUM="${PORT:-3001}"
if lsof -ti :"$PORT_NUM" >/dev/null 2>&1; then
  echo "→ Port $PORT_NUM in use — killing existing process(es)..."
  lsof -ti :"$PORT_NUM" | xargs kill 2>/dev/null || true
  sleep 1
fi

# 5. Banner + launch
status() { [[ -n "${1:-}" ]] && echo "set" || echo "$2"; }
echo "→ Node:                $NODE_BIN ($($NODE_BIN -v))"
echo "→ FRED_API_KEY:        $(status "${FRED_API_KEY:-}" 'MISSING (will fail)')"
echo "→ ANTHROPIC_API_KEY:   $(status "${ANTHROPIC_API_KEY:-}" 'not set (blurbs will be empty)')"
echo "→ INTERNAL_TOKEN:      ${INTERNAL_TOKEN:0:12}…  (matches index.html ✓)"
echo "→ Port:                $PORT_NUM"
echo "→ Starting server..."
echo
exec "$NODE_BIN" server.js
