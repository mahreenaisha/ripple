#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [[ ! -x "$ROOT/.venv/bin/python" ]]; then
  python3 -m venv "$ROOT/.venv"
fi
"$ROOT/.venv/bin/pip" install -q -r "$ROOT/backend/requirements-dev.txt"
npm --prefix "$ROOT/frontend" install --silent

(
  cd "$ROOT"
  "$ROOT/.venv/bin/python" -m pytest
)
npm --prefix "$ROOT/frontend" test
npm --prefix "$ROOT/frontend" run build

