// The Creator flow's cards (PP-369, src/server/creator.ts; the owner's OK of 2026-11-03 on the mockup pp366-mockup):
// - `CreatorCard`: Pi asks before it makes a drop-in (`extension_create`): Make a drop-in: <title>, what it will be and
//   where it shows, Make it or Not now. The owner's.
// - `MadeCard`: one card under the extension_create call that follows the drop-in as it is made: written, checked,
//   installed switched off, waiting for the owner to switch it on (Switch it on), checked in the app; Open the
//   subagent; and at the end Keep, Undo and Restore… with its versions.
// - `MadeList`: the same versions and buttons for every drop-in Pi made, in Settings › Extensions.
// They read the Extension builder's routes (`/api/x/extension-builder/made…`) and hear its `made` events.
import { useEffect, useState } from "preact/hooks";
import { t, tx } from "./i18n.js";
import { actions, api, attempt, notify, onExtensionEvent, store } from "./store.js";
import { openSubagent } from "./subagents.js";
import { Choice, clockTime, html, Icon, StateTag } from "./ui.js";

const MODULE = "extension-builder";

/** Whether the Extension builder is on: its routes answer only then. */
export const builderOn = () => store.state.server?.extensions?.includes("pocket-extension-builder") === true;

/** Where a drop-in's UI shows, as the card names it. */
const PLACES = () => ({
    tool: t("a tool for Pi"),
    rail: t("a rail button"),
    page: t("a page"),
    sheet: t("a sheet"),
    menu: t("a menu row"),
    launcher: t("a launcher action"),
    dock: t("a strip above the message box"),
    overlay: t("a floating panel"),
    panelTab: t("a tab in the side panel"),
    sessionMenu: t("a row in a session's menu"),
    theme: t("its own colours"),
});

/** Pi asks to make a drop-in (`form: { type: "creator" }`): Make it starts its subagent; nothing installs yet. */
export function CreatorCard({ approval }) {
    const { me } = store.state;
    const form = approval.form;
    const [busy, setBusy] = useState(false);
    const names = PLACES();
    const answer = (allow) => {
        setBusy(true);
        attempt(() => actions.approve(approval.id, allow)).finally(() => setBusy(false));
    };

    return html`<div class="approval creator-card" data-part="approval">
        <div class="approval-head">
            <span class="approval-shield" aria-hidden="true"><${Icon} name="plus" size=${16} /></span>
            <div class="approval-title">
                <span class="approval-ask">${form.next ? t("Make the next version: {title}", { title: form.title }) : t("Make a drop-in: {title}", { title: form.title })}</span>
                <span class="approval-reason">${form.brief}</span>
            </div>
        </div>
        <div class="creator-facts small">
            <div>${tx("Pi's subagent writes it as {module} and checks it; then you install it on a card.", { module: html`<span class="mono">${form.module}</span>` })}</div>
            <div class="muted">${t("Where it shows: {places}", { places: form.places.map((place) => names[place] ?? place).join(", ") })}</div>
            <div class="muted">${t("It gets the same rights as any drop-in (everything the app has, secrets included), and stays off until you switch it on.")}</div>
        </div>
        ${
            me?.role !== "owner"
                ? html`<div class="muted small">${t("Making a drop-in is the owner's: waiting for them.")}</div>`
                : html`<div class="approval-actions">
                      <button class="button ghost" disabled=${busy} onClick=${() => answer(false)}>${t("Not now")}</button>
                      <button class="button primary" disabled=${busy} onClick=${() => answer(true)}>${t("Make it")}</button>
                  </div>`
        }
    </div>`;
}

/** A made drop-in's state, kept current: fetched, again when the app's extensions change, and from its events. */
function useMade(name) {
    const [state, setState] = useState(null);
    const [problem, setProblem] = useState(null);
    const ui = store.state.server?.ui;
    const on = builderOn();

    useEffect(() => {
        if (!on || store.state.me?.role !== "owner") {
            return undefined;
        }

        api(`x/${MODULE}/made/${encodeURIComponent(name)}`).then(
            (answer) => {
                setState(answer.made);
                setProblem(null);
            },
            (error) => setProblem(error.message),
        );

        return onExtensionEvent(({ module: from, event, data }) => {
            if (from === MODULE && event === "made" && data?.name === name) {
                setState(data);
            }
        });
    }, [name, on, ui]);

    return [state, problem, setState];
}

/** A made drop-in's state as a word and a dot. */
function tagOf(state) {
    switch (state.phase) {
        case "writing":
            // Written and checked: the install card waits for the owner.
            return state.build.checks?.ok ? ["warn", t("Waiting for you")] : ["warn", t("Building")];
        case "failed":
            return ["err", t("Stopped")];
        case "refused":
            return ["err", t("Checks failed")];
        case "declined":
            return ["off", t("Not installed")];
        case "installed":
            return state.enabled ? ["ok", t("On")] : ["warn", t("Waiting for you")];
        case "checked":
            return ["ok", t("Checked")];
        case "kept":
            return ["ok", t("Kept")];
        default:
            return ["off", t("Removed")];
    }
}

