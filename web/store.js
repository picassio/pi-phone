// App state, the server connection, and API calls. Components read `store.state` and re-render on `store.subscribe`.
import { BASE, routeOf } from "./base.js";
import { onRoute, pushRoute } from "./back.js";
import { sessionForest } from "./session-tree.js";
import { liveMessage } from "./live.js";
import { chooseLanguage, tServer } from "./i18n.js";

/** A random id. crypto.randomUUID only exists on https and localhost pages; plain-http network addresses lack it. */
export function uid() {
    if (typeof crypto.randomUUID === "function") {
        return crypto.randomUUID();
    }

    const bytes = crypto.getRandomValues(new Uint8Array(16));

    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");

    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** How many transcript rows a session shows when opened; "Show earlier messages" adds this many more. */
export const TRANSCRIPT_ROWS = 60;

const TAB_KEY = "pocket.tab";
const UNREAD_KEY = "pocket.unread";

/** Sessions this browser has marked unread, like the pinned list beside it (`pocket.unread`). */
function unreadOf() {
    try {
        const ids = JSON.parse(localStorage.getItem(UNREAD_KEY) ?? "[]");

        return Array.isArray(ids) ? ids : [];
    } catch {
        return [];
    }
}

/** How far this browser has read a session's chat: the time of the newest message seen, in `pocket.chatRead.<id>`. */
const CHAT_READ_PREFIX = "pocket.chatRead.";

/**
 * Every session's read time, by id, from local storage. Read once at load and kept in the store (`chatReads`): the list
 * asks for each row as it draws, and storage is slow to ask.
 */
function readChatReads() {
    const reads = {};

    for (let index = 0; index < localStorage.length; index++) {
        const key = localStorage.key(index);
        const at = key?.startsWith(CHAT_READ_PREFIX) ? Number(localStorage.getItem(key)) : 0;

        if (at > 0) {
            reads[key.slice(CHAT_READ_PREFIX.length)] = at;
        }
    }

    return reads;
}

const firstReads = readChatReads();

const TAB = sessionStorage.getItem(TAB_KEY) ?? uid();

sessionStorage.setItem(TAB_KEY, TAB);


const emptyView = () => ({
    conversation: null,
    entries: new Map(),
    order: [],
    live: { busy: false },
    inbox: [],
    agent: null,
    stats: { cost: 0 },
    clients: 0,
    viewers: [],
    approvals: [],
    subagents: [],
    authors: {},
    reactions: {},
    pins: [],
    turns: { on: false, asks: [] },
    decisions: {},
    plan: { on: false },
    artifacts: [],
    schedules: [],
    goal: null,
    ciWatches: [],
    branch: null,
    subagentsHeld: null,
});

export const store = {
    state: {
        me: undefined, // undefined: unknown, null: signed out
        users: [],
        // Removed people's names, by id: what they wrote keeps its author's name.
        former: {},
        models: [],
        // Subscription accounts' plan limits, by provider id (src/server/usage-limits.ts): from `hello`, `usage` events, and
        // `loadUsage`.
        usage: {},
        /** This tab's shared model refresh state and last result (`model-refresh.js`). */
        modelRefresh: { loading: false, result: null, error: null },
        guard: null,
        server: null,
        sessions: [],
        /** This person's favorite folders, in shortcut order, sent by the server to every signed-in device. */
        folderFavorites: [],
        /** The machines' ports open here (`forwards.ts`), once the Ports sheet loaded them or the server sent a change. */
        forwards: null,
        /** This person's folder groups in the session list (PP-76), from the server: the same on every device. */
        sessionGroups: { groups: [], members: {} },
        /** False until the server's first session list arrives: an empty list until then means "not here yet". */
        sessionsLoaded: false,
        /** Sessions on their way into the archive (true) or out of it (false), by id, until the list catches up (`sessions.js`). */
        moving: {},
        /** Sessions marked unread in this browser: an id each, until opened again. */
        unread: unreadOf(),
        conversationId: routeConversation(),
        view: emptyView(),
        /** How far this browser has read each session's chat, by id: what `pocket.chatRead.<id>` keeps. */
        chatReads: firstReads,
        ...peopleFor(routeConversation(), firstReads),
        history: null,
        /** The id of the oldest transcript entry shown, or null for the newest `TRANSCRIPT_ROWS` rows. */
        transcriptFrom: null,
        missing: null,
        connection: "connecting",
        notices: [],
        sheet: null,
        drawer: false,
        auth: null,
        /** A transcript message the next chat message discusses: `{ entryId, text }`. */
        chatQuote: null,
        /** Text to put into the message box to Pi: `{ text, n }`, picked up by the composer. */
        composerInsert: null,
        /** Pi's prompt templates for a conversation's folder: `{ conversationId, at, list }`. */
        templates: null,
        /** Whether Pi trusts a conversation's project, for its own skills (`trust.js`): `{ conversationId, cwd, info }`. */
        trust: null,
        /** The conversation whose subagents bar shows a row for each subagent (`subagents.js`); null for none. */
        subagentsOpen: null,
        /** The subagents board shows in the conversation's place (`subagents-board.js`). */
        board: false,
        /** Every subagent in every session, while the board shows; null until the server's first list arrives. */
        boardAgents: null,
        /** An extension's page in the conversation's place, as the board shows (`extension-ui.js`): `{ module, id }`. */
        page: null,
        /** Counts changes to what extensions' browser modules add (`extension-ui.js`), so what shows them draws again. */
        extensionsRev: 0,
        /** Counts the lists of files for @ mentions that arrived; the lists themselves are kept in `files.js`. */
        filesLoaded: 0,
        /** `!` commands this tab started that have no entry yet: `{ taskId, command, conversationId, at }`. */
        pendingShells: [],
        /** The Files tile shows (`files-panel.js`); kept per tab, so the reload after a live edit keeps it. */
        filesOpen: sessionStorage.getItem("pocket.files") === "1",
        /** Pi's browser panel shows (`browser-panel.js`), and what the server last said of Pi's browser. */
        browserOpen: sessionStorage.getItem("pocket.piBrowser") === "1" && sessionStorage.getItem("pocket.files") !== "1",
        // Pi's browsers by place (`phone`, `machine:<id>`): what each shows and does. The panel shows the session's own.
        piBrowsers: {},
        /** The Files tile's tab: `files` or `changes`. */
        filesTab: sessionStorage.getItem("pocket.filesTab") === "changes" ? "changes" : "files",
        /** The last file asked to open in the Files tile: `{ path, line, n }`, `n` telling requests apart. */
        filesTarget: null,
        /** When someone last asked for the Files tile, and for which tab: `{ tab, at }`. */
        filesAsk: null,
        /** The People panel shows beside the conversation on wide screens; kept per tab, like the Files tile. */
        peopleOpen: sessionStorage.getItem("pocket.people") === "1",
        /** The last request to show the People panel: which tab and chat message, and a count that tells requests apart. */
        peopleAsk: { tab: null, highlight: null, n: 0 },
    },
    listeners: new Set(),
    /**
     * Change the state: by a patch, or by what a function of the state returns. The function runs first, so a change
     * it makes on the way (a notice, say) is kept, not overwritten by the state as it was before.
     */
    set(patch) {
        const change = typeof patch === "function" ? patch(this.state) : patch;

        this.state = { ...this.state, ...change };

        for (const listener of this.listeners) {
            listener(this.state);
        }
    },
    /**
     * Change the state without drawing anything again: for what the last draw already showed, so a draw for it would
     * change nothing on screen. Kept in the same state object, which `apartFromViews` compares, so the next change draws
     * as if this one was always there.
     */
    note(patch) {
        Object.assign(this.state, patch);
    },
    subscribe(listener) {
        this.listeners.add(listener);

        return () => this.listeners.delete(listener);
    },
};

// ─── Marked-unread sessions (this browser) ──────────────────────────────────────

/** The marked-unread ids as a set, made again only when the list changes: rows ask for each session as they draw. */
let unreadSet = { list: null, set: new Set() };

export function isUnread(id) {
    const list = store.state.unread;

    if (unreadSet.list !== list) {
        unreadSet = { list, set: new Set(list) };
    }

    return unreadSet.set.has(id);
}

/** Mark a session unread, or clear it again, in this browser only. Opening the session clears it (`opened`). */
export function setUnread(id, unread) {
    const next = unread
        ? [...new Set([...store.state.unread, id])]
        : store.state.unread.filter((each) => each !== id);

    localStorage.setItem(UNREAD_KEY, JSON.stringify(next));
    store.set({ unread: next });
}

/** Opening a session is reading it, however it opens (a tap, back, a link, a notification): its mark goes. */
function opened(id) {
    if (id !== null && isUnread(id)) {
        setUnread(id, false);
    }
}

opened(store.state.conversationId);

function routeConversation() {
    const match = /^\/s\/(\d+)/.exec(routeOf(location.pathname));

    return match ? Number(match[1]) : null;
}

// ─── People: presence, typing, and the side chat ───────────────────────────────────

const CHAT_LIMIT = 500;

/**
 * Fresh people state for a conversation: no one known yet, and how far this browser has read its chat. A function
 * declaration, not a const: the store's initial state calls it before this line runs, with `reads` given.
 */
function peopleFor(id, reads = store.state.chatReads) {
    return {
        chat: [],
        presence: [],
        notes: null,
        chatQuote: null,
        chatRead: id === null ? 0 : (reads[id] ?? 0),
    };
}

// Another tab of this browser read a chat (or the storage was cleared): the list's marks follow.
addEventListener("storage", (event) => {
    if (event.key === null || event.key.startsWith(CHAT_READ_PREFIX)) {
        setChanged({ chatReads: kept(store.state.chatReads, readChatReads()) });
    }
});

/** Someone else chatted in a session after this browser last read its chat. */
export function sessionUnread(session, state = store.state) {
    const read =
        session.id === state.conversationId ? state.chatRead : (state.chatReads[session.id] ?? 0);

    return session.chatAt !== undefined && session.chatBy !== state.me?.id && session.chatAt > read;
}

/**
 * Sessions in "workspace" order, as Alt+1…9 and the rail number them: pinned ones first (in the order they were
 * pinned), then the rest, newest first, each followed by the linked sessions under it, as the list shows them
 * (`session-tree.js`). Archived sessions are left out.
 */
export function workspaceOrder(state = store.state) {
    const { sessions, pinned: pins } = state;

    // The list, the rail, the home screen, and peek tiles all ask as they draw: the order is made once for each list.
    if (ordered.sessions === sessions && ordered.pinned === pins) {
        return ordered.order;
    }

    const active = sessions.filter((session) => !session.archived);
    const { roots, rows } = sessionForest(active, { pinned: pins });
    const family = (root) => rows.get(root.id).map((row) => row.session);
    const byId = new Map(roots.map((root) => [root.id, root]));
    const pinned = pins.map((id) => byId.get(id)).filter(Boolean);
    const first = new Set(pinned);
    // Shared by every caller until the next list: frozen, so none changes it for the others.
    const order = Object.freeze([
        ...pinned.flatMap(family),
        ...roots.filter((root) => !first.has(root)).flatMap(family),
    ]);

    ordered = { sessions, pinned: pins, order };

    return order;
}

/** The last workspace order, and the lists it was made from. */
let ordered = { sessions: null, pinned: null, order: [] };

/** Server features the web app may use. `collab` 2 adds roles, take turns, reactions, pins, notes, mentions, push. */
export const collab = () => (store.state.server?.collab ?? 0) >= 2;
/** Viewers read and chat; they never steer Pi. */
export const canSteer = () => store.state.me?.role !== "viewer";

/**
 * Whether this person may turn take turns on or off here, as the server decides: anyone who steers while it is off; the
 * driver, the owner, or anyone when nobody drives or the driver has left, while it is on.
 */
export function canToggleTurns() {
    const { me, presence, view } = store.state;
    const turns = view.turns;

    return (
        canSteer() &&
        (!turns?.on ||
            turns.driver === me?.id ||
            me?.role === "owner" ||
            !turns.driver ||
            !presence.some((person) => person.id === turns.driver))
    );
}

/** People invited to one session cannot start sessions or invite others. */
export const scoped = () => Array.isArray(store.state.me?.sessions);

/** The notices that announce chat messages, here or a mention elsewhere, by id: their session's. Reading its chat takes them down. */
const chatNotices = new Map();

/** Everything in the chat counts as read: called while the chat is open. */
export function markChatRead() {
    const { chat, chatRead, conversationId } = store.state;

    for (const [id, conversation] of chatNotices) {
        if (conversation === conversationId) {
            dismiss(id);
            chatNotices.delete(id);
        }
    }

    const last = chat.at(-1)?.at ?? 0;

    if (last <= chatRead || conversationId === null) {
        return;
    }

    localStorage.setItem(CHAT_READ_PREFIX + conversationId, String(last));
    store.set((state) => ({
        chatRead: last,
        chatReads: { ...state.chatReads, [conversationId]: last },
    }));
}

function applyChat(data) {
    const state = store.state;

    if (data.conversationId !== state.conversationId) {
        return;
    }

    const known = new Set(data.full ? [] : state.chat.map((message) => message.id));
    const added = data.messages.filter((message) => !known.has(message.id));

    store.set({ chat: (data.full ? data.messages : [...state.chat, ...added]).slice(-CHAT_LIMIT) });

    // The People panel stays open for long: on its Pinned or Notes tab, new messages still count and show a notice.
    if (chatLogs > 0) {
        markChatRead();

        return;
    }

    // A full list comes on connect: only live messages from others pop up.
    const fresh = data.full
        ? []
        : added.filter((message) => message.userId !== state.me?.id && message.kind !== "event");

    if (fresh.length === 0) {
        return;
    }

    const open = () => openSheet({ type: "chat" });
    const announce = (message) =>
        chatNotices.set(notify("info", message, open), store.state.conversationId);

    if (fresh.length > 1) {
        return announce(`${fresh.length} new chat messages`);
    }

    const [message] = fresh;
    const name = state.users.find((user) => user.id === message.userId)?.name ?? message.name;
    const text = message.text.replace(/\s+/g, " ");
    const mentioned = message.mentions?.includes(state.me?.id);

    announce(
        `${name}${mentioned ? " mentioned you" : ""}: ${text.length > 120 ? `${text.slice(0, 119)}…` : text}`,
    );
}

let typingSent = { where: null, at: 0, conversationId: null };

/** Tell others this person is typing ("chat" or "pi") or stopped (null). Renewed at most every few seconds. */
export function typing(where) {
    const id = store.state.conversationId;

    if (!store.state.server?.chat || id === null) {
        return;
    }

    const now = Date.now();
    const same = typingSent.conversationId === id && typingSent.where === where;

    if (same && (where === null || now - typingSent.at < 3000)) {
        return;
    }

    typingSent = { where, at: now, conversationId: id };
    api(`c/${id}/typing`, { where }).catch(() => {});
}

/**
 * The server refused: its message in the person's language (`tServer`, PP-85), and as the server wrote it (`english`),
 * for the code that tells failures apart by their words.
 */
class ApiError extends Error {
    constructor(status, message) {
        super(tServer(message));
        this.status = status;
        this.english = message;
    }
}

/** Call the server's API: a GET without `body`, a POST with one, or `options.method`; `options.signal` stops it. */
export async function api(path, body, options = {}) {
    const init = {
        method: body === undefined && !options.method ? "GET" : (options.method ?? "POST"),
        headers: { "X-Pocket": "1" },
        ...(options.signal ? { signal: options.signal } : {}),
    };

    if (body !== undefined) {
        if (body instanceof Blob) {
            init.body = body;
            init.headers["content-type"] = body.type || "application/octet-stream";
        } else {
            init.body = JSON.stringify(body);
            init.headers["content-type"] = "application/json";
        }
    }

    const response = await fetch(`api/${path}`, init);
    const text = await response.text();
    let data;

    try {
        data = text ? JSON.parse(text) : {};
    } catch {
        data = { error: text };
    }

    if (!response.ok) {
        throw new ApiError(response.status, data.error ?? `HTTP ${response.status}`);
    }

    return data;
}

let nextNotice = 1;
/** Each notice's countdown, by id: what is left of it, and its timer while it runs. */
const countdowns = new Map();

/**
 * Show a short notice, and return its id. With `action`, tapping it runs the action as well as dismissing it. It stays longer when it
 * offers something (an Undo) or says what went wrong, and its countdown holds while a pointer or the focus is on it.
 */
export function notify(level, message, action) {
    const id = nextNotice++;
    const life = level === "error" ? 9000 : action ? 7000 : 4500;

    store.set((state) => ({
        notices: [...state.notices, { id, level, message, action, life }].slice(-4),
    }));
    countdowns.set(id, {
        left: life,
        since: Date.now(),
        timer: setTimeout(() => dismiss(id), life),
    });

    return id;
}

/** Hold a notice's countdown (`held`), or let it go on with what was left. */
export function holdNotice(id, held) {
    const countdown = countdowns.get(id);

    if (!countdown || held === (countdown.timer === null)) {
        return;
    }

    if (held) {
        clearTimeout(countdown.timer);
        countdown.timer = null;
        countdown.left -= Date.now() - countdown.since;
    } else {
        countdown.since = Date.now();
        countdown.timer = setTimeout(() => dismiss(id), Math.max(countdown.left, 1000));
    }
}

export function dismiss(id) {
    clearTimeout(countdowns.get(id)?.timer);
    countdowns.delete(id);
    chatNotices.delete(id);
    store.set((state) => ({ notices: state.notices.filter((notice) => notice.id !== id) }));
}

/** Run an action and show its error, if any, as a notice. */
export async function attempt(action) {
    try {
        return await action();
    } catch (error) {
        notify("error", error.message ?? String(error));

        return undefined;
    }
}

/**
 * Whether the person's role allows a permission (PP-22): behind the server edition's gateway, the role's policy says;
 * everywhere else (the phone), everything is allowed. The menu, the rail and the launcher leave out what it does not.
 */
export function roleAllows(permission, state = store.state) {
    return !state.server?.policy || state.server.policy.permissions.includes(permission);
}

/** End this browser's sign-in, and go to the sign-in page. */
export function signOut() {
    return attempt(async () => {
        // Behind the server edition's gateway: its sign-in is the one to end (PP-21).
        if (store.state.server?.gateway) {
            await fetch("/auth/api/sign-out", { method: "POST", headers: { "content-type": "application/json" }, body: "{}", credentials: "same-origin" });
            location.href = "/auth/sign-in";

            return;
        }

        await api("logout", {});
        location.href = "/";
    });
}

let source;

function applyView(data) {
    store.set((state) => ({ view: mergeView(state.view, data), missing: null }));
}

/** A view after an update from the server: the full view, or what changed since the last one. */
function mergeView(current, data) {
    const same = current.conversation?.id === data.conversation.id;
    const base = data.full || !same ? emptyView() : current;
    // Most updates while Pi writes bring no entries: the same Map then, so what is built from it (the transcript's rows)
    // is not built again for each of them.
    const unchanged = !data.full && same && data.entries.length === 0 && !data.order;
    const entries = unchanged ? current.entries : new Map(base.entries);

    for (const entry of data.entries) {
        entries.set(entry.id, entry);
    }

    const order = data.order ?? base.order;

    if (data.order) {
        const keep = new Set(data.order);

        for (const id of entries.keys()) {
            if (!keep.has(id)) {
                entries.delete(id);
            }
        }
    }

    return {
        ...base,
        conversation: data.conversation,
        entries,
        order,
        live: mergeLive(base.live, data.live),
        agent: data.agent,
        stats: data.stats,
        clients: data.clients,
        viewers: data.viewers,
        approvals: data.approvals,
        // The server sends these again only when they change: a missing one keeps its last value.
        inbox: data.inbox ?? base.inbox,
        subagents: data.subagents ?? base.subagents,
        authors: data.authors ?? base.authors,
        reactions: data.reactions ?? base.reactions,
        pins: data.pins ?? base.pins,
        turns: data.turns ?? base.turns,
        decisions: data.decisions ?? base.decisions,
        plan: data.plan ?? base.plan,
        artifacts: data.artifacts ?? base.artifacts,
        schedules: data.schedules ?? base.schedules,
        // No goal is null, which the server sends too: only a missing field keeps the last value.
        goal: data.goal === undefined ? base.goal : data.goal,
        ciWatches: data.ciWatches ?? base.ciWatches,
        // Why subagents' reports wait (a spend limit), or null when none do: the subagents bar says it.
        subagentsHeld: data.subagentsHeld === undefined ? base.subagentsHeld : data.subagentsHeld,
        // What the folder has checked out: `{ branch }` or `{ detached }`, and null outside a repository.
        branch: data.branch === undefined ? base.branch : data.branch,
    };
}

let reconnecting = false;

/**
 * The live run from an update, whose message may come as what changed (`liveMessage`). One that does not fit what this
 * tab has, which should not happen, keeps the message as it was and connects again for a full view.
 */
function mergeLive(current, live) {
    if (live.generation?.message?.keep === undefined) {
        return live;
    }

    const had = current.generation?.message;
    let message = liveMessage(had, live.generation.message);

    if (message === null) {
        message = had;

        // One batch of events may hold several such updates: connect once.
        if (!reconnecting) {
            reconnecting = true;
            setTimeout(() => {
                reconnecting = false;
                connect();
            });
        }
    }

    return { ...live, generation: { ...live.generation, message } };
}

/** The `moving` marks that a session list has not caught up with yet: it still shows those sessions where they were. */
export function stillMoving(moving, sessions) {
    const next = { ...moving };

    for (const session of sessions) {
        if (next[session.id] === Boolean(session.archived)) {
            delete next[session.id];
        }
    }

    return next;
}

/** Whether two values the server sent as JSON are the same: the same plain values, arrays, and objects, all the way down. */
function sameJson(a, b) {
    if (a === b) {
        return true;
    }

    if (
        typeof a !== "object" ||
        typeof b !== "object" ||
        a === null ||
        b === null ||
        Array.isArray(a) !== Array.isArray(b)
    ) {
        return false;
    }

    const keys = Object.keys(a);

    return (
        keys.length === Object.keys(b).length &&
        keys.every((key) => Object.hasOwn(b, key) && sameJson(a[key], b[key]))
    );
}

/**
 * What the server sent, or what the store has when it is the same. Each connect sends hello and the lists again, mostly
 * as they were: what did not change keeps its identity, so memos hold and identity checks (`theme.js`) see no change.
 */
const kept = (had, next) => (sameJson(had, next) ? had : next);

/** A list of items with ids, each item kept where it is the same, and the list itself when all are: one session changed draws one row again. */
function keptEach(had, next) {
    if (!Array.isArray(had) || !Array.isArray(next)) {
        return next;
    }

    const byId = new Map(had.map((item) => [item?.id, item]));
    const items = next.map((item) => kept(byId.get(item?.id), item));

    return items.length === had.length && items.every((item, index) => item === had[index])
        ? had
        : items;
}

/** How far the server's clock is ahead of this browser's, from its last hello (`seen.js`). */
let clockOffset = 0;

export const serverClockOffset = () => clockOffset;

/**
 * The server's facts from a hello. Its clock (`now`) is new in each one and is no change to them: the clock goes to
 * `clockOffset`, and the facts keep the clock of the hello that brought them.
 */
function keptServer(had, next) {
    if (typeof next?.now === "number") {
        clockOffset = next.now - Date.now();
    }

    return had && next && sameJson({ ...had, now: 0 }, { ...next, now: 0 }) ? had : next;
}

/** Set only what changed, and nothing when nothing did: data sent again as it was draws nothing again. */
function setChanged(change) {
    const changed = Object.entries(change).filter(([key, value]) => store.state[key] !== value);

    if (changed.length > 0) {
        store.set(Object.fromEntries(changed));
    }
}

/** Who hears extensions' events: `extension-ui.js`, which imports this module and so cannot be imported here. */
const extensionListeners = new Set();
const browserFrameListeners = new Set();

/** Hear Pi's browser's frames (`browser-panel.js`): they skip the store, which would redraw the app with each one. */
export function onBrowserFrame(listener) {
    browserFrameListeners.add(listener);

    return () => browserFrameListeners.delete(listener);
}

/** Hear the events extension modules send their browser modules: `{ module, event, data }`. */
export function onExtensionEvent(listener) {
    extensionListeners.add(listener);

    return () => extensionListeners.delete(listener);
}

/** What the server sends, by event name. Both transports deliver the same events. */
const usageMap = (list) => Object.fromEntries(list.map((each) => [each.provider, each]));

/**
 * The subscription accounts' plan limits, asked now: kept on the server a minute, unless `fresh` (Providers' Check again).
 * Providers and the model menu ask as they open; failures stay quiet, as the figures are extra.
 */
export function loadUsage(fresh = false) {
    return api(`usage-limits${fresh ? "?fresh=1" : ""}`).then(
        (answer) => store.set((state) => ({ usage: { ...state.usage, ...usageMap(answer.usage) } })),
        () => {},
    );
}

const handlers = {
    hello: (data) => {
        // The app's language for this person (PP-81): another one than this page is in loads it again in that.
        if (chooseLanguage(data.user.language)) {
            return;
        }

        // Sent again on each connect, mostly as it was: what is the same keeps its identity (`kept`).
        const state = store.state;

        setChanged({
            me: kept(state.me, data.user),
            users: keptEach(state.users, data.users),
            former: kept(state.former, data.former ?? {}),
            folderFavorites: kept(state.folderFavorites, data.folderFavorites ?? []),
            sessionGroups: kept(state.sessionGroups, data.sessionGroups),
            models: kept(state.models, data.models),
            ...(Array.isArray(data.usage) ? { usage: kept(state.usage, usageMap(data.usage)) } : {}),
            guard: kept(state.guard, data.guard),
            server: keptServer(state.server, data.server),
            // Every theme folder (`theme.js`): an older server lists none.
            themeList: kept(state.themeList, Array.isArray(data.themes) ? data.themes : []),
            // This connection's id, which peek lists name (`peeks.js`). `GET /api/me` answers without one.
            ...(data.connection === undefined ? {} : { streamId: data.connection }),
        });
    },
    // The person chose another language, on this device or another (PP-81).
    language: (data) => chooseLanguage(data.language),
    // The machines' ports open here changed: one opened, closed, or ended by itself (PP-108). The owner's tabs only.
    forwards: (data) => store.set({ forwards: data.forwards }),
    sessions: (list) => {
        const state = store.state;
        const sessions = keptEach(state.sessions, list);

        setChanged({
            sessions,
            sessionsLoaded: true,
            moving: kept(state.moving, stillMoving(state.moving, sessions)),
        });
    },
    "folder-favorites": (folderFavorites) =>
        setChanged({ folderFavorites: kept(store.state.folderFavorites, folderFavorites) }),
    "session-groups": (sessionGroups) =>
        setChanged({ sessionGroups: kept(store.state.sessionGroups, sessionGroups) }),
    models: (models) => setChanged({ models: kept(store.state.models, models) }),
    usage: (usage) => store.set((state) => ({ usage: { ...state.usage, [usage.provider]: usage } })),
    // A theme folder came, went, or changed (`theme.js` loads its new version).
    themes: (themeList) => setChanged({ themeList: kept(store.state.themeList, themeList) }),
    // Every subagent in every session, while this tab shows the subagents board (`subagents-board.js`).
    subagents: (agents) => store.state.board && store.set({ boardAgents: agents }),
    view: applyView,
    // This person's PiP: its conversation, whether it works, and when it last answered (`pip.js`); null for none.
    // PiP's conversation, while this tab's PiP panel is open.
    chat: applyChat,
    presence: (data) =>
        data.conversationId === store.state.conversationId && store.set({ presence: data.people }),
    notes: (data) =>
        data.conversationId === store.state.conversationId &&
        store.set({ notes: { text: data.text, rev: data.rev, by: data.by, at: data.at } }),
    // Another session as its peek tile shows it (`peeks.js`): kept after it scrolls away, as the tile's last look.
    peek: (data) =>
        store.set((state) => ({ peeks: { ...state.peeks, [data.conversationId]: data } })),
    users: (users) => setChanged({ users: keptEach(store.state.users, users) }),
    // Pi's lessons changed somewhere: a Memory sheet or menu that shows them fetches them again (`sheets/memory.js`).
    memory: () => store.set((state) => ({ memoryRev: (state.memoryRev ?? 0) + 1 })),
    missing: (data) => store.set({ missing: data.message }),
    // Pi's browser: what it shows and does (the owner's tabs), and frames of its page (the tabs that watch it).
    browser: (data) => setPiBrowser(data),
    "browser-frame": (data) => {
        for (const listener of browserFrameListeners) {
            listener(data);
        }
    },
    // An event an extension module sent its browser module (`extension-ui.js`).
    ext: (data) => {
        for (const listener of extensionListeners) {
            listener(data);
        }
    },
    // A notice may link to a conversation, such as a mention elsewhere: tapping it goes there.
    notice: (data) => {
        const id = notify(
            data.level,
            tServer(data.message),
            data.link
                ? () =>
                      navigate(data.link.conversationId, {
                          sheet: data.link.sheet ? { type: data.link.sheet } : null,
                      })
                : undefined,
        );

        // A mention's: reading that chat takes it down.
        if (data.link?.sheet === "chat") {
            chatNotices.set(id, data.link.conversationId);
        }
    },
    auth: (data) => handleAuth(data),
    closing: () => store.set({ connection: "closed" }),
    reload: () => {
        // A web file changed on the server. Message drafts live in localStorage and survive the reload; an unsaved notes
        // draft, attachments not yet sent, and an open provider sign-in do not.
        setTimeout(() => location.reload(), 150);
    },
};

/**
 * What this code understands of the server's updates, sent with each connection. 2: it keeps the queue when an update
 * leaves it out. 3: it takes the message being written as what changed (`mergeLive`). The server sends a tab below 3 the
 * whole message with each update, and one whose code names none (as a tab asleep through an update keeps) the queue too.
 */
const PROTOCOL = 3;
const TRANSPORT_KEY = "pocket.transport";
const local = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\])$/.test(location.hostname);
/** After an event stream stalls on this address, poll for a day, then try the stream again: one slow start is not forever. */
const POLL_FOR_MS = 24 * 60 * 60_000;

