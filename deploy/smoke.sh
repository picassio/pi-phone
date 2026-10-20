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
docker exec "$name" timeout 180 node /opt/smoke.ts
echo "smoke test passed"