/** The five steps of the build under way, each done, now, to come, or failed. */
function stepsOf(state) {
    const build = state.build;
    const checks = build.checks;
    const installed = build.installed !== undefined && state.current !== null;

    return [
        build.written
            ? ["done", t("Written: {note}", { note: build.written.note })]
            : state.phase === "failed"
              ? ["failed", t("Not written: {why}", { why: build.failed ?? "" })]
              : ["now", t("Pi's subagent is writing it")],
        checks === undefined
            ? ["todo", t("Checks: one module, no built-in tool names, no paths outside, 1 MB at most")]
            : checks.ok
              ? ["done", t("Checks: one module, no built-in tool names, no paths outside, {kb} KB", { kb: Math.max(1, Math.round(checks.bytes / 1024)) })]
              : ["failed", t("Checks found problems: {problems}", { problems: checks.problems.join("; ") })],
        installed
            ? ["done", t("Installed, switched off (you approved the card)")]
            : state.phase === "declined"
              ? ["failed", t("Not installed: the card was declined")]
              : checks?.ok
                ? ["now", t("Waiting for your install card")]
                : ["todo", t("Installed, switched off")],
        state.enabled ? ["done", t("Switched on")] : installed ? ["now", t("Waiting for you to switch it on")] : ["todo", t("Switched on by you")],
        build.checked
            ? ["done", t("Checked in the app at 390 and 1280 px: {note}", { note: build.checked.note || "" })]
            : state.enabled
              ? ["now", t("Pi checks it in the app at 390 and 1280 px")]
              : ["todo", t("Checked in the app at 390 and 1280 px")],
    ];
}

/** Its versions, and Keep, Undo and Restore… (Undo and Restore ask first). */
export function MadeVersions({ state, onState, keep = false }) {
    const [asking, setAsking] = useState(null);
    const [picked, setPicked] = useState("");
    const [busy, setBusy] = useState(false);
    const others = state.versions.filter((version) => version.n !== state.current);
    const previous = state.current === null ? undefined : state.versions.filter((version) => version.n < state.current).at(-1);
    const run = (path, body) => {
        setBusy(true);
        attempt(async () => {
            const answer = await api(`x/${MODULE}/made/${encodeURIComponent(state.name)}/${path}`, body ?? {});

            onState(answer.made);
            setAsking(null);

            // Keep changes nothing installed: a word says it took (PP-375; the owner's "Keep did nothing visible").
            // Pi is not told.
            if (path === "keep") {
                notify("info", t("Kept {module}, version {n}", { module: answer.made.module, n: answer.made.current }));
            }
        }).finally(() => setBusy(false));
    };

    return html`<div class="made-versions" data-part="made-versions">
        <div class="made-actions">
            ${keep && state.phase !== "kept" && state.current !== null && html`<button class="button primary small" disabled=${busy} onClick=${() => run("keep")}>${t("Keep")}</button>`}
            ${state.current !== null && html`<button class="button small" disabled=${busy} onClick=${() => setAsking("undo")}>${t("Undo")}</button>`}
            ${
                others.length > 0 &&
                html`<button
                    class="button ghost small"
                    disabled=${busy}
                    onClick=${() => {
                        setPicked(String(others.at(-1).n));
                        setAsking("restore");
                    }}
                >
                    ${t("Restore…")}
                </button>`
            }
        </div>
        ${
            asking === "undo" &&
            html`<div class="made-ask">
                <span class="small">${previous === undefined ? t("Undo removes {module}: this is its first version. Its versions stay, to restore.", { module: state.module }) : t("Undo goes back to version {n}, switched off.", { n: previous.n })}</span>
                <div class="made-actions">
                    <button class="button ghost small" disabled=${busy} onClick=${() => setAsking(null)}>${t("Cancel")}</button>
                    <button class="button primary small" disabled=${busy} onClick=${() => run("undo")}>${t("Undo")}</button>
                </div>
            </div>`
        }
        ${
            asking === "restore" &&
            html`<div class="made-ask">
                <${Choice}
                    label=${t("The version to restore")}
                    value=${picked}
                    options=${others.map((version) => ({ value: String(version.n), label: t("Version {n}", { n: version.n }), detail: version.note }))}
                    onChange=${setPicked}
                />
                <span class="small muted">${t("It installs switched off: you switch it on.")}</span>
                <div class="made-actions">
                    <button class="button ghost small" disabled=${busy} onClick=${() => setAsking(null)}>${t("Cancel")}</button>
                    <button class="button primary small" disabled=${busy || picked === ""} onClick=${() => run("restore", { version: Number(picked) })}>${t("Restore")}</button>
                </div>
            </div>`
        }
        <ul class="made-list">
            ${state.versions.map(
                (version) => html`<li key=${version.n} class="made-ver">
                    <span class="grow">${t("Version {n} · {time} · {note}", { n: version.n, time: clockTime(new Date(version.at)), note: version.note })}</span>
                    ${version.n === state.current && html`<${StateTag} tone=${state.enabled ? "ok" : "off"} label=${state.enabled ? t("On now") : t("Installed")} />`}
                </li>`,
            )}
        </ul>
    </div>`;
}

