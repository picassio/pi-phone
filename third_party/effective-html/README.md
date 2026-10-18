# Effective HTML's skills, for pi-phone

From [plannotator/effective-html](https://github.com/plannotator/effective-html) (MIT, see `LICENSE`) at commit
`975b047f6da6874e176db54f048c0c31c30e9f65` (2026-10-15): its `skills/` folder, whole. They guide self-contained HTML
artifacts: `html` (the router: reports, explainers, presentations, tools), `design-artifact` (creative direction),
`html-wireframe`, `html-prototype`, `html-plan`, `html-diagram`, and `big-pics-little-words` (invoked by name only:
`/skill:big-pics-little-words`).

pi-phone offers them to Pi in every session on the phone (`SkillSources.builtIn`, after the owner's own skills, so a
skill of theirs by the same name comes first). Plan mode points to `html-plan` for long plans (`extensions/plan.ts`).

## pi-phone's change

Each `SKILL.md` gets one note after its front matter, marked `<!-- pi-phone: added ... -->`: publish with the `artifact`
tool so the result opens on the phone (and write a file when asked), keep artifacts self-contained for their sandbox,
design for phone widths first, and check the result with the `screenshot` tool (pi-phone's browser check). Nothing else is changed.

To update: copy upstream's `skills/` at a new commit here, add the same note, and update the commit above.
