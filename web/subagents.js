// The subagents bar, above the message box: this session's subagents at a glance. It shows while one works or has a
// report on its way to Pi, and after they finish until it is put away. Folded, one line: how many work and how many
// are done, and what the newest one does. Unfolded, a row each: what it was asked, what it does this moment (its peek,
// as tiles have), for how long, whether its report is on its way, Stop, and a tap to open it. Below them: "Retire idle
// subagents" (PP-515), on a confirm, and the Retired list, fetched when opened: a row each, which opens its kept
// conversation.
import { useEffect, useRef, useState } from "preact/hooks";
import { nowDoing } from "./agent-now.js";
import { t, tn } from "./i18n.js";
import { useOnScreen } from "./peeks.js";
import { fromServer } from "./seen.js";
import { api, attempt, canSteer, navigate, openSheet, store } from "./store.js";
import { html, Icon, Spinner, timeAgo } from "./ui.js";

/**
 * When each session's bar was put away, in this browser, as the newest thing its subagents did then (the server's clock,
 * as theirs is): it shows again once one does something newer.
 */
const AWAY_KEY = "pocket.subagentsAway";

function awayMarks() {
    try {
        return JSON.parse(localStorage.getItem(AWAY_KEY) ?? "{}");
    } catch {
        return {};
    }
}

/** The server's time of the newest thing a subagent did: asked, or answered. */
const newest = (agent) => Math.max(agent.askedAt ?? 0, agent.answeredAt ?? 0);

function putAway(id, agents) {
    const marks = { ...awayMarks(), [id]: Math.max(0, ...agents.map(newest)) };
    // The newest few sessions' marks are enough.
    const kept = Object.entries(marks)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 50);

    localStorage.setItem(AWAY_KEY, JSON.stringify(Object.fromEntries(kept)));
}

/** Unfold the bar, as the top bar's count of working subagents does: for this session only. */
export const openSubagents = () => store.set({ subagentsOpen: store.state.conversationId });

/** Where a subagent is: working, done, stopped, or failed. */
/** A thinking level in words (PP-281): the subagents' settings and their spawn lines. */
export const levelName = (level) =>
    ({
        off: t("Off"),
        minimal: t("Minimal"),
        low: t("Low"),
        medium: t("Medium"),
        high: t("High"),
        xhigh: t("Extra high"),
        max: t("Max"),
    })[level] ?? level;

export const stateOf = (agent) =>
    agent.busy ? "working" : agent.stopped ? "stopped" : agent.failed ? "failed" : "done";

/** A failed subagent nobody has dealt with yet: it needs someone, on the board, the rail, and the session list. */
export const unresolved = (agent) => stateOf(agent) === "failed" && agent.dealt !== true;

/** Say a subagent's failure was dealt with: the one this browser shows (by its time), so a newer one still shows. */
export const dismiss = (agent) =>
    api(`c/${agent.conversationId}/dismiss`, { at: agent.answeredAt ?? 0 });

/** A failure shown to someone who can deal with it, who opens the subagent: seen, it needs nobody now. */
export function seeFailure(agent) {
    if (agent && unresolved(agent) && canSteer()) {
        dismiss(agent).catch(() => {});
    }
}

/** Open a subagent's conversation, from this session's subagents or the board; a failure it had is seen there. */
export function openSubagent(id) {
    const { boardAgents, view } = store.state;

    seeFailure(
        [...(view.subagents ?? []), ...(boardAgents ?? [])].find(
            (agent) => agent.conversationId === id,
        ),
    );
    navigate(id);
}

/** The mark a row starts with, for a subagent that is not working: a line icon, never a symbol. */
const MARKS = { done: "check", stopped: "stop", failed: "close" };

/** "3 subagents working": every one of them in one state. */
function allIn(status, n) {
    switch (status) {
        case "working":
            return tn(n, "{n} subagent working", "{n} subagents working");
        case "failed":
            return tn(n, "{n} subagent failed", "{n} subagents failed");
        case "stopped":
            return tn(n, "{n} subagent stopped", "{n} subagents stopped");
        default:
            return tn(n, "{n} subagent done", "{n} subagents done");
    }
}

