// The sidebar: the rail (Pi, the tools, and you; folded, numbered sessions too) and the session list beside it, in the
// sidebar, the drawer, and a phone's home screen; and the order and archiving of sessions.
import { t, tn } from "./i18n.js";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
import { Avatar, folderColor, initials } from "./avatar.js";
import { goHome, useBack } from "./back.js";
import { ExtensionRailButtons } from "./extension-ui.js";
import { GATEWAY_PAGE, openGatewayPage } from "./gateway-panel.js";
import { useDragToClose } from "./gestures.js";
import { PeeksRailButton } from "./peeks.js";
import { VoiceNewButton } from "./voice-view.js";
import { sessionForest, unfolded } from "./session-tree.js";
import { settledAt, settledOf as settleReason } from "./session-settle.js";
import {
    actions,
    canSteer,
    collab,
    navigate,
    notify,
    isUnread,
    openSheet,
    scoped,
    sessionUnread,
    setUnread,
    stillMoving,
    store,
    workspaceOrder,
    roleAllows,
} from "./store.js";
import { finishedUnseen, fromServer } from "./seen.js";
import { createGroup, foldGroup, groupOf, moveToGroup, pinGroup, placeGroup, renameGroup } from "./session-groups.js";
import { isPinned, prefs, setPrefs, togglePin } from "./theme.js";
import {
    APPLE,
    apartFromViews,
    drawnFor,
    formatWhen,
    html,
    Icon,
    memo,
    NO_HOVER,
    railState,
    scrimPress,
    shortPath,
    Slide,
    timeAgo,
    useMinute,
    usePresence,
    useSide,
    useSlide,
    WIDE,
} from "./ui.js";
import { WhatsNewCard } from "./guide.js";

/**
 * Back to the session list, where it is not beside the conversation: back past the sessions opened from it, as a
 * phone's back would go, or to it in this session's place when history does not lead there.
 */
export const toSessions = () => goHome(() => navigate(null, { replace: true }));

/** A time ahead from the server's clock, on this device's: when a waiting request tries again ("14:30"). */
const clockAt = (ms) => formatWhen(fromServer(ms));

/** The session list on its way: rows shaped like sessions, lit in turn. */
function LoadingSessions() {
    return html`<div role="status" aria-label=${t("Loading sessions")}>
        ${[72, 54, 64, 46, 58].map(
            (width, index) =>
                html`<div
                    class="session-placeholder"
                    aria-hidden="true"
                    style=${`--width: ${width}%; --delay: ${index * 0.12}s`}
                >
                    <span></span>
                </div>`,
        )}
    </div>`;
}

/**
 * Archive sessions, or bring them back, then say so in a notice that undoes it. Archiving the open session leaves it
 * for the home screen; undoing that opens it again.
 */
export async function setArchived(ids, archived, { undo = true } = {}) {
    if (ids.length === 0) {
        return;
    }

    const titles = new Map(
        store.state.sessions.map((session) => [session.id, session.title ?? t("New session")]),
    );

    markMoving(ids, archived);
    const results = await Promise.allSettled(
        ids.map((id) => actions.updateSession(id, { archived })),
    );
    const done = ids.filter((_, index) => results[index].status === "fulfilled");

    // Rows that failed come back at once; the rest stay dimmed until the server's list shows them moved.
    unmarkMoving(
        ids.filter((id) => !done.includes(id)),
        archived,
    );
    const failed = results.find((result) => result.status === "rejected");

    if (failed) {
        notify("error", failed.reason?.message ?? String(failed.reason));
    }

    const open = store.state.conversationId;
    const left = undo && archived && done.includes(open);

    if (left) {
        navigate(null);
    }

    if (!undo || done.length === 0) {
        return;
    }

    const title = titles.get(done[0]) ?? "";
    const what =
        done.length === 1
            ? `“${title.length > 48 ? `${title.slice(0, 47)}…` : title}”`
            : t("{n} sessions", { n: done.length });

    notify(
        "info",
        matchMedia("(pointer: coarse)").matches
            ? archived
                ? t("Archived {what}. Tap to undo.", { what })
                : t("Unarchived {what}. Tap to undo.", { what })
            : archived
              ? t("Archived {what}. Click to undo.", { what })
              : t("Unarchived {what}. Click to undo.", { what }),
        async () => {
            await setArchived(done, !archived, { undo: false });

            if (left && store.state.conversationId === null) {
                navigate(open);
            }
        },
    );
}

/**
 * Mark sessions as on their way into the archive (true) or out of it (false). The store drops a mark once the list
 * shows the session where it was going; should that never happen (someone moved it straight back, or the request
 * hangs), the mark goes after a while anyway.
 */
function markMoving(ids, archived) {
    store.set((state) => ({
        moving: stillMoving(
            { ...state.moving, ...Object.fromEntries(ids.map((id) => [id, archived])) },
            state.sessions,
        ),
    }));
    setTimeout(() => unmarkMoving(ids, archived), 10_000);
}

/** Drop the marks, but not ones made since the other way (an undo, say). */
function unmarkMoving(ids, archived) {
    if (!ids.some((id) => store.state.moving[id] === archived)) {
        return;
    }

    store.set((state) => {
        const moving = { ...state.moving };

        for (const id of ids) {
            if (moving[id] === archived) {
                delete moving[id];
            }
        }

        return { moving };
    });
}

const CLOSED_KEY = "pocket.closedGroups";

const readClosed = () => {
    try {
        return new Set(JSON.parse(localStorage.getItem(CLOSED_KEY) ?? "[]"));
    } catch {
        return new Set();
    }
};

/** The sessions whose linked sessions are folded away in the list: this browser's choice, kept across reloads (PP-157). */
const FOLDED_KEY = "pocket.foldedLinked";

const readFolded = () => {
    try {
        return new Set(JSON.parse(localStorage.getItem(FOLDED_KEY) ?? "[]"));
    } catch {
        return new Set();
    }
};

/** Whether a session folded away under `id` waits for you or failed: the fold shows it, as a folded group does. */
function hiddenTrouble(group, id) {
    const at = group.hidden.findIndex((row) => row.session.id === id);

    if (at === -1) {
        return undefined;
    }

    const depth = group.hidden[at].branches.length;

    for (const row of group.hidden.slice(at + 1)) {
        if (row.branches.length <= depth) {
            break;
        }

        const shape = sessionMark(row.session).shape;

        if (shape === "waiting" || shape === "failed") {
            return shape;
        }
    }

    return undefined;
}

const DAY = 86_400_000;

/** Which day bucket a time falls in, in this device's time zone. */
function dayGroup(ms) {
    const today = new Date();

    today.setHours(0, 0, 0, 0);
    const start = today.getTime();

    if (ms >= start) {
        return t("Today");
    }

    if (ms >= start - DAY) {
        return t("Yesterday");
    }

    if (ms >= start - 6 * DAY) {
        return t("This week");
    }

    if (ms >= start - 29 * DAY) {
        return t("This month");
    }

    return t("Earlier");
}

/** `~/Development/pi-pocket` with its last part bold, for a folder group's name. */
function FolderName({ path }) {
    const at = path.lastIndexOf("/");

    if (at <= 0) {
        return html`<b class="last">${path}</b>`;
    }

    // A long path gives way before its last part does.
    return html`<span class="first">${path.slice(0, at + 1)}</span>
        <b class="last">${path.slice(at + 1)}</b>`;
}

/** The text with what matched the search marked. */
function Highlight({ text, needle }) {
    if (!needle) {
        return text;
    }

    const at = text.toLowerCase().indexOf(needle);

    if (at === -1) {
        return text;
    }

    return html`${text.slice(0, at)}
    <mark>${text.slice(at, at + needle.length)}</mark>
    ${text.slice(at + needle.length)}`;
}

/** Failed subagents nobody has dealt with (seen or dismissed), of a session's counts or the rail's totals. */
const failing = (counts) => (counts.failed ?? 0) - (counts.dealt ?? 0);

/** "2 working · 1 failed subagents": a session's subagents, for the ⑂ mark's tooltip. */
function subagentsTip(counts) {
    const shown = { ...counts, failed: failing(counts) };
    const kinds = ["working", "waiting", "failed"].filter((kind) => shown[kind] > 0);
    const total = kinds.reduce((sum, kind) => sum + shown[kind], 0);

    return `${kinds.map((kind) => `${shown[kind]} ${kind}`).join(" · ")} subagent${total === 1 ? "" : "s"}`;
}

/**
 * How long a finger rests on a row before its actions open; how far it may stray meanwhile (as far as a scroll, or the
 * drawer's drag); and how long before the row shows the press, so a scroll's start does not light it.
 */
const PRESS_MS = 450;
const PRESS_SLOP = 8;
const PRESS_SHOWS_MS = 100;

/** The list whose row a finger last held: Select in that row's sheet selects there. */
let pressedIn = null;

/**
 * Select a session in the list where its row was held, and let taps there select more (or let go), as Ctrl/⌘+click
 * does with a mouse. From the sheet a long press opens.
 */
export function selectFromList(id) {
    pressedIn?.current?.(id);
}

/**
 * The square at the start of a session's row: its folder's color, in the shape of where the session is. The first that
 * holds wins: a call waiting for you, a request waiting for its provider's limit to clear, Pi or its subagents at
 * work, a failed run (solid while new, drawn once seen), finished since this browser last looked or marked unread
 * (solid), and read or never run (hollow).
 */
function stateMark(session, working, marked, unseen = finishedUnseen(session)) {
    const fresh = marked || unseen;

    if (session.waiting) {
        return { shape: "waiting", label: session.asks === undefined ? t("Waiting for approval") : t("Pi asks you: {title}", { title: session.asks }) };
    }

    // Pi's request waits for the provider's limit to clear: at work, held up, until a time or a try (PP-135).
    if (session.limited !== undefined) {
        return { shape: "limited", label: t("Waiting for a limit") };
    }

    if (session.busy || working) {
        return { shape: "working", label: t("Working") };
    }

    if (session.failed) {
        return fresh
            ? { shape: "failed", label: t("Failed, not read") }
            : { shape: "failed seen", label: t("Failed") };
    }

    return fresh ? { shape: "fresh", label: t("Not read") } : { shape: "seen", label: "" };
}

