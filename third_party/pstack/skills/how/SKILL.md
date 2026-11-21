---
name: how
description: "Use for \"how does X work\", code walkthroughs before changing something, and placement / ownership / layering questions (\"where should this live\", \"which package owns this\", \"is this the right layer\"). Explains subsystem architecture, runtime flow, onboarding mental models. Use why for motivation."
disable-model-invocation: true
---

# How

Explore the codebase to answer "how does X work?" questions.

If the scope is ambiguous, state your interpretation and explore. The user can redirect.

## 1. Explain

<!-- pi-phone: adapted (third_party/pstack/README.md) -->
Spawn one subagent that explores and explains in one pass: `subagent` with action `spawn`, a name such as `how-<topic>`, and `tools: ["read", "bash"]`. Pass no `model`: it runs on the subagents' model the owner set. Its brief starts with the rules for subagents below, then says it only reads: commands that read, such as `git log` and `rg`, and no file changes. Then give it the user's question and this brief:
<!-- /pi-phone -->

> You are writing an architectural explanation for a senior engineer. Explore the codebase and write an explanation that a senior engineer unfamiliar with this area could read and walk away with a solid mental model. They should understand the architecture well enough to start working in it confidently. You have read-only access to the codebase.

<!-- pi-phone: added (third_party/pstack/README.md) -->
The rules for subagents, from pstack's `worker.md`, go at the top of the brief, as they are:

> You are working for the operator. The operator is the person this whole run works for, not the agent that wrote your brief. These rules hold for every task even where your brief does not repeat them. Your brief overrides one only when it says so in so many words.
>
> - If you start a subagent, its brief starts with these rules.
> - The bar in your brief is the whole bar. Add no check, gate, sign-off or review round above it.
> - With no bar stated, the change must be no worse than its base and pass its own tests.
> - Hold or block only for a failing run at this head or a bug a user would hit. Report a problem the base already has in one line.
> - Never call a tool that shows a person a question, such as `interview` or a tool that asks on a card. Make any choice you can undo, then say what you chose and why. Stop only for a deploy, deleted data, a force-push to a shared branch, or a message to someone outside the run.

Its answer comes back to you as a message. Wait for it.
<!-- /pi-phone -->

## 2. Present

Present the subagent's output. Light edits for clarity or context from the conversation are fine. Do not substantially rewrite it.