/** "2 working": how many are in a state. */
function countIn(status, n) {
    switch (status) {
        case "working":
            return t("{n} working", { n });
        case "failed":
            return t("{n} failed", { n });
        case "stopped":
            return t("{n} stopped", { n });
        default:
            return t("{n} done", { n });
    }
}

/** "failed 3m": a finished subagent's state and how long ago, "· dismissed" for a failure someone dealt with. */
function endedText(status, when, dealt) {
    switch (status) {
        case "failed":
            return dealt ? t("failed {when} · dismissed", { when }) : t("failed {when}", { when });
        case "stopped":
            return t("stopped {when}", { when });
        default:
            return t("done {when}", { when });
    }
}

/** How long since `ms`, a time the server took: "45s", "3m 05s", "1h 12m". */
export function elapsed(ms) {
    const seconds = Math.max(0, Math.round((Date.now() - fromServer(ms)) / 1000));

    if (seconds < 60) {
        return t("{n}s", { n: seconds });
    }

    if (seconds < 3600) {
        return t("{m}m {s}s", { m: Math.floor(seconds / 60), s: String(seconds % 60).padStart(2, "0") });
    }

    return t("{h}h {m}m", { h: Math.floor(seconds / 3600), m: String(Math.floor(seconds / 60) % 60).padStart(2, "0") });
}

/** The order of the states, in the dots and the rows: working, then trouble, then done. */
const RANK = { working: 0, failed: 1, stopped: 2, done: 3 };

/** By state; working ones newest asked first, the rest newest answer first. */
export function ordered(agents) {
    return [...agents].sort(
        (a, b) =>
            RANK[stateOf(a)] - RANK[stateOf(b)] ||
            (a.busy
                ? (b.askedAt ?? 0) - (a.askedAt ?? 0)
                : (b.answeredAt ?? 0) - (a.answeredAt ?? 0)),
    );
}

function AgentRow({ agent }) {
    const stop = () => attempt(() => api(`c/${agent.conversationId}/abort`, {}));
    const status = stateOf(agent);
    // A failure someone dealt with says so, as the board does.
    const dealt = status === "failed" && agent.dealt;
    const when = agent.busy
        ? agent.askedAt && elapsed(agent.askedAt)
        : agent.answeredAt && endedText(status, timeAgo(fromServer(agent.answeredAt)), dealt);

    return html`<div class=${`agent-row ${status}`} data-peek=${agent.conversationId}>
        <button class="agent-open" onClick=${() => openSubagent(agent.conversationId)}>
            <span class="agent-mark" aria-hidden="true">
                ${agent.busy ? html`<${Spinner} />` : MARKS[status] && html`<${Icon} name=${MARKS[status]} size=${16} />`}
            </span>
            <span class="agent-main">
                <span class="agent-head">
                    <span class="agent-name">${agent.name}</span>
                    ${when && html`<span class="agent-when">${when}</span>`}
                    ${agent.reporting && html`<span class="agent-chip">${t("report on its way to Pi")}</span>`}
                </span>
                ${agent.busy && html`<span class="agent-now">${nowDoing(agent)}</span>`}
                ${status === "failed" && agent.error && html`<span class="agent-error">${agent.error}</span>`}
                ${agent.asked && html`<span class="agent-asked">${agent.asked}</span>`}
            </span>
        </button>
        ${
            agent.busy &&
            canSteer() &&
            html`<button
                class="icon-button agent-stop"
                aria-label=${t("Stop {name}", { name: agent.name })}
                title=${t("Stop")}
                onClick=${stop}
            >
                <${Icon} name="stop" size=${16} />
            </button>`
        }
    </div>`;
}

/**
 * Reports a spend limit holds back: why they wait, and for the owner the way to raise it. They go once it is raised.
 */
function Held({ why }) {
    const owner = store.state.me?.role === "owner";

    return html`<div class="agents-held" role="status">
        <span>${t("Reports wait: {why}.", { why })}</span>
        ${
            owner
                ? html`<button class="link" onClick=${() => openSheet({ type: "spend" })}>
                      ${t("Raise it")}
                  </button>`
                : html`<span>${t("They go once the owner raises it.")}</span>`
        }
    </div>`;
}

/** A span short, as times ago are: "40m", "5h", "4d". */
function spanOf(ms) {
    const minutes = Math.max(1, Math.round(ms / 60_000));

    return minutes < 60 ? t("{n}m", { n: minutes }) : minutes < 1440 ? t("{n}h", { n: Math.round(minutes / 60) }) : t("{n}d", { n: Math.round(minutes / 1440) });
}