/** A row's state for themes (`data-state`), by its square's shape: a documented name that stays when the squares change. */
const ROW_STATES = {
    waiting: "waiting",
    limited: "limited",
    working: "working",
    failed: "failed",
    fresh: "done",
    seen: "idle",
};

/**
 * Sessions whose rows this page has drawn. A row rises in only the first time: back to the list on a phone builds the
 * list anew, and every row rising in again made it flicker. A session new to the page (started since) still rises in.
 */
const shownRows = new Set();

/** A session's square, as its row in the list draws it (the home screen's Jump back in too). */
export function sessionMark(session) {
    const counts = session.subagents ?? {};

    return stateMark(
        session,
        (counts.working ?? 0) + (counts.waiting ?? 0) > 0,
        isUnread(session.id),
    );
}

/**
 * One session on one line: its folder's color in the shape of its state, its title, and on the right what goes on there (its working subagents,
 * who else is in it, Pi working, a call waiting for you), unread chat, and how long ago. Its folder and model are in
 * its tooltip. Memoized (`memo`): it reads nothing of the store as it draws, only its props, which `AllSessions` works
 * out for it. `minute` (and `tick`, each second while it works) draws it again as time passes.
 */
function SessionRow({
    session,
    branches,
    kids = 0,
    foldedAway = false,
    foldTrouble,
    onFold,
    index,
    number,
    needle,
    selected,
    pressing,
    folders,
    team = false,
    settled = null,
    filed,
    onPick,
    onSelect,
    open,
    pinned,
    marked,
    unread,
    unseen,
    moving,
    home,
    meId,
    collabs,
    steers,
    grouping,
    hovers,
}) {
    // Where it rises in, in turn, when it is new to this page; null when it shows as it was.
    const [arrival] = useState(() => (shownRows.has(session.id) ? null : index));

    useLayoutEffect(() => {
        shownRows.add(session.id);
    }, []);
    const title = session.title ?? t("New session");
    const path = shortPath(session.cwd, home);
    const where = [
        session.worktree ? `${path} ⎇ ${session.worktree.branch}` : path,
        session.model,
    ].filter(Boolean);
    // The Folders tab names the folder above the row already: its model comes first.
    const tip = [title, ...(folders ? where.reverse() : where)].join(" · ");
    // A search can match the folder or model instead of the title: the row shows which.
    let hit =
        needle && !title.toLowerCase().includes(needle)
            ? [path, session.cwd, session.model].find((text) =>
                  text?.toLowerCase().includes(needle),
              )
            : undefined;

    // A path from the folder that matched: its start is the same in every row, and would push the match out of sight.
    if (hit && hit !== session.model) {
        const parts = hit.split("/");
        const at = parts.findLastIndex((part) => part.toLowerCase().includes(needle));

        hit = at > 0 ? `…/${parts.slice(at).join("/")}` : hit;
    }

    const counts = session.subagents ?? {};
    const live = (counts.working ?? 0) + (counts.waiting ?? 0);
    const failed = failing(counts);
    // Subagents at work, or failed ones nobody dealt with, but not over a call waiting for you: that says more.
    const fork = !session.waiting && (live > 0 || failed > 0);
    const person = collabs ? (session.people ?? []).find((each) => each.id !== meId) : undefined;
    // `unseen`: finished since this browser last looked; its result is unread, so its title reads bold.
    const mark = stateMark(session, live > 0, marked, unseen);
    // Archive (and Settle, and Move to group) for people who steer, pin, and mark-unread show on hover; an archived
    // session only comes back. None where nothing hovers (`hovers`): a long press opens them there.
    const movable = grouping && !session.archived;
    const acts = hovers ? (steers ? (session.archived ? 1 : 2) : 0) + (session.archived ? 0 : 2) + (movable ? 1 : 0) : 0;
    // A task session (a project's): its task's ref leads its third line; its title says the rest.
    const task = session.group?.role === "task" ? /^([A-Z][A-Z0-9]{1,5}-\d+) · (.*)$/.exec(title) : null;
    const shownTitle = task ? task[2] : title;
    const remote = session.cwd.startsWith("machine:");
    // On a machine, as the design has it: the machine, then the folder's last two parts ("tualh-laptop · source/cmg").
    const machine = remote ? /^([^:]+):\s*(.*)$/.exec(path) : null;
    const shortWhere = machine ? `${machine[1]} · ${machine[2].split("/").filter((part) => part !== "" && part !== "~").slice(-2).join("/") || machine[2]}` : path;
    const place = team ? "task session" : session.group ? session.group.title : shortWhere;
    const branch = session.worktree?.branch ?? session.branch ?? (task ? `task/${task[1]}` : null);
    const when = session.waiting ? "waits" : session.limited !== undefined ? clockAt(session.limited) : session.busy && session.busySince ? workingFor(session.busySince) : timeAgo(session.updatedAt);

    return html`<div
        class=${`session-row ${kids > 0 ? "with-fold" : ""} ${arrival === null ? "" : "arriving"} ${open ? "active" : ""} ${selected ? "selected" : ""} ${pressing ? "pressing" : ""} ${moving ? "moving" : ""} ${marked ? "marked-unread" : ""} ${unseen ? "unseen" : ""} ${team ? "team" : ""} ${settled ? "settled" : ""} ${["no-acts", "one-act", "", "three-acts", "four-acts", "five-acts"][acts]}`}
        data-part="session-row"
        data-state=${ROW_STATES[mark.shape.split(" ")[0]]}
        data-id=${session.id}
        style=${`${arrival === null ? "" : `--i:${arrival};`}--linked-depth:${Math.min(branches.length, 3)}`}
    >
        ${
            branches.length > 0 &&
            html`<span class="session-branches" data-part="session-branches" aria-hidden="true">
                ${branches.slice(-3).map(
                    (continues, index, visible) => html`<span
                        class=${`${continues ? "continues" : ""} ${index === visible.length - 1 ? "elbow" : ""}`}
                    ></span>`,
                )}
            </span>`
        }
        <button
            class=${`session ${unread ? "unread" : ""}`}
            data-part="session-button"
            aria-current=${open ? "page" : undefined}
            onPointerDown=${(event) => onSelect(event, session.id)}
            onClick=${(event) => onPick(event, session.id)}
            onContextMenu=${(event) => event.ctrlKey && event.preventDefault()}
            title=${tip}
        >
            <span class="session-lines">
                <span class="session-l1">
                    <${Icon} name=${session.group ? "board" : remote ? "monitor" : "folder"} size=${12} />
                    <span class="session-where">${place}</span>
                    ${pinned && html`<span class="session-pinned" title=${t("Pinned")}><${Icon} name="pin" size=${10} /></span>`}
                    ${filed && html`<span class="sg-tag" title=${t("In the group {name}", { name: filed })}><${Icon} name="folder" size=${9} />${filed}</span>`}
                    <span class="session-side">
                        ${
                            fork &&
                            html`<span
                                class=${`session-fork ${live > 0 ? "" : "failed"}`}
                                title=${subagentsTip(counts)}
                            >
                                <${Icon} name="fork" size=${10} />${live > 0 ? live : failed}
                            </span>`
                        }
                        ${!fork && person && html`<${Avatar} person=${person} size=${16} />`}
                        ${
                            (unread || marked) &&
                            html`<span
                                class="unread-dot"
                                title=${marked ? t("Marked unread") : t("New chat messages")}
                            ></span>`
                        }
                        <span class=${`session-time ${session.waiting ? "need" : session.limited !== undefined ? "limit" : session.busy ? "work" : ""}`}>${when}</span>
                        ${
                            number !== undefined &&
                            number < 9 &&
                            html`<kbd class="session-num">${number + 1}</kbd>`
                        }
                    </span>
                </span>
                <span class=${`session-title ${hit ? "with-hit" : ""}`}>
                    ${
                        hit
                            ? html`<span class="session-name">${shownTitle}</span>
                                <span class="session-hit">
                                    <${Highlight} text=${hit} needle=${needle} />
                                </span>`
                            : html`<${Highlight} text=${shownTitle} needle=${needle} />`
                    }
                </span>
                ${
                    (branch || task || settled) &&
                    html`<span class="session-l3">
                        ${task && html`<span class="session-ref">${task[1]}</span>`}
                        ${branch && html`<${Icon} name="fork" size=${10} /><span class="session-branch">${branch}</span>`}
                        ${settled && html`<span class="session-reason">${settled}</span>`}
                    </span>`
                }
            </span>
            <span class="session-status" data-part="session-mark" style=${`--folder:${folderColor(session.cwd)}`}>
                ${
                    selected
                        ? html`<span class="state-check" role="img" aria-label=${t("Selected")}><${Icon} name="check" size=${9} /></span>`
                        : session.waiting
                          ? html`<span class="status-need" role="img" aria-label=${steers ? t("Needs you") : t("Waiting")} title=${session.asks !== undefined ? t("Pi asks you: {title}", { title: session.asks }) : steers ? t("Needs you") : t("Waiting for approval")}></span>`
                          : session.limited !== undefined
                            ? html`<span class="status-limit" role="img" aria-label=${t("Waiting for a limit")} title=${t("Waiting for a limit: next try at {time}", { time: clockAt(session.limited) })}></span>`
                            : session.busy
                            ? html`<span class="status-work" role="img" aria-label=${t("Working")} title=${t("Working")}></span>`
                            : session.failed
                              ? html`<span class="status-fail" role="img" aria-label=${t("Failed")} title=${t("Its last run failed")}></span>`
                              : html`<span class=${`status-idle ${mark.shape}`} role="img" aria-label=${mark.label || t("Idle")} title=${mark.label || t("Idle")}>
                                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 18h10a4 4 0 0 0 .5-8A6 6 0 0 0 6 9a4.5 4.5 0 0 0 1 9z" /></svg>
                                </span>`
                }
            </span>
        </button>
        ${
            // The sessions it started, under it (PP-157, from pi-pocket): how many, and a tap folds them away and back.
            kids > 0 &&
            html`<button
                class=${`session-fold ${foldedAway ? "folded" : ""}`}
                data-part="session-fold"
                aria-expanded=${!foldedAway}
                aria-label=${foldedAway ? tn(kids, "Show {n} linked session", "Show {n} linked sessions") : tn(kids, "Hide {n} linked session", "Hide {n} linked sessions")}
                title=${foldedAway ? tn(kids, "Show {n} linked session", "Show {n} linked sessions") : tn(kids, "Hide {n} linked session", "Hide {n} linked sessions")}
                onClick=${() => onFold(session.id)}
            >
                ${foldTrouble && html`<span class=${`group-trouble ${foldTrouble}`} aria-hidden="true"></span>`}
                <span class="session-fold-pill">
                    ${kids}
                    <${Icon} name="down" size=${10} />
                </span>
            </button>`
        }
        ${
            hovers &&
            html`<span class="session-actions">
            ${
                movable &&
                html`<button
                    class="session-act"
                    title=${t("Move to a folder group")}
                    aria-label=${t("Move to group")}
                    onClick=${() => openSheet({ type: "session-move", ids: [session.id] })}
                >
                    <${Icon} name="folder" size=${14} />
                </button>`
            }
            ${
                steers &&
                !session.archived &&
                html`<button
                    class="session-act"
                    title=${settled ? t("Un-settle: back in the active list") : t("Settle: out of the active list")}
                    aria-label=${settled ? t("Un-settle") : t("Settle")}
                    onClick=${() => setSettled(session.id, !settled)}
                >
                    <${Icon} name=${settled ? "undo" : "check"} size=${14} />
                </button>`
            }
            ${
                steers &&
                html`<button
                    class="session-act"
                    title=${session.archived ? t("Unarchive") : t("Archive")}
                    aria-label=${session.archived ? t("Unarchive") : t("Archive")}
                    onClick=${() => setArchived([session.id], !session.archived)}
                >
                    <${Icon} name=${session.archived ? "unarchive" : "archive"} size=${14} />
                </button>`
            }
            ${
                !session.archived &&
                html`<button
                    class=${`session-act session-pin ${pinned ? "on" : ""}`}
                    title=${pinned ? t("Unpin") : t("Pin to the top")}
                    aria-label=${pinned ? t("Unpin") : t("Pin")}
                    onClick=${() => togglePin(session.id)}
                >
                    <${Icon} name="pin" size=${14} />
                </button>`
            }
            ${
                !session.archived &&
                html`<button
                    class=${`session-act session-unread ${marked ? "on" : ""}`}
                    title=${marked ? t("Mark read") : t("Mark unread")}
                    aria-label=${marked ? t("Mark read") : t("Mark unread")}
                    onClick=${() => setUnread(session.id, !marked)}
                >
                    <${Icon} name=${marked ? "check" : "unread"} size=${14} />
                </button>`
            }
        </span>`
        }
    </div>`;
}

