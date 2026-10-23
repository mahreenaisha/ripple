#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUN_DIR="$ROOT/.ripple-run"
MODEL="${RIPPLE_OLLAMA_MODEL:-qwen2.5-coder:7b}"
mkdir -p "$RUN_DIR"

if [[ ! -x "$ROOT/.venv/bin/python" ]]; then
  echo "Preparing the local Python environment..."
  python3 -m venv "$ROOT/.venv"
fi
"$ROOT/.venv/bin/pip" install -q -r "$ROOT/backend/requirements.txt"

if [[ ! -d "$ROOT/frontend/node_modules" ]]; then
  echo "Installing frontend dependencies..."
  npm --prefix "$ROOT/frontend" install
fi

OLLAMA_PID=""
if ! curl -fsS http://127.0.0.1:11434/api/tags >/dev/null 2>&1; then
  if command -v ollama >/dev/null 2>&1; then
    echo "Starting Ollama..."
    ollama serve >"$RUN_DIR/ollama.log" 2>&1 &
    OLLAMA_PID=$!
  else
    echo "Ollama is not installed. The folder inventory will work, but AI explanations will be unavailable."
  fi
fi

cleanup() {
  kill "${BACKEND_PID:-}" "${FRONTEND_PID:-}" "${OLLAMA_PID:-}" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

echo "Starting Ripple API..."
(
  cd "$ROOT"
  exec "$ROOT/.venv/bin/python" -m uvicorn backend.main:app --host 127.0.0.1 --port 8000 --reload
) >"$RUN_DIR/backend.log" 2>&1 &
BACKEND_PID=$!

echo "Starting Ripple UI..."
npm --prefix "$ROOT/frontend" start -- --host 127.0.0.1 >"$RUN_DIR/frontend.log" 2>&1 &
FRONTEND_PID=$!

for _ in {1..60}; do
  if curl -fsS http://127.0.0.1:4200 >/dev/null 2>&1; then
    break
  fi
  if ! kill -0 "$BACKEND_PID" "$FRONTEND_PID" 2>/dev/null; then
    echo "Ripple failed to start. Check $RUN_DIR/backend.log and $RUN_DIR/frontend.log."
    exit 1
  fi
  sleep 1
done

if curl -fsS http://127.0.0.1:11434/api/tags 2>/dev/null | grep -q "\"$MODEL\""; then
  echo "Ollama model ready: $MODEL"
else
  echo "Model $MODEL is not installed. Run: ollama pull $MODEL"
fi

URL="http://127.0.0.1:4200"
if [[ "${1:-}" != "--no-browser" ]]; then
  if command -v google-chrome >/dev/null 2>&1; then
    google-chrome "$URL" >/dev/null 2>&1 &
  elif command -v google-chrome-stable >/dev/null 2>&1; then
    google-chrome-stable "$URL" >/dev/null 2>&1 &
  elif [[ -x "/mnt/c/Program Files/Google/Chrome/Application/chrome.exe" ]]; then
    "/mnt/c/Program Files/Google/Chrome/Application/chrome.exe" "$URL" >/dev/null 2>&1 &
  elif command -v chrome.exe >/dev/null 2>&1; then
    chrome.exe "$URL" >/dev/null 2>&1 &
  else
    echo "Chrome was not found. Open $URL in Chrome."
  fi
fi

echo "Ripple is running at $URL. Press Ctrl+C to stop."
wait "$BACKEND_PID" "$FRONTEND_PID"

