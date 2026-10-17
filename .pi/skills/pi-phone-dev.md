---
name: pi-phone-dev
description: Develop and test pi-phone on the phone: run the server from the checkout in Termux, build the APK in CI, install it, and inspect the app's runtime over adb.
---

# pi-phone development on the phone

Repo: `~/projects/pi-phone` (GitHub `picassio/pi-phone`, private). Rules in `AGENTS.md`, design in `DESIGN.md`.

## Layout

| path | role |
| --- | --- |
| `src/server/` | pi-pocket server, cut down; `main.ts` entry; `claude-billing.ts`, `cc-patch.ts`, `phone-settings.ts` are ours |
| `web/` | pi-pocket web app (Preact + htm, no build) |
| `android/` | shell: `MainActivity` (WebView), `PiService` (runs node), `RuntimeInstaller` (extracts assets) |
| `scripts/package-rootfs.ts` | Termux packages -> `rootfs.bin`, prefix rewritten to `/data/data/io.piphone` |
| `scripts/package-runtime.ts` | server -> `runtime.bin` + `runtime-version` |
| `scripts/check-web-imports.ts` | every relative import in `web/` resolves and exports what is imported |

## Checks

```bash
npm run check     # tsc 6 (runs here, ~30 s) + web import check
npm test          # node:test; UI tests skip without Chromium (CI runs them)
for f in $(find web -name "*.js"); do node --check $f; done   # syntax of the web modules
```

## Server from the checkout (Termux)

The APK's server uses port 8787; run the checkout on another port with its own data folder:

```bash
mkdir -p ~/tmp/pi-phone
(setsid nohup node src/server/main.ts --port 8788 --data ~/tmp/pi-phone/pocket-data --cwd ~/tmp > ~/tmp/pi-phone/pocket.log 2>&1 &)
head ~/tmp/pi-phone/pocket.log        # prints the owner's /login?token=... link
pkill -f "main.ts --port 878[8]"      # stop; the [8] keeps pkill from matching this shell
```

Never `pkill -f` with a pattern that matches your own command line: it kills the shell running you.
Billing patch settings: `<data>/phone.json`, `{"claudeCodeBilling":{"enabled":true,"version":"2.1.280"}}`.

## APK

Every push to `master` builds `pi-phone-aarch64` in GitHub Actions (rootfs, runtime, Gradle, signed with the fixed
key in repo secrets). Install it from Termux:

```bash
gh run list --limit 3
gh run download <run-id> -n pi-phone-aarch64 -D ~/tmp/pi-phone/apk
termux-open --content-type application/vnd.android.package-archive ~/tmp/pi-phone/apk/build/outputs/apk/debug/app-debug.apk
```

The user confirms the install prompt. First start extracts the runtime (about a minute); later starts only when
`runtime-version` changes.

## Inspecting the installed app (adb, wireless debugging on the same phone)

Pair once (Settings > Developer options > Wireless debugging > Pair device with pairing code; the user sends the
pairing `IP:port` and code, and the connect `IP:port`):

```bash
adb pair IP:PAIRPORT CODE; adb connect IP:CONNECTPORT
A() { timeout 20 adb "$@"; }
A shell run-as io.piphone tail -50 files/log/server.log      # server log (the APK is debuggable)
A shell run-as io.piphone cat files/.runtime-version
A shell run-as io.piphone ls files/usr/bin | head
A logcat -d -s pi-phone                                       # PiService errors
A shell screencap -p /sdcard/s.png; A pull /sdcard/s.png ~/tmp/pi-phone/s.png   # then read the image
A shell dumpsys window | rg -o "mCurrentFocus=.*"             # check focus before any tap or text
```

Android 12+: if node children die in the background, disable the phantom process killer:
`adb shell settings put global settings_enable_monitor_phantom_procs false`.