const pollHere = () => {
    const saved = localStorage.getItem(TRANSPORT_KEY) ?? "";

    // Saved before the choice had a time: a choice made now.
    if (saved === "poll") {
        localStorage.setItem(TRANSPORT_KEY, `poll:${Date.now()}`);
    }

    const [mode, at] = (localStorage.getItem(TRANSPORT_KEY) ?? "").split(":");

    return mode === "poll" && Date.now() - Number(at) < POLL_FOR_MS;
};

/** Event stream reconnects in a row that the browser gave up on, for the pause before the next one. */
let streamRetries = 0;

const connected = () => store.state.connection !== "open" && store.set({ connection: "open" });

export function connect() {
    source?.close();
    store.set({ connection: "connecting" });
    const id = store.state.conversationId;
    const query = `tab=${encodeURIComponent(TAB)}&p=${PROTOCOL}${id === null ? "" : `&c=${id}`}`;

    source = pollHere() && !local ? pollEvents(query) : streamEvents(query);
}

// A page kept for Back and Forward stays alive, frozen, and so would its stream: each holds one of the few connections a
// browser makes to a server, and after a handful nothing else loads. It closes on leaving and reconnects on return.
addEventListener("pagehide", () => {
    source?.close();
    source = null;
});
addEventListener("pageshow", (event) => {
    if (event.persisted) {
        connect();
    }
});

