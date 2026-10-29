#!/usr/bin/env bash
# Soften a library sound effect: high-pass, low-pass, click-free fades.
# Usage: scripts/soften-sfx.sh in.mp3 out.mp3 [highpass=150] [lowpass=6500] [fade_out_start] [fade_out_dur=0.15]
set -euo pipefail
in="$1"; out="$2"; hp="${3:-150}"; lp="${4:-6500}"
dur=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$in")
fd="${6:-0.15}"; fs="${5:-$(awk -v d="$dur" -v f="$fd" 'BEGIN{print d-f}')}"
ffmpeg -loglevel error -y -i "$in" -af "highpass=f=$hp,lowpass=f=$lp,afade=t=in:d=0.01,afade=t=out:st=$fs:d=$fd" -ar 48000 "$out"
echo "$out"
