---
name: html-plan
description: Direct-invocation specialist for clear, self-contained HTML plans that preserve source material while improving hierarchy, sequence, ownership, dependencies, and reviewability. Use when the user explicitly invokes html-plan or the broad html skill routes a plan request here. Do not activate independently from a general request.
---

<!-- pi-phone: added (third_party/effective-html/README.md). -->
> **In pi-phone:** publish the finished HTML with the `artifact` tool (type `html`), so it opens on the person's phone, and also write it to a file when they ask for one or the work belongs in a project. Artifacts run in a sandbox with no way into the app: keep them self-contained (libraries from a CDN with full URLs are fine) and touch-friendly. Most people here read on a phone: design for about 360–430 px wide first, then desktop. You have no browser to look with: check the layout by reasoning about those widths, and say what you could not check.

# HTML Plan

Turn source material into a plan people can inspect and act on. Preserve the user's scope, ordering, commitments, and terminology unless they ask for broader synthesis.

## Shape the document around the work

Read the conversation, project instructions, and supplied plan before designing. Match an existing design language when one is present. Otherwise derive a quiet, workmanlike direction from the audience and subject.

When [`design-artifact`](../design-artifact/SKILL.md) is available, read its
fundamentals to make that direction intentional. Keep this skill's traceability
and source-preservation rules authoritative; creative direction must not
inflate the plan into a dashboard or campaign page.

Decide what the plan actually needs:

- phases or sequence;
- status and decision points;
- owners and collaborators;
- dependencies and risks;
- acceptance checks;
- unresolved questions.

Do not add a timeline, progress percentage, status badge, or dashboard summary unless the source supports it. Improve grammar and structure without inflating an implementation plan into a strategy document.

## Preserve traceability

- Keep source commitments recognizable.
- Separate accepted decisions from assumptions and open questions.
- Show sequence and dependency only where they are real.
- Use tables for exact mappings, comparisons, or repeated fields.
- Use a flow or timeline only when it makes order materially easier to understand.
- Keep long prose readable instead of forcing every paragraph into a card.

## Build and verify

Deliver one responsive, accessible, self-contained HTML file. Use semantic headings, lists, tables, and landmarks. Keep essential CSS and JavaScript inline, avoid external services, and make any navigation or disclosure keyboard-operable.

Inspect the result at wide and narrow widths. Check that no commitment disappeared, that stages remain in the intended order, that ownership and dependencies are legible, and that long content does not overflow.

Return the absolute path and note any structural interpretation you introduced.
