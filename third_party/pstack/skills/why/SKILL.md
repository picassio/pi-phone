---
name: why
description: "Use for 'why does X work this way', 'why we picked Y', design rationale, regressions, postmortems, or data-backed thresholds. Returns a cited read on decisions and tradeoffs. Use how for runtime behavior."
disable-model-invocation: true
---

# Why

Answer from the record, not the code: read the commits and PR discussions that introduced the target and each later change, and other sources if the trail is thin. Cite what the authors wrote, mark your own inferences as inferences, and say what the record does not answer.

<!-- pi-phone: added (third_party/pstack/README.md) -->
In pi-phone the record also holds the wiki (`wiki_query`, then `wiki_read`), the board's tasks with their comments and activity (`task_list`, `task_get`), and the design notes in the repository, such as DESIGN.md. Cite each by its page, task, or section.
<!-- /pi-phone -->