/**
 * A row draws again when what it shows changes. Its place (`index`) counts only as it mounts, for its rise-in. `minute`
 * and `tick` are props it does not read: they draw it again as the time it shows moves on.
 */
const MemoRow = memo(SessionRow, ["index"]);

/**
 * The branch lines a linked row draws, one array for each shape: the forest makes new ones each time, and a memoized
 * row would draw again for an array that only looks the same. There are few shapes (a row is at most a few deep).
 */
const branchShapes = new Map();

function sameBranches(branches) {
    const key = branches.join();
    let shape = branchShapes.get(key);

    if (shape === undefined) {
        shape = Object.freeze([...branches]);
        branchShapes.set(key, shape);
    }

    return shape;
}

/** How long since `since`: "45s", "3m 40s", "2h 14m". */
function workingFor(since) {
    const seconds = Math.max(0, Math.round((Date.now() - since) / 1000));

    return seconds < 60 ? `${seconds}s` : seconds < 3600 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}

/** Why a session is settled, or null while it is active (`session-settle.js`), with the person's pin: pinned, it stays. */
export const settledOf = (session, now = Date.now()) => settleReason(session, now, isPinned(session.id));

/** Settle a session (out of the active list) or bring it back. Settling unpins it, as in T3 Code. */
export async function setSettled(id, settled) {
    if (settled && isPinned(id)) {
        togglePin(id);
    }

    try {
        await actions.updateSession(id, { settled });
    } catch (error) {
        notify("error", error.message);
    }
}

/** What the list shows: everything, one project's team, one folder, or the archive. Kept on this device. */
const SCOPE_KEY = "pocket.sessionScope";
const readScope = () => localStorage.getItem(SCOPE_KEY) ?? "all";
/** Whether empty folder groups show under All, on this device (PP-76). */
const EMPTY_KEY = "pocket.showEmptyGroups";

function inScope(session, scope, mine) {
    // What waits for the person: a card to answer, a call to approve (PP-284).
    if (scope === "waits") {
        return session.waiting === true;
    }

    // One of the person's folder groups (PP-76).
    if (scope.startsWith("fg:")) {
        return mine.members[String(session.id)] === scope.slice(3);
    }

    if (scope.startsWith("group:")) {
        return session.group?.id === scope.slice(6);
    }

    if (scope.startsWith("folder:")) {
        const folder = scope.slice(7);

        return session.cwd === folder || session.cwd.startsWith(`${folder}/`);
    }

    return true;
}

/**
 * Sessions in sections, as T3 Code's sidebar has them: Pinned, the person's pinned folder groups, Active (newest first;
 * a project's running task sessions under its main session), their other folder groups (PP-76) in their order, then
 * the folded Settled shelf (the last settled first). A group holds its sessions whether they are active or settled
 * (settled ones last); a pinned session shows in Pinned only. Under a scope, a group with nothing in it is left out.
 * While searching, or in the archive, one flat list. `team` holds the rows drawn under their main session.
 */
function groupsOf(shown, { scope, needle, pinned, now, mine, showEmpty, fresh }) {
    if (needle !== "" || scope === "archived") {
        return [{ key: "flat", label: needle ? t("Matches") : t("Archived"), rows: shown, team: new Set() }];
    }

    const filed = new Map(mine.groups.map((group) => [group.id, []]));

    for (const session of shown) {
        const group = mine.members[String(session.id)];

        if (group !== undefined && filed.has(group) && !pinned.includes(session.id)) {
            filed.get(group).push(session);
        }
    }

    const inGroups = new Set([...filed.values()].flat().map((session) => session.id));
    const folders = mine.groups
        .map((group) => {
            const rows = filed.get(group.id);
            const live = rows.filter((session) => settledOf(session, now) === null).sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
            const done = rows.filter((session) => settledOf(session, now) !== null).sort((a, b) => settledAt(b) - settledAt(a));

            return { key: `g:${group.id}`, label: group.name, folder: group, under: !group.pinned, rows: [...live, ...done], team: new Set() };
        })
        // Empty groups: shown under All only when asked (or just made here); under a scope, never.
        .filter((group) => group.rows.length > 0 || (scope === "all" && (showEmpty || fresh.has(group.folder.id))));
    const empties = scope === "all" ? mine.groups.filter((group) => !filed.get(group.id).length).length : 0;
    const under = folders.filter((group) => group.under);

    shown = shown.filter((session) => !inGroups.has(session.id));

    const live = shown.filter((session) => settledOf(session, now) === null);
    const settled = shown.filter((session) => settledOf(session, now) !== null).sort((a, b) => settledAt(b) - settledAt(a));
    const pins = live.filter((session) => pinned.includes(session.id));
    const active = live.filter((session) => !pinned.includes(session.id)).sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
    const leads = new Set(active.filter((session) => session.group?.role === "lead").map((session) => session.group.id));
    const team = new Set();
    const ordered = [];

    for (const session of active) {
        if (session.group?.role === "task" && leads.has(session.group.id)) {
            continue;
        }

        ordered.push(session);

        if (session.group?.role === "lead") {
            for (const child of active) {
                if (child.group?.id === session.group.id && child.group.role === "task") {
                    team.add(child.id);
                    ordered.push(child);
                }
            }
        }
    }

    return [
        ...(pins.length > 0 ? [{ key: "pinned", label: t("Pinned"), rows: pins, team: new Set() }] : []),
        ...folders.filter((group) => group.folder.pinned),
        // Active stays under All while there are groups: it is where a session dragged out of one goes.
        ...(ordered.length > 0 || (scope === "all" && folders.length > 0) ? [{ key: "active", label: t("Active"), rows: ordered, team }] : []),
        // The other groups under one heading that folds them all at once, on this device.
        ...(under.length > 0 || empties > 0 ? [{ key: "groups", label: t("Groups"), heading: true, count: mine.groups.filter((group) => !group.pinned).length, empties, rows: [], team: new Set() }] : []),
        ...under,
        ...(settled.length > 0 ? [{ key: "settled", label: t("Settled"), foldable: true, rows: settled, team: new Set() }] : []),
    ];
}

/**
 * Whether a group shows folded: a folder group as its person left it (on every device), the Settled shelf unless
 * opened, the others when closed here.
 */
const folded = (group, closed) =>
    group.key === "flat" ? false : group.folder ? group.folder.folded : group.foldable ? !closed.has(`open:${group.key}`) : closed.has(group.key);

/**
 * The list's scope, in place of tabs (after T3 Code's "All projects"): All, each project (its team's sessions), each
 * folder, or the archive, with how many are there and how many work.
 */
