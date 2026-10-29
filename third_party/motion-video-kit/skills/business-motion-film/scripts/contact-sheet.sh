#!/usr/bin/env bash
# Contact sheet for critics: one frame every N seconds, tiled.
# Usage: scripts/contact-sheet.sh film.mp4 out.jpg [every_seconds=1] [cols=6] [rows=5] [start=0] [duration=]
set -euo pipefail
f="$1"; o="$2"; e="${3:-1}"; c="${4:-6}"; r="${5:-5}"; ss="${6:-0}"; d="${7:-}"
ffmpeg -loglevel error -y -ss "$ss" ${d:+-t "$d"} -i "$f" -vf "fps=1/$e,scale=480:-1,tile=${c}x${r}" -frames:v 1 "$o"
echo "$o"