// ─── What made cards wait for (PP-375): the waiting bar at the top of the session lists them ──────────────────────────

/** Each made card that waits for the owner, by its drop-in's name: what it waits for. Several cards of one share it. */
const waiting = new Map();
const waitingListeners = new Set();

/** The made cards that wait for the owner now: `{ key, name, module, version, kind }`, kind `switch` or `keep`. */
export const waitingMade = () => [...waiting.values()].map((each) => each.at(-1).entry);

/** Hear when what made cards wait for changes; answers how to stop. */
export function onWaitingMade(listener) {
    waitingListeners.add(listener);

    return () => waitingListeners.delete(listener);
}

function waitingChanged() {
    for (const listener of waitingListeners) {
        listener();
    }
}

/** What a made drop-in waits for the owner to do on its card: switch it on, or keep (or undo) it once checked. */
function waitsFor(state) {
    if (state === null || state.current === null) {
        return undefined;
    }

    if (!state.enabled && ["installed", "checked"].includes(state.phase)) {
        return "switch";
    }

    return state.phase === "checked" ? "keep" : undefined;
}

/** The card under an extension_create call: how its drop-in is coming along, and the owner's buttons. */
export function MadeCard({ name }) {
    const [state, problem, setState] = useMade(name);
    const [busy, setBusy] = useState(false);
    const shown = store.state.me?.role === "owner" && builderOn();
    const kind = shown ? waitsFor(state) : undefined;

    // While it waits for the owner, the waiting bar knows it (and leads back to this card when it is scrolled away).
    useEffect(() => {
        if (kind === undefined) {
            return undefined;
        }

        const mine = { entry: { key: `made:${name}`, name, module: state.module, version: state.current, kind } };
        const list = waiting.get(name) ?? [];

        waiting.set(name, [...list, mine]);
        waitingChanged();

        return () => {
            const left = (waiting.get(name) ?? []).filter((each) => each !== mine);

            if (left.length === 0) {
                waiting.delete(name);
            } else {
                waiting.set(name, left);
            }

            waitingChanged();
        };
    }, [name, kind, state?.current, state?.module]);

    if (!shown) {
        return null;
    }

    if (state === null) {
        return problem === null ? null : html`<div class="made-card muted small">${problem}</div>`;
    }

    const [tone, label] = tagOf(state);
    const switchOn = () => {
        setBusy(true);
        attempt(() => api(`extensions/${encodeURIComponent(`${state.module}.ts`)}`, { enabled: true })).finally(() => setBusy(false));
    };
    const ended = ["checked", "kept", "removed"].includes(state.phase) || (state.phase === "installed" && state.enabled);

    return html`<div class="made-card" data-part="made-card" data-phase=${state.phase} data-waiting=${`made:${name}`}>
        <div class="made-head">
            <span class="made-title">${state.current === null ? state.module : t("{module} · version {n}", { module: state.module, n: state.current })}</span>
            <${StateTag} tone=${tone} label=${label} />
        </div>
        <ul class="made-steps">
            ${stepsOf(state).map(([step, text]) => html`<li data-state=${step}><span class="made-dot" aria-hidden="true"></span><span>${text}</span></li>`)}
        </ul>
        <div class="made-actions">
            ${
                state.current !== null &&
                !state.enabled &&
                ["installed", "checked"].includes(state.phase) &&
                html`<button class="button primary small" data-part="made-switch-on" disabled=${busy} onClick=${switchOn}>${t("Switch it on")}</button>`
            }
            ${state.subagent && html`<button class="button ghost small" onClick=${() => openSubagent(state.subagent.conversationId)}>${t("Open the subagent")}</button>`}
        </div>
        ${ended && state.versions.length > 0 && html`<${MadeVersions} state=${state} onState=${setState} keep=${true} />`}
    </div>`;
}

/** Settings › Extensions: every drop-in Pi made, with its versions, Undo and Restore…. */
export function MadeList() {
    const [list, setList] = useState(null);
    const ui = store.state.server?.ui;
    const on = builderOn() && store.state.me?.role === "owner";

    useEffect(() => {
        if (on) {
            api(`x/${MODULE}/made`).then((answer) => setList(answer.made), () => setList([]));
        }
    }, [on, ui]);

    if (!on || list === null || list.length === 0) {
        return null;
    }

    const replace = (state) => setList(list.map((each) => (each.module === state.module ? state : each)));

    return html`<section class="made-section" data-part="made-section">
        <div class="label">${t("Drop-ins Pi made")}</div>
        ${list.map((state) => {
            const [tone, label] = tagOf(state);

            return html`<div class="made-card" key=${state.module} data-module=${state.module}>
                <div class="made-head">
                    <span class="made-title">${state.title} <span class="muted small mono">${state.module}</span></span>
                    <${StateTag} tone=${tone} label=${label} />
                </div>
                <${MadeVersions} state=${state} onState=${replace} />
            </div>`;
        })}
    </section>`;
}
