#!/usr/bin/env bash
# pi-phone: added (PP-413). Same t, same picture: snapshot a HyperFrames composition at the same times twice, each
# time in its own shuffled order, and name every time whose two pictures differ. A picture that depends on what was
# drawn before it (state kept between updates, unseeded randomness, Date.now or performance.now, a tween that took its
# start value from the screen) shows up as two different pictures. `hyperframes check` does not catch these.
# The idea and the limit are OpenFilm's `look` (MIT): 8x8 block averages, largest channel difference over 32 of 255.
# Usage: scripts/twice.sh <project dir> [count=12]
# Needs hyperframes and ffmpeg on PATH (pi-phone's machine tools: PATH=~/.pi/mobile/tools/bin:$PATH).
# Exit: 0 same pictures, 1 different pictures, 2 it could not check.
set -euo pipefail
dir="${1:-}"; count="${2:-12}"; limit="${TWICE_LIMIT:-32}"
if [[ -z "$dir" || ! -d "$dir" ]]; then echo "usage: twice.sh <project dir> [count=12]" >&2; exit 2; fi
if ! [[ "$count" =~ ^[0-9]+$ ]] || (( count < 2 || count > 48 )); then echo "twice.sh: count is a whole number from 2 to 48" >&2; exit 2; fi
for tool in hyperframes ffmpeg; do
  command -v "$tool" >/dev/null || { echo "twice.sh: $tool not found: install the HyperFrames and ffmpeg machine tools (Settings › Machines › Install tools) and run with PATH=~/.pi/mobile/tools/bin:\$PATH" >&2; exit 2; }
done
dir="$(cd "$dir" && pwd)"

info="$(hyperframes info "$dir" --json 2>/dev/null)" || { echo "twice.sh: hyperframes info failed on $dir" >&2; exit 2; }
duration="$(printf '%s\n' "$info" | sed -n 's/^ *"duration": *\([0-9.]*\).*/\1/p' | head -n 1)"
if [[ -z "$duration" ]] || ! awk -v d="$duration" 'BEGIN { exit !(d > 0) }'; then echo "twice.sh: no duration in hyperframes info for $dir" >&2; exit 2; fi

# The times, evenly over the composition (the last one just before its end), and two fixed shuffles of them: the same
# orders every run, but not one a render would draw them in.
mapfile -t times < <(awk -v d="$duration" -v n="$count" 'BEGIN {
  for (i = 0; i < n; i++) { t = d * i / n; if (t > d - 0.001) t = d - 0.001; s = sprintf("%.3f", t); sub(/0+$/, "", s); sub(/\.$/, "", s); print s }
}')
shuffle() {
  awk -v n="$count" -v seed="$1" 'BEGIN {
    for (i = 0; i < n; i++) p[i] = i
    for (i = n - 1; i > 0; i--) { seed = (seed * 16807) % 2147483647; j = seed % (i + 1); x = p[i]; p[i] = p[j]; p[j] = x }
    for (i = 0; i < n; i++) print p[i]
  }'
}
mapfile -t first < <(shuffle 1)
mapfile -t second < <(shuffle 2)
if [[ "${first[*]}" == "${second[*]}" ]]; then mapfile -t second < <(printf '%s\n' "${first[@]}" | tac); fi

out="$dir/.hyperframes/artifacts/twice"
rm -rf "$out"; mkdir -p "$out"
snap() { # $1: a or b; the rest: the order, as indexes into times
  local name="$1"; shift
  local at="" k
  for k in "$@"; do at+="${at:+,}${times[$k]}"; done
  hyperframes snapshot "$dir" --at "$at" --no-end -o "$out/$name" >"$out/$name.log" 2>&1 || { echo "twice.sh: hyperframes snapshot failed; see $out/$name.log" >&2; exit 2; }
}
echo "  drawing ${#times[@]} frames twice (0s to ${duration}s), each time in its own shuffled order..." >&2
snap a "${first[@]}"
snap b "${second[@]}"

# The still of time index $2 in run $1: snapshot names them by their place in the order it was given.
still() {
  local name="$1" want="$2" order k
  if [[ "$name" == a ]]; then order=("${first[@]}"); else order=("${second[@]}"); fi
  for k in "${!order[@]}"; do
    if [[ "${order[$k]}" == "$want" ]]; then
      local found=("$out/$name"/frame-"$(printf '%02d' "$k")"-at-*.png)
      [[ -f "${found[0]}" ]] || { echo "twice.sh: no still for ${times[$want]}s in $out/$name" >&2; exit 2; }
      echo "${found[0]}"; return
    fi
  done
}
# The largest channel difference between two pictures after averaging 8x8 blocks, 0 to 255.
diff8() {
  ffmpeg -hide_banner -nostdin -loglevel error -i "$1" -i "$2" -lavfi "[0]scale=iw/8:ih/8:flags=area,format=gbrp[x];[1]scale=iw/8:ih/8:flags=area,format=gbrp[y];[x][y]blend=all_mode=difference,extractplanes=r+g+b[r][g][b];[r][g][b]hstack=inputs=3,signalstats,metadata=print:key=lavfi.signalstats.YMAX:file=-" -f null - \
    | sed -n 's/.*YMAX=\([0-9]*\).*/\1/p' | head -n 1
}

bad=(); worst=0; example=""; previous=""; same=1
for i in "${!times[@]}"; do
  a="$(still a "$i")"; b="$(still b "$i")"
  d="$(diff8 "$a" "$b")"
  [[ -n "$d" ]] || { echo "twice.sh: ffmpeg could not compare $a and $b" >&2; exit 2; }
  if (( d > limit )); then bad+=("${times[$i]}s"); (( d > worst )) && { worst=$d; example="$a with $b"; }; fi
  if [[ -n "$previous" ]] && ! cmp -s "$previous" "$a"; then same=0; fi
  previous="$a"
done

status=0
if (( ${#bad[@]} > 0 )); then
  echo "different: the same t drew two different pictures at ${bad[*]} (largest difference $worst of 255, limit $limit)"
  echo "  compare $example"
  echo "  something besides t decides the picture: state kept between updates, unseeded randomness, Date.now or"
  echo "  performance.now, a tween that took its start value from the screen (use fromTo), or media still seeking"
  status=1
else
  echo "same: ${#times[@]} frames drawn twice, in two shuffled orders: same t, same picture"
fi
if (( same == 1 )); then echo "warning: every frame looks the same: the timeline may not draw anything that changes with t"; fi
echo "stills: $out"
exit "$status"
