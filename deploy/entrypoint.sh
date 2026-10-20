#!/bin/sh
# The server edition's start (Dockerfile): its data and the home folder Pi works in are under /data (a volume). The
# server exits with 75 when the app asks for a restart; the container's restart policy starts it again.
set -e
mkdir -p "$HOME/work" /data/pocket
exec node /app/src/server/main.ts --platform server --host 0.0.0.0 --port 8787 --data /data/pocket --cwd "$HOME/work" "$@"
