#!/usr/bin/env bash
# Builds native/agy-tls (PP-559), Google Antigravity's requests on Go's TLS, for one platform:
#   scripts/build-agy-tls.sh android-arm64   -> native/android-arm64/agy-tls/agy-tls (the APK's runtime)
#   scripts/build-agy-tls.sh linux-x64       -> native/linux-x64/agy-tls/agy-tls     (the server edition, CI's tests)
#   scripts/build-agy-tls.sh linux-arm64     -> native/linux-arm64/agy-tls/agy-tls
# Needs Go 1.26 or later (native/agy-tls/go.mod). Static, no cgo, stripped, the same input giving the same file.
set -euo pipefail

target="${1:?usage: build-agy-tls.sh android-arm64|linux-x64|linux-arm64}"
case "$target" in
    android-arm64) goos=android goarch=arm64 ;;
    linux-x64) goos=linux goarch=amd64 ;;
    linux-arm64) goos=linux goarch=arm64 ;;
    *) echo "unknown target: $target" >&2; exit 2 ;;
esac

root="$(cd "$(dirname "$0")/.." && pwd)"
out="$root/native/$target/agy-tls/agy-tls"
mkdir -p "$(dirname "$out")"
cd "$root/native/agy-tls"
CGO_ENABLED=0 GOOS="$goos" GOARCH="$goarch" go build -trimpath -buildvcs=false -ldflags="-s -w" -o "$out" .
echo "built $out ($(go version))"
