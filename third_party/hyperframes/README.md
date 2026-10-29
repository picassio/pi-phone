# HyperFrames, as pi-phone installs it on a machine

[HyperFrames](https://github.com/heygen-com/hyperframes) by HeyGen (Apache-2.0, npm package `hyperframes`) renders HTML
and GSAP compositions to MP4. pi-phone installs it as a machine tool (`HYPERFRAMES_TOOL` in
`src/server/machine-tools.ts`, PP-246); none of its code is in the app.

- `package.json` names `hyperframes` at one exact version; `package-lock.json` pins it and every dependency with its
  `integrity` (sha512), as npm resolved them. The app copies both to `~/.pi/mobile/tools/hyperframes/<version>/app/` on
  the machine, and the tool's own Node (24.22.2 LTS from nodejs.org, checked by its sha256, in the same folder) runs
  `npm ci --ignore-scripts --omit=dev`: npm checks each package against the lockfile's integrity. No install script
  runs; HyperFrames needs none (esbuild's postinstall only checks its binary, which its platform package brings).
- The wrapper `~/.pi/mobile/tools/bin/hyperframes` sets `HYPERFRAMES_NO_TELEMETRY=1` and `DO_NOT_TRACK=1` (its PostHog
  telemetry off), `HYPERFRAMES_NO_UPDATE_CHECK`, `HYPERFRAMES_NO_AUTO_INSTALL`, `HYPERFRAMES_NO_OPTIONAL_INSTALL` and
  `HYPERFRAMES_SKIP_SKILLS` (no update checks, no installs of itself, its skills or optional packages), and points
  `HYPERFRAMES_BROWSER_PATH`, `HYPERFRAMES_FFMPEG_PATH` and `HYPERFRAMES_FFPROBE_PATH` at pi-phone's Chrome headless
  shell and ffmpeg tools, which install before it.

To update: set the new version in `package.json`, run `npm install --package-lock-only --ignore-scripts` here, check
that `node_modules/hyperframes` and its dependencies still declare no install script other than esbuild's
(`hasInstallScript` in the lockfile), and bump `version` in `HYPERFRAMES_TOOL` (also for a new Node).
