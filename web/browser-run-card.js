// The live card of a `browser_run` call in the conversation (src/server/browser/run.ts): the goal, what Pi's browser is
// doing now and the steps done so far, the time it has taken, and Watch, which opens the Browser panel. While it runs,
// the steps come from the browser's state (each step it takes shows there as it happens); once it ended, from its
// report: how it ended, every step, the time, the decisions, and what they cost.

import { useEffect, useRef, useState } from "preact/hooks";
import { setBrowserOpen } from "./browser-panel.js";
import { piBrowserState, store } from "./store.js";
import { html, Icon } from "./ui.js";

/** How a finished run's report begins (`report()` in run.ts), as parts. */
export function parseRunReport(text) {
    const lines = String(text ?? "").split("\n");
    const head = lines[0] ?? "";
    const done = head.startsWith("Done in ");
    const stopped = /^Stopped \(([^)]+)\) after \d+ steps?(?:: (.*?))?\. [\d.]+ s, /.exec(head);

    if (!done && !stopped) {
        return null;
    }

    const steps = [];

    for (const line of lines.slice(1)) {
        const step = /^(\d+)\. (.*)$/.exec(line);

        if (!step) {
            break;
        }

        steps.push(step[2]);
    }

    return {
        done,
        reason: stopped?.[1] ?? null,
        detail: stopped?.[2] ?? null,
        seconds: Number(/\. ([\d.]+) s, /.exec(head)?.[1] ?? 0),
        decider: / decisions? by (.+?)(?:, \$[\d.]+)?\.$/.exec(head)?.[1] ?? "",
        cost: Number(/, \$([\d.]+)\.$/.exec(head)?.[1] ?? 0),
        steps,
    };
}

/** Why a run stopped, in words. */
const REASONS = {
    needs_value: "needs a value",
    blocked: "blocked",
    stuck_loop: "stuck",
    unverified_done: "not visibly done",
    budget: "out of steps or time",
    decision_error: "the run model failed",
    stale: "the page kept changing",
};

const duration = (seconds) => (seconds < 60 ? `${Math.round(seconds)} s` : `${Math.floor(seconds / 60)} min ${Math.round(seconds % 60)} s`);

/** While running: the browser's steps as they happen, and the seconds since the card first saw it run. */
function useLiveRun(running, conversationId) {
    const state = piBrowserState();
    const doing = running && state?.session === conversationId ? state.doing : null;
    const [steps, setSteps] = useState([]);
    const started = useRef(Date.now());
    const [, tick] = useState(0);

    useEffect(() => {
        if (doing && !doing.startsWith("Deciding") && !doing.startsWith("Running:")) {
            setSteps((before) => (before.at(-1) === doing ? before : [...before, doing]));
        }
    }, [doing]);

    useEffect(() => {
        if (!running) {
            return undefined;
        }

        const timer = setInterval(() => tick((n) => n + 1), 1000);

        return () => clearInterval(timer);
    }, [running]);

    return { doing, steps, seconds: (Date.now() - started.current) / 1000 };
}

export function BrowserRunCard({ args, status, resultText, conversationId }) {
    const running = status === "running";
    const live = useLiveRun(running, conversationId);
    const report = running ? null : parseRunReport(resultText);
    const failed = !running && report === null && (status === "error" || status === "stopped");
    const steps = running ? live.steps : (report?.steps ?? []);
    const shown = steps.slice(-8);
    const state = report?.done ? "done" : running ? "running" : report || failed ? "stopped" : status;
    const title = running
        ? "Running in Pi's browser"
        : report?.done
          ? `Done in ${report.steps.length} ${report.steps.length === 1 ? "step" : "steps"}`
          : report
            ? `Stopped: ${REASONS[report.reason] ?? report.reason}`
            : failed
              ? "The run failed"
              : "Waiting to run";
    const meta = running
        ? `${duration(live.seconds)} · ${live.steps.length} ${live.steps.length === 1 ? "step" : "steps"}`
        : report
          ? [duration(report.seconds), report.decider, report.cost > 0 ? `$${report.cost.toFixed(5)}` : ""].filter(Boolean).join(" · ")
          : "";

    return html`<div class="pr-card" data-state=${state}>
        <div class="pr-head">
            <span class="pr-mark" aria-hidden="true">${running ? html`<span class="pb-spin"></span>` : html`<${Icon} name="globe" size=${14} />`}</span>
            <b class="pr-title">${title}</b>
            <span class="pr-meta">${meta}</span>
            ${
                store.state.me?.role === "owner" &&
                html`<button class="button small" onClick=${() => setBrowserOpen(true)}>Watch</button>`
            }
        </div>
        <p class="pr-goal">${args.goal ?? ""}</p>
        ${
            shown.length > 0 &&
            html`<ol class="pr-steps" start=${steps.length - shown.length + 1}>
                ${shown.map((step) => html`<li>${step}</li>`)}
            </ol>`
        }
        ${running && live.doing && html`<div class="pr-now">${live.doing}</div>`}
        ${report?.detail && html`<div class="pr-detail">${report.detail}</div>`}
        ${failed && resultText && html`<div class="pr-detail">${String(resultText).split("\n")[0]}</div>`}
    </div>`;
}
