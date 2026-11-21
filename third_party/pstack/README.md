# pstack's commands, for pi-phone

From [cursor/plugins](https://github.com/cursor/plugins) `pstack/skills/` (pstack 0.15.46 by Lauren Tan,
[@poteto](https://github.com/poteto); MIT, © 2026 Lauren Tan, see `LICENSE`), at commit
`0b46ec399d55f2829e88822998f53b84944837d3`: the thirteen skills the owner chose (PP-541, PP-550, PP-551), each its `SKILL.md`
only. Each keeps pstack's `disable-model-invocation: true`. It is a slash command (`/skill:<name>`) that runs when
someone types it, and no session's system prompt names it.

| Command | What it does |
| --- | --- |
| `interrogate` | Adversaries on models the owner picks try to break a change; only findings whose command fails when rerun survive |
| `blast-radius` | What a change could break elsewhere, with the one fact it is safe because of proven by a run |
| `ketchup` | Catch the owner up since their last message, with every call waiting on them |
| `ketchup-video` | The same catch-up as a short narrated video of slides, rendered on a machine after the owner's card |
| `reflect` | Learnings from this chat, routed to edits of skills (the library) or to the wiki |
| `correct` | Make the mistakes agents repeat in a repo impossible: architecture, types, lints, tests, then docs |
| `why` | Why something is the way it is, from the record: commits, pull requests, the wiki, the board |
| `how` | How something works, explained by one read-only subagent |
| `bro` | The last message again, in plain words |
| `in-your-own-words` | The user's goal, restated |
| `create-formal-verification-skill` | A project skill that formally checks the riskiest part of a repo |
| `unslop-writing` | pstack's `unslop`: cut AI tells from prose |
| `teach` | Explain a body of work so a person understands it, with `how` and `why` |

`scripts/sync-pstack.ts` copies them from a clone at that commit (it refuses another commit or local changes), then
applies `pi-phone.patch`, which must apply cleanly. `--write-patch` writes the patch again after the skills are adapted by
hand.

## Where pi-phone offers them

The **pstack commands** built-in extension (`extensions/pstack.ts`, off by default) owns them. While it is on, sessions
on the phone and in the server edition list them in the / list (`PSTACK_SKILLS`). Off, none does. Turn it on in
Settings › Extensions, or Pi does with `setting_change` `extensions.pstack.ts` on the owner's card. With it on, the
system prompt is the same, character for character, as with it off (`test/pstack.test.ts`).

## pi-phone's changes

`pi-phone.patch` holds them all. In the files, each is marked: a block between `<!-- pi-phone: adapted ... -->` or
`<!-- pi-phone: added ... -->` and `<!-- /pi-phone -->` on lines of their own, or a run inside a line between
`<!-- pi-phone: adapted -->` and `<!-- /pi-phone -->`. The rest is pstack's text.

- `unslop` is `unslop-writing`, in its folder and front matter, because the app's `unslop` (Design & video) is
  heydamir's UI skill. A note under its heading says so, and `blast-radius` and `teach` name it.
- `interrogate`, in place of arena's runners and Cursor's Task tool:
  - The owner ticks the models on one `interview` card. The options come from `models`, and each ticked model
    approves one adversary.
  - Pi spawns only those, with `subagent`, and never adds or swaps one.
  - Each adversary gets a git worktree beside the repository, with the uncommitted changes copied in.
  - Pi reruns each finding's command in that worktree and keeps only those that fail.
  - Then Pi stops the adversaries and removes the worktrees.
- `how` spawns one `subagent` with `read` and `bash` that only reads, on the subagents' model.
- pstack's `worker.md` rules go only into the briefs these two skills give subagents, as a quoted block. These rules
  are left out because these subagents open none: the first line about reading worker.md (it is quoted instead), and
  the pull request rules (ready for review, title, body). The system prompt is unchanged.
- `ketchup` reads the board, subagents and sessions for the current state. A task in Review, and a branch not merged,
  count as calls waiting on the owner. It puts the calls waiting on the owner on
  one async `interview` card, and draws charts as Mermaid in place of `/visualize`.
- `ketchup-video` is narrated, where pstack's is silent:
  - Each subtitle is also the spoken line, one `audio_speak` file per slide.
  - It renders with the HyperFrames machine tool on a machine, and lays in the voice with ffmpeg.
  - It states the cost and the time on an `interview` card, and makes nothing before the owner picks Render.
  - The mp4 is embedded in the reply as Markdown, which the app plays.
- `reflect` saves skill edits to the owner's library with `skill_save` (the owner's card), never into the app's files,
  and puts durable facts in the wiki.
- `why` also reads the wiki, board tasks and DESIGN.md.
- `blast-radius` offers `/skill:interrogate` in place of an arena.
- `create-formal-verification-skill` puts the project skill in `.agents/skills/`, and runs TLC only where pi-phone's
  TLC tool is. It names `/statechart` (Formal checks) without a path. pi-phone has no
  `/maintain-formal-verification-skill`, and the skill says so.
- `teach` loads `how` and `why` from beside it.
- `correct`, `bro` and `in-your-own-words` are pstack's as they are.

Left out of pstack: the other skills, its agents, automations and `poteto-mode`.
