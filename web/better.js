// `/better` (PP-506, pi-better by Nico Bailon): a read-only helper deepens a prompt, or the task in progress, in the
// background. While it works, two rows above the message box say what it does: a six-cell meter (reading, the four
// questions, writing) with its step and time and Stop, then its newest tools with ✓ or ✗. Its rewrite then goes into the
// message box of the person who asked, above what they typed meanwhile; nothing is sent. Esc stops it on a desktop.
import { useEffect, useState } from "preact/hooks";
import { t, tn } from "./i18n.js";
import { fromServer } from "./seen.js";
import { api, attempt, canSteer, navigate, notify, store } from "./store.js";
import { html, Icon } from "./ui.js";

/** One per question of helper.md, in its order: what the helper works out then. */
const STEPS = [
    () => t("Reading your code and files"),
    () => t("Working out what a pro would do"),
    () => t("Finding the rawest material"),
    () => t("Picking the methods and tools"),
    () => t("Deciding what would prove it right"),
    () => t("Writing your improved prompt"),
];

/** The same, where a phone's row is narrow (pi-better's short forms). */
const SHORT = [
    () => t("Reading files"),
    () => t("Thinking"),
    () => t("Thinking"),
    () => t("Thinking"),
    () => t("Thinking"),
    () => t("Writing prompt"),
];

/** The results this browser put in a message box already, by the run's task: a reload must not add one again. */
const APPLIED_KEY = "pocket.betterApplied";
/** A result older than this, found on opening a session, is not put in the box any more. */
const FRESH_MS = 24 * 60 * 60 * 1000;

function applied() {
    try {
        return new Set(JSON.parse(localStorage.getItem(APPLIED_KEY) ?? "[]"));
    } catch {
        return new Set();
    }
}

function markApplied(id) {
    // The newest few are enough.
    const kept = [...applied(), id].slice(-50);

    localStorage.setItem(APPLIED_KEY, JSON.stringify(kept));
}

/** `/better <prompt>`, or `/better` alone for the task in progress: the helper starts; the rows show it. */
export async function startBetter(prompt) {
    await api(`c/${store.state.conversationId}/better`, { text: prompt });
}

/** Stop this session's helper. */
export function stopBetter() {
    return attempt(() => api(`c/${store.state.conversationId}/better/stop`, {}));
}

/**
 * Esc on a desktop: while the helper works, the first Esc that nothing else takes stops it (pi-better's way); the next
 * goes on to stop Pi as usual. True when it took the key.
 */
export function stopBetterOnEscape() {
    const { view, sheet, launcher, board, page, drawer } = store.state;

    if (sheet || launcher || board || page || drawer || !view.better?.running || !canSteer()) {
        return false;
    }

    stopBetter();

    return true;
}

/** What a failed run says, and what to do. */
function failure(last) {
    switch (last.error) {
        case "cancelled":
            return t("/better stopped; nothing was sent.");
        case "timeout":
            return t("/better stopped after 20 minutes. Try again with a narrower prompt.");
        case "model":
            return t("/better's helper got no answer from its model: {why}. Check the model or its sign-in, then run /better again.", { why: last.detail ?? "" });
        case "no-reply":
            return t("/better's helper finished without replying. Run /better again.");
        case "no-block":
            return t("/better's helper did not end with an <improved-prompt> block. Tap to read its whole reply, then run /better again.");
        case "empty-block":
            return t("/better's helper left the <improved-prompt> block empty. Tap to read its whole reply, then run /better again.");
        default:
            return t("/better failed: {why}", { why: last.detail ?? last.error });
    }
}

/**
 * The result of the person's own run, once: the rewrite above the draft (`update`, the box's), or what went wrong. A
 * reply that has no prompt can be read in the helper's conversation, which the notice opens.
 */