function ScopePicker({ scope, onScope, sessions, home, mine }) {
    const [open, setOpen] = useState(false);
    const live = sessions.filter((session) => !session.archived);
    const teams = new Map();
    const folders = new Map();

    for (const session of live) {
        if (session.group) {
            const team = teams.get(session.group.id) ?? { id: session.group.id, title: session.group.title, count: 0, working: 0, at: 0 };

            team.count += 1;
            team.working += session.busy ? 1 : 0;
            team.at = Math.max(team.at, session.updatedAt ?? 0);
            team.title = session.group.role === "lead" ? session.group.title : team.title;
            teams.set(session.group.id, team);
        } else {
            const folder = folders.get(session.cwd) ?? { cwd: session.cwd, count: 0, at: 0 };

            folder.count += 1;
            folder.at = Math.max(folder.at, session.updatedAt ?? 0);
            folders.set(session.cwd, folder);
        }
    }

    useEffect(() => {
        if (!open) {
            return;
        }

        const away = (event) => !event.target.closest?.(".session-scope") && setOpen(false);

        addEventListener("pointerdown", away, true);

        return () => removeEventListener("pointerdown", away, true);
    }, [open]);

    const pick = (next) => {
        setOpen(false);
        onScope(next);
    };
    const name =
        scope === "archived"
            ? t("Archived")
            : scope === "waits"
            ? t("Waits for you")
            : scope.startsWith("fg:")
              ? (mine.groups.find((group) => group.id === scope.slice(3))?.name ?? t("Group"))
              : scope.startsWith("group:")
              ? (teams.get(scope.slice(6))?.title ?? t("Project"))
              : scope.startsWith("folder:")
                ? folderPlace(scope.slice(7))
                : t("All");
    const icon = scope === "archived" ? "archive" : scope === "waits" ? "chat" : scope.startsWith("group:") ? "board" : scope.startsWith("folder:") || scope.startsWith("fg:") ? "folder" : "menu";
    // The person's folder groups (PP-76), pinned ones first, with how many chats each holds now.
    const filed = mine.groups
        .map((group) => ({ group, count: live.filter((session) => mine.members[String(session.id)] === group.id).length }))
        .sort((a, b) => Number(b.group.pinned) - Number(a.group.pinned));
    const option = (key, lead, label, hint) => html`<button role="option" aria-selected=${scope === key} class=${scope === key ? "on" : ""} onClick=${() => pick(key)}>
        ${lead}<span class="scope-label">${label}</span><small>${hint}</small>
    </button>`;
    // A project as the design shows it: its key in a chip, then its name.
    const teamKey = (team) => /^project:(.+)$/.exec(team.id)?.[1] ?? "";
    const teamName = (team) => team.title.replace(/^[A-Z][A-Z0-9]{1,5} · /, "");
    const folderPlace = (cwd) => {
        const short = shortPath(cwd, home);
        const machine = cwd.startsWith("machine:") ? /^([^:]+):\s*(.*)$/.exec(short) : null;

        return machine ? `${machine[1]} · ${machine[2].split("/").filter((part) => part !== "" && part !== "~").slice(-2).join("/") || machine[2]}` : short;
    };

    return html`<div class=${`session-scope ${open ? "open" : ""}`} data-part="session-scope">
        <button class="session-scope-button" aria-haspopup="listbox" aria-expanded=${open} onClick=${() => setOpen(!open)}>
            <${Icon} name=${icon} size=${14} />
            <span class="scope-label">${name}</span>
            <${Icon} name="down" size=${12} />
        </button>
        ${
            open &&
            html`<div class="session-scope-menu" role="listbox" aria-label=${t("Show")}>
                ${option("all", null, "All", `${live.length} active`)}
                ${option("waits", html`<${Icon} name="chat" size=${13} />`, t("Waits for you"), `${live.filter((session) => session.waiting).length}`)}
                ${filed.length > 0 && html`<div class="scope-sec">${t("Groups")}</div>`}
                ${filed.map(({ group, count }) =>
                    option(`fg:${group.id}`, html`<${Icon} name=${group.pinned ? "pin" : "folder"} size=${13} />`, group.name, `${count}`),
                )}
                ${teams.size > 0 && html`<div class="scope-sec">${t("Projects")}</div>`}
                ${[...teams.values()]
                    .sort((a, b) => b.at - a.at)
                    .map((team) =>
                        option(
                            `group:${team.id}`,
                            html`<span class="scope-key">${teamKey(team)}</span>`,
                            teamName(team),
                            `${team.count}${team.working > 0 ? ` · ${team.working} working` : ""}`,
                        ),
                    )}
                ${folders.size > 0 && html`<div class="scope-sec">${t("Folders")}</div>`}
                ${[...folders.values()]
                    .sort((a, b) => b.at - a.at)
                    .slice(0, 20)
                    .map((folder) =>
                        option(
                            `folder:${folder.cwd}`,
                            html`<${Icon} name=${folder.cwd.startsWith("machine:") ? "monitor" : "folder"} size=${13} />`,
                            folderPlace(folder.cwd),
                            `${folder.count}`,
                        ),
                    )}
                <div class="scope-sec"></div>
                ${option("archived", null, "Archived", `${sessions.length - live.length}`)}
            </div>`
        }
    </div>`;
}

/**
 * What the full list searched for and how far it was scrolled, kept while the tab lives: on a phone the list goes when a
 * session opens, and back from the session shows it again as it was.
 */
const listKept = { query: "", scroll: 0 };

