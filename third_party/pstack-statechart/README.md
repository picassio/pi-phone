# pstack's /statechart skill, for pi-phone

**The skill.** From [cursor/plugins](https://github.com/cursor/plugins) `pstack/skills/statechart/` (pstack 0.15.36 by
Lauren Tan, [@poteto](https://github.com/poteto); MIT, © 2026 Lauren Tan, see `LICENSE`), at commit
`ae5650febf4320793844c12c4adaa937f417f8da`, in `skills/statechart/`: `SKILL.md`, `references/render.md` and `scripts/`
(9.4k lines of TypeScript, no runtime dependencies). `scripts/test/` (3.6 MB of tests and a Java oracle) is left out.
It checks a TLA+ model with TLC (SANY, then TLC with one worker, each broken rule removed and run again, then TLC's
state graph) and writes `chart.mmd` (a Mermaid statechart in the reader's words), `report.md` (each broken rule with the
shortest path to it) and `tlc.out`. Exit codes: 0 every rule holds, 1 a rule breaks, 2 an error. It needs Node 22.18 or
later (or Bun, or Deno 2), Java 11 or later and tla2tools.jar 1.7.4.

**The examples.** From [kevintngo/statechart-art](https://github.com/kevintngo/statechart-art) (MIT, © 2026 Kevin T.
Ngo, see `skills/statechart/examples/LICENSE`), at commit `09c959c79e25767cc34a5beddf3df234b085636e`: the four boba
models of `business/`, in `skills/statechart/examples/`, each its `Spec.tla` and `.cfg`, `view.mjs`, and the `chart/`
(`chart.mmd`, `report.md`) that /statechart wrote. The art (the plates' layouts and drawing scripts) is left out.

| Example | Shows |
| --- | --- |
| `order` | a flat chart with a branch and a loop |
| `day` | parent states |
| `counter` | two parallel regions |
| `bug` | a rule that breaks, and the shortest path to it (exit 1) |

`scripts/sync-statechart.ts` copies both from clones at those commits (it refuses another commit or local changes).

## Where pi-phone offers it

The **Formal checks** built-in extension (`extensions/formal.ts`, on by default) owns it:

- On the phone and in the server edition, sessions list the skill while the extension is on (`FORMAL_SKILLS`).
- On a machine, the **TLC** machine tool (Settings › Machines › Install tools, opt-in: Temurin JRE 21 and
  tla2tools.jar 1.7.4, each pinned by its sha256) copies this folder's `skills/` beside it, and sessions there list the
  skill while the extension is on. bash there has `TLA2TOOLS` and `JAVA` set to the tool's files.
- The server edition's image carries the same JRE and tla2tools.jar, with `TLA2TOOLS` and `JAVA` set.
- The phone has no Java: Pi may draw a chart by hand there, said to be unchecked, and offers to check it on a machine.

## pi-phone's changes

`SKILL.md` only:

- One note after its front matter, marked `<!-- pi-phone: added ... -->`: run only where `TLA2TOOLS` is set (a machine
  with the TLC tool, or the server edition), never install Java or TLC and never use mise; run the script with `sh`;
  the exit code is the verdict (1 is a broken rule, reported with its path); show `chart.mmd` as a mermaid block, as
  the app draws it with pele; on the phone, an unchecked chart only, said so, with an offer to check it on a machine;
  where the examples are.
- The front matter's `disable-model-invocation: true` is left out, so Pi can pick the skill when it fits, not only when
  someone types `/statechart`.

Nothing else is changed. To update: change the commits in `scripts/sync-statechart.ts`, run it, read the new
`SKILL.md` against the note, run `test/statechart.test.ts` on a machine with Java, and update the commits above.