/** Server-sent events: one long response the server writes to as things change. */
function streamEvents(query) {
    const events = new EventSource(`api/events?${query}`);
    /** The first batch arrived whole: the session's view, or the session list when no session is open. */
    let settled = false;
    const settles = query.includes("&c=") ? ["view", "missing"] : ["sessions"];
    const connection = {
        close() {
            clearTimeout(fallback);
            events.close();
        },
    };
    // Some tunnels hold the stream back. A Cloudflare quick tunnel passes it on in 64 KiB blocks and keeps the rest, so
    // a long session's first view can stop partway after its small first events got through. The stream counts as
    // working only once that first batch is whole; otherwise poll instead, and remember that for this address.
    const fallback = local
        ? undefined
        : setTimeout(() => {
              if (settled || source !== connection) {
                  return;
              }

              localStorage.setItem(TRANSPORT_KEY, `poll:${Date.now()}`);
              connect();
          }, 6000);

    for (const [name, handler] of Object.entries(handlers)) {
        events.addEventListener(name, (event) => {
            if (source !== connection) {
                return;
            }

            if (settles.includes(name)) {
                settled = true;
            }

            handler(JSON.parse(event.data));
        });
    }

    events.onopen = () => {
        if (source !== connection) {
            return;
        }

        streamRetries = 0;
        connected();
    };

    events.onerror = async () => {
        if (source !== connection) {
            return;
        }

        store.set({ connection: "closed" });

        // EventSource retries by itself after a network error; a 401 needs a sign-in instead.
        try {
            await api("me");
        } catch (error) {
            if (error.status === 401) {
                connection.close();
                store.set({ me: null });

                return;
            }

            // In a session shared with you (PP-56), 404 means it is no longer shared: the page says so.
            if (error.status === 404 && BASE !== "/") {
                connection.close();
                location.reload();

                return;
            }
        }

        // It gives up for good when a retry gets an answer other than 200, such as a tunnel's 502 while the server
        // restarts. Start a new stream after a pause that grows with each try.
        if (events.readyState === EventSource.CLOSED && source === connection) {
            // A stream that failed was not held back: no reason to switch this address to polling.
            clearTimeout(fallback);
            streamRetries++;
            setTimeout(
                () => source === connection && connect(),
                Math.min(10_000, 1000 * streamRetries),
            );
        }
    };

    return connection;
}

