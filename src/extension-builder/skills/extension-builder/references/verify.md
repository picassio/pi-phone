# Checking a drop-in in the live app

Adapted for pi-phone from DeepSeek Harness's `cordis-plugin-development` skill (`references/verification.md`; MIT,
Copyright (c) 2026 DeepSeek).

## Before installing

- `node <skill>/scripts/check.mjs <cwd>/<name>` says `ok`. It never runs the drop-in.
- Read the module once more for what the check cannot see: every word through `t()` with `WORDS`, tools and the page
  on the same functions, timers stopped in `onDispose`.

## After the owner turns it on

1. **Did it load?** `extension_inspect` with its name: on or off, loaded, failed or refused and why (a tool's name,
   nothing added), and what it added on the server. `setting_change` also answers with the error. Fix it and install
   again.
   After a tab loaded it (a screenshot of the app is one), ask again: its browser part's page and sheet ids (with
   their links), and its newest error in a tab, which a picture may not show.
2. **Its tools:** call each once with real arguments, then a wrong one: the answers are what Pi should read.
3. **Its page or sheet:** `screenshot` with url `http://127.0.0.1:8787/?page=<name>:<page id>` (or
   `?sheet=<name>:<sheet id>`), widths 390 and 1280. Go by the layout check's numbers (what spills out of its box,
   a page wider than the screen) over the picture. Look for: the theme's colours (no colour of its own), text that
   fits at 390 px, a state as a StateTag, line icons only, the app's dropdowns, nothing cut off. A page that shows
   "failed to load in this browser" or "failed: …" names its error: fix that first.
4. **Rail, menu, launcher:** a screenshot of `http://127.0.0.1:8787/` at 1280 px shows the rail with its button; a
   menu row or launcher action needs Pi's browser to open the menu or the launcher first.
5. **Both callers:** for each operation the page and a tool share, do it with the tool and see the page show it.
6. **Put back** what you changed while checking (test items, a timer left running), unless the person wants it.

## What not to do

- Never a mock page, an HTML copy of the design, a picture made another way, or a renderer of your own in place of the
  installed drop-in: a picture of something else does not check it.
- Never read the app's token, change `HOME`, open browser profiles, or reach into the app's API or WebView to look at
  it: the `screenshot` tool and Pi's browser are the ways to look.
- Never install it again in a loop without reading why it failed.

## What to report

Where it is (rail, menu, launcher; its tools), what you checked and how (tool calls, screenshots at 390 and 1280), and
what you could not check (a menu row you did not open, the other theme, another person's access). The owner turns it
off in Settings › Extensions; it stays off after an update until turned on again.
