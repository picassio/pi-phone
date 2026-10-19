// Subscription accounts' plan limits (src/server/usage-limits.ts), as the Providers sheet, the model menu, and the top bar
// show them: each window's share used, a bar colored by how close it is, and when it resets.
import { useState } from "preact/hooks";
import { store } from "./store.js";
import { html } from "./ui.js";

const SHORT = { "5-hour": "5h", Weekly: "wk", "Weekly Opus": "wk Opus", "Weekly Sonnet": "wk Sonnet", "Premium requests": "premium" };
const OPEN_KEY = "pi-phone.usage-meter-open";

/** How close to the limit: under 70% fine, under 90% near, else at it. */
const level = (percent) => (percent >= 90 ? "high" : percent >= 70 ? "near" : "low");

/** When a window resets, in a few words: a time today, a weekday and time within the week, else a date. */
export function resetText(at) {
    if (at === undefined) {
        return "";
    }

    const when = new Date(at);
    const now = new Date();
    const time = when.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

    if (when.toDateString() === now.toDateString()) {
        return `resets ${time}`;
    }

    if (at - now.getTime() < 6 * 86_400_000) {
        return `resets ${when.toLocaleDateString([], { weekday: "short" })} ${time}`;
    }

    return `resets ${when.toLocaleDateString([], { day: "numeric", month: "short" })}`;
}

/** An account's figures in one short line, "5h 42% · wk 61%"; undefined without figures. */
export function usageLine(provider) {
    const usage = store.state.usage[provider];

    if (usage === undefined || usage.windows === undefined) {
        return undefined;
    }

    return usage.windows.map((window) => `${SHORT[window.label] ?? window.label} ${Math.round(window.usedPercent)}%`).join(" · ");
}

/** The highest share used of an account's windows, for the meter's color. */
export function usagePeak(provider) {
    const usage = store.state.usage[provider];

    return usage?.windows === undefined ? undefined : Math.max(...usage.windows.map((window) => window.usedPercent));
}

/** An account's windows as bars, or why there are none. */
export function UsageBars({ provider }) {
    const usage = store.state.usage[provider];

    if (usage === undefined) {
        return null;
    }

    if (usage.error !== undefined) {
        return html`<div class="muted small usage-error">${usage.error}</div>`;
    }

    return html`<div class="usage-bars">
        ${usage.windows.map(
            (window) => html`<div class="usage-window">
                <div class="usage-head small">
                    <span>${window.label}</span>
                    <span class="muted">
                        ${Math.round(window.usedPercent)}% used${window.resetsAt === undefined ? "" : ` · ${resetText(window.resetsAt)}`}${window.detail ? ` · ${window.detail}` : ""}
                    </span>
                </div>
                <div class="usage-track" role="meter" aria-valuemin="0" aria-valuemax="100" aria-valuenow=${Math.round(window.usedPercent)} aria-label=${window.label}>
                    <div class=${`usage-fill ${level(window.usedPercent)}`} style=${`width:${Math.max(2, window.usedPercent)}%`}></div>
                </div>
            </div>`,
        )}
        ${usage.plan && html`<div class="muted small">${usage.plan} plan</div>`}
    </div>`;
}

/**
 * The top bar's meter for the session's model, when its account has plan limits: the first window's share, colored, and
 * a tap opens every window with its reset (and a tap closes it). Whether it is open stays on this device.
 */
export function UsageMeter({ provider }) {
    const [open, setOpen] = useState(() => localStorage.getItem(OPEN_KEY) === "1");
    const usage = store.state.usage[provider];

    if (usage === undefined || usage.windows === undefined || usage.windows.length === 0) {
        return null;
    }

    const toggle = () => {
        localStorage.setItem(OPEN_KEY, open ? "0" : "1");
        setOpen(!open);
    };
    const first = usage.windows[0];

    return html`<div class="usage-meter-wrap">
        <button
            class=${`usage-meter ${level(usagePeak(provider))}`}
            aria-expanded=${open ? "true" : "false"}
            title="Plan usage of this session's account"
            onClick=${toggle}
        >
            ${SHORT[first.label] ?? first.label} ${Math.round(first.usedPercent)}%
        </button>
        ${open && html`<div class="usage-meter-panel"><${UsageBars} provider=${provider} /></div>`}
    </div>`;
}