/** Long polling: each request waits for events and returns them; the next one acknowledges what arrived. */
function pollEvents(query) {
    let session = null;
    let ack = 0;
    let stopped = false;
    let request = null;
    const connection = {
        close() {
            stopped = true;
            request?.abort();

            if (session) {
                fetch(`api/poll?session=${session}&close=1`, { keepalive: true }).catch(() => {});
            }
        },
    };

    (async () => {
        let failures = 0;

        while (!stopped) {
            request = new AbortController();

            try {
                const response = await fetch(
                    `api/poll?${query}${session ? `&session=${session}&ack=${ack}` : ""}`,
                    { signal: request.signal, cache: "no-store" },
                );

                if (response.status === 401) {
                    stopped = true;
                    store.set({ me: null });

                    return;
                }

                if (!response.ok) {
                    throw new Error(`HTTP ${response.status}`);
                }

                const data = await response.json();

                if (stopped || source !== connection) {
                    return;
                }

                if (data.session !== session) {
                    // A new session (first poll, or the server restarted): it starts with hello and a full view.
                    session = data.session;
                    ack = 0;
                }

                failures = 0;
                connected();

                for (const item of data.events) {
                    if (item.seq <= ack) {
                        continue;
                    }

                    ack = item.seq;
                    handlers[item.event]?.(item.data);
                }
            } catch {
                if (stopped) {
                    return;
                }

                failures++;

                if (store.state.connection === "open") {
                    store.set({ connection: "closed" });
                }

                await new Promise((resolve) =>
                    setTimeout(resolve, Math.min(10_000, 1000 * failures)),
                );
            }
        }
    })();

    return connection;
}

