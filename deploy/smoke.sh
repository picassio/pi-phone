#!/bin/sh
# Smoke test of a server edition image, after a local build (deploy/README.md): a fresh container serves the app,
# carries its tools, and Pi's browser and the screenshot renderer work in it (deploy/smoke.ts).
#
#   deploy/smoke.sh pi-phone-server:local
set -eu
image="$1"
name="pi-phone-smoke-$$"
here="$(cd "$(dirname "$0")" && pwd)"
trap 'docker rm -f "$name" >/dev/null 2>&1 || true' EXIT

docker run -d --name "$name" -p 127.0.0.1::8787 -v "$here/smoke.ts:/opt/smoke.ts:ro" "$image" >/dev/null
port="$(docker port "$name" 8787/tcp | head -1 | sed 's/.*://')"

# Serving within a minute.
for _ in $(seq 60); do
    [ "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$port/")" = 200 ] && break
    sleep 1
done
[ "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$port/")" = 200 ] || { docker logs "$name"; exit 1; }
echo "serves on :$port"

docker exec "$name" sh -c 'set -e; node --version; git --version; gh --version | head -1; ssh -V; rg --version | head -1; fd --version; officecli --version; /app/native/linux-*/chrome/chrome-headless-shell --version'
# TLC (PP-316): its Java, and the statechart skill on the boba Bug model, whose rule breaks (exit 1) as its report says.
docker exec "$name" sh -c 'set -e; "$JAVA" -version 2>&1 | head -1; "$JAVA" -cp "$TLA2TOOLS" tlc2.TLC --version | head -1
    skill=/app/third_party/pstack-statechart/skills/statechart; out=$(mktemp -d)
    code=0; sh $skill/scripts/statechart $skill/examples/bug/Bug.tla --view $skill/examples/bug/view.mjs --out "$out" >/dev/null || code=$?
    [ "$code" = 1 ] || { echo "statechart exited $code, not 1" >&2; exit 1; }
    cmp "$out/chart.mmd" $skill/examples/bug/chart/chart.mmd; cmp "$out/report.md" $skill/examples/bug/chart/report.md
    rm -rf "$out"; echo "statechart: the Bug model breaks NeverServeOldPearls, as its report says"'
docker exec "$name" timeout 180 node /opt/smoke.ts
echo "smoke test passed"
