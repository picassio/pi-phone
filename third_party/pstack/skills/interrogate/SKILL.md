---
name: interrogate
description: "Use for \"interrogate\", \"adversarial review\", \"multi-model review\", \"challenge this\", \"stress test this code\", \"find blind spots\", or \"tear this apart\". Adversaries try to break a change or design, and only findings proven by a run survive."
disable-model-invocation: true
---

# Interrogate

Adversaries try to break a change or a design. A finding survives only when a run proves it. Report the findings. Do not apply fixes.

## Frame

The scope is what the user names. Otherwise it is the branch diff from its merge base with the base branch, through the working tree. State the intent with the **in-your-own-words** skill, from the user's message, the commits, and the PR description. Ask the user when the intent is unclear.

## Fan out

<!-- pi-phone: adapted (third_party/pstack/README.md) -->
The owner picks the models, and each pick is one adversary. Call `models` with `available: true`. Then ask on one `interview` card, as a `multi` question with one option per ready model, written `provider/modelId`. Recommend two or three models from different providers, the owner's favorites first, and say each one's price. Each ticked option approves one spawn. Spawn only on the models ticked on that card. Never add, pick, or swap a model yourself. When an adversary fails because of its model or provider, tell the owner and do not start it again on another model. With nothing ticked, stop. Without the `interview` tool, say that /interrogate needs the Interview extension and stop.

Give each adversary its own git worktree beside the repository, so no two of them share files:

```bash
repo=$(git rev-parse --show-toplevel); wt="$repo-interrogate-<n>"
git worktree add --detach "$wt" HEAD
git diff HEAD --binary | git -C "$wt" apply --binary --allow-empty
git ls-files -z --others --exclude-standard | tar --null -T - -cf - | tar -xf - -C "$wt"
```

That copies the scope's uncommitted changes into it, untracked files included. Spawn every adversary in one message with `subagent` (action `spawn`, name `interrogate-<n>`). Pass the model the owner ticked as `model`: the card is the owner asking for it, and a model not allowed for subagents asks the owner on its own card first. Each brief starts with the rules for subagents below, then the adversary's worktree path (it works only there, and starts every bash command with `cd` into it), the scope, the intent, and this brief:
<!-- /pi-phone -->

> Break this change. Prove each finding with a run against the real code, such as a failing test, a repro script, or command output that shows the wrong behavior. For a design or plan, run a prototype or probe the current tree. Keep repros in your own worktree. Report each finding with a title, the exact command, the output it printed, and the output the intent requires. Leave out anything you did not run. That covers style, naming, structure, and risks that need a future change to matter. No findings is a valid result.

<!-- pi-phone: added (third_party/pstack/README.md) -->
The rules for subagents, from pstack's `worker.md`, go at the top of each brief, as they are:

> You are working for the operator. The operator is the person this whole run works for, not the agent that wrote your brief. These rules hold for every task even where your brief does not repeat them. Your brief overrides one only when it says so in so many words.
>
> - If you start a subagent, its brief starts with these rules.
> - The bar in your brief is the whole bar. Add no check, gate, sign-off or review round above it.
> - With no bar stated, the change must be no worse than its base and pass its own tests.
> - Hold or block only for a failing run at this head or a bug a user would hit. Report a problem the base already has in one line.
> - Never call a tool that shows a person a question, such as `interview` or a tool that asks on a card. Make any choice you can undo, then say what you chose and why. Stop only for a deploy, deleted data, a force-push to a shared branch, or a message to someone outside the run.

The adversaries' answers come back to you as messages. Wait for every one of them before you verify.
<!-- /pi-phone -->

## Verify

<!-- pi-phone: adapted (third_party/pstack/README.md) -->
Verify each finding yourself: rerun its exact command in that adversary's worktree, and read what it prints. Keep a finding when the output shows the failure and the failure breaks the intent. Drop the rest, including every finding whose command does not fail when you rerun it. Merge findings that share a root cause.

Adversaries find different failures, so the verdict keeps every verified finding, not one adversary's list.

When the report is written, stop each adversary (`subagent` action `stop`) and remove its worktree with `git worktree remove --force "$wt"`. Keep a worktree only when the owner asks for it.
<!-- /pi-phone -->

## Output

- **Intent**: the restatement.
- **Findings**: for each verified finding, the command, its output, how it breaks the intent, and the adversaries that found it. Say "no verified findings" when none survive.
- **Dropped**: for each adversary, the count of dropped findings and why.

<!-- pi-phone: added (third_party/pstack/README.md) -->
Name each adversary by the model it ran on.
<!-- /pi-phone -->
