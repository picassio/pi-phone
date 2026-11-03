# DeepSeek Harness's plugin skill, adapted for pi-phone

From [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) (MIT, Copyright (c) 2026
DeepSeek, see `LICENSE`) at commit `ce7073d51254c26cd63b22a60835b8f948deb447` (2026-10-30): its
`packages/preset/agent-preset/skills/cordis-plugin-development/` skill, which teaches DeepSeek Harness's agent to make
a plugin for the Harness Web UI from a chat request (its "Creator mode").

Nothing of it is copied whole: Harness plugins are npm bundles with Cordis patches, and pi-phone's drop-ins are one
TypeScript module with a browser part. pi-phone's own `extension-builder` skill
(`src/extension-builder/skills/extension-builder/`, the Extension builder extension, PP-367) adapts its ideas and some
of its text, rewritten for pi-phone's drop-in API:

| pi-phone file | Adapted from |
|---|---|
| `SKILL.md` | `SKILL.md`: deliver a small working version first, from a template; check the syntax; install; read the result; look at the installed one (never a mock preview); fix the same one; report what was not checked |
| `references/practices.md` | `references/practices.md` (principles: the weakest mechanism, registrations owned by their context, the framework draws, plugin UI is part of the host's UI, theme tokens; performance) and `references/user-actions.md` (one operation, two callers; authority stays the person's) |
| `references/verify.md` | `references/verification.md` (verify in the connected page; no mock pages, no separate browser, no token hunting; say what was not verified) |

`references/server-part.md`, `references/browser-part.md`, the four templates and `scripts/check.mjs` are pi-phone's
own, written for its drop-ins (`src/server/reload.ts`, `src/server/extension-web.ts`, `web/extension-ui.js`).