function AllSessions({ compact = false }) {
    const { sessions, sessionsLoaded, server, pinned, sessionGroups } = store.state;
    const canStart = canSteer() && !scoped();
    const [query, setQueryState] = useState(() => (compact ? "" : listKept.query));
    const [chosenScope, setScopeState] = useState(readScope);
    // A folder group's scope whose group is gone: All.
    const scope = chosenScope.startsWith("fg:") && !sessionGroups.groups.some((group) => group.id === chosenScope.slice(3)) ? "all" : chosenScope;
    const [closed, setClosed] = useState(readClosed);
    const [foldedLinked, setFoldedLinked] = useState(readFolded);
    const [selected, setSelectedState] = useState(() => new Set());
    // Taps select rows instead of opening them: a selection started from a long press's sheet, on a touch screen.
    const [tapSelects, setTapSelects] = useState(false);
    // The row a finger holds down, before its actions open.
    const [pressing, setPressing] = useState(null);
    // The folder group whose name is being typed (PP-76): a new one, or one being renamed.
    const [naming, setNaming] = useState(null);
    // Folder groups made on this device show while empty; the others only when asked (on this device).
    const [fresh, setFresh] = useState(() => new Set());
    const [showEmpty, setShowEmptyState] = useState(() => localStorage.getItem(EMPTY_KEY) === "1");
    const setShowEmpty = (next) => {
        localStorage.setItem(EMPTY_KEY, next ? "1" : "0");
        setShowEmptyState(next);
    };
    // The selection as drags and clicks see it between renders; the row a Shift+click extends from; the row a Ctrl/⌘ press
    // already selected, whose click then does nothing; the rows in view, in order.
    const picked = useRef(selected);
    const anchor = useRef(null);
    const held = useRef(null);
    const visible = useRef([]);
    const list = useRef(null);
    const needle = query.trim().toLowerCase();
    const archived = scope === "archived";

    const setQuery = (next) => {
        if (!compact) {
            listKept.query = next;
        }

        setQueryState(next);
    };

    // Scrolled back to where it was, once its rows are there.
    useLayoutEffect(() => {
        if (!compact && sessionsLoaded && list.current) {
            list.current.scrollTop = listKept.scroll;
        }
    }, [sessionsLoaded]);

    const setSelected = (next) => {
        picked.current = next;
        setSelectedState(next);

        if (next.size === 0) {
            setTapSelects(false);
        }
    };

    // What Select in a held row's sheet does here; and what lets go of a press under way.
    const startSelect = useRef(null);
    const unpress = useRef(null);

    startSelect.current = (id) => {
        anchor.current = id;
        setSelected(new Set([...picked.current, id]));
        setTapSelects(true);
    };

    useEffect(
        () => () => {
            unpress.current?.();

            if (pressedIn === startSelect) {
                pressedIn = null;
            }
        },
        [],
    );

    const clearSelection = () => {
        anchor.current = null;
        setSelected(new Set());
    };

    // A working session shows how long it has worked: while one does, the list draws again each second, and those rows
    // with it (`tick`).
    const [tick, setTick] = useState(0);
    const working = sessions.some((session) => session.busy && session.busySince);

    useEffect(() => {
        if (!working) {
            return undefined;
        }

        const timer = setInterval(() => setTick((tick) => tick + 1), 1000);

        return () => clearInterval(timer);
    }, [working]);

    const setScope = (next) => {
        setScopeState(next);
        localStorage.setItem(SCOPE_KEY, next);
        clearSelection();
    };

    // What changes the list's rows: the sessions and pins, the scope and the search, the folder groups, and the minute,
    // as sessions settle after a day idle. Worked out again only when one of them changes, not on every draw.
    const minute = useMinute();
    const home = server?.home;
    const { shown, groups } = useMemo(() => {
        const shown = sessions.filter(
            (session) =>
                Boolean(session.archived) === archived &&
                inScope(session, scope, sessionGroups) &&
                (needle === "" ||
                    `${session.title ?? ""} ${session.cwd} ${shortPath(session.cwd, home)} ${session.model ?? ""} ${groupOf(session.id, sessionGroups)?.name ?? ""}`
                        .toLowerCase()
                        .includes(needle)),
        );
        const forest = sessionForest(shown, { pinned, folders: false });
        // Folded under the Groups heading: the groups below it go.
        const groups = groupsOf(forest.roots, { scope, needle, pinned, now: Date.now(), mine: sessionGroups, showEmpty, fresh })
            .filter((group) => !(group.under && closed.has("groups")))
            .map((group) => {
                const rows = group.rows.flatMap((root) => forest.rows.get(root.id));

                return {
                    ...group,
                    total: rows.length,
                    // Linked sessions folded away under the one that started them; a search shows every match.
                    rows: needle === "" ? unfolded(rows, foldedLinked) : rows,
                    // What each folded row hides, for the marks it stands in for.
                    hidden: rows,
                };
            });

        return { shown, groups };
    }, [sessions, pinned, scope, needle, home, sessionGroups, showEmpty, fresh, closed, minute, foldedLinked]);

    visible.current = useMemo(
        () => groups.flatMap((group) => (folded(group, closed) ? [] : group.rows.map(({ session }) => session.id))),
        [groups, closed],
    );
    const chosen = useMemo(
        () => (selected.size === 0 ? [] : shown.filter((session) => selected.has(session.id)).map((session) => session.id)),
        [shown, selected],
    );
    // Taps select while the bar shows: not for rows selected and then hidden (archived, or searched away).
    const tapping = tapSelects && chosen.length > 0;
    const order = workspaceOrder();
    const numbers = useMemo(() => new Map(order.map((session, index) => [session.id, index])), [order]);

    /** The rows from `from` to `to` as they show, or just `to` when either is out of view. */
    const span = (from, to) => {
        const ids = visible.current;
        const a = ids.indexOf(from);
        const b = ids.indexOf(to);

        return a === -1 || b === -1 ? [to] : ids.slice(Math.min(a, b), Math.max(a, b) + 1);
    };

    /**
     * A plain click opens the session. Shift+click selects from the last row picked (or the open one) to this row;
     * Ctrl/⌘+Enter on a focused row selects it or lets it go.
     */
    const pick = (event, id) => {
        // The press already selected, even if Ctrl/⌘ was let go before the button.
        if (held.current === id && event.detail > 0) {
            held.current = null;

            return;
        }

        if (event.shiftKey) {
            // From the last row picked, or else the open session, if it shows; or else from this row on.
            if (!visible.current.includes(anchor.current)) {
                const open = store.state.conversationId;

                anchor.current = visible.current.includes(open) ? open : id;
            }

            setSelected(new Set([...picked.current, ...span(anchor.current, id)]));

            return;
        }

        if (event.ctrlKey || event.metaKey || tapping) {
            const next = new Set(picked.current);

            if (next.has(id)) {
                next.delete(id);
            } else {
                next.add(id);
            }

            anchor.current = id;
            setSelected(next);

            return;
        }

        clearSelection();
        navigate(id);
    };

    /**
     * A finger (or a pen) held on a row opens its actions in a sheet, as hovering shows them to a mouse: touch screens
     * have no hover. The row shows the press while it is held; moving (a scroll, a drag) lets it go. The click the lift
     * may then make, on the row or on the scrim that rose under it, does nothing. While the finger is held nothing on
     * the page can be selected: the sheet rises under the finger, and Android's own long press would otherwise select
     * the word there and raise its Copy bar over the sheet.
     */
    const press = (event, id) => {
        const session = sessions.find((each) => each.id === id);

        // Nothing to offer: an archived session, for someone who cannot bring it back.
        if (!event.isPrimary || !session || (session.archived && !canSteer())) {
            return;
        }

        const { pointerId, clientX: x, clientY: y } = event;
        let fired = false;
        let after = 0;
        const root = document.documentElement;
        const shows = setTimeout(() => setPressing(id), PRESS_SHOWS_MS);

        const open = setTimeout(() => {
            // Gone meanwhile (someone deleted it): nothing to open.
            if (!store.state.sessions.some((each) => each.id === id)) {
                return stop();
            }

            fired = true;
            setPressing(null);
            pressedIn = startSelect;
            // Over the drawer, which stays: Select goes on there.
            store.set({ sheet: { type: "session", id } });
        }, PRESS_MS);

        const move = (each) => {
            if (
                each.pointerId === pointerId &&
                !fired &&
                Math.hypot(each.clientX - x, each.clientY - y) >= PRESS_SLOP
            ) {
                stop();
            }
        };

        const lift = (each) => {
            if (each.pointerId !== pointerId) {
                return;
            }

            if (!fired) {
                return stop();
            }

            // The lift's click comes at once, if at all; the next press is someone else's tap.
            removeEventListener("pointerup", lift, true);
            removeEventListener("pointercancel", lift, true);
            addEventListener("pointerdown", stop, true);
            after = setTimeout(stop, 400);
        };

        // A finger's mouse events only: its mousedown can close the scrim before the click, and Enter on a sheet's
        // item is a click too. Keep the guard through mousedown so the click cannot act on an item under the lift.
        const eat = (each) => {
            if (fired && each.detail > 0) {
                each.preventDefault();
                each.stopPropagation();

                if (each.type === "click") {
                    stop();
                }
            }
        };

        // Android's own long press: no menu, and no text selection. The row's own text cannot be selected already,
        // but the sheet this press opens, rising under the finger, could be: Android would select the word under it
        // and raise its Copy bar over the sheet. So, while the finger is held, the page selects nothing.
        const quiet = (each) => each.preventDefault();
        const hold = (each) => each.preventDefault();

        const stop = () => {
            unpress.current = null;
            clearTimeout(shows);
            clearTimeout(open);
            clearTimeout(after);
            setPressing((now) => (now === id ? null : now));
            root.classList.remove("holding");
            removeEventListener("pointermove", move, true);
            removeEventListener("pointerup", lift, true);
            removeEventListener("pointercancel", lift, true);
            removeEventListener("pointerdown", stop, true);
            removeEventListener("mousedown", eat, true);
            removeEventListener("click", eat, true);
            removeEventListener("contextmenu", quiet, true);
            removeEventListener("selectstart", hold, true);
        };

        unpress.current?.();
        unpress.current = stop;
        root.classList.add("holding");
        addEventListener("pointermove", move, true);
        addEventListener("pointerup", lift, true);
        addEventListener("pointercancel", lift, true);
        addEventListener("mousedown", eat, true);
        addEventListener("click", eat, true);
        addEventListener("contextmenu", quiet, true);
        addEventListener("selectstart", hold, true);
    };

    /**
     * Ctrl/⌘+press on a row selects it (or, if it was selected, unselects it); dragging on does the same to every row
     * between it and the pointer. Once the pointer moves, the list scrolls along near its top or bottom edge. A finger
     * held on a row opens its actions instead.
     */
    const select = (event, id) => {
        held.current = null;

        if (event.button !== 0) {
            return;
        }

        if (event.pointerType !== "mouse") {
            press(event, id);

            return;
        }

        if (event.shiftKey) {
            // No text selection: the click extends the session selection instead.
            event.preventDefault();

            return;
        }

        if (!event.ctrlKey && !event.metaKey) {
            // A plain press that moves carries the row (and the rest of the selection) to a group (PP-76).
            if (mayGroup) {
                carry(event, picked.current.has(id) ? [...picked.current] : [id], "sessions");
            }

            return;
        }

        event.preventDefault();
        held.current = id;
        const box = list.current;
        const root = document.documentElement;
        const before = picked.current;
        const adding = !before.has(id);

        anchor.current = id;
        let reached = null;

        const reach = (to) => {
            if (to === reached) {
                return;
            }

            reached = to;
            const next = new Set(before);

            for (const each of span(id, to)) {
                if (adding) {
                    next.add(each);
                } else {
                    next.delete(each);
                }
            }

            setSelected(next);
        };

        reach(id);
        const start = event.clientY;
        let y = start;

        // The row at the pointer's height, held inside the list so a drag past its sides or ends still counts.
        const under = () => {
            const rect = box.getBoundingClientRect();
            const row = document
                .elementFromPoint(
                    rect.left + box.clientWidth / 2,
                    Math.min(rect.bottom - 2, Math.max(rect.top + 2, y)),
                )
                ?.closest?.(".session-row[data-id]");

            if (!row || !box.contains(row)) {
                return;
            }

            const found = visible.current.find((each) => String(each) === row.dataset.id);

            if (found !== undefined) {
                reach(found);
            }
        };

        // No frame until the pointer moves: a press near an edge is not a drag.
        let frame = 0;

        const scroll = () => {
            const rect = box.getBoundingClientRect();
            const edge = 36;
            const past =
                y < rect.top + edge
                    ? y - rect.top - edge
                    : y > rect.bottom - edge
                      ? y - rect.bottom + edge
                      : 0;

            if (past !== 0) {
                box.scrollTop += Math.max(-24, Math.min(24, past / 2));
                under();
            }

            frame = requestAnimationFrame(scroll);
        };

        const move = (each) => {
            // The button came up where this page did not hear it, say in another window.
            if ((each.buttons & 1) === 0) {
                return stop();
            }

            y = each.clientY;

            if (frame === 0 && Math.abs(y - start) > 4) {
                frame = requestAnimationFrame(scroll);
            }

            under();
        };

        const stop = () => {
            cancelAnimationFrame(frame);
            root.classList.remove("selecting");
            removeEventListener("pointermove", move);
            removeEventListener("pointerup", stop);
            removeEventListener("pointercancel", stop);
            removeEventListener("blur", stop);
        };

        root.classList.add("selecting");
        getSelection()?.removeAllRanges();
        addEventListener("pointermove", move);
        addEventListener("pointerup", stop);
        addEventListener("pointercancel", stop);
        addEventListener("blur", stop);
    };

    const moveChosen = () => openSheet({ type: "session-move", ids: chosen });

    const archiveChosen = () => {
        clearSelection();
        setArchived(chosen, !archived);
    };

    const allPinned = chosen.length > 0 && chosen.every((id) => pinned.includes(id));

    const pinChosen = () => {
        for (const id of chosen) {
            if (isPinned(id) === allPinned) {
                togglePin(id);
            }
        }

        clearSelection();
    };

    // Esc lets go of the selection, unless something else takes it: a sheet, the launcher, a text field, or a menu.
    const selecting = selected.size > 0;

    // On a touch screen, so does back.
    useBack(tapping, clearSelection);

    useEffect(() => {
        if (!selecting) {
            return;
        }

        const onKey = (event) => {
            if (
                event.key !== "Escape" ||
                event.defaultPrevented ||
                store.state.sheet ||
                store.state.launcher
            ) {
                return;
            }

            // Taken: this Esc lets go of the selection, and closes nothing else.
            event.preventDefault();
            clearSelection();
        };

        addEventListener("keydown", onKey);

        return () => removeEventListener("keydown", onKey);
    }, [selecting]);

    // Folder groups (PP-76): only for people who steer here with a list of their own (not an invited guest).
    const mayGroup = canSteer() && !scoped();

    /**
     * Drag and drop with a mouse (PP-76): sessions onto a folder group's name (into it), Active's (out of every group) or
     * Pinned's (pinned); a folder group's name before another's (its place, pinned like the one it lands by), onto
     * Pinned (pinned) or Active (unpinned). The menus do all of this too; dragging is a shortcut. The click that ends a
     * drag opens nothing.
     */
    const carry = (event, ids, kind) => {
        const root = document.documentElement;
        const startX = event.clientX;
        const startY = event.clientY;
        let ghost = null;
        let target = null;

        const label =
            kind === "group"
                ? (sessionGroups.groups.find((group) => group.id === ids[0])?.name ?? "")
                : ids.length === 1
                  ? (sessions.find((session) => session.id === ids[0])?.title ?? t("New session"))
                  : `${ids.length} sessions`;
        const move = (each) => {
            if (ghost === null) {
                if (Math.hypot(each.clientX - startX, each.clientY - startY) < 6) {
                    return;
                }

                ghost = document.createElement("div");
                ghost.className = "sg-ghost";
                ghost.textContent = label;
                document.body.append(ghost);
                root.classList.add("sg-carrying");
            }

            ghost.style.transform = `translate(${each.clientX + 12}px, ${each.clientY + 8}px)`;
            const next = document.elementFromPoint(each.clientX, each.clientY)?.closest?.("[data-drop]") ?? null;
            const fits = next !== null && !(kind === "group" && next.dataset.drop === `g:${ids[0]}`);

            if ((fits ? next : null) !== target) {
                target?.classList.remove("sg-drop");
                target = fits ? next : null;
                target?.classList.add("sg-drop");
            }
        };
        const eat = (each) => {
            each.preventDefault();
            each.stopPropagation();
        };
        const up = () => {
            removeEventListener("pointermove", move, true);
            removeEventListener("pointerup", up, true);
            removeEventListener("pointercancel", up, true);

            if (ghost === null) {
                return;
            }

            ghost.remove();
            root.classList.remove("sg-carrying");
            target?.classList.remove("sg-drop");
            addEventListener("click", eat, true);
            setTimeout(() => removeEventListener("click", eat, true), 60);

            const drop = target?.dataset.drop;

            if (drop === undefined) {
                return;
            }

            if (kind === "sessions") {
                if (drop === "pinned") {
                    ids.filter((id) => !isPinned(id)).forEach(togglePin);
                } else {
                    void moveToGroup(ids, drop === "active" ? null : drop.slice(2));
                }

                clearSelection();

                return;
            }

            const id = ids[0];
            const group = sessionGroups.groups.find((each) => each.id === id);

            if (drop === "pinned" || drop === "active") {
                if (group.pinned !== (drop === "pinned")) {
                    void pinGroup(id, drop === "pinned");
                }

                return;
            }

            const before = sessionGroups.groups.find((each) => each.id === drop.slice(2));

            void placeGroup(id, before.id).then(() => before.pinned !== group.pinned && pinGroup(id, before.pinned));
        };

        addEventListener("pointermove", move, true);
        addEventListener("pointerup", up, true);
        addEventListener("pointercancel", up, true);
    };

    /** "+ New group": an empty one, its name ready to type. */
    const newGroup = async () => {
        const made = await createGroup(t("New group"));

        if (made !== undefined) {
            setFresh(new Set([...fresh, made.id]));
            setNaming(made.id);

            // Under the folded Groups heading it would not show: the heading opens.
            if (closed.has("groups")) {
                toggleGroup("groups");
            }
        }
    };

    const toggleGroup = (key) => {
        const next = new Set(closed);

        if (next.has(key)) {
            next.delete(key);
        } else {
            next.add(key);
        }

        localStorage.setItem(CLOSED_KEY, JSON.stringify([...next]));
        setClosed(next);
    };

    const count = useMemo(() => sessions.filter((session) => !session.archived).length, [sessions]);
    // Rows' handlers that stay the same from draw to draw, so a row draws again only when what it shows changes. They
    // call this draw's `pick` and `select`, which see this draw's selection.
    const handlers = useRef(null);

    const toggleFold = (id) => {
        const next = new Set(foldedLinked);

        if (next.has(id)) {
            next.delete(id);
        } else {
            next.add(id);
        }

        try {
            localStorage.setItem(FOLDED_KEY, JSON.stringify([...next]));
        } catch {
            // Storage refused (a private window): the fold holds until the page reloads.
        }

        setFoldedLinked(next);
    };

    handlers.current = { pick, select, toggleFold };
    const [onPick] = useState(() => (event, id) => handlers.current.pick(event, id));
    const [onSelect] = useState(() => (event, id) => handlers.current.select(event, id));
    const [onFold] = useState(() => (id) => handlers.current.toggleFold(id));
    // What every row reads of the store, read once here: rows read none of it themselves (`SessionRow`). Marks, seen
    // marks, and read times come through `isUnread`, `finishedUnseen`, and `sessionUnread`.
    const { conversationId, me, moving } = store.state;
    const collabs = collab();
    const steers = canSteer();
    // Row buttons that only a hovering pointer shows (`NO_HOVER`): touch screens draw none, a long press opens them.
    const hovers = !NO_HOVER.matches;

    const rowOf = ({ session, branches, descendants }, index, group, folder) => {
        const open = session.id === conversationId && !session.archived;
        // Linked sessions fold under the one that started them; a search shows them all, with nothing to fold.
        const kids = needle === "" ? descendants : 0;
        const isFolded = kids > 0 && foldedLinked.has(session.id);

        return html`<${MemoRow}
            key=${session.id}
            session=${session}
            branches=${sameBranches(branches)}
            kids=${kids}
            foldedAway=${isFolded}
            foldTrouble=${isFolded ? hiddenTrouble(group, session.id) : undefined}
            onFold=${onFold}
            index=${index}
            number=${numbers.get(session.id)}
            needle=${needle}
            selected=${selected.has(session.id)}
            pressing=${pressing === session.id}
            folders=${false}
            team=${group.team?.has(session.id)}
            settled=${group.key === "settled" || folder ? settledOf(session) : null}
            filed=${group.key === "flat" ? groupOf(session.id, sessionGroups)?.name : undefined}
            onPick=${onPick}
            onSelect=${onSelect}
            open=${open}
            pinned=${isPinned(session.id)}
            marked=${isUnread(session.id)}
            unread=${collabs && !open && sessionUnread(session)}
            unseen=${finishedUnseen(session)}
            moving=${moving[session.id] !== undefined}
            home=${home}
            meId=${me?.id}
            collabs=${collabs}
            steers=${steers}
            grouping=${mayGroup}
            hovers=${hovers}
            minute=${minute}
            tick=${session.busy && session.busySince ? tick : 0}
        />`;
    };

    let index = 0;

    return html`<div class=${`sessions ${compact ? "compact" : ""}`} data-part="session-list">
        <div class="sessions-head">
            <span class="sessions-name" data-part="session-list-title">${t("Sessions")}</span>
            <span class="sessions-count">${sessionsLoaded ? count : ""}</span>
            ${
                canStart &&
                html`<button
                    class="new-button"
                    title=${t("New session (Alt+N)")}
                    onClick=${() => openSheet({ type: "cwd", mode: "new" })}
                >
                    <${Icon} name="plus" size=${14} />${t("New")}</button>`
            }
            ${canStart && html`<${VoiceNewButton} />`}
        </div>
        ${
            // After a big update (PP-235): on a phone's list; a wide screen has it on the home screen.
            !compact && !WIDE.matches && html`<${WhatsNewCard} />`
        }
        <label class=${`search ${query ? "filled" : ""}`} data-part="session-search">
            <${Icon} name="search" size=${14} />
            <input
                placeholder=${t("Search sessions")}
                aria-label=${t("Search sessions")}
                value=${query}
                onInput=${(event) => setQuery(event.currentTarget.value)}
                onKeyDown=${(event) => {
                    if (event.key !== "Escape" || query === "") {
                        return;
                    }

                    // Taken: this Esc clears the search, not the selection.
                    event.preventDefault();
                    setQuery("");
                }}
            />
            ${
                query
                    ? html`<button
                        class="search-clear"
                        aria-label=${t("Clear")}
                        onClick=${() => setQuery("")}
                    >
                        <${Icon} name="close" size=${13} />
                    </button>`
                    : html`<span
                            class="search-keys"
                            title=${t("Launcher")}
                            aria-hidden="true"
                            onClick=${(event) => {
                                event.preventDefault();
                                store.set({ launcher: true, drawer: false });
                            }}
                        >
                            ${APPLE ? "⌘K" : "Ctrl K"}
                        </span>
                        <button
                            class="search-launcher"
                            title=${t("Launcher")}
                            aria-label=${t("Open the launcher")}
                            onClick=${(event) => {
                                event.preventDefault();
                                store.set({ launcher: true, drawer: false });
                            }}
                        >
                            <${Icon} name="command" size=${14} />
                        </button>`
            }
        </label>
        <${ScopePicker} scope=${scope} onScope=${setScope} sessions=${sessions} home=${server?.home} mine=${sessionGroups} />
        <div
            class="session-items"
            ref=${list}
            onScroll=${(event) => !compact && (listKept.scroll = event.currentTarget.scrollTop)}
        >
            ${!sessionsLoaded && html`<${LoadingSessions} />`}
            ${
                sessionsLoaded &&
                shown.length === 0 &&
                html`<div class="sessions-empty">
                    ${archived ? t("No archived sessions.") : needle ? t("No matches.") : t("No sessions yet. Start one with New.")}
                </div>`
            }
            ${groups.map((group) => {
                const isClosed = folded(group, closed);
                // A folded group hides its rows' marks: say when one waits for you or its run failed.
                const trouble = isClosed
                    ? group.hidden
                          .map((row) => sessionMark(row.session).shape)
                          .find((shape) => shape === "waiting" || shape === "failed")
                    : undefined;

                const folder = group.folder;
                // The folder groups end with "+ New group", before Settled (or at the end).
                const lastFolder = mayGroup && !needle && !archived && !scope.startsWith("fg:") && group.key === groups.findLast((each) => each.under || each.key === "groups" || each.key === "active")?.key;
                const empties = groups.find((each) => each.key === "groups")?.empties ?? 0;
                const drop = mayGroup && !needle && !archived && (folder || group.key === "active" || group.key === "pinned") ? (folder ? `g:${folder.id}` : group.key) : undefined;

                return html`<section
                    class=${`session-group ${isClosed ? "closed" : ""} ${folder ? "sg-group" : ""}`}
                    data-part="session-group"
                    data-group=${group.key}
                    key=${`${scope}:${group.key}`}
                >
                    ${
                        folder && naming === folder.id
                            ? html`<div class="group-head sg-head sg-naming" data-part="session-group-head">
                                  <${Icon} name="folder" size=${12} />
                                  <input
                                      class="sg-name-field"
                                      aria-label=${t("The group's name")}
                                      maxlength="60"
                                      value=${folder.name}
                                      ref=${(field) => field && document.activeElement !== field && !field.dataset.focused && ((field.dataset.focused = "1"), field.focus(), field.select())}
                                      onKeyDown=${(event) => {
                                          if (event.key === "Enter") {
                                              event.currentTarget.blur();
                                          } else if (event.key === "Escape") {
                                              event.preventDefault();
                                              event.currentTarget.value = folder.name;
                                              event.currentTarget.blur();
                                          }
                                      }}
                                      onBlur=${(event) => {
                                          const name = event.currentTarget.value.trim();

                                          setNaming(null);

                                          if (name !== "" && name !== folder.name) {
                                              void renameGroup(folder.id, name);
                                          }
                                      }}
                                  />
                              </div>`
                            : group.key !== "flat" || needle
                            ? html`<button
                                class=${`group-head ${folder ? "sg-head" : ""}`}
                                data-part="session-group-head"
                                data-drop=${drop}
                                onClick=${() => group.key !== "flat" && (folder ? foldGroup(folder.id, !folder.folded) : toggleGroup(group.foldable ? `open:${group.key}` : group.key))}
                                onPointerDown=${(event) => folder && mayGroup && event.pointerType === "mouse" && event.button === 0 && !event.ctrlKey && !event.metaKey && !event.shiftKey && carry(event, [folder.id], "group")}
                                onContextMenu=${(event) => {
                                    // A long press (or a right click) on a group's name: its menu.
                                    if (folder && mayGroup) {
                                        event.preventDefault();
                                        openSheet({ type: "session-group", id: folder.id });
                                    }
                                }}
                                aria-expanded=${!isClosed}
                            >
                                <span class="group-name" data-part="session-group-name">
                                    ${folder && html`<${Icon} name="folder" size=${12} />`}
                                    ${
                                        typeof group.label === "string"
                                            ? html`<b>${group.label}</b>`
                                            : group.label
                                    }
                                    ${folder?.pinned && html`<span class="sg-pin" title=${t("Pinned")}><${Icon} name="pin" size=${10} /></span>`}
                                </span>
                                ${
                                    trouble &&
                                    html`<span
                                        class=${`group-trouble ${trouble}`}
                                        role="img"
                                        aria-label=${trouble === "waiting" ? t("A session needs you") : t("A session failed")}
                                        title=${trouble === "waiting" ? t("A session here needs you") : t("A session here failed")}
                                    ></span>`
                                }
                                <span class="group-count" data-part="session-group-count">
                                    ${group.count ?? group.total}
                                </span>
                                ${group.key !== "flat" && html`<${Icon} name="down" size=${11} />`}
                            </button>`
                            : null
                    }
                    ${
                        folder &&
                        mayGroup &&
                        naming !== folder.id &&
                        html`<button
                            class="sg-more"
                            title=${t("Pin, rename, fold, move or delete the group")}
                            aria-label=${t("{name}: the group's menu", { name: folder.name })}
                            onClick=${() => openSheet({ type: "session-group", id: folder.id })}
                        >
                            <${Icon} name="more" size=${14} />
                        </button>`
                    }
                    <div class="group-body" inert=${isClosed}>
                        <div>
                            ${group.rows.map((row) => rowOf(row, index++, group, folder))}
                        </div>
                    </div>
                </section>
                ${
                    lastFolder &&
                    html`<div class="sg-foot">
                        <button class="sg-new" data-part="session-group-new" onClick=${newGroup}><${Icon} name="plus" size=${12} /><span>${t("New group")}</span></button>
                        ${
                            empties > 0 &&
                            !closed.has("groups") &&
                            html`<button class="sg-new sg-empties" title=${showEmpty ? t("Hide empty groups") : tn(empties, "Show {n} empty group", "Show {n} empty groups")} onClick=${() => setShowEmpty(!showEmpty)}>
                                <span>${showEmpty ? t("Hide empty") : t("Show {n} empty", { n: empties })}</span>
                            </button>`
                        }
                    </div>`
                }`;
            })}
        </div>
        ${
            chosen.length > 0 &&
            html`<div class="select-bar" role="group" aria-label=${t("Selected sessions")}>
                <span class="select-count">
                    <b>${chosen.length}</b>
                    <span class="select-word"> ${t("selected")}</span>
                </span>
                ${
                    canSteer() &&
                    html`<button class="button" onClick=${archiveChosen}>
                        ${archived ? t("Unarchive") : t("Archive")}
                    </button>`
                }
                ${
                    !archived &&
                    html`<button class="button" onClick=${pinChosen}>
                        ${allPinned ? t("Unpin") : t("Pin")}
                    </button>`
                }
                ${
                    !archived &&
                    mayGroup &&
                    html`<button class="button" title=${t("Move them to a folder group")} onClick=${moveChosen}>${t("Move…")}</button>`
                }
                <button
                    class="select-clear"
                    title=${t("Clear the selection (Esc)")}
                    aria-label=${t("Clear the selection")}
                    onClick=${clearSelection}
                >
                    <${Icon} name="close" size=${14} />
                </button>
            </div>`
        }
    </div>`;
}

