#!/bin/bash
# PPIO 产业政策信息流 — Daily pipeline runner
# Scheduled via launchd: ~/Library/LaunchAgents/com.ppio.expresso.plist

set -e
export PATH="/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin:$PATH"

PROJECT_DIR="/Users/mac/ppio-expresso"
LOG_DIR="$PROJECT_DIR/logs"
mkdir -p "$LOG_DIR"

LOG_FILE="$LOG_DIR/$(date +%Y-%m-%d).log"
LOCK_FILE="$PROJECT_DIR/.pipeline.lock"

log() { echo "  $1" >> "$LOG_FILE"; }

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" >> "$LOG_FILE"
echo "  PPIO 产业政策信息流 — $(date '+%Y-%m-%d %H:%M:%S')" >> "$LOG_FILE"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" >> "$LOG_FILE"

# ── Lock: prevent concurrent runs ──────────────────────────────────────────
if [ -f "$LOCK_FILE" ]; then
  LOCK_PID=$(cat "$LOCK_FILE" 2>/dev/null || echo "")
  if [ -n "$LOCK_PID" ] && kill -0 "$LOCK_PID" 2>/dev/null; then
    log "⚠ Already running (PID $LOCK_PID), exiting"
    exit 0
  fi
fi
echo $$ > "$LOCK_FILE"
trap 'rm -f "$LOCK_FILE"' EXIT

# ── Network check with retry ────────────────────────────────────────────────
wait_for_network() {
  local max_wait=300  # wait up to 5 minutes
  local elapsed=0
  while ! curl -sf --max-time 5 https://news.google.com > /dev/null 2>&1; do
    if [ $elapsed -ge $max_wait ]; then
      log "⚠ Network unavailable after ${max_wait}s — aborting"
      return 1
    fi
    log "  Waiting for network... (${elapsed}s)"
    sleep 30
    elapsed=$((elapsed + 30))
  done
  log "✓ Network ready"
  return 0
}

# Load credentials
set -a
source "$PROJECT_DIR/.env"
set +a

cd "$PROJECT_DIR"

# ── Wait for network ────────────────────────────────────────────────────────
if ! wait_for_network; then
  exit 1
fi

# ── Run pipeline ────────────────────────────────────────────────────────────
node pipeline/run.mjs >> "$LOG_FILE" 2>&1
PIPELINE_EXIT=$?

echo "" >> "$LOG_FILE"
if [ $PIPELINE_EXIT -eq 0 ]; then
  log "✓ Done at $(date '+%Y-%m-%d %H:%M:%S')"
else
  log "✗ Pipeline failed (exit $PIPELINE_EXIT) at $(date '+%Y-%m-%d %H:%M:%S')"
fi

# Keep only last 60 days of logs
ls -t "$LOG_DIR"/*.log 2>/dev/null | tail -n +61 | xargs rm -f 2>/dev/null || true

# ── Push to GitHub Pages ────────────────────────────────────────────────────
if [ $PIPELINE_EXIT -eq 0 ]; then
  cd "$PROJECT_DIR"
  git add index.html archive.html reports/ data/archive.json data/curated-items.json data/weekly-synthesis.json
  git commit -m "Daily update: $(date '+%Y-%m-%d')" >> "$LOG_FILE" 2>&1 || true
  git push origin main >> "$LOG_FILE" 2>&1 \
    && log "✓ Pushed to GitHub Pages" \
    || log "⚠ Git push failed (will retry next run)"
fi
