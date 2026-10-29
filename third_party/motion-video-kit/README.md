# Motion Video Kit's skill, for pi-phone

From [echris6/motion-video-kit](https://github.com/echris6/motion-video-kit) (MIT, © 2026 echris6, see `LICENSE`) at
commit `e4b1c0004080fe6a0deb883631bad5eba1e5f339`: its `business-motion-film/` folder, whole (`SKILL.md`,
`references/`, `scripts/`, `templates/`), in `skills/`. It plans, builds and critiques short business commercials made
of code-built motion (HTML/GSAP, selective Three.js), with an independent-critic loop ("the Gauntlet"), a quality bar,
audio rules and a business-offer playbook. The 28 reference films are only linked; no footage is redistributed.

pi-phone offers it to Pi in every session on the phone (`SkillSources.builtIn`, after the owner's own skills, so a
skill of theirs by the same name comes first).

## pi-phone's change

`SKILL.md` gets one note after its front matter, marked `<!-- pi-phone: added ... -->`: renders are made on a machine
with the HyperFrames machine tool (PP-246), never on the phone; the scripts need ffmpeg, numpy and scipy on that
machine; each critic is a fresh subagent; stills come from the `screenshot` tool. Nothing else is changed.

To update: copy upstream's `business-motion-film/` at a new commit into `skills/`, add the same note, and update the
commit above.
