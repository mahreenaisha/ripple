#!/usr/bin/env bash

set -Eeuo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$ROOT_DIR/backend"
FRONTEND_DIR="$ROOT_DIR/frontend"
RUN_DIR="$ROOT_DIR/.ripple-run"
BACKEND_LOG="$RUN_DIR/backend.log"
FRONTEND_LOG="$RUN_DIR/frontend.log"
BACKEND_URL="http://localhost:8000"
APP_URL="http://localhost:4200"

BACKEND_PID=""
FRONTEND_PID=""
OPEN_BROWSER=true

if [[ "${1:-}" == "--no-browser" ]]; then
  OPEN_BROWSER=false
elif [[ -n "${1:-}" ]]; then
  echo "Usage: ./run-ripple.sh [--no-browser]" >&2
  exit 2
fi

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 1
  fi
}

is_ready() {
  curl --silent --fail --max-time 1 "$1" >/dev/null 2>&1
}

stop_group() {
  local pid="$1"
  if [[ -n "$pid" ]] && kill -0 "$pid" >/dev/null 2>&1; then
    kill -TERM -- "-$pid" >/dev/null 2>&1 || kill -TERM "$pid" >/dev/null 2>&1 || true
    wait "$pid" >/dev/null 2>&1 || true
  fi
}

cleanup() {
  trap - EXIT INT TERM
  echo
  echo "Stopping Ripple..."
  stop_group "$FRONTEND_PID"
  stop_group "$BACKEND_PID"
}

wait_until_ready() {
  local name="$1"
  local url="$2"
  local pid="$3"
  local log="$4"

  for _ in {1..60}; do
    if is_ready "$url"; then
      echo "$name is ready."
      return 0
    fi
    if ! kill -0 "$pid" >/dev/null 2>&1; then
      echo "$name stopped before it became ready. Last log lines:" >&2
      tail -n 30 "$log" >&2 || true
      return 1
    fi
    sleep 1
  done

  echo "Timed out waiting for $name at $url. Last log lines:" >&2
  tail -n 30 "$log" >&2 || true
  return 1
}

open_app() {
  if [[ "$OPEN_BROWSER" != true ]]; then
    return
  fi

  if command -v google-chrome >/dev/null 2>&1; then
    google-chrome "$APP_URL" >/dev/null 2>&1 &
    return
  fi
  if command -v google-chrome-stable >/dev/null 2>&1; then
    google-chrome-stable "$APP_URL" >/dev/null 2>&1 &
    return
  fi

  local chrome_paths=(
    "${CHROME_PATH:-}"
    "/mnt/c/Program Files/Google/Chrome/Application/chrome.exe"
    "/mnt/c/Program Files (x86)/Google/Chrome/Application/chrome.exe"
    /mnt/c/Users/*/AppData/Local/Google/Chrome/Application/chrome.exe
  )
  local chrome
  for chrome in "${chrome_paths[@]}"; do
    if [[ -n "$chrome" && -x "$chrome" ]]; then
      "$chrome" "$APP_URL" >/dev/null 2>&1 &
      return
    fi
  done

  echo "Google Chrome was not found. Open $APP_URL manually or set CHROME_PATH." >&2
}

require_command curl
require_command node
require_command npm
require_command python3
require_command setsid

mkdir -p "$RUN_DIR"

if is_ready "$BACKEND_URL" && is_ready "$APP_URL"; then
  echo "Ripple is already running."
  echo "App:      $APP_URL"
  echo "API:      $BACKEND_URL"
  echo "API docs: $BACKEND_URL/docs"
  open_app
  exit 0
fi

if [[ ! -x "$BACKEND_DIR/venv/bin/python" ]]; then
  echo "Creating the Python environment..."
  python3 -m venv "$BACKEND_DIR/venv"
  "$BACKEND_DIR/venv/bin/python" -m pip install -r "$BACKEND_DIR/requirements.txt"
fi

if [[ ! -d "$FRONTEND_DIR/node_modules" ]]; then
  echo "Installing frontend dependencies..."
  (cd "$FRONTEND_DIR" && npm ci)
fi

trap cleanup EXIT INT TERM

if is_ready "$BACKEND_URL"; then
  echo "Backend is already running at $BACKEND_URL."
else
  echo "Starting backend..."
  : >"$BACKEND_LOG"
  setsid bash -c 'cd "$1" && exec ./venv/bin/python -m uvicorn main:app --host 127.0.0.1 --port 8000' \
    bash "$BACKEND_DIR" >"$BACKEND_LOG" 2>&1 &
  BACKEND_PID=$!
  wait_until_ready "Backend" "$BACKEND_URL" "$BACKEND_PID" "$BACKEND_LOG"
fi

if is_ready "$APP_URL"; then
  echo "Frontend is already running at $APP_URL."
else
  echo "Starting frontend..."
  : >"$FRONTEND_LOG"
  setsid bash -c 'cd "$1" && exec npm start -- --host 127.0.0.1' \
    bash "$FRONTEND_DIR" >"$FRONTEND_LOG" 2>&1 &
  FRONTEND_PID=$!
  wait_until_ready "Frontend" "$APP_URL" "$FRONTEND_PID" "$FRONTEND_LOG"
fi

echo
echo "Ripple is running."
echo "App:      $APP_URL"
echo "API:      $BACKEND_URL"
echo "API docs: $BACKEND_URL/docs"
echo "Logs:     $RUN_DIR"
echo
echo "Press Ctrl+C to stop services started by this script."

open_app

while true; do
  if [[ -n "$BACKEND_PID" ]] && ! kill -0 "$BACKEND_PID" >/dev/null 2>&1; then
    echo "Backend stopped unexpectedly. See $BACKEND_LOG." >&2
    exit 1
  fi
  if [[ -n "$FRONTEND_PID" ]] && ! kill -0 "$FRONTEND_PID" >/dev/null 2>&1; then
    echo "Frontend stopped unexpectedly. See $FRONTEND_LOG." >&2
    exit 1
  fi
  sleep 2
done
