---
name: skill-creator
description: "The owner's skills and /commands, kept in the app's library, not on disk: make, edit, pin, list, undo. Use when the owner asks to make, fix, pin or undo one, which they have, or to turn work into one."
---

# Skill creator

A skill is a folder with `SKILL.md`: a name and a description that sit in every pinned session's prompt, and a body
Pi reads only when the description matches the task. Most skills fail in one of two ways: Pi never opens them (the
description misses the owner's words), or Pi opens them and gets nothing it did not know (the body explains instead of
instructing). Write against both.

The owner's library in the app keeps them, with a version for every save; they are not files to look for on disk.
Its tools: `skill_save` (a skill, new or edited), `command_save` (a slash command), `library_pin` (a session, a board,
or every session), `library_list` (what it holds, an item's files and versions), `library_undo` and `library_delete`.
Each waits for `tool_search`: call it with the tool's name (`tool_search` with query "library_undo"), then call the
tool. Each change waits for the owner's card; until they approve, what you wrote is only a draft. To pin, list, undo
or delete, that is all: the rest of this skill is for writing one.

## 1. Decide what to make

- **A skill**: a procedure Pi should follow when a kind of task comes up, with steps, checks, or files Pi would
  otherwise rediscover each time.
- **A slash command**: a prompt the owner sends by hand, with arguments (section 6).
- **Neither**: a fact every session needs on every turn (a project rule, a path, a convention) belongs in the
  project's `AGENTS.md` or the wiki, where no decision to load it is needed. A one-off fix is not a skill.

## 2. Find out what it is for

When the owner says "make a skill from what we did", read the conversation first: the tools used, the order, the
corrections the owner made, the result they accepted. Those corrections are the skill's most valuable lines.

When the owner described the work in their message, that is enough to draft: write it and save it (the card is where
they correct it). Ask only what you can neither find nor guess well, with the `interview` tool, never in a chat
message, at most four questions, each with your recommendation:
1. What should Pi do with it, and what comes out (a file, a report, a change)?
2. What would the owner type when they need it? Two or three real phrasings.
3. What should it never do, or when should it stop and ask?
4. Which sessions or board need it (for the pin)?

## 3. Write the description

The description is the only part Pi sees before it decides to open the skill. It is the trigger.

- First what it is for, in a few words; then `Use when …` with the situations and the owner's own words: the nouns,
  file types, tool and project names they actually say. Pi matches words more than ideas: a skill about "form
  actions" is missed when the owner says "the contact form does not submit".
- Do not list the steps. A description that summarises the workflow gets followed instead of the body.
- Third person, no "I" or "you". Keep it under 300 characters (1024 at most): every pinned session pays for it on
  every turn.
- Lean towards triggering: models undertrigger. Name the near cases it covers, and the near case it does not when
  another skill or tool owns that ("not for …").

Name: lowercase letters, digits and hyphens, at most 64, the same as the folder: what it does (`ssp-review`,
`release-notes`), never `helper` or `utils`.

## 4. Write the body

- Lead with what matters most: the rules that must hold every time come first, as standing instructions ("run the
  tests after every edit", not "run the tests").
- Instruct; do not explain what Pi already knows. Give the reason for a rule that takes judgment, in one clause, so Pi
  can apply it to cases the skill did not foresee.
- Match the freedom to the risk: steps in prose where many ways work; the exact command, script or template where one
  mistake breaks something. Give one default, not a menu of options.
- A multi-step job gets numbered steps, and a check that loops: do, check (a script, a test, a list), fix, check
  again, and only then report.
- One concrete example (input → output) beats a paragraph of description. Keep one term for one thing.
- No dates, versions or "new since"; the library keeps the history.
- No secrets. Name the secret (`$SSP_TOKEN`); the owner keeps it in Settings › Secrets.

Size: aim for under 150 lines. Past that, move detail into files beside it and say when to read each:
- `references/<topic>.md`: detail for one branch of the task ("for the PDF variant, read `references/pdf.md`").
  One level deep: `SKILL.md` links every file, files do not link further. A file over 100 lines starts with a short
  table of contents.
- `scripts/`: code Pi would otherwise write again each time, or a check that must be exact. Pi runs it and reads
  only its output: `node scripts/check.ts <file>`, through its interpreter. It fails with a clear message naming
  what is wrong.
- `assets/`: templates and files the output copies.

## 5. Check it, save it, test it

Before saving, reread the draft as a Pi that has not seen this conversation:
- Would the description fire on each of the owner's phrasings from step 2, and stay quiet on a near miss?
- Is every line something Pi would get wrong without it? Cut the rest.
- Does each step say what done looks like?

Then `skill_save` it: `body` is SKILL.md after its front matter (the tool writes `name` and `description`), `files`
the others by path. The owner sees the whole content on a card, and a diff when you edit; nothing is saved until
they approve. A denied card says why: change the draft and save again. To edit, read it first (`library_list` with
its name) and keep the name: an edit keeps the old version (`library_undo`), never save `name-v2`. A new skill is
pinned nowhere: pin it where the owner said (`library_pin`; ask when they did not).

Test the triggering with three prompts, written as the owner would type them, not naming the skill:
1. a plain request it must catch;
2. an indirect one (a symptom, a different word for the same thing);
3. a near miss that shares its words but needs something else.

For each prompt, a fresh session (an earlier read would count for the next): start it in the work's folder
(`session_start`, first message "Wait for my next message."), pin the skill to it (`library_pin`), send the prompt
(`session_send`), and read what Pi did (`session_wait`, `session_read`). Pass: it read the `SKILL.md` for 1 and 2,
not for 3, and followed the steps. A miss on 1 or 2: add the missing words to the description. A wrong fire on 3:
narrow it or add "not for …". Opened but not followed: fix the body, not the description. Save the fix and run the
prompts again, then tell the owner which passed, and archive the test sessions.

## 6. Slash commands

A slash command is a prompt template: typing `/ssp-review abc` puts the filled text into the message box. It suits a
prompt the owner fires by hand, on their own timing (a review, a release, a deploy); a skill suits work Pi should
recognise by itself.

- Name it like a skill. The description is one line the owner reads in the `/` list: what it does, not when.
- The argument hint shows what to type: `<issue>` for a required argument, `[focus]` for an optional one.
- Arguments: `$ARGUMENTS` (or `$@`) for all of them, `$1`, `$2` for one, `${1:-default}` for one with a default.
  Quote a value with spaces: `/review "API compatibility"`.
- Write the text as a complete request the owner would send: what to do, on what (`$1`), and what to report. It runs
  once, so it holds no standing rules; when it needs a procedure, have it name the skill to follow.
- Make it work with no arguments too: a default, or "ask me which … when none is given".

Save it with `command_save`; the owner approves it on a card. Test it once: fill it with a real argument and read the
text it gives.
