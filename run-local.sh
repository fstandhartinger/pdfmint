#!/usr/bin/env bash
# Start (or restart) the local dev server. Writes a pidfile so we never pkill ourselves.
set -a; . "$(dirname "$0")/.env.local"; set +a
PID_FILE=/tmp/pdfmint.pid
if [ -f "$PID_FILE" ]; then kill "$(cat $PID_FILE)" 2>/dev/null; sleep 1; fi
nohup node "$(dirname "$0")/src/server.js" > /tmp/pdfmint.log 2>&1 &
echo $! > "$PID_FILE"
sleep 4
curl -s localhost:3000/healthz; echo