/**
 * The store's keys the session list reads as it draws, itself and through what it calls: `canSteer()`, `scoped()`, and
 * `collab()` (`me`, `server`), `isPinned` and `workspaceOrder` (`pinned`), `isUnread` (`unread`), `sessionUnread`
 * (`conversationId`, `chatRead`, `chatReads`, `me`), `finishedUnseen` and `sessionMark` (`peekSeen`, and `server` for
 * when this browser started), and the folder groups (`sessionGroups`). The sheet and the launcher it reads only as keys
 * are pressed.
 */
const LIST_KEYS = [
    "sessions",
    "sessionsLoaded",
    "server",
    "me",
    "pinned",
    "sessionGroups",
    "unread",
    "moving",
    "conversationId",
    "chatRead",
    "chatReads",
    "peekSeen",
];

/**
 * Drawn again only when what it reads changes (`LIST_KEYS`): not as an answer streams, nor for the chat, people, or
 * the connection. Back to the list and each reconnect change little of it.
 */
export const SessionList = drawnFor(LIST_KEYS, AllSessions);

/**
 * Subagents across the sessions, by state, as the rail counts them: archived sessions only while a subagent works
 * there, as the subagents board shows them.
 */
export function subagentTotals(sessions = store.state.sessions) {
    const totals = { working: 0, waiting: 0, failed: 0, stopped: 0, done: 0, dealt: 0 };

    for (const session of sessions) {
        const counts = session.subagents;

        if (!counts || (session.archived && !counts.working && !counts.waiting)) {
            continue;
        }

        for (const state of Object.keys(totals)) {
            totals[state] += counts[state] ?? 0;
        }
    }

    return totals;
}