/** Idle now, so "Retire idle subagents" would retire it: not working, and no report on its way (the server checks the rest). */
const retirable = (agent) => !agent.busy && !agent.reporting;

/** A retired subagent's row: when it was retired, how long it had been idle, what it was asked; a tap opens it. */
function RetiredRow({ agent }) {
    const idle = spanOf(agent.retiredAt - agent.idleSince);

    return html`<div class="agent-row retired" data-part="retired-agent">
        <button class="agent-open" onClick=${() => navigate(agent.conversationId)}>
            <span class="agent-mark" aria-hidden="true"><${Icon} name="archive" size=${16} /></span>
            <span class="agent-main">
                <span class="agent-head">
                    <span class="agent-name">${agent.name}</span>
                    <span class="agent-when">${t("retired {when} · idle {idle}", { when: timeAgo(fromServer(agent.retiredAt)), idle })}</span>
                </span>
                ${agent.asked && html`<span class="agent-asked">${agent.asked}</span>`}
            </span>
        </button>
    </div>`;
}

/**
 * Under the rows: "Retire idle subagents" for those idle now, on a confirm that says how many and that their
 * conversations are kept; and "Retired", which fetches and lists the retired ones.
 */
function Retirement({ agents, retiredCount }) {
    const id = store.state.conversationId;
    const [asking, setAsking] = useState(false);
    const [shown, setShown] = useState(false);
    const [retired, setRetired] = useState(null);
    const idle = agents.filter(retirable).length;
    const load = () =>
        attempt(async () => {
            const answer = await api(`c/${id}/retired-subagents`);

            setRetired(answer.retired);
        });
    const retire = () =>
        attempt(async () => {
            await api(`c/${id}/retire-subagents`, {});
            setAsking(false);

            if (shown) {
                await load();
            }
        });

    // A list shown follows the count: one retired meanwhile (here or by Pi's next call) joins it.
    useEffect(() => {
        if (shown) {
            void load();
        }
    }, [shown, retiredCount]);

    if (idle === 0 && retiredCount === 0) {
        return null;
    }

    return html`<div class="agents-retirement" data-part="subagents-retirement">
        ${
            asking
                ? html`<div class="agents-confirm" role="alertdialog" aria-label=${t("Retire idle subagents")} data-part="retire-confirm">
                      <span>${tn(idle, "Retire {n} idle subagent? Its conversation is kept.", "Retire {n} idle subagents? Their conversations are kept.")}</span>
                      <span class="agents-confirm-actions">
                          <button class="button small ghost" onClick=${() => setAsking(false)}>${t("Cancel")}</button>
                          <button class="button small primary" data-part="retire-yes" onClick=${retire}>${t("Retire")}</button>
                      </span>
                  </div>`
                : html`<div class="agents-foot">
                      ${
                          retiredCount > 0 &&
                          html`<button class="agents-foot-button" aria-expanded=${shown} data-part="retired-toggle" onClick=${() => setShown(!shown)}>
                              <span>${t("Retired · {n}", { n: retiredCount })}</span>
                              <span class=${`agents-foot-chevron ${shown ? "open" : ""}`}><${Icon} name="chevron" size=${16} /></span>
                          </button>`
                      }
                      ${
                          idle > 0 &&
                          canSteer() &&
                          html`<button class="agents-foot-button agents-retire" data-part="retire-idle" onClick=${() => setAsking(true)}>
                              <${Icon} name="archive" size=${16} />
                              <span>${t("Retire idle subagents")}</span>
                          </button>`
                      }
                  </div>`
        }
        ${
            shown &&
            retiredCount > 0 &&
            html`<div class="agents-list agents-retired" data-part="retired-list">
                ${retired === null ? html`<div class="agents-loading muted small">${t("Loading…")}</div>` : retired.map((agent) => html`<${RetiredRow} key=${agent.conversationId} agent=${agent} />`)}
            </div>`
        }
    </div>`;
}

