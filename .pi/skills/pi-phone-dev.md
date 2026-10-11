---
name: pi-phone-dev
description: Develop and test pi-phone on the phone itself from Termux. Run the server, workers, Metro, and Expo Go; verify through smoke scripts, logs, and ADB screenshots and taps.
---

# pi-phone development on the phone

Repo: `~/projects/pi-phone`. pi checkout (read-only dependency): `~/projects/pi` (`PI_CHECKOUT`). Rules in
`AGENTS.md`; design in `DESIGN.md` and `UI.md`. Never modify the pi checkout; `bin/resolver.mjs` adapts it at load.

## Layout

| path | role |
| --- | --- |
| `bin/run.mjs` | runs a TS entry with pi's source resolver and ours preloaded (`NODE_OPTIONS`, inherited by spawned workers) |
| `bin/resolver.mjs` | `pi-src/*` imports; redirects pi's worker entry to `server/worker.ts`; patches the Unix listener's hard link to `rename` |
| `server/main.ts` | pi's experimental server + WebSocket `ws://127.0.0.1:7741/pi` + `GET /health` + `POST /admin/shutdown`; token in `~/.pi-phone/token` |
| `server/worker.ts`, `harness.ts` | our Session worker (`process.title` `pi-phone-worker`), Harness composition |
| `server/models.ts`, `cc-patch.ts`, `settings.ts` | ModelRuntime wrapper with `onPayload`; Claude Code billing patch; `~/.pi-phone/settings.json` |
| `server/facets/` | worker services (`Providers`, more to come); contracts in `contracts/` (runtime-neutral) |
| `client/ws-transport.ts` | pi-client transport over the WebSocket API (Node and React Native) |
| `scripts/*.ts` | smoke scripts |
| `app/` | Expo app; `src/lib/connection.ts`, `src/model/view.ts`, `src/app/*` screens |

## Server

```bash
cd ~/projects/pi-phone
nohup npm run server > ~/tmp/pi-phone/phone-server.log 2>&1 &     # start (mkdir -p ~/tmp/pi-phone first)
curl -s "http://127.0.0.1:7741/health?token=$(cat ~/.pi-phone/token)"  # {"serverId":..,"uptimeMs":..,"workerPids":{}}
curl -s -X POST "http://127.0.0.1:7741/admin/shutdown?token=$(cat ~/.pi-phone/token)"; sleep 4  # stop, then restart
```

Restart the server after changing anything under `server/` (workers are spawned fresh per Session, so worker-side
changes apply to new Sessions without a server restart, but `main.ts`/`http.ts`/`ws-listener.ts` need one). The
coordinator survives server restarts by design. Session dirs: `~/.pi/agent/experimental/sessions/<id>/`.

Logs: server `~/tmp/pi-phone/phone-server.log`; workers `~/.pi-phone/logs/worker.log` (pi spawns workers with stdio
ignored; our worker redirects console there). Worker processes show as `pi-phone-worker` in `ps`.

Never `pkill -f` with a pattern that matches your own shell command (it kills the pi session running you). Use the
shutdown endpoint, or `pkill -f "pi-phone-server.mjs"`.

Settings (`~/.pi-phone/settings.json`, re-read on mtime change, unknown keys rejected):
`{"claudeCodeBilling":{"enabled":true,"version":"2.1.280"}}`.

## Smoke scripts and tests

```bash
npm test                                            # node:test: token, transport, cc-patch, settings
npm run smoke                                       # attach over WS, stream Transcript, get an answer
node bin/run.mjs scripts/ws-smoke.ts ws://127.0.0.1:7741/pi "prompt" anthropic/claude-haiku-4-5
node bin/run.mjs scripts/providers-smoke.ts         # Providers facet: list, start OAuth, answer select, cancel
```

Billing patch check: ask `Quote the very first line of your system prompt verbatim` on an Anthropic model. Patched:
pi's preamble with "operating as a coding assistant". Unpatched: "You are Claude Code, Anthropic's official CLI".

Type checking does not run on the phone (TypeScript 7 and Biome lack Android binaries); tests do.

## Metro and Expo Go

```bash
cd ~/projects/pi-phone/app
(nohup npx expo start --localhost --port 8081 > ~/tmp/pi-phone/metro.log 2>&1 &); sleep 25
curl -s -o /dev/null -w "%{http_code}\n" "http://127.0.0.1:8081/node_modules/expo-router/entry.bundle?platform=android&dev=true&minify=false"  # 200 = compiles
am start -a android.intent.action.VIEW -d "exp://127.0.0.1:8081"   # open in Expo Go
curl -s "http://127.0.0.1:8081/reload"                              # reload connected clients
```

`app/.env` (gitignored): `EXPO_PUBLIC_PI_TOKEN=<token>` prefills the server token; `EXPO_PUBLIC_PI_AUTORUN=1` makes
the app create a session, send a prompt, and log what it renders (`LOG autorun: ...` in metro.log). Metro's log
shows the app's `console.log` lines and bundling errors; `Android Bundled N modules` confirms a load.

If Metro was restarted, Expo Go keeps the old bundle and gets no Fast Refresh: `adb shell am force-stop
host.exp.exponent` then open the `exp://` URL again. Running a command in a `( ... & )` subshell that is then killed
with `pkill` can take the tool call down with it; start Metro in its own command.

## Driving the UI with ADB (wireless debugging on the same phone)

One-time: Settings > Developer options > Wireless debugging > Pair device with pairing code; the user sends the
pairing `IP:port` and code, and the connect `IP:port` from the main page. The connect port changes when wireless
debugging restarts; pairing persists.

```bash
adb pair 192.168.1.32:PAIRPORT CODE
adb connect 192.168.1.32:CONNECTPORT
A() { timeout 20 adb "$@"; }
A shell dumpsys window | rg -o "mCurrentFocus=.*"          # MUST show host.exp.exponent before any tap/text
A shell screencap -p /sdcard/s.png; A pull /sdcard/s.png ~/tmp/pi-phone/shots/s.png   # then read the image
A shell uiautomator dump /sdcard/ui.xml; A pull /sdcard/ui.xml ~/tmp/pi-phone/shots/ui.xml
rg -o 'text="[^"]{1,200}"' ~/tmp/pi-phone/shots/ui.xml       # rendered texts, including under the keyboard
rg -o 'text="SEND"[^>]*bounds="\[[0-9,]+\]\[[0-9,]+\]"' ~/tmp/pi-phone/shots/ui.xml   # element bounds
A shell input tap X Y; A shell input text "words%sseparated%sby%s%%s"; A shell input keyevent 111   # 111 = Esc closes the keyboard
```

Rules learned the hard way:

- Check `mCurrentFocus` first. In split screen, taps and `input text` go to the focused window, which may be the
  Termux session running you; typed text then lands in your own prompt.
- The keyboard covers the composer buttons; close it (`keyevent 111`) before tapping SEND, or read bounds from the
  dump after closing it.
- Tap into the app pane once to move focus before typing.
- Screenshots are of the unfolded display (2448x1848); the pane split is at x~1000 when Termux shares the screen.
- `adb` prints a "Multiple displays" warning on every screencap; harmless.

## Login

Credentials are pi's (`~/.pi/agent/auth.json`): `pi` then `/login` in Termux works, as will the app's Providers
sheet. Anthropic OAuth redirects to `localhost:53692`, which Termux serves, so no code paste is needed on the phone.
`pi auth print-bearer-token --provider anthropic` checks validity.