/** Sign-ins that ended, or whose dialog was closed here: what the server still says about them shows nothing. */
const endedSignIns = new Set();

/** The dialog of a sign-in (`AuthDialog`), as the server's words about it come. */
function handleAuth(data) {
    if (endedSignIns.has(data.flowId)) {
        return;
    }

    if (data.step === "done") {
        endedSignIns.add(data.flowId);
    }

    store.set((state) => {
        const flow =
            state.auth?.flowId === data.flowId
                ? state.auth
                : {
                      flowId: data.flowId,
                      providerId: data.providerId,
                      // Its id when the server sends no name (one not restarted since an update).
                      providerName: data.providerName ?? data.providerId,
                      events: [],
                      prompt: null,
                      done: null,
                  };

        if (data.step === "prompt") {
            return { auth: { ...flow, prompt: { id: data.promptId, ...data.prompt } } };
        }

        if (data.step === "prompt-closed") {
            return { auth: flow.prompt?.id === data.promptId ? { ...flow, prompt: null } : flow };
        }

        if (data.step === "event") {
            return { auth: { ...flow, events: [...flow.events, data.event] } };
        }

        if (data.step === "done") {
            if (data.ok) {
                notify("info", `Signed in to ${data.providerName ?? data.providerId}.`);
            }

            return { auth: data.ok ? null : { ...flow, prompt: null, done: data } };
        }

        return {};
    });
}

