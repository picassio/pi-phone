#!/usr/bin/env bash
# Report near-frozen moments in a render: frame-to-frame luma difference below a threshold, sampled at 10fps.
# Usage: scripts/frozen-time.sh film.mp4 [threshold=0.35]
set -euo pipefail
f="$1"; th="${2:-0.35}"
ffmpeg -hide_banner -i "$f" -vf "fps=10,scale=320:-1,format=gray,tblend=all_mode=difference,signalstats,metadata=print:key=lavfi.signalstats.YAVG" -an -f null - 2>&1 \
 | grep -o "YAVG=[0-9.]*" | awk -F= -v th="$th" '
   {t=NR/10; if($2<th){n++; printf "%.1f ", t}}
   END{printf "\nnear-frozen samples: %d (≈%.1fs)\n", n, n/10}'
