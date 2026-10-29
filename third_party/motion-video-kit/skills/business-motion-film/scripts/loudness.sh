#!/usr/bin/env bash
# Integrated loudness, loudness range, true peak, plus short-term loudness each second.
# Usage: scripts/loudness.sh film.mp4
set -euo pipefail
f="$1"
out=$(ffmpeg -hide_banner -i "$f" -af ebur128=peak=true -f null - 2>&1)
echo "$out" | grep -E "^ +(I|LRA|Peak):" | tr -s ' '
echo "short-term per second:"
echo "$out" | grep -oE "t: *[0-9.]+ .*S: *[-0-9.]+" | awk '{for(i=1;i<=NF;i++){if($i=="t:")t=$(i+1); if($i=="S:")s=$(i+1)}; if(int(t*10)%10==0) printf "%d:%s ", t, s} END{print ""}'