/** Open the subagents board in the conversation's place, or close it. */
export const toggleBoard = () =>
    store.set((state) =>
        state.board
            ? { board: false, boardAgents: null }
            : { board: true, drawer: false, page: null },
    );

/** The folded sidebar's sessions, numbered like Waybar's workspaces. */
function RailTiles() {
    const { conversationId } = store.state;
    const items = useRef(null);
    const order = workspaceOrder();
    // The tiles are as tall as each other: the open session's place in the order says where its marker goes.
    const at = order.findIndex((session) => session.id === conversationId);
    const indicator = useSlide(items, ".ws.active", "y", at);

    return html`<div class="rail-items" ref=${items}>
        <${Slide} box=${indicator} />
        ${order.map(
            (session, index) => html`<button
                key=${session.id}
                class=${`ws ${session.id === conversationId ? "active" : ""} ${session.busy ? "busy" : ""} ${session.waiting ? "waiting" : ""}`}
                style=${`--i:${index}`}
                title=${`${session.title ?? t("New session")}${index < 9 ? ` (Alt+${index + 1})` : ""}`}
                aria-label=${session.waiting ? t("{title}, needs you", { title: session.title ?? t("New session") }) : session.busy ? t("{title}, working", { title: session.title ?? t("New session") }) : (session.title ?? t("New session"))}
                aria-current=${session.id === conversationId ? "page" : undefined}
                onClick=${() => navigate(session.id)}
            >
                ${index < 9 ? index + 1 : initials(session.title ?? t("New session"))}
                ${
                    ((collab() && sessionUnread(session)) || isUnread(session.id)) &&
                    session.id !== conversationId &&
                    html`<span class="unread-dot"></span>`
                }
            </button>`,
        )}
    </div>`;
}

/**
 * The rail beside the session list: Pi (home), the sessions (which fold the sidebar), then the tools (peek tiles, PiP,
 * running now, the subagents board, people, providers, the theme) and you. Folded, it holds the sessions too, numbered.
 * In the drawer and on a phone's home screen it does not fold, and Pi is a mark.
 */
