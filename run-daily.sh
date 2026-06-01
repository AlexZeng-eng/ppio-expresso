#!/bin/bash
# PPIO 产业政策信息流 — Daily pipeline runner
# Scheduled via launchd: ~/Library/LaunchAgents/com.ppio.expresso.plist

set -e

# launchd runs with minimal PATH — explicitly add node/git locations
export PATH="/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin:$PATH"

PROJECT_DIR="/Users/mac/ppio-expresso"
LOG_DIR="$PROJECT_DIR/logs"
mkdir -p "$LOG_DIR"

LOG_FILE="$LOG_DIR/$(date +%Y-%m-%d).log"

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" >> "$LOG_FILE"
echo "  PPIO 产业政策信息流 — $(date '+%Y-%m-%d %H:%M:%S')" >> "$LOG_FILE"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" >> "$LOG_FILE"

# Load credentials
set -a
source "$PROJECT_DIR/.env"
set +a

cd "$PROJECT_DIR"

# Run pipeline
node pipeline/run.mjs >> "$LOG_FILE" 2>&1

echo "" >> "$LOG_FILE"
echo "  ✓ Done at $(date '+%Y-%m-%d %H:%M:%S')" >> "$LOG_FILE"

# Keep only last 60 days of logs
ls -t "$LOG_DIR"/*.log | tail -n +61 | xargs rm -f 2>/dev/null || true

# Push to GitHub Pages
cd "$PROJECT_DIR"
git add index.html archive.html reports/ data/archive.json data/curated-items.json data/weekly-synthesis.json
git commit -m "Weekly update: $(date '+%Y-%m-%d')" >> "$LOG_FILE" 2>&1 || true
git push origin main >> "$LOG_FILE" 2>&1 && echo "  ✓ Pushed to GitHub Pages" >> "$LOG_FILE" || echo "  ⚠ Git push failed" >> "$LOG_FILE"

