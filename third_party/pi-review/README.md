# pi-review's review rubric, for pi-phone

**The rubric.** `REVIEW_RUBRIC.md` is the `REVIEW_RUBRIC` text of [earendil-works/pi-review](https://github.com/earendil-works/pi-review)
(`review.ts`, itself adapted from Codex's review prompt) at commit `f1de050504936046c0f85b21fec0e0a93ef394eb`
(2026-07-19), copied as it is. MIT licence, Copyright (c) 2026 Earendil Inc. (see `LICENSE`, upstream's copy).

It tells a reviewer what to flag (discrete, provable issues the change introduced; clean-code, untrusted input and
fail-fast rules), how to write a finding, the priorities P0 to P3, a verdict ("correct" or "needs attention"), and a
closing "Human Reviewer Callouts (Non-Blocking)" section.

## How pi-phone uses it

The `review` tool (PP-357, `src/server/review.ts`) starts a subagent with this rubric, the target's instructions
(uncommitted changes, a branch, a commit, a GitHub pull request, or folders), the project's `REVIEW_GUIDELINES.md`
when there is one, and pi-phone's own output format: the same findings, also as a `review-result` JSON block that the
app draws as a card. The rubric itself is not changed; pi-phone's additions come after it.

Nothing else of pi-review is used: its `/review` and `/end-review` commands, menus and tree navigation are written for
Pi's terminal UI.