function Rail({ foldable = false, folded = false }) {
    const { sessions, board, me } = store.state;
    const canStart = canSteer() && !scoped();
    // Counted again only when the session list changes, not on each draw of the rail.
    const { busy, agents } = useMemo(
        () => ({
            busy: sessions.filter((session) => session.busy).length,
            agents: subagentTotals(sessions),
        }),
        [sessions],
    );
    const live = agents.working + agents.waiting;
    const failed = failing(agents);
    const keys = APPLE ? "⌘B" : "Ctrl+B";
    const fold = () => setPrefs({ sidebar: folded ? "open" : "rail" });
    const role = me?.role === "owner" ? "owner" : me?.role === "viewer" ? "view only" : "guest";

    return html`<nav class="rail" data-part="rail" aria-label=${t("Sessions and tools")}>
        ${
            foldable
                ? html`<button
                    class="rail-brand"
                    data-part="brand-mark"
                    title=${t("Home")}
                    aria-label=${t("Home")}
                    onClick=${toSessions}
                >
                    <img class="brand-icon" src="icon.svg" alt="" />
                </button>`
                : html`<span class="rail-brand" data-part="brand-mark" aria-hidden="true"><img class="brand-icon" src="icon.svg" alt="" /></span>`
        }
        <span class="rail-gap"></span>
        ${
            foldable
                ? html`<button
                    class=${`rail-button ${folded ? "" : "on"}`}
                    data-part="rail-button"
                    data-state=${railState(!folded)}
                    title=${folded ? t("Sessions ({keys} unfolds the list)", { keys }) : t("Sessions ({keys} folds the list)", { keys })}
                    aria-label=${t("Sessions")}
                    aria-expanded=${!folded}
                    onClick=${fold}
                >
                    <${Icon} name="chat" size=${19} />
                </button>`
                : html`<span
                    class="rail-button on"
                    data-part="rail-button"
                    data-state="open"
                    title=${t("Sessions")}
                    aria-current="page"
                >
                    <${Icon} name="chat" size=${19} />
                </span>`
        }
        ${!folded && html`<span class="rail-fill"></span>`}
        ${
            folded &&
            canStart &&
            html`<button
                class="rail-button rail-new"
                data-part="rail-button"
                title=${t("New session (Alt+N)")}
                aria-label=${t("New session")}
                onClick=${() => openSheet({ type: "cwd", mode: "new" })}
            >
                <${Icon} name="plus" size=${19} />
            </button>`
        }
        ${folded && html`<${RailTiles} />`}
        ${foldable && html`<${PeeksRailButton} />`}
        <button
            class=${`rail-button rail-running ${busy > 0 ? "lit" : ""}`}
            data-part="rail-button"
            data-state=${railState(false, busy > 0)}
            title=${t("Running now")}
            aria-label=${busy > 0 ? t("Running now, {n}", { n: busy }) : t("Running now")}
            onClick=${() => openSheet({ type: "running" })}
        >
            <${Icon} name="pulse" size=${19} />
            ${busy > 0 && html`<span class="rail-count">${busy}</span>`}
        </button>
        <button
            class=${`rail-button rail-agents ${live > 0 ? "lit" : ""} ${board ? "open" : ""}`}
            data-part="rail-button"
            data-state=${railState(board, live > 0)}
            title=${t("Subagents in every session")}
            aria-label=${[
                t("Subagents"),
                live > 0 && t("{n} at work", { n: live }),
                agents.waiting > 0 && t("{n} waiting for approval", { n: agents.waiting }),
                failed > 0 && t("{n} failed", { n: failed }),
            ]
                .filter(Boolean)
                .join(", ")}
            aria-pressed=${board}
            onClick=${toggleBoard}
        >
            <${Icon} name="fork" size=${19} />
            ${live > 0 && html`<span class="rail-count">${live}</span>`}
            ${
                (failed > 0 || agents.waiting > 0) &&
                html`<span class="rail-trouble" aria-hidden="true"></span>`
            }
        </button>
        <${ExtensionRailButtons} />
        ${
            // Behind the server edition's gateway, people and devices are its (PP-21): the rail opens its pages in the
            // People & account panel (PP-80), on People (Account for a role that may not see people).
            store.state.server?.gateway
                ? html`<button
                    class=${`rail-button rail-ext ${store.state.page?.module === GATEWAY_PAGE ? "open" : ""}`}
                    data-part="rail-button"
                    title=${t("Your account and people")}
                    aria-label=${t("People & account")}
                    onClick=${() => openGatewayPage("people")}
                >
                    <${Icon} name="users" size=${19} />
                </button>`
                : collab()
                ? html`<button
                    class="rail-button"
                    data-part="rail-button"
                    title=${canStart ? t("People and invites") : t("People")}
                    aria-label=${t("People")}
                    onClick=${() => openSheet({ type: "people" })}
                >
                    <${Icon} name="users" size=${19} />
                </button>`
                : html`<button
                    class="rail-button"
                    data-part="rail-button"
                    title=${t("Sign in another device")}
                    aria-label=${t("Devices")}
                    onClick=${() => openSheet({ type: "invite" })}
                >
                    <${Icon} name="users" size=${19} />
                </button>`
        }
        ${
            me?.role === "owner" &&
            roleAllows("providers.signin") &&
            html`<button
                class="rail-button"
                data-part="rail-button"
                title=${t("Model providers")}
                aria-label=${t("Providers")}
                onClick=${() => openSheet({ type: "providers" })}
            >
                <${Icon} name="key" size=${19} />
            </button>`
        }
        <button
            class="rail-button"
            data-part="rail-button"
            title=${t("Theme, tiling, motion")}
            aria-label=${t("Theme")}
            onClick=${() => openSheet({ type: "appearance" })}
        >
            <${Icon} name="palette" size=${19} />
        </button>
        <button
            class="rail-button"
            data-part="rail-button"
            title=${t("Settings: providers, GitHub, app updates")}
            aria-label=${t("Settings")}
            onClick=${() => openSheet({ type: "menu", fromPlaces: true })}
        >
            <${Icon} name="menu" size=${19} />
        </button>
        <button
            class="rail-button rail-me"
            data-part="rail-button"
            title=${`${me?.name ?? ""} · ${role}`}
            aria-label=${t("Your name")}
            onClick=${() => openSheet({ type: "name" })}
        >
            ${me && html`<${Avatar} person=${me} size=${30} />`}
        </button>
    </nav>`;
}

/** Not drawn again as an answer streams: it reads no conversation's view. */
export const RailNav = apartFromViews(Rail);

/** The sidebar's list is this wide at least and at most; the rail beside it stays 56px. */
const LIST_MIN = 204;
const LIST_MAX = 464;

/** The sidebar's usual width, the rail and its list together: the one a new browser starts with (theme.js). */
export const SIDEBAR_WIDTH = 312;

/** Drag the sidebar's right edge to resize its list; a double click puts it back to its usual width. */
export function ResizeHandle() {
    const ref = useRef(null);
    // A theme may put the sidebar on the right: the handle goes to its other edge, and drags the other way.
    const side = useSide(ref, (handle) => handle.parentElement);

    const start = (event) => {
        if (event.button !== 0) {
            return;
        }

        event.preventDefault();
        const root = document.documentElement;
        const sidebar = event.currentTarget.parentElement;
        const box = sidebar.getBoundingClientRect();
        // The rail and the borders, which keep their width.
        const rest = sidebar.offsetWidth - (sidebar.querySelector(".sessions")?.offsetWidth ?? 0);
        let width = prefs().sidebarWidth;

        root.classList.add("resizing");

        // No wider than the stylesheet lets it be: 40% of the screen.
        const max = Math.min(LIST_MAX + rest, Math.max(SIDEBAR_WIDTH, innerWidth * 0.4));

        const move = (each) => {
            const across = side === "right" ? box.right - each.clientX : each.clientX - box.left;

            width = Math.round(Math.min(max, Math.max(LIST_MIN + rest, across)));
            root.style.setProperty("--sidebar-w", `${width}px`);
        };

        const stop = () => {
            root.classList.remove("resizing");
            removeEventListener("pointermove", move);
            removeEventListener("pointerup", stop);
            removeEventListener("pointercancel", stop);
            setPrefs({ sidebarWidth: width });
        };

        addEventListener("pointermove", move);
        addEventListener("pointerup", stop);
        addEventListener("pointercancel", stop);
    };

    return html`<div
        class=${`resize-handle ${side === "right" ? "at-left" : ""}`}
        ref=${ref}
        role="separator"
        aria-orientation="vertical"
        title=${t("Drag to resize")}
        onPointerDown=${start}
        onDblClick=${() => setPrefs({ sidebarWidth: SIDEBAR_WIDTH })}
    ></div>`;
}

/** The rail and the session list, sliding in from the left on narrow screens. */
export function Drawer() {
    const [open, leaving] = usePresence(store.state.drawer || null, 200);
    const ref = useRef(null);
    const close = () => store.set({ drawer: false });
    // A theme may slide it in from the right: it is dragged back that way.
    const side = useSide(ref);

    useBack(store.state.drawer === true, close);
    // Not under a row's actions, which a long press opens over it: the finger that opened them may still move.
    useDragToClose(ref, {
        dir: side,
        onClose: close,
        enabled: Boolean(open) && !leaving && !store.state.sheet,
    });
    // Esc closes it, as it does a sheet; one over it closes first.
    useEffect(() => {
        if (!open || leaving) {
            return undefined;
        }

        const onKey = (event) => {
            if (
                event.key === "Escape" &&
                !event.defaultPrevented &&
                !store.state.sheet &&
                !store.state.launcher
            ) {
                event.preventDefault();
                close();
            }
        };

        addEventListener("keydown", onKey);

        return () => removeEventListener("keydown", onKey);
    }, [open, leaving]);

    if (!open) {
        return null;
    }

    return html`<div class=${leaving ? "leaving" : ""} inert=${leaving}>
        <div
            class="overlay drawer-overlay"
            data-part="scrim"
            data-for="drawer"
            onMouseDown=${scrimPress(close)}
        >
            <aside
                class="drawer"
                data-part="drawer"
                data-state=${leaving ? "closing" : undefined}
                ref=${ref}
            >
                <${RailNav} />
                <${SessionList} compact=${true} />
            </aside>
        </div>
    </div>`;
}