/** The bar, while it shows: its hooks watch its rows for peeks, and tick the elapsed times. */
function Bar({ agents, all, retiredCount, active, open, held }) {
    const box = useRef(null);
    const [, rerender] = useState(0);
    const count = (status) => agents.filter((agent) => stateOf(agent) === status).length;
    const working = agents.filter((agent) => agent.busy);
    const lead = ordered(working)[0];
    // Trouble first: on a phone the end of the line may not fit.
    const kinds = ["working", "failed", "stopped", "done"].filter((status) => count(status) > 0);
    // "3 subagents working" when one kind says it all; "2 working · 1 done · 1 failed", short for a phone, when not.
    // None left but retired ones (PP-515): how many were.
    const summary =
        kinds.length === 0
            ? tn(retiredCount, "{n} subagent retired", "{n} subagents retired")
            : kinds.length === 1
              ? allIn(kinds[0], agents.length)
              : kinds.map((status) => countIn(status, count(status))).join(" · ");
    const shown = ordered(agents);

    // The rows' and the folded line's peeks: what each working subagent does now.
    useOnScreen(box);
    // Elapsed times tick while one works.
    useEffect(() => {
        if (working.length === 0) {
            return;
        }

        const timer = setInterval(() => rerender((count) => count + 1), 1000);

        return () => clearInterval(timer);
    }, [working.length]);

    // What the button says, the newest one's work too: the label stands for everything in it.
    const label =
        lead && !open
            ? t("Subagents: {summary}. {name}: {doing}", { summary, name: lead.name, doing: nowDoing(lead) })
            : t("Subagents: {summary}", { summary });

    return html`<div
        class=${`agents-bar ${open ? "open" : ""} ${working.length > 0 ? "busy" : ""}`}
        data-part="subagents-bar"
        ref=${box}
    >
        <div class="agents-top">
            <button
                class="agents-summary"
                aria-label=${label}
                aria-expanded=${open}
                onClick=${() =>
                    store.set({ subagentsOpen: open ? null : store.state.conversationId })}
            >
                <span class="agents-dots" aria-hidden="true">
                    ${shown
                        .slice(0, 6)
                        .map(
                            (agent) => html`<span class=${`agents-dot ${stateOf(agent)}`}></span>`,
                        )}
                    ${shown.length > 6 && html`<span class="agents-more">+${shown.length - 6}</span>`}
                </span>
                <span class="agents-count">${summary}</span>
                ${
                    lead &&
                    !open &&
                    html`<span class="agents-lead" data-peek=${lead.conversationId}>
                        ${lead.name}: ${nowDoing(lead)}
                    </span>`
                }
                <span class="agents-chevron"><${Icon} name="chevron" size=${16} /></span>
            </button>
            ${
                !active &&
                html`<button
                    class="icon-button"
                    aria-label=${t("Put the subagents bar away")}
                    title=${t("Put away")}
                    onClick=${() => {
                        putAway(store.state.conversationId, agents);
                        store.set({ subagentsOpen: null });
                    }}
                >
                    <${Icon} name="close" size=${16} />
                </button>`
            }
        </div>
        ${held && html`<${Held} why=${held} />`}
        ${
            open &&
            shown.length > 0 &&
            html`<div class="agents-list">
                ${shown.map((agent) => html`<${AgentRow} key=${agent.name} agent=${agent} />`)}
            </div>`
        }
        ${open && html`<${Retirement} agents=${all} retiredCount=${retiredCount} />`}
    </div>`;
}

/**
 * This session's subagents, while one works or has a report on its way, and after until put away. Once put away, it
 * counts and lists only those that did something since.
 */
export function SubagentsBar() {
    const { view, conversationId, subagentsOpen } = store.state;
    const away = awayMarks()[conversationId] ?? 0;
    const all = view.subagents ?? [];
    const agents = all.filter(
        (agent) => agent.busy || agent.reporting || newest(agent) > away,
    );
    const open = subagentsOpen === conversationId;
    const retiredCount = view.subagentsRetired;

    // Open, it stays while there are retired ones to list, after "Retire idle subagents" took the last rows too.
    if (agents.length === 0 && !(open && retiredCount > 0)) {
        return null;
    }

    return html`<${Bar}
        agents=${agents}
        all=${all}
        retiredCount=${retiredCount}
        held=${view.subagentsHeld}
        active=${agents.some((agent) => agent.busy || agent.reporting)}
        open=${open}
    />`;
}
