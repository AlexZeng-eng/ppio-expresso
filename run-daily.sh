#!/bin/bash
# PPIO Expresso — Daily pipeline runner
# Schedule: 0 8 * * * /tmp/ppio-expresso/run-daily.sh

set -e

PROJECT_DIR="/tmp/ppio-expresso"
LOG_DIR="$PROJECT_DIR/logs"
mkdir -p "$LOG_DIR"

LOG_FILE="$LOG_DIR/$(date +%Y-%m-%d).log"

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" >> "$LOG_FILE"
echo "  PPIO Expresso — $(date '+%Y-%m-%d %H:%M:%S')" >> "$LOG_FILE"
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

