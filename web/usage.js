// Subscription accounts' plan limits (src/server/usage-limits.ts), as the Providers sheet, the model menu, and the top bar
// show them: each window's share used, a bar colored by how close it is, and when it resets.
import { useState } from "preact/hooks";
import { t, tx } from "./i18n.js";
import { actions, attempt, store } from "./store.js";
import { html } from "./ui.js";

const SHORT = { "5-hour": "5h", Weekly: "wk", "Weekly Opus": "wk Opus", "Weekly Sonnet": "wk Sonnet", "Premium requests": "premium" };
const OPEN_KEY = "pi-phone.usage-meter-open";

/**
 * A plan window's name in the person's language: the server names them in English ("5-hour", "Weekly", `usage-limits.ts`
 * and `limits.ts`); one it names otherwise shows as it is.
 */
export function windowName(label) {
    const hours = /^(\d+)-hour$/.exec(label ?? "");

    if (hours !== null) {
        return t("{n}-hour", { n: Number(hours[1]) });
    }

    const names = {
        Weekly: t("Weekly"),
        "Weekly Opus": t("Weekly Opus"),
        "Weekly Sonnet": t("Weekly Sonnet"),
        "Premium requests": t("Premium requests"),
        Window: t("Window"),
    };

    return names[label] ?? label;
}

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
        return t("resets {time}", { time });
    }

    if (at - now.getTime() < 6 * 86_400_000) {
        return t("resets {day} {time}", { day: when.toLocaleDateString([], { weekday: "short" }), time });
    }

    return t("resets {date}", { date: when.toLocaleDateString([], { day: "numeric", month: "short" }) });
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
                    <span>${windowName(window.label)}</span>
                    <span class="muted">
                        ${t("{n}% used", { n: Math.round(window.usedPercent) })}${window.resetsAt === undefined ? "" : ` · ${resetText(window.resetsAt)}`}${window.detail ? ` · ${window.detail}` : ""}
                    </span>
                </div>
                <div class="usage-track" role="meter" aria-valuemin="0" aria-valuemax="100" aria-valuenow=${Math.round(window.usedPercent)} aria-label=${windowName(window.label)}>
                    <div class=${`usage-fill ${level(window.usedPercent)}`} style=${`width:${Math.max(2, window.usedPercent)}%`}></div>
                </div>
            </div>`,
        )}
        ${usage.plan && html`<div class="muted small">${t("{plan} plan", { plan: usage.plan })}</div>`}
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
            title=${t("Plan usage of this session's account")}
            onClick=${toggle}
        >
            ${SHORT[first.label] ?? first.label} ${Math.round(first.usedPercent)}%
        </button>
        ${open && html`<div class="usage-meter-panel"><${UsageBars} provider=${provider} /></div>`}
    </div>`;
}

/** The base provider of an account's id (`anthropic~work` is Anthropic's), as src/server/accounts.ts names them. */
const baseOf = (provider) => provider.split("~")[0];

/** An account's name for people: its own, "Default" for the original, or the provider's id when it has no others. */
export const accountName = (provider) =>
    store.state.models.find((model) => model.provider === provider)?.account ?? provider;

/**
 * The other accounts the session's model can move to: the same model, signed in, on another account of its provider
 * (src/server/accounts.ts), with their figures' peak. Least used first.
 */
export function otherAccounts(provider, modelId) {
    if (provider === undefined) {
        return [];
    }

    const seen = new Set();

    return store.state.models
        .filter((model) => model.id === modelId && model.provider !== provider && baseOf(model.provider) === baseOf(provider) && !model.signIn)
        .filter((model) => !seen.has(model.provider) && seen.add(model.provider))
        .map((model) => ({ provider: model.provider, name: model.account ?? model.provider, peak: usagePeak(model.provider) }))
        .sort((a, b) => (a.peak ?? 0) - (b.peak ?? 0));
}

/** Move this session to `provider`'s account, the same model; then, when asked, carry on where it stopped. */
export async function switchAccount(provider, modelId, carryOn = false) {
    await actions.configure({ model: { provider, modelId } });

    if (carryOn) {
        await actions.submit("Continue.");
    }
}

/** Whether a failed request says it hit a plan's limit (Claude's, Codex's, Copilot's words for it). */
export const limitError = (text) =>
    /usage limit|rate.?limit|limit reached|reached your|hit your limit|quota|too many requests|\b429\b|UsageLimitExceeded/i.test(text ?? "");

/**
 * Over the composer, when a window of the session's account is at 90% or more: which, when it resets, and Switch to each
 * other account with the same model. Closed, it stays closed until that window resets.
 */
export function UsageWarning() {
    const { view } = store.state;
    const provider = view.agent?.model?.provider;
    const modelId = view.agent?.model?.modelId;
    const usage = provider === undefined ? undefined : store.state.usage[provider];
    const window = usage?.windows?.filter((each) => each.usedPercent >= 90).sort((a, b) => b.usedPercent - a.usedPercent)[0];
    const key = window === undefined ? "" : `pi-phone.usage-warned:${provider}:${window.label}:${window.resetsAt ?? ""}`;
    const [, redraw] = useState(0);

    // A limit's account card is up here (PP-135): it says it, and offers the other account.
    if (window === undefined || localStorage.getItem(key) === "1" || (view.limitOffers ?? []).length > 0) {
        return null;
    }

    const others = otherAccounts(provider, modelId);
    const close = () => {
        localStorage.setItem(key, "1");
        redraw((n) => n + 1);
    };

    return html`<div class="watch-bar usage-warning" data-part="usage-warning">
        <span class="grow">
            ${(() => {
                const limit = html`<strong>${t("{account}: {window} limit at {n}%", { account: accountName(provider), window: windowName(window.label).toLowerCase(), n: Math.round(window.usedPercent) })}</strong>`;

                return window.resetsAt === undefined ? tx("{limit}.", { limit }) : tx("{limit}, {reset}.", { limit, reset: resetText(window.resetsAt) });
            })()}
        </span>
        ${others.map(
            (other) => html`<button class="link small" onClick=${() => attempt(() => switchAccount(other.provider, modelId))}>
                ${other.peak === undefined ? t("Switch to {name}", { name: other.name }) : t("Switch to {name} ({n}%)", { name: other.name, n: Math.round(other.peak) })}
            </button>`,
        )}
        <button class="link small" aria-label=${t("Close")} onClick=${close}>${t("Close")}</button>
    </div>`;
}

/** Under a request that failed on its plan's limit: Continue on each other account with the same model. */
export function LimitSwitch({ error }) {
    const { view } = store.state;
    const provider = view.agent?.model?.provider;
    const modelId = view.agent?.model?.modelId;

    if (!limitError(error)) {
        return null;
    }

    const others = otherAccounts(provider, modelId);

    return others.length === 0
        ? null
        : html`<div class="limit-switch">
              ${others.map(
                  (other) => html`<button class="button small" onClick=${() => attempt(() => switchAccount(other.provider, modelId, true))}>
                      ${other.peak === undefined ? t("Continue on {name}", { name: other.name }) : t("Continue on {name} ({n}% used)", { name: other.name, n: Math.round(other.peak) })}
                  </button>`,
              )}
          </div>`;
}