export function useBetterResult(draft, update, focus) {
    const { view, me, conversationId } = store.state;
    const last = view.better?.last;

    useEffect(() => {
        if (!last || last.by !== me?.id || applied().has(last.id) || Date.now() - fromServer(last.at) > FRESH_MS) {
            return;
        }

        markApplied(last.id);

        if (!last.ok) {
            const open = last.helper !== undefined && last.error !== "cancelled" ? () => navigate(last.helper) : undefined;

            notify(last.error === "cancelled" ? "info" : "error", failure(last), open);

            return;
        }

        const typed = draft().trim();

        update(typed === "" ? last.improved : `${last.improved}\n\n${typed}`, last.improved.length);
        focus(last.improved.length);
        notify(
            "info",
            typed === ""
                ? t("The improved prompt is in your message box. Edit it, then send.")
                : t("The improved prompt is in your message box, above what you typed. Edit it, then send."),
        );
    }, [last?.id, conversationId, me?.id]);
}

/** How long it has worked: 8s, 1m 27s. */
function clock(ms) {
    const seconds = Math.max(0, Math.floor(ms / 1000));

    return seconds < 60 ? t("{s}s", { s: seconds }) : t("{m}m {s}s", { m: Math.floor(seconds / 60), s: String(seconds % 60).padStart(2, "0") });
}

/** The rows above the message box while the helper works. A tap on them opens the helper, to watch it read. */
export function BetterBar() {
    const running = store.state.view.better?.running;
    const [, tick] = useState(0);

    useEffect(() => {
        if (!running) {
            return undefined;
        }

        const timer = setInterval(() => tick((count) => count + 1), 1000);

        return () => clearInterval(timer);
    }, [running?.task]);

    if (!running) {
        return null;
    }

    const step = Math.min(Math.max(running.stage ?? 0, 0), 5);
    const answering = step >= 1 && step <= 4;
    const count =
        running.failed > 0
            ? t("{tools} · {failed} failed", { tools: tn(running.count, "{n} tool", "{n} tools"), failed: running.failed })
            : tn(running.count, "{n} tool", "{n} tools");
    const open = running.helper === undefined ? undefined : () => navigate(running.helper);

    return html`<div class="better-bar" data-part="better-bar" role="status" aria-live="polite">
        <div class="better-row">
            <button
                type="button"
                class="better-open"
                disabled=${open === undefined}
                title=${t("Open the helper to watch it work")}
                onClick=${open}
            >
                <span class="better-meter" aria-hidden="true">
                    ${[0, 1, 2, 3, 4, 5].map(
                        (cell) => html`<span class=${`better-cell ${cell < step ? "done" : cell === step ? "now" : ""}`}></span>`,
                    )}
                </span>
                <span class="better-step">
                    <span class="better-long">${STEPS[step]()}</span><span class="better-short">${SHORT[step]()}</span>${answering && html`<span class="better-of"> ${t("({n} of 4)", { n: step })}</span>`}
                </span>
                <span class="better-time">${clock(Date.now() - fromServer(running.startedAt))}</span>
            </button>
            ${
                canSteer() &&
                html`<button type="button" class="link small better-stop" title=${t("Stop /better (Esc)")} onClick=${stopBetter}>
                    ${t("Stop")}
                </button>`
            }
        </div>
        <div class="better-tools">
            ${
                running.tools.length === 0
                    ? html`<span class="better-none">${t("No tools yet")}</span>`
                    : html`<span class="better-trail">
                          ${[...running.tools].reverse().map(
                              (tool) => html`<span class=${`better-tool is-${tool.state}`}>
                                  ${
                                      tool.state === "running"
                                          ? html`<span class="better-dot" aria-label=${t("running")}></span>`
                                          : html`<${Icon} name=${tool.state === "ok" ? "check" : "close"} size=${16} />`
                                  }
                                  <span class="better-label">${tool.label}</span>
                              </span>`,
                          )}
                      </span>`
            }
            <span class="better-count">${count}</span>
        </div>
    </div>`;
}