/**
 * A sign-in's question was answered, and the server took the answer. The server's next words may have come first (the
 * next question, or the end, which closes the dialog or shows why it failed): the dialog waits for the provider only
 * while it still shows that sign-in asking that question.
 */
export function signInAnswered(flowId, promptId) {
    store.set((state) =>
        state.auth?.flowId === flowId && state.auth.prompt?.id === promptId
            ? { auth: { ...state.auth, prompt: null } }
            : {},
    );
}

/** A sign-in's dialog was closed: it stays closed, whatever the server still says about that sign-in. */
export function closeSignIn(flowId) {
    endedSignIns.add(flowId);
    store.set((state) => (state.auth?.flowId === flowId ? { auth: null } : {}));
}

export function navigate(conversationId, { replace = false, sheet = null } = {}) {
    const path = conversationId === null ? "/" : `/s/${conversationId}`;

    if (routeOf(location.pathname) !== path || store.state.conversationId !== conversationId) {
        pushRoute(path, { replace });
    }

    // The subagents board and extensions' pages show in the conversation's place: going to one, even the one under it,
    // closes them.
    if (store.state.board || store.state.page) {
        store.set({ board: false, boardAgents: null, page: null });
    }

    // Its row tapped again counts too.
    opened(conversationId);

    if (store.state.conversationId === conversationId && source) {
        if (sheet) {
            openSheet(sheet);
        }

        return;
    }

    store.set((state) => ({
        conversationId,
        view: emptyView(),
        ...peopleFor(conversationId),
        browser: null,
        history: null,
        transcriptFrom: null,
        missing: null,
        drawer: false,
        ...sheetChange(sheet, state),
    }));
    connect();
}

// Back or forward to another route. Back that only closes a layer (a sheet, a panel) is back.js's.
onRoute(() => {
    const id = routeConversation();

    if (id !== store.state.conversationId) {
        opened(id);
        store.set({
            conversationId: id,
            view: emptyView(),
            ...peopleFor(id),
            browser: null,
            history: null,
            transcriptFrom: null,
            missing: null,
            sheet: null,
            drawer: false,
        });
        connect();
    }
});

export async function start() {
    try {
        const hello = await api("me");

        store.set({
            me: hello.user,
            users: hello.users,
            former: hello.former ?? {},
            models: hello.models,
            guard: hello.guard,
            server: keptServer(store.state.server, hello.server),
            themeList: Array.isArray(hello.themes) ? hello.themes : [],
        });
        connect();
    } catch (error) {
        store.set({ me: error.status === 401 ? null : undefined });

        if (error.status !== 401) {
            notify("error", `Server unreachable: ${error.message}`);
            setTimeout(start, 3000);
        }
    }
}

// ─── Commands ───────────────────────────────────────────────────────────

const current = () => store.state.conversationId;

