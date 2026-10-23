#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [[ ! -x "$ROOT/backend/venv/bin/python" ]]; then
  python3 -m venv "$ROOT/backend/venv"
fi
"$ROOT/backend/venv/bin/pip" install -q -r "$ROOT/backend/requirements-dev.txt"
npm --prefix "$ROOT/frontend" install --silent

"$ROOT/backend/venv/bin/python" -m pytest "$ROOT/backend"
npm --prefix "$ROOT/frontend" test -- --watch=false
npm --prefix "$ROOT/frontend" run build

