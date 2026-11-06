# Motion Video Kit's skill, for pi-phone

From [echris6/motion-video-kit](https://github.com/echris6/motion-video-kit) (MIT, © 2026 echris6, see `LICENSE`) at
commit `e4b1c0004080fe6a0deb883631bad5eba1e5f339`: its `business-motion-film/` folder, whole (`SKILL.md`,
`references/`, `scripts/`, `templates/`), in `skills/`. It plans, builds and critiques short business commercials made
of code-built motion (HTML/GSAP, selective Three.js), with an independent-critic loop ("the Gauntlet"), a quality bar,
audio rules and a business-offer playbook. The 28 reference films are only linked; no footage is redistributed.

pi-phone offers it to Pi in every session on the phone while its Design & video extension is on (the default;
`DESIGN_SKILLS` in `src/server/design-systems.ts`), after the owner's own skills, so a skill of theirs by the same name
comes first.

## pi-phone's change

`SKILL.md` gets one note after its front matter, marked `<!-- pi-phone: added ... -->`: renders are made on a machine
with the HyperFrames machine tool (PP-246), never on the phone; the scripts need ffmpeg, numpy and scipy on that
machine; each critic is a fresh subagent; stills come from the `screenshot` tool.

PP-413 (owner's decision of 2026-11-06, after research PP-407 on [OpenFilm](https://github.com/openfilm/openfilm)) adds
`scripts/twice.sh`, ours: it snapshots a HyperFrames composition at the same times twice, each time in its own shuffled
order (`hyperframes snapshot --at … --no-end -o …`), compares each pair with ffmpeg (8×8 block averages, largest
channel difference over 32 of 255, OpenFilm's `look` limit), and names the times whose pictures differ (exit 1).
`hyperframes check` passes a composition that keeps state between updates; this catches it. `SKILL.md` gets a second
marked note (run `hyperframes check` and `scripts/twice.sh` before every render), step 7 one clause pointing to it, and
`references/quality-bar.md`'s Determinism row names the script. Nothing else is changed.

To update: copy upstream's `business-motion-film/` at a new commit into `skills/`, keep `scripts/twice.sh`, add the
same notes, and update the commit above.

