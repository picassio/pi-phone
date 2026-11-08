// Settings › Hooks (PP-419, src/server/hooks.ts): the checks pi-phone runs around Pi's work by itself, each with a
// switch, and beside them the automatic behaviours that keep settings of their own (listed only). Pi changes a hook with
// setting_change (hooks.<id>), after the owner approves a card.
import { useEffect, useState } from "preact/hooks";
import { t } from "../i18n.js";
import { openSheetWhenReady } from "../extension-ui.js";
import { api, attempt, closeSheet, store } from "../store.js";
import { html, Loader, Sheet, StateTag, Switch } from "../ui.js";

/** Each hook's words in the person's language; the server's English for one this page does not know yet. */
const TEXTS = {
    artifactCheck: () => ({
        title: t("Check artifacts on publish"),
        does: t("Renders the artifact at 390, 1280 and 1920 px and adds the layout check's counts to the artifact tool's result, so Pi sees cut text, overlaps, small tap targets and low contrast in the same call."),
        when: t("Each time Pi publishes an HTML, SVG or interactive artifact."),
    }),
    uiReminder: () => ({
        title: t("Remind to check UI before finishing"),
        does: t("Sends Pi one follow-up naming the UI files it changed after its last screenshot, asking it to check them at 390, 1280 and 1920 px or say why not. Files in temp and test fixture folders are skipped."),
        when: t("When Pi ends a turn with UI files edited after its last check; once a turn, subagents too."),
    }),
};

/** Each built-in behaviour's words, in the person's language. */
const BUILT_IN = {
    wikiCapture: () => ({ title: t("Capture idle sessions into the wiki"), does: t("Writes what a session learned into the wiki once it has been idle a while.") }),
    autoCompact: () => ({
        title: t("Compact a full context"),
        does: t("Summarizes a session's older messages once its context passes the set share of the model's window. Set it in a session's menu › Compact context."),
    }),
    // PP-455: no switch, as one would be a way to pay without asking.
    askBeforeRisky: () => ({
        title: t("Ask before paying, sending, booking or deleting"),
        does: t("Before Pi's click, key or run step that may pay, send, book or delete, in Pi's browser or on a computer, you answer a card: Approve once or Deny. No answer in 5 minutes is Deny. It cannot be turned off."),
    }),
};

/** A built-in behaviour's value as a state: what its own setting says now. */
function builtInState(item) {
    if (item.id === "askBeforeRisky") {
        return { tone: "ok", label: t("Always on") };
    }

    if (item.id === "wikiCapture") {
        return item.minutes === null ? { tone: "off", label: t("Only when asked") } : { tone: "ok", label: t("After {n} min idle", { n: item.minutes }) };
    }

    return item.at === "full" ? { tone: "ok", label: t("When nearly full") } : { tone: "ok", label: t("At {n}% of the context", { n: item.at }) };
}

export function HooksSheet() {
    const [view, setView] = useState(null);
    const [busy, setBusy] = useState(null);

    useEffect(() => {
        attempt(async () => setView(await api("hooks")));
    }, []);

    const toggle = (hook) =>
        attempt(async () => {
            setBusy(hook.id);

            try {
                setView(await api(`hooks/${hook.id}`, { on: !hook.on }, { method: "PUT" }));
            } finally {
                setBusy(null);
            }
        });
    const wiki = store.state.server?.extensions?.includes("pocket-para");

    return html`<${Sheet} title=${t("Hooks")} onClose=${closeSheet}>
        <p class="muted small">${t("Checks pi-phone runs around Pi's work by itself, so they happen even when Pi forgets them. Pi can turn one on or off too, after you approve a card.")}</p>
        ${!view && html`<${Loader} label=${t("Loading hooks")} />`}
        ${
            view &&
            html`<div class="label">${t("Hooks")}</div>
                <div class="sheet-list" data-part="hooks">
                    ${view.hooks.map((hook) => {
                        const words = TEXTS[hook.id]?.() ?? hook;

                        return html`<div class="provider toggle" data-part="hook" data-hook=${hook.id}>
                            <div>
                                <div>${words.title} <${StateTag} tone=${hook.on ? "ok" : "off"} label=${hook.on ? t("On") : t("Off")} /></div>
                                <div class="muted small">${words.does}</div>
                                <div class="muted small">${words.when}</div>
                            </div>
                            <${Switch} on=${hook.on} disabled=${busy === hook.id} label=${words.title} onChange=${() => toggle(hook)} />
                        </div>`;
                    })}
                </div>
                <div class="label">${t("Built in")}</div>
                <div class="sheet-list" data-part="hooks-built-in">
                    ${view.builtIn.map((item) => {
                        const state = builtInState(item);
                        const words = BUILT_IN[item.id]();

                        return html`<div class="provider" data-part="hook-built-in" data-hook=${item.id}>
                            <div>
                                <div>${words.title} <${StateTag} tone=${state.tone} label=${state.label} /></div>
                                <div class="muted small">${words.does}</div>
                            </div>
                            ${
                                item.id === "wikiCapture" &&
                                wiki &&
                                html`<div class="provider-actions">
                                    <button class="button small ghost" onClick=${() => openSheetWhenReady("para", "settings")}>${t("Wiki settings")}</button>
                                </div>`
                            }
                        </div>`;
                    })}
                </div>`
        }
    <//>`;
}