export const actions = {
    /** `inlineFiles`: the files the message mentions with @ go along with it. */
    submit: (text, attachments, mode, inlineFiles = false) =>
        api(`c/${current()}/submit`, {
            text,
            attachments,
            mode,
            requestId: uid(),
            ...(inlineFiles ? { inlineFiles } : {}),
        }),
    /** Run a command in the session's folder (`!`); `context: false` keeps it from Pi (`!!`). */
    shell: (command, context, requestId = uid()) =>
        api(`c/${current()}/shell`, { command, context, requestId }),
    stopShell: (taskId) => api(`c/${current()}/shell/${taskId}/stop`, {}),
    /** Run an extension's command; sending the same request id again finds the first run. */
    extensionCommand: (commandId, args, requestId = uid()) =>
        api(`c/${current()}/extension-commands`, { commandId, args, requestId }),
    /** A file or folder for the viewer. */
    view: (path) => api(`c/${current()}/view?path=${encodeURIComponent(path)}`),
    /** What changed in the session's folder: git's uncommitted changes, and Pi's edits. */
    changes: (id = current()) => api(`c/${id}/changes`),
    branches: () => api(`c/${current()}/branches`),
    switchBranch: (target) => api(`c/${current()}/branch`, target),
    /** Undo the uncommitted changes to one file. */
    revert: (path) => api(`c/${current()}/changes/revert`, { path }),
    abort: () => api(`c/${current()}/abort`, {}),
    chat: (text, quote) =>
        api(`c/${current()}/chat`, {
            text,
            requestId: uid(),
            ...(quote ? { quote: { entryId: quote.entryId } } : {}),
        }),
    react: (entryId, emoji) => api(`c/${current()}/react`, { entryId, emoji }),
    pin: (target) => api(`c/${current()}/pin`, target),
    saveNotes: (text, rev) => api(`c/${current()}/notes`, { text, rev }),
    turns: (action, to) => api(`c/${current()}/turns`, { action, ...(to ? { to } : {}) }),
    setAccess: (userId, patch) => api(`users/${encodeURIComponent(userId)}`, patch),
    withdraw: (submissionId) => api(`c/${current()}/withdraw`, { submissionId }),
    configure: (change) => api(`c/${current()}/configure`, change),
    /** The owner's model and thinking level for new sessions, `{ provider, modelId, thinkingLevel }`; null clears it. */
    setDefaultModel: (choice) => api("settings", { defaultModel: choice }),
    compact: (instructions) => api(`c/${current()}/compact`, { instructions }),
    reset: (note) => api(`c/${current()}/reset`, { note }),
    setInstructions: (text) => api(`c/${current()}/instructions`, { text }),
    /** A new session with this one's history through `entryId`. */
    fork: (entryId, { worktree = false } = {}) =>
        api(`c/${current()}/fork`, { entryId, ...(worktree ? { worktree } : {}) }),
    /** Send a message to Pi again in a fork that ends just before it: `{ text }` edits it, `{ model }` picks another model. */
    resend: (entryId, change = {}) => api(`c/${current()}/resend`, { entryId, ...change }),
    setPlan: (on) => api(`c/${current()}/plan`, { on }),
    stopCiWatch: (watch) => api(`c/${current()}/ci-watch/stop`, { repo: watch.repo, runId: watch.runId }),
    /** What the owner typed on a Pi's browser card (or chose to use a kept sign-in, or did on the page). */
    answerBrowserAsk: (id, body) => api(`browser/asks/${id.split("/").map(encodeURIComponent).join("/")}`, body),
    /** A value typed into `secret_request`'s card: to Settings › Secrets. An approval id may hold a slash. */
    answerSecretRequest: (id, value) =>
        api(`secrets/requests/${id.split("/").map(encodeURIComponent).join("/")}`, { value }),
    approvePlan: () => api(`c/${current()}/plan`, { approve: true }),
    prompts: () => api(`c/${current()}/prompts`),
    trust: () => api(`c/${current()}/trust`),
    /** `trust`, `trust-parent`, or `distrust`, as Pi's `/trust` offers them. */
    setTrust: (choice) => api(`c/${current()}/trust`, { choice }),
    /** Pi's sessions from the terminal on this machine; one of them to look at; and one continued as a new session. */
    piSessions: (query = "") =>
        api(query === "" ? "pi-sessions" : `pi-sessions?q=${encodeURIComponent(query)}`),
    piSession: (path) => api(`pi-sessions/preview?path=${encodeURIComponent(path)}`),
    /** `when` says when, then what Pi gets: `in 2h check the deploy`. Clock times are this device's. */
    schedule: (when) =>
        api(`c/${current()}/schedules`, {
            when,
            zone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        }),
    cancelSchedule: (id) => api(`c/${current()}/schedules/${encodeURIComponent(id)}/cancel`, {}),
    setGoal: (command) => api(`c/${current()}/goal`, { command }),
    clearGoal: () => api(`c/${current()}/goal`, { clear: true }),
    removeWorktree: (force) => api(`c/${current()}/worktree`, { remove: true, force }),
    piSessions: (query = "") =>
        api(query === "" ? "pi-sessions" : `pi-sessions?q=${encodeURIComponent(query)}`),
    piSession: (path) => api(`pi-sessions/preview?path=${encodeURIComponent(path)}`),
    /** A Pi session file from elsewhere (another machine, Termux), kept with Pi's sessions here. */
    importPiSession: (file) => api(`pi-sessions/import?name=${encodeURIComponent(file.name)}`, file),
    /** `cwd`: the folder to work in, for a session whose own folder is not on this phone. */
    continuePiSession: (path, cwd) => api("pi-sessions/continue", { path, ...(cwd ? { cwd } : {}) }),
    approve: (id, allow) => api(`approvals/${encodeURIComponent(id)}`, { allow }),
    /** `worktree`: the session works in a git worktree of its own, made from the folder. */
    createSession: (cwd, { worktree = false } = {}) =>
        api("sessions", { cwd, ...(worktree ? { worktree } : {}) }),
    updateSession: (id, patch) => api(`sessions/${id}`, patch),
    upload: (file) => api(`c/${current()}/upload?name=${encodeURIComponent(file.name)}`, file),
    fullEntry: (entryId) => api(`c/${current()}/entry/${entryId}`),
    history: (before) => api(`c/${current()}/history?before=${before}`),
};

/** The kinds of entries that show as transcript rows. */
const ROW_KINDS = new Set([
    "user",
    "assistant",
    "compaction",
    "reset",
    "shell",
    "command",
    "note",
    "fromPi",
]);

/** Entries that show as transcript rows. Tool results show inside their call's card instead. */
export const isRow = (entry) => ROW_KINDS.has(entry.kind);

/**
 * Show the transcript from this entry down when it is above the rows shown now, as for a jump to a pinned or quoted
 * message. Compares places in the transcript, not ids: after a compaction, the summary comes first with the newest id.
 */
export function revealEntry(entryId) {
    const { view, transcriptFrom } = store.state;

    if (transcriptFrom === null) {
        return;
    }

    const ids = view.order.filter((id) => {
        const entry = view.entries.get(id);

        return entry !== undefined && isRow(entry);
    });
    const at = ids.indexOf(entryId);
    const from = ids.indexOf(transcriptFrom);

    if (at !== -1 && (from === -1 || at < from)) {
        store.set({ transcriptFrom: entryId });
    }
}

