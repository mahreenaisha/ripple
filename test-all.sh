#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DOTNET="${RIPPLE_DOTNET:-dotnet}"

if ! command -v "$DOTNET" >/dev/null 2>&1; then
  echo "Ripple scanner requires the .NET 10 SDK in the current environment. Install it or set RIPPLE_DOTNET." >&2
  exit 1
fi

DOTNET_VERSION="$("$DOTNET" --version)"
DOTNET_MAJOR="${DOTNET_VERSION%%.*}"
if [[ ! "$DOTNET_MAJOR" =~ ^[0-9]+$ ]] || (( DOTNET_MAJOR < 10 )); then
  echo "Ripple scanner requires .NET 10 SDK or newer; found $DOTNET_VERSION at $DOTNET." >&2
  exit 1
fi

DOTNET_CLI_TELEMETRY_OPTOUT=1 "$DOTNET" build \
  "$ROOT/scanner/Ripple.CSharpAnalyzer/Ripple.CSharpAnalyzer.csproj" \
  -c Release --nologo --verbosity quiet

if [[ ! -x "$ROOT/backend/venv/bin/python" ]]; then
  python3 -m venv "$ROOT/backend/venv"
fi
"$ROOT/backend/venv/bin/pip" install -q -r "$ROOT/backend/requirements-dev.txt"
npm --prefix "$ROOT/frontend" install --silent

node --test "$ROOT"/scanner/*.test.js
"$ROOT/backend/venv/bin/python" -m pytest "$ROOT/backend"
npm --prefix "$ROOT/frontend" test -- --watch=false
npm --prefix "$ROOT/frontend" run build