// ─── The People panel ──────────────────────────────────────────────────────────────

const PEOPLE_KEY = "pocket.people";
/** Wide enough for the session list, the conversation, and a panel beside it: where the Browser panel docks too. */
const PEOPLE_DOCK = matchMedia("(min-width: 1100px)");

/**
 * Panels (People, Browser, Files) dock beside the conversation now; narrower, the Browser panel and the Files tile cover
 * the screen, and back closes them. A change re-renders (below).
 */
export const panelsBeside = () => PEOPLE_DOCK.matches;

/** The People panel shows beside the conversation now. */
export function peopleDocked(state = store.state) {
    return (
        state.peopleOpen &&
        PEOPLE_DOCK.matches &&
        Boolean(state.server?.chat) &&
        state.conversationId !== null &&
        !state.missing
    );
}

/**
 * What showing a sheet changes. On wide screens the chat docks beside the conversation instead, as the People panel, and
 * takes the Browser panel's place: both beside the conversation leave it too narrow.
 */
function sheetChange(sheet, state) {
    if (sheet?.type !== "chat" || !PEOPLE_DOCK.matches) {
        return { sheet };
    }

    sessionStorage.setItem(PEOPLE_KEY, "1");
    sessionStorage.removeItem("pocket.files");
    sessionStorage.removeItem("pocket.piBrowser");

    return {
        sheet: null,
        peopleOpen: true,
        filesOpen: false,
        browserOpen: false,
        peopleAsk: {
            tab: sheet.tab ?? null,
            highlight: sheet.highlight ?? null,
            n: state.peopleAsk.n + 1,
        },
    };
}

/**
 * The Files tile shows now: asked for, in a conversation, for someone who can steer, and not in the Browser panel's
 * place (one panel at a time). `App` draws it by this, and `openFile` opens files in it by this.
 */
export function filesShown(state = store.state) {
    return (
        state.filesOpen &&
        state.conversationId !== null &&
        !state.missing &&
        state.me?.role !== "viewer"
    );
}

/** Hide the People panel. Showing it is `openSheet({ type: "chat" })`, which docks it on wide screens. */
export function closePeople() {
    sessionStorage.removeItem(PEOPLE_KEY);

    // Its active border goes to the conversation, not nowhere.
    if (document.documentElement.dataset.focus === "people-panel") {
        document.documentElement.dataset.focus = "pane";
    }

    store.set({ peopleOpen: false });
}

let chatLogs = 0;

/** A chat log is on screen, as the People sheet's or panel's Chat tab: call when it shows, and what it returns when it goes. */
export function chatLogShown() {
    chatLogs++;

    return () => {
        chatLogs--;
    };
}

// A window widened with the chat open as a sheet docks it. One narrowed hides the panel until it is wide again.
PEOPLE_DOCK.addEventListener("change", () => {
    const { sheet } = store.state;

    if (PEOPLE_DOCK.matches && sheet?.type === "chat") {
        openSheet(sheet);
    } else {
        store.set({});
    }
});

/** Which of Pi's browsers the session shown uses: `phone`, or `machine:<id>` for a session working on a machine. */
export function browserPlace(state = store.state) {
    const cwd = state.view?.agent?.cwd ?? state.view?.conversation?.cwd ?? "";
    const machine = /^machine:([^:]+):/.exec(cwd)?.[1];

    return machine === undefined ? "phone" : `machine:${machine}`;
}

/** Which browser state belongs to a place and a session: each session has its own tabs at a place (PP-13). */
const browserKey = (place, session) => `${place}#${session}`;

/** The state of the session shown's own browser, or null before it is known. */
export const piBrowserState = (state = store.state) => state.piBrowsers?.[browserKey(browserPlace(state), state.conversationId)] ?? null;

/** Keep a browser's state, as the server sent it (each names its place and session). */
export function setPiBrowser(data) {
    if (data && typeof data === "object" && typeof data.session === "number") {
        store.set((state) => ({ piBrowsers: { ...state.piBrowsers, [browserKey(data.place ?? "phone", data.session)]: data } }));
    }
}

/** The address of a request to the session shown's own browser. */
export const browserPath = (path) => `${path}?place=${encodeURIComponent(browserPlace())}&session=${store.state.conversationId}`;

/** The panel's request to the session shown's own browser. */
export const browserApi = (path, body) => api(browserPath(path), body);

export function openSheet(sheet) {
    store.set((state) => ({ ...sheetChange(sheet, state), drawer: false }));
}

/**
 * Put text into the message box to Pi (after what is there: on a new paragraph, or with `inline`, after a space), and
 * files to attach, and close any sheet so it shows.
 */
export function insertIntoComposer(text, files = [], { inline = false } = {}) {
    store.set((state) => ({
        sheet: null,
        composerInsert: { text, files, inline, n: (state.composerInsert?.n ?? 0) + 1 },
    }));
}

/** Open the chat to discuss a transcript message: the next chat message quotes it. */
export function discuss(entryId, text) {
    store.set((state) => ({
        chatQuote: { entryId, text },
        ...sheetChange({ type: "chat" }, state),
        drawer: false,
    }));
}

/** Where this browser keeps its push subscription's id while notifications are on here (`web/push.js`, PP-127). */
export const PUSH_KEY = "pocket.pushId";

// Tell the server when this tab is hidden or shown: others see "away", and push notifications only reach a browser with
// no pi-phone tab in front (the tab names its browser's subscription).
let lastVisible = null;

export function reportVisibility(force = false) {
    const visible = document.visibilityState === "visible";
    const push = localStorage.getItem(PUSH_KEY);

    if ((visible === lastVisible && !force) || (!collab() && push === null)) {
        return;
    }

    lastVisible = visible;
    api("visibility", { tab: TAB, visible, ...(push === null ? {} : { push }) }).catch(() => {});
}

document.addEventListener("visibilitychange", () => reportVisibility());
store.subscribe((state) => {
    // Report again after each (re)connect: the server starts every new connection as visible, and without its browser's
    // push subscription.
    if (state.connection !== "open") {
        lastVisible = null;
    } else if (lastVisible === null && (document.visibilityState !== "visible" || localStorage.getItem(PUSH_KEY) !== null)) {
        reportVisibility(true);
    }
});

export function closeSheet() {
    store.set({ sheet: null });
}

// Per-conversation composer drafts survive reloads, including the automatic ones after a live edit.
export const drafts = {
    get: (id) => localStorage.getItem(`pocket.draft.${id ?? "home"}`) ?? "",
    set: (id, text) => {
        if (text) {
            localStorage.setItem(`pocket.draft.${id ?? "home"}`, text);
        } else {
            localStorage.removeItem(`pocket.draft.${id ?? "home"}`);
        }
    },
};
