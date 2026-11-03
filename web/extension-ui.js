// Extensions' browser modules. An extension module can give the app one (`web.client` on the server): it loads here, in
// the tabs of the people it is for, and its default export gets `pocket`, the app's API for extensions. With it, it adds
// rail buttons, menu rows, launcher actions, pages in the conversation's place, sheets, and how its own tools' calls
// show, calls its own routes, and hears its module's events. What it added goes when it reloads or is turned off; one that fails says why, and the app
// goes on without it. A tab opened with `?noext=1` loads none of them (safe mode), for as long as the tab stays open.
import { Component, Fragment, h, options } from "preact";
import {
    useCallback,
    useEffect,
    useLayoutEffect,
    useMemo,
    useReducer,
    useRef,
    useState,
} from "preact/hooks";
import { useBack } from "./back.js";
import { describersChanged, setCallDescriber } from "./calls.js";
import { currentLanguage, t, tn, tx } from "./i18n.js";
import { leaveSafeMode, onSafeModeEnd, safeMode } from "./safe-mode.js";
import {
    api,
    closePeople,
    closeSheet,
    computerState,
    insertIntoComposer,
    notify,
    onExtensionEvent,
    openSheet,
    panelsBeside,
    piBrowserState,
    store,
} from "./store.js";
import { setCallSummary } from "./turns.js";
import { pickFolder } from "./sheets/folder.js";
import { browserAvailable, setBrowserOpen } from "./browser-panel.js";
import { computerAvailable, setComputerOpen } from "./computer-panel.js";
import { BOTTOM_SHEETS, Choice, html, Icon, iconPath, Loader, Markdown, MultiChoice, railState, Sheet, Spinner, StateTag, Switch } from "./ui.js";

/**
 * The version of `pocket`. It goes up only when something extensions use changes in a way that breaks them; additions
 * keep it. The server's `web.api` is the same number (2 since PP-132, as pi-pocket's).
 */
export const POCKET_API = 2;
/** The oldest version extensions can still be written for: they load. */
const OLDEST_POCKET_API = 1;

/**
 * A module's title in the person's language: the server names the built-in modules in English (`reload.ts` TITLES);
 * a drop-in's own title stays as its author wrote it.
 */
export function moduleTitle(title) {
    const titles = {
        "System prompt": t("System prompt"),
        Artifacts: t("Artifacts"),
        Images: t("Images"),
        Media: t("Media"),
        Browser: t("Browser"),
        Subagents: t("Subagents"),
        "Agent Teams": t("Agent Teams"),
        "Scheduled messages": t("Scheduled messages"),
        "Done when": t("Done when"),
        "Plan mode": t("Plan mode"),
        "Lancet Guard": t("Lancet Guard"),
        Codemode: t("Codemode"),
        "CI watch": t("CI watch"),
        "Other sessions": t("Other sessions"),
        Secrets: t("Secrets"),
        "Role policy": t("Role policy"),
        Team: t("Team"),
        Documents: t("Documents"),
        "Sharing sessions": t("Sharing sessions"),
        Interview: t("Interview"),
        "Web access": t("Web access"),
        "Interactive answers": t("Interactive answers"),
        "Design & video": t("Design & video"),
        "Formal checks": t("Formal checks"),
        "Extension builder": t("Extension builder"),
        "Machine tools": t("Machine tools"),
        "Wiki (PARA)": t("Wiki (PARA)"),
        Projects: t("Projects"),
        Memory: t("Memory"),
        PiP: t("PiP"),
        Triggers: t("Triggers"),
        "Extension gallery": t("Extension gallery"),
        "Getting started": t("Getting started"),
    };

    return Object.hasOwn(titles, title) ? titles[title] : title;
}

/**
 * What a browser module can add, each kept by its id. PP-371 added five places: a dock strip above the message box, a
 * floating overlay, a tab in the side panel, a row in a session's menu, and (`pocket.theme`, not by id) colours.
 */
const KINDS = ["rail", "menu", "launcher", "page", "sheet", "dock", "overlay", "panelTab", "sessionMenu"];
/** What a kind's spec must name: a title, or a label (a dock names neither). */
const TITLED = new Set(["rail", "page", "sheet", "overlay", "panelTab"]);
/** The kinds that draw a component of the module's. */
const DRAWN = new Set(["page", "sheet", "dock", "overlay", "panelTab"]);
/** What a rail button, menu row, or launcher action can open: one of the module's own, or a function to run. */
const TARGETS = ["page", "sheet", "panelTab", "overlay"];
/** At most this many modules' docks show at once: the newest loaded. */
const DOCKS = 2;
/**
 * The colour tokens `pocket.theme` may set: the palette's (`--o-*`, what Appearance's colours set) and the app's colours
 * made from it (`web/style.css`'s `:root`). Sizes, fonts and corners stay the app's.
 */
const THEME_TOKENS = [
    "--o-bg", "--o-bg-dark", "--o-bg-darker", "--o-bg-light", "--o-fg", "--o-fg-dim", "--o-fg-light", "--o-fg-bright",
    "--o-accent", "--o-selection", "--o-red", "--o-yellow", "--o-orange", "--o-green", "--o-cyan", "--o-blue", "--o-magenta",
    "--desk", "--bg", "--panel", "--card", "--card-2", "--raised", "--hover", "--pressed", "--line", "--line-strong", "--edge",
    "--hair", "--hair-2", "--text", "--body", "--muted", "--faint", "--accent", "--accent-ink", "--accent-fill", "--accent-soft",
    "--accent-line", "--focus-ring", "--spark", "--accent-2", "--brand", "--ok", "--ok-soft", "--warn", "--warn-soft",
    "--warn-line", "--err", "--err-soft", "--err-line", "--code-bg", "--hl-kw", "--hl-str", "--hl-num", "--hl-fn", "--hl-type",
    "--hl-op", "--hl-tag", "--scrim", "--sh",
];
const THEME_TOKEN_SET = new Set(THEME_TOKENS);
/** Each module's load, numbered: the newest docks show, and the newest colours win. */
let loads = 0;
const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;
const isId = (value) => typeof value === "string" && ID.test(value);
const LEVELS = new Set(["info", "warning", "error"]);

/**
 * Each browser module this tab loads, by module name: its address and title, whether it is `loading`, `ready`, or
 * `failed` (and why), what it added, its cleanups, the events it listens to, and its `pocket`. One that failed stays,
 * for the Extensions sheet, but adds nothing more (`dead`).
 */
const modules = new Map();

/** The modules' names in the order the server lists them: what they add shows in that order. */
let order = [];

const liveRecord = (record) =>
    record !== undefined && !record.gone && !record.dead && modules.get(record.module) === record;

// ─── Drawing again, within bounds ────────────────────────────────────────────

/**
 * How often a module may make the app draw again. What it adds, changes, or removes draws at the next frame, once for
 * every change since: whatever it does, its changes cost the app no more than a redraw a frame, as an animation does.
 * What could hold the page is a loop that never lets a task through; and pages and sheets, which show at once. Past
 * these bounds, the module stops, as one that failed to load does:
 *
 * - Calls to `pocket`'s methods (all but `h`, `html`, the hooks, and the components) with no task between them (a loop
 *   of microtasks, which holds the page): more than 1000, over more than a second. Its calls then throw until the next
 *   task, so that such a loop ends.
 * - Pages and sheets opened or closed: more than 300 within any second; or, with no task between them, more than 1000,
 *   or 5 or more over more than a second.
 */
const HELD_CALLS = 1000;
const HELD_MS = 1000;
const OPENS_PER_SECOND = 300;
const HELD_OPENS = 1000;
const SLOW_OPENS = 5;
/** And how many notices a module may show, across its versions: past these, the rest are dropped. */
const NOTICES = 5;
const NOTICES_MS = 5000;
/** When a hidden tab draws no frames: its redraws wait this long at most (and longer, as such tabs' timers do). */
const FRAME_FALLBACK_MS = 100;

/**
 * The page's tasks, counted by a message that gets through only between them: a loop that holds the page lets none
 * through. A message rather than a timer: a hidden tab's timers wait up to a minute.
 */
let turn = 0;
let posted = false;
const tasks = new MessageChannel();

tasks.port1.onmessage = () => {
    posted = false;
    turn++;
};

/** An address the server gives from the root (`/x/…`), under the page's base (PP-54: a shared space's `/space/<key>/`). */
const underBase = (url) => new URL(String(url).replace(/^\//, ""), document.baseURI).href;

function nextTurn() {
    if (!posted) {
        posted = true;
        tasks.port2.postMessage(null);
    }
}

/**
 * What a module spent lately: its calls in this task and since when (`tick`), and the pages and sheets it opened or
 * closed, within the last second and in this task (`chargeOpen`).
 */
const spending = () => ({
    calls: 0,
    callsTurn: -1,
    callsSince: 0,
    held: -1,
    opens: [],
    turn: -1,
    inTurn: 0,
    turnSince: 0,
});

/**
 * Count a call a module makes to `pocket`. Past the bound with no task between them (a loop of microtasks holds the
 * page), the module stops, and its calls throw until the next task, so that the loop making them ends. Any version
 * counts, even one that went: its calls do nothing, but its loop would hold the page all the same.
 */
function tick(record) {
    const spent = record.spent;
    const now = performance.now();
    const stopped = () =>
        new Error(`${record.title} was stopped in this browser: it redraws without end`);

    if (spent.held === turn) {
        throw stopped();
    }

    if (spent.callsTurn !== turn) {
        spent.callsTurn = turn;
        spent.calls = 0;
        spent.callsSince = now;
        nextTurn();
    }

    spent.calls++;

    if (spent.calls > HELD_CALLS && now - spent.callsSince > HELD_MS) {
        spent.held = turn;

        if (liveRecord(record)) {
            fail(record, new Error(t("it redraws without end")), "was stopped");
        }

        throw stopped();
    }
}

/** Count a page or sheet a module opened or closed; false, once that stopped the module for going past its bounds. */
function chargeOpen(record) {
    const now = performance.now();
    const spent = record.spent;

    spent.opens.push(now);

    while (now - spent.opens[0] >= 1000) {
        spent.opens.shift();
    }

    if (spent.turn !== turn) {
        spent.turn = turn;
        spent.inTurn = 0;
        spent.turnSince = now;
    }

    spent.inTurn++;
    nextTurn();

    if (
        spent.opens.length > OPENS_PER_SECOND ||
        spent.inTurn > HELD_OPENS ||
        (spent.inTurn >= SLOW_OPENS && now - spent.turnSince > HELD_MS)
    ) {
        fail(record, new Error(t("it redraws without end")), "was stopped");

        return false;
    }

    return true;
}

/** Whether a redraw is due at the next frame, for every change made until then. */
let due = false;

/** Draw what extensions add again at the next frame: every change until then goes in the same redraw. */
function redraw() {
    if (due) {
        return;
    }

    due = true;

    // A hidden tab draws no frames: a timer then, whichever comes first.
    const frame = requestAnimationFrame(() => {
        clearTimeout(timer);
        flush();
    });
    const timer = setTimeout(() => {
        cancelAnimationFrame(frame);
        flush();
    }, FRAME_FALLBACK_MS);
}

function flush() {
    if (!due) {
        return;
    }

    due = false;
    store.set((state) => ({ extensionsRev: state.extensionsRev + 1 }));
    placesChanged();
}

/** Each module's recent notices, by name, so that a new version does not start afresh: `{ times, droppedAt }`. */
const noticeBudgets = new Map();

/**
 * A notice from a module, as many as its bound lets through; the rest are dropped, with a word in the console. None from
 * a version that went or failed (an action of it that fails late): it would use up the next version's.
 */
function noticeFrom(record, level, message, action) {
    if (!liveRecord(record)) {
        return;
    }

    const now = performance.now();
    const budget = noticeBudgets.get(record.module) ?? { times: [], droppedAt: -Infinity };

    budget.times = budget.times.filter((at) => now - at < NOTICES_MS);
    noticeBudgets.set(record.module, budget);

    if (budget.times.length >= NOTICES) {
        // Once a burst: a drop soon after another is the same one.
        if (now - budget.droppedAt >= NOTICES_MS) {
            console.warn(`${record.title}: too many notices; dropping the rest for a few seconds`);
        }

        budget.droppedAt = now;

        return;
    }

    budget.times.push(now);
    notify(level, message, action);
}

/** What was thrown, as text for a notice or an error box: an Error's message, a string, or a word that it gave none. */
function reason(error) {
    let text = "";

    try {
        if (error instanceof Error) {
            text = error.message || error.name;
        } else if (typeof error?.message === "string") {
            text = error.message;
        } else if (error !== undefined && error !== null) {
            text = String(error);
        }
    } catch {
        text = "";
    }

    return text.trim() === "" ? t("it gave no reason") : text;
}

/** Run a cleanup; one that fails says so in the console, and the rest still run. */
function cleanUp(record, dispose) {
    try {
        dispose();
    } catch (error) {
        console.error(`${record.title}: a cleanup failed`, error);
    }
}

// ─── Safe mode ───────────────────────────────────────────────────────────────

/** Safe mode was told once in this page: a reconnect does not tell it again. */
let safeTold = false;

export { leaveSafeMode, safeMode };

// Leaving safe mode loads the browser modules again.
onSafeModeEnd(() => follow(store.state));

// ─── Loading ─────────────────────────────────────────────────────────────────

/**
 * A page or sheet a link asked for (`/?page=module:id`, `/?sheet=module:id`), opened once its module is ready: before,
 * the module list would close it.
 */
let linked = null;

/** Open an extension's page as soon as its module has loaded (now, if it has). */
export function openPageWhenReady(module, id) {
    whenReady(module, id, "page");
}

/** Open an extension's sheet as soon as its module has loaded (now, if it has). */
export function openSheetWhenReady(module, id) {
    whenReady(module, id, "sheet");
}

/**
 * By link, as soon as its module has loaded: open an extension's side panel tab (`/s/<id>?panelTab=module:id`), or run
 * one of its rows (`/s/<id>?run=module:id`: a session menu row with that session, a menu row, or a launcher action),
 * so Pi's screenshot tool can show what a tap would (PP-369's live check: an overlay a menu row opens).
 */
export function openLinkedWhenReady(module, id, kind) {
    whenReady(module, id, kind);
}

function whenReady(module, id, kind) {
    const record = modules.get(module);

    if (record?.status === "ready" && !record.dead && !record.gone) {
        openLinked(module, id, kind);
    } else {
        linked = { module, id, kind };
    }
}

function openLinked(module, id, kind) {
    if (kind === "sheet") {
        openExtensionSheet(module, id);
    } else if (kind === "panelTab") {
        openExtensionPanel(module, id);
    } else if (kind === "run") {
        const key = `${module}:${id}`;
        const row = [
            ...(store.state.conversationId === null ? [] : extensionSessionMenuItems(store.state.conversationId)),
            ...extensionMenuItems(),
            ...extensionLauncherItems().map((item) => ({ ...item, key: item.key.replace(/^action:ext:/, "") })),
        ].find((each) => each.key === key);

        if (row === undefined) {
            notify("error", t("{module} has no row {id} to run here.", { module, id }));
        } else {
            row.run();
        }
    } else {
        openPage(module, id);
    }
}

/** The list the tab loaded last, as a key: the server sends hello again for many reasons. */
let loadedKey = null;

/** Load what the server lists now, when it changed. */
function follow(state) {
    const listed = state.me ? state.server?.ui : [];
    const list = Array.isArray(listed) ? listed : [];
    // Signed in or not counts too: safe mode says so once someone is.
    const key = [
        safeMode() ? "safe" : "",
        state.me ? "in" : "",
        ...list.map(
            (each) =>
                `${each.module}@${each.url}@${Array.isArray(each.tools) ? each.tools.join(",") : ""}`,
        ),
    ].join("\n");

    if (key === loadedKey) {
        return;
    }

    loadedKey = key;
    // Not inside the store's own round of listeners: loading changes the store too.
    queueMicrotask(() => sync(list));
}

store.subscribe(follow);

/** Who hears which modules went: `sheets.js`, which takes their sheets out of the ones back goes through. */
const goneListeners = new Set();

/** Hear when modules go: `listener(gone)`, where `gone(module)` says whether that module went. */
export function onExtensionsGone(listener) {
    goneListeners.add(listener);

    return () => goneListeners.delete(listener);
}

/** Load what the server lists, and unload what it no longer does or lists at a new address (a new version). */
function sync(list) {
    order = list.map((each) => each.module);
    const wanted = new Map(safeMode() ? [] : list.map((each) => [each.module, each]));

    for (const record of [...modules.values()]) {
        const entry = wanted.get(record.module);
        const tools = Array.isArray(entry?.tools) ? entry.tools : null;
        // A module reloaded on the server may install other tools, with the same browser module.
        const retooled = tools !== null && String(tools) !== String(record.tools);

        // One that failed (describing a tool its server module did not have yet, say) gets another go.
        if (entry?.url !== record.url || (retooled && record.dead)) {
            unload(record);
        } else if (retooled) {
            record.tools = tools;
            describersChanged();
        }
    }

    for (const entry of wanted.values()) {
        if (!modules.has(entry.module)) {
            void load(entry);
        }
    }

    // A page or sheet of a module that went closes, and back does not bring back the sheets it had under the one open.
    // One of a module coming back in a new version waits for it.
    const { page, sheet } = store.state;
    const gone = (module) => !wanted.has(module);

    if (page && gone(page.module)) {
        closePage();
    }

    if (sheet?.type === "ext" && gone(sheet.module)) {
        closeSheet();
    }

    if (store.state.extensionPanel && gone(store.state.extensionPanel.module)) {
        closeExtensionPanel();
    }

    for (const listener of goneListeners) {
        listener(gone);
    }

    // A module the server no longer lists has no notices to count.
    for (const module of noticeBudgets.keys()) {
        if (!order.includes(module)) {
            noticeBudgets.delete(module);
        }
    }

    if (safeMode() && !safeTold && store.state.me) {
        safeTold = true;
        notify(
            "warning",
            t("Extensions' browser parts are off in this tab, and so is the theme. Menu → Extensions turns them back on."),
            () => openSheet({ type: "extensions" }),
        );
    }

    redraw();
}

async function load(entry) {
    const record = {
        module: entry.module,
        title: entry.title,
        url: entry.url,
        status: "loading",
        error: null,
        adds: Object.fromEntries(KINDS.map((kind) => [kind, new Map()])),
        // How its own tools' calls show (`pocket.toolCall`), by tool.
        calls: new Map(),
        // The tools its module installs, whose calls it may describe; none known from a server before that list.
        tools: Array.isArray(entry.tools) ? entry.tools : null,
        disposers: [],
        listeners: new Set(),
        // Replaced or turned off.
        gone: false,
        // Failed, or stopped: what it set up went, and what it tries later (a timer) does nothing.
        dead: false,
        // How it failed, for its page and sheets: "failed to load", or "was stopped".
        how: null,
        // Its calls in this task, and the pages and sheets it opened and closed lately (`tick`, `chargeOpen`).
        spent: spending(),
        // A drop-in's: it tells the server what it added once it loads (`reportTo`).
        dropIn: entry.dropIn === true,
        // Its load's number: newer ones' docks show first, and their colours win (PP-371).
        seq: ++loads,
        // Its colours (`pocket.theme`): token to value, or null.
        theme: null,
        // Its overlays closed with ×, by id, until it shows one again.
        closed: new Set(),
    };

    record.pocket = pocketFor(record);
    modules.set(entry.module, record);
    redraw();

    try {
        // Under the page's base (PP-54): the server names it from the root.
        const loaded = await import(underBase(entry.url));

        if (record.gone) {
            return;
        }

        const needs = loaded.pocketApi;

        if (
            needs !== undefined &&
            !(typeof needs === "number" && Number.isInteger(needs) && needs >= OLDEST_POCKET_API && needs <= POCKET_API)
        ) {
            throw new Error(
                typeof needs === "number" && needs < OLDEST_POCKET_API
                    ? `it was written for version ${needs} of the app's extension API, and this app loads ${OLDEST_POCKET_API} to ${POCKET_API}`
                    : `it needs version ${needs} of the app's extension API, and this app has ${POCKET_API}`,
            );
        }

        if (typeof loaded.default !== "function") {
            throw new Error("it has no default export function");
        }

        const dispose = await loaded.default(record.pocket);

        if (typeof dispose === "function") {
            record.disposers.push(dispose);
        }

        // Replaced or turned off while it started, or stopped already: what it set up goes.
        if (record.gone || record.dead) {
            teardown(record);

            return;
        }

        record.status = "ready";

        if (record.dropIn) {
            reportTo(record, {
                state: "ready",
                adds: Object.fromEntries(KINDS.map((kind) => [kind, [...record.adds[kind].keys()]])),
            });
        }

        if (linked?.module === record.module) {
            const { id, kind } = linked;

            linked = null;
            openLinked(record.module, id, kind);
        }
    } catch (error) {
        if (!record.gone && !record.dead) {
            fail(record, error, "failed to load");
        }

        return;
    }

    redraw();
}

/**
 * A module failed, while it loaded or later (`how`): what it added goes, its cleanups run, what it tries next does
 * nothing, and a notice, its page or sheet, and the Extensions sheet say why.
 */
function fail(record, error, how) {
    record.dead = true;
    teardown(record);
    record.status = "failed";
    record.error = reason(error);
    record.how = how;
    console.error(`${record.title}'s browser module ${how}`, error);
    notify("error", failedText(record));
    reportTo(record, { state: "failed", how, error: record.error });
    redraw();
}

/**
 * Tell the server how a module's browser part stands in this tab (PP-368), for `extension_inspect`: what a drop-in's
 * added once it loaded, and any module's failure (to load, stopped, or a page or sheet that failed to draw). The server
 * keeps it only about the version it serves now. One that does not reach the server says so in the console.
 */
function reportTo(record, report) {
    api("extensions/browser-reports", { module: record.module, url: record.url, ...report }).catch((error) =>
        console.warn(`${record.title}: could not tell the server how its browser part stands`, error),
    );
}

/** "Board failed to load in this browser: why": a failed module's notice, and its page's or sheet's error. */
function failedText(record) {
    const vars = { title: record.title, reason: record.error };

    return record.how === "was stopped"
        ? t("{title} was stopped in this browser: {reason}", vars)
        : t("{title} failed to load in this browser: {reason}", vars);
}

function unload(record) {
    record.gone = true;
    modules.delete(record.module);
    teardown(record);
}

/** Take away what a browser module added, and run its cleanups, last first. */
function teardown(record) {
    for (const kind of KINDS) {
        record.adds[kind].clear();
    }

    if (record.calls.size > 0) {
        record.calls.clear();
        describersChanged();
    }

    record.listeners.clear();

    if (record.theme !== null) {
        record.theme = null;
        applyThemes();
    }

    for (const dispose of record.disposers.splice(0).reverse()) {
        cleanUp(record, dispose);
    }
}

// ─── Colours (`pocket.theme`, PP-371) ─────────────────────────────────────────────────

/** The style element that holds the modules' colours. */
const THEME_STYLE = "pocket-extension-theme";

/** A frozen copy of the colours a module gives, checked: the app's colour tokens, each a colour and nothing more. */
function themeOf(tokens) {
    if (typeof tokens !== "object" || tokens === null || Array.isArray(tokens)) {
        throw new Error('pocket.theme: give it the colour tokens to set, like { "--accent": "#ff9e64" }');
    }

    const copy = {};

    for (const [name, value] of Object.entries(tokens)) {
        if (!THEME_TOKEN_SET.has(name)) {
            throw new Error(`pocket.theme: ${name} is not one of the app's colour tokens`);
        }

        // A colour, and so nothing that could end the rule it goes in.
        if (typeof value !== "string" || value.length > 200 || /[;{}<>\\]/.test(value) || !CSS.supports("color", value)) {
            throw new Error(`pocket.theme: ${name}'s value is not a colour`);
        }

        copy[name] = value;
    }

    return Object.freeze(copy);
}

/** Each token a module sets now: the newest loaded module's value wins; `over` are the older modules that set it too. */
function themeWinners() {
    const won = new Map();
    const setters = [...modules.values()]
        .filter((record) => liveRecord(record) && record.theme !== null)
        .sort((a, b) => b.seq - a.seq);

    for (const record of setters) {
        for (const [name, value] of Object.entries(record.theme)) {
            const held = won.get(name);

            if (held === undefined) {
                won.set(name, { record, value, over: [] });
            } else {
                held.over.push(record.module);
            }
        }
    }

    return won;
}

/**
 * Put the modules' colours on the page, or take them off. Unlayered, so they win over the app's own layer, Appearance's
 * colours and the theme's (index.html's `@layer pocket, palette, theme`); sizes people choose stay inline, and stay.
 */
function applyThemes() {
    const won = themeWinners();
    let style = document.getElementById(THEME_STYLE);

    if (won.size === 0) {
        style?.remove();
    } else {
        if (style === null) {
            style = document.createElement("style");
            style.id = THEME_STYLE;
            document.head.append(style);
        }

        style.textContent = `:root{${[...won].map(([name, { value }]) => `${name}:${value}`).join(";")}}`;
    }

    placesChanged();
}

// ─── What the tab tells the server of the shared places (PP-371) ───────────────────────────

/** The places report sent last, as JSON: the same again is not sent. */
let placesSent = JSON.stringify({ docks: [], hiddenDocks: [], theme: {} });
let placesDue = false;

/**
 * Tell the server which modules' docks show in this session and which are left out (at most two show), and whose colour
 * each token takes, for `extension_inspect`; soon after a change, once.
 */
function placesChanged() {
    if (placesDue) {
        return;
    }

    placesDue = true;
    setTimeout(() => {
        placesDue = false;

        const sessionId = store.state.conversationId;
        const { shown, hidden } = sessionId === null ? { shown: [], hidden: [] } : docksFor(sessionId);
        const places = {
            docks: shown.map(({ record }) => record.module),
            hiddenDocks: hidden.map(({ record }) => record.module),
            theme: Object.fromEntries([...themeWinners()].map(([name, { record, over }]) => [name, [record.module, ...over]])),
        };
        const text = JSON.stringify(places);

        if (text === placesSent || !store.state.me) {
            return;
        }

        placesSent = text;
        api("extensions/browser-reports", { state: "places", ...places }).catch((error) =>
            console.warn("Could not tell the server where extensions show", error),
        );
    }, 50);
}

// The docks follow the session open.
{
    let session = store.state.conversationId;

    store.subscribe((state) => {
        if (state.conversationId !== session) {
            session = state.conversationId;
            placesChanged();
        }
    });
}

// Events from the server: to the listeners of the module that sent them.
onExtensionEvent(({ module, event, data }) => {
    const record = modules.get(module);

    for (const listener of [...(record?.listeners ?? [])]) {
        if (listener.event !== event) {
            continue;
        }

        try {
            listener.run(data);
        } catch (error) {
            console.error(`${record.title}: a listener for ${event} failed`, error);
        }
    }
});

// ─── pocket: the app's API for a browser module ──────────────────────────────

/** A copy of what a module gives to add, once it holds: read once, so what is checked is what is kept. */
function specOf(kind, spec) {
    if (typeof spec !== "object" || spec === null) {
        throw new Error(`pocket.${kind}: give it an object`);
    }

    const copy = { ...spec };

    check(kind, copy);

    return copy;
}

/** What each kind needs besides its `id`, and the one thing it does when used, if it is used. */
function check(kind, spec) {
    const name = `pocket.${kind}`;

    if (!isId(spec.id)) {
        throw new Error(`${name}: an id is up to 64 letters, digits, and . _ : -`);
    }

    const text = (field) => {
        if (typeof spec[field] !== "string" || spec[field].trim() === "") {
            throw new Error(`${name} ${spec.id}: give it a ${field}`);
        }
    };

    if (TITLED.has(kind)) {
        text("title");
    } else if (kind !== "dock") {
        text("label");
    }

    // What the app's own screens draw must be what they expect: a wrong type would fail where no boundary catches it.
    for (const field of ["hint", "detail", "icon", "iconPath"]) {
        if (spec[field] !== undefined && typeof spec[field] !== "string") {
            throw new Error(`${name} ${spec.id}: ${field} is text`);
        }
    }

    if (
        spec.badge !== undefined &&
        spec.badge !== null &&
        spec.badge !== false &&
        typeof spec.badge !== "string" &&
        typeof spec.badge !== "number"
    ) {
        throw new Error(`${name} ${spec.id}: a badge is a number or short text`);
    }

    if (
        spec.keywords !== undefined &&
        !(Array.isArray(spec.keywords) && spec.keywords.every((each) => typeof each === "string"))
    ) {
        throw new Error(`${name} ${spec.id}: keywords are a list of words`);
    }

    // A page can keep Esc and sideways swipes for itself; a sheet can be wide, and bare (it draws its own header).
    const flags = { page: ["escape", "swipe"], sheet: ["wide", "bare"] }[kind] ?? [];

    for (const field of flags) {
        if (spec[field] !== undefined && typeof spec[field] !== "boolean") {
            throw new Error(`${name} ${spec.id}: ${field} is true or false`);
        }
    }

    // A dock shows in the sessions its filter takes (all, without one).
    if (kind === "dock" && spec.sessions !== undefined && typeof spec.sessions !== "function") {
        throw new Error(`${name} ${spec.id}: sessions is a function of a session's id`);
    }

    // An overlay's width, in whole pixels.
    if (kind === "overlay" && spec.width !== undefined && !(Number.isInteger(spec.width) && spec.width >= 160 && spec.width <= 480)) {
        throw new Error(`${name} ${spec.id}: width is a whole number of pixels from 160 to 480`);
    }

    if (DRAWN.has(kind)) {
        if (typeof spec.component !== "function") {
            throw new Error(`${name} ${spec.id}: give it a component to show`);
        }

        return;
    }

    // A row in a session's menu runs a function with the session's id.
    if (kind === "sessionMenu") {
        if (typeof spec.run !== "function") {
            throw new Error(`${name} ${spec.id}: give it a run function, which gets the session's id`);
        }

        return;
    }

    const does = [...TARGETS, "run"].filter((field) => spec[field] !== undefined);

    if (does.length !== 1 || (spec.run !== undefined && typeof spec.run !== "function")) {
        throw new Error(`${name} ${spec.id}: say what it does: page, sheet, panelTab, overlay, or a run function`);
    }

    for (const field of TARGETS) {
        if (spec[field] !== undefined && !isId(spec[field])) {
            throw new Error(`${name} ${spec.id}: ${field} is the id of one of its ${field}s`);
        }
    }
}

/** Two specs that would show the same: the same fields, each the very same value. */
function sameSpec(a, b) {
    if (a === undefined || b === undefined) {
        return false;
    }

    const keys = Object.keys(a);

    return (
        keys.length === Object.keys(b).length &&
        keys.every((key) => Object.hasOwn(b, key) && Object.is(a[key], b[key]))
    );
}

/**
 * A route's path under the module's own address (`/api/x/<module>/`): no `.` or `..` parts, no address of its own (a
 * leading `//`, or a scheme such as `https:`), so a call never reaches anything else.
 */
function routeOf(module, path) {
    const given = String(path);
    const refuse = (why) => new Error(`pocket.api: ${JSON.stringify(given)} ${why}`);

    if (/^[\\/]{2}/.test(given) || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(given)) {
        throw refuse('is not one of its routes: give a path such as "status"');
    }

    const relative = given.replace(/^[\\/]/, "");
    const parts = relative.split(/[?#]/, 1)[0].split(/[\\/]/);

    if (parts.some((part) => /^(\.|%2e){1,2}$/i.test(part))) {
        throw refuse("has a . or .. part: give the route's own path");
    }

    // Under the page's base (PP-54: a shared space lives under /space/<key>/).
    const prefix = new URL(`api/x/${module}/`, document.baseURI);
    const url = new URL(relative, prefix);

    if (url.origin !== prefix.origin || !url.pathname.startsWith(prefix.pathname)) {
        throw refuse("leads out of the module's routes");
    }

    return `x/${module}/${relative}`;
}

function pocketFor(record) {
    const live = () => liveRecord(record);

    // A page or sheet opened or closed shows at once: it counts toward bounds of its own.
    const change = () => live() && chargeOpen(record);

    /** Add something, or replace what has its id; what comes back changes or removes it. */
    const add = (kind, spec) => {
        tick(record);

        let current = specOf(kind, spec);

        if (live()) {
            const before = record.adds[kind].get(current.id);

            record.adds[kind].set(current.id, current);

            // An overlay closed with × shows again when it is added again.
            const reopened = kind === "overlay" && record.closed.delete(current.id);

            // The same again (a component that adds as it draws) draws nothing again.
            if (reopened || !sameSpec(before, current)) {
                redraw();
            }
        }

        return Object.freeze({
            update(patch) {
                tick(record);

                if (typeof patch !== "object" || patch === null) {
                    throw new Error(`pocket.${kind} ${current.id}: update takes an object`);
                }

                if (!live() || record.adds[kind].get(current.id) !== current) {
                    return;
                }

                const next = { ...current, ...patch, id: current.id };

                // Nothing changed (an update on every draw): nothing draws again.
                if (sameSpec(current, next)) {
                    return;
                }

                check(kind, next);
                current = next;
                record.adds[kind].set(current.id, current);
                redraw();
            },
            remove() {
                tick(record);

                if (live() && record.adds[kind].get(current.id) === current) {
                    record.adds[kind].delete(current.id);
                    redraw();
                }
            },
        });
    };

    /** Its own folder's address, `/x/<module>/<version>/`, where its stylesheets are. */
    const folder = () => new URL(".", underBase(record.url));

    return Object.freeze({
        version: POCKET_API,
        module: record.module,
        title: record.title,
        // Drawing: the app's own Preact and htm, so components and hooks work with its renderer.
        h,
        html,
        Fragment,
        useState,
        useEffect,
        useLayoutEffect,
        useRef,
        useMemo,
        useCallback,
        useReducer,
        // The app's pieces, so an extension looks like the rest of the app.
        Icon,
        Spinner,
        Loader,
        Markdown,
        Switch,
        /** The app's own dropdown (`{ value, options: [{ value, label, detail? }], onChange, label }`), not the system's. */
        Choice,
        /**
         * The app's list to tick several from (`{ options: [{ value, label, detail?, group?, disabled?, chosen? }], onAdd,
         * label, placeholder? }`, `onAdd` given the values ticked), not the system's (PP-367).
         */
        MultiChoice,
        /** A state as a word and a small dot (`{ tone: "ok" | "warn" | "err" | "off", label }`), never a ✓. */
        StateTag,
        /**
         * The app's words in the person's language (PP-84): `t` takes an English sentence with {placeholders} and their
         * values, `tn` a count with its one and other sentences, `tx` a sentence with elements in it; English where the
         * app's catalog has no sentence.
         * `language()` is the one in use ("en", "zh-CN", "vi"). Uncounted, as `html` is: they draw.
         */
        t,
        tn,
        tx,
        language: currentLanguage,
        /** Who uses this tab. */
        me: () => {
            tick(record);

            const me = store.state.me;

            return me ? { id: me.id, name: me.name, role: me.role } : null;
        },
        /** The session open in this tab, or null. */
        conversationId: () => {
            tick(record);

            return store.state.conversationId;
        },
        /**
         * Call one of the module's routes: `api("status")` gets, `api("items", { name })` posts, and
         * `api("items/3", undefined, { method: "DELETE" })` deletes. Rejects with an error with the server's words, or
         * for a path that would lead out of the module's routes.
         */
        api: (path, body, options) => {
            // Counted at once, so that a loop of calls that holds the page is stopped; once it is, the call throws, as
            // the others do, so that a loop that only calls this ends too.
            tick(record);

            return (async () => api(routeOf(record.module, path), body, options))();
        },
        /** Hear an event the module sends (`web.send` on the server); returns how to stop. */
        on(event, run) {
            tick(record);

            if (typeof event !== "string" || typeof run !== "function") {
                throw new Error("pocket.on: give it an event name and a function");
            }

            const listener = { event, run };

            if (live()) {
                record.listeners.add(listener);
            }

            return () => record.listeners.delete(listener);
        },
        /** A short notice, as the app's own: `info`, `warning`, or `error`. A few at a time (`NOTICES`). */
        notify(level, message) {
            tick(record);

            if (live()) {
                noticeFrom(record, LEVELS.has(level) ? level : "info", String(message));
            }
        },
        /**
         * Put text into the message box to Pi in the open session, after what is there, and show it: its page and any
         * sheet close. The person sends it, or not.
         */
        compose(text) {
            tick(record);

            if (typeof text !== "string" || text.trim() === "") {
                throw new Error("pocket.compose: give it the text to put in the message box");
            }

            if (live()) {
                closePage();
                insertIntoComposer(text);
            }
        },
        rail: (spec) => add("rail", spec),
        menu: (spec) => add("menu", spec),
        launcher: (spec) => add("launcher", spec),
        page: (spec) => add("page", spec),
        sheet: (spec) => add("sheet", spec),
        /**
         * A strip one line high right above the message box (PP-371): `{ id, component, sessions? }`, the component
         * getting `{ pocket, sessionId }`; `sessions(id)` says in which sessions it shows (all, without it). At most two
         * modules' docks show at once: the newest loaded.
         */
        dock: (spec) => add("dock", spec),
        /**
         * A small panel floating over the app (PP-371): `{ id, title, component, width? }`, dragged by its title, closed
         * with × (adding it again shows it again; a rail button's `overlay: id` too). Where it was dragged is kept in
         * this browser; on a phone it stays clear of the message box and the keyboard.
         */
        overlay: (spec) => add("overlay", spec),
        /**
         * A tab in the side panel, beside Pi's browser and computer (PP-371): `{ id, title, icon, component }`, opened
         * from the top bar's panel button, or a rail button's `panelTab: id`. On a phone the panel covers the screen.
         */
        panelTab: (spec) => add("panelTab", spec),
        /** A row in a session's menu (PP-371): `{ id, label, hint?, run(sessionId) }`. */
        sessionMenu: (spec) => add("sessionMenu", spec),
        /**
         * The app's colours while the module is on (PP-371): `{ "--accent": "#ff9e64", … }`, colour tokens only (a
         * palette's `--o-*` and the app's colours). Called again, it replaces them; `remove()` takes them away. Two
         * modules that set one: the newest loaded wins. None in safe mode.
         */
        theme(tokens) {
            tick(record);

            const current = themeOf(tokens);

            if (live()) {
                record.theme = current;
                applyThemes();
            }

            return Object.freeze({
                remove() {
                    tick(record);

                    if (live() && record.theme === current) {
                        record.theme = null;
                        applyThemes();
                    }
                },
            });
        },
        /**
         * The app's folder picker (browse, make folders, here or on a machine), taking the sheet's place: answers the
         * folder chosen (a path, or `machine:<id>:<path>`), or null. `start` is where it opens; `title`, its title.
         */
        pickFolder(options = {}) {
            tick(record);

            if (!live()) {
                return Promise.resolve(null);
            }

            return pickFolder({
                ...(typeof options.start === "string" ? { start: options.start } : {}),
                ...(typeof options.title === "string" ? { title: options.title } : {}),
            });
        },
        /** How calls of one of its tools show: in a line in transcripts and peek tiles, and in a group's summary. */
        toolCall(spec) {
            tick(record);

            const current = toolCallOf(record, spec);

            if (current === null) {
                return Object.freeze({ remove() {} });
            }

            if (live()) {
                record.calls.set(current.tool, current);
                describersChanged();
                redraw();
            }

            return Object.freeze({
                remove() {
                    tick(record);

                    if (live() && record.calls.get(current.tool) === current) {
                        record.calls.delete(current.tool);
                        describersChanged();
                        redraw();
                    }
                },
            });
        },
        // Its own page and sheet only, and only while this version is loaded: a timer that outlived it opens or closes
        // nothing, not even the page of the version after it.
        openPage(id) {
            tick(record);

            if (!isId(id)) {
                throw new Error("pocket.openPage: give it the id of one of its pages");
            }

            if (change()) {
                openPage(record.module, id);
            }
        },
        // Another module's page, by its module's name and the page's id (a board's Docs opens Documents, PP-47): a page
        // only, never another module's sheet, and only while this version is loaded.
        openPageOf(module, id) {
            tick(record);

            if (!isId(module) || !isId(id)) {
                throw new Error("pocket.openPageOf: give it a module's name and the id of one of its pages");
            }

            if (change()) {
                openPageWhenReady(module, id);
            }
        },
        closePage() {
            tick(record);

            if (live() && store.state.page?.module === record.module && change()) {
                closePage();
            }
        },
        openSheet(id, props) {
            tick(record);

            if (!isId(id)) {
                throw new Error("pocket.openSheet: give it the id of one of its sheets");
            }

            if (props !== undefined && (typeof props !== "object" || props === null)) {
                throw new Error("pocket.openSheet: its props are an object");
            }

            if (change()) {
                openExtensionSheet(record.module, id, props);
            }
        },
        closeSheet() {
            tick(record);

            const sheet = store.state.sheet;

            if (live() && sheet?.type === "ext" && sheet.module === record.module && change()) {
                closeSheet();
            }
        },
        /**
         * Load a stylesheet from the browser module's folder (`look.css`); it goes with this version. One that does
         * not load says so in a notice.
         */
        style(path) {
            tick(record);

            if (!live()) {
                return;
            }

            const base = folder();
            let href;

            try {
                href = new URL(String(path), base);
            } catch {
                href = null;
            }

            if (
                href === null ||
                href.origin !== base.origin ||
                !href.pathname.startsWith(base.pathname)
            ) {
                throw new Error(
                    `pocket.style: ${JSON.stringify(String(path))} is not in the module's own folder`,
                );
            }

            // In the app's own layer (index.html), after its rules: it wins and loses against them by specificity and
            // order, as a stylesheet of its own would, and the theme's layer stays above both. The address is the URL
            // parser's, so it holds no quote or backslash to end the string early.
            const sheet = document.createElement("style");

            sheet.textContent = `@import url("${href.href.replace(/["\\\n]/g, encodeURIComponent)}") layer(pocket);`;
            sheet.dataset.extension = record.module;
            sheet.addEventListener("error", () => {
                if (live() && sheet.isConnected) {
                    console.warn(`${record.title}: ${href.href} did not load`);
                    noticeFrom(
                        record,
                        "warning",
                        `${record.title}: its stylesheet ${String(path)} did not load`,
                    );
                }
            });
            document.head.append(sheet);
            record.disposers.push(() => sheet.remove());
        },
        /** Run `dispose` when this version goes: an edit, or the module turned off. Gone or failed already: now. */
        onDispose(dispose) {
            tick(record);

            if (typeof dispose !== "function") {
                throw new Error("pocket.onDispose: give it a function");
            }

            if (!live()) {
                cleanUp(record, dispose);

                return;
            }

            record.disposers.push(dispose);
        },
    });
}

// ─── Tool calls: how a module's own tools show ───────────────────────────────

/**
 * A copy of what `pocket.toolCall` was given, once it holds; null from a server that does not say which tools are the
 * module's, where calls keep the default display. A module describes only the tools its own module installs, by the
 * very names Pi runs them by, so it never changes how another's calls show (a command shown as something else).
 */
function toolCallOf(record, spec) {
    if (typeof spec !== "object" || spec === null) {
        throw new Error("pocket.toolCall: give it an object");
    }

    const copy = { ...spec };
    const name = `pocket.toolCall ${String(copy.tool)}`;

    if (typeof copy.tool !== "string") {
        throw new Error("pocket.toolCall: give it the name of one of its tools");
    }

    if (record.tools === null) {
        return null;
    }

    if (!record.tools.includes(copy.tool)) {
        throw new Error(`${name}: it is not one of this module's tools`);
    }

    if (typeof copy.label !== "function") {
        throw new Error(`${name}: give it a label function`);
    }

    for (const field of ["subject", "summary"]) {
        if (copy[field] !== undefined && typeof copy[field] !== "function") {
            throw new Error(`${name}: ${field} is a function`);
        }
    }

    for (const field of ["icon", "iconPath"]) {
        if (copy[field] !== undefined && typeof copy[field] !== "string") {
            throw new Error(`${name}: ${field} is text`);
        }
    }

    return copy;
}

/** The module that describes a tool's calls, first in the server's order, and what it gave. */
function describerOf(tool) {
    for (const module of order) {
        const record = modules.get(module);

        // Only a tool its module still installs: one a newer version took away is no longer its own.
        if (
            liveRecord(record) &&
            record.calls.has(tool) &&
            (record.tools === null || record.tools.includes(tool))
        ) {
            return { record, spec: record.calls.get(tool) };
        }
    }

    return undefined;
}

/** Describers that failed, said once each in the console: they are asked again at every draw. */
const toldFailures = new Set();

/**
 * What a describer gives for a call's arguments (a copy, so it cannot change them), as one line of text up to `max`
 * long; undefined when it throws or gives anything else.
 */
function described(record, tool, field, run, args, max) {
    let value;

    try {
        value = run(structuredClone(args));
    } catch (error) {
        const key = `${record.module}:${tool}:${field}`;

        if (!toldFailures.has(key)) {
            toldFailures.add(key);
            console.error(`${record.title}: describing a ${tool} call (${field}) failed`, error);
        }

        return undefined;
    }

    if (typeof value !== "string") {
        return undefined;
    }

    const line = value.replace(/\s+/g, " ").trim();

    return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

setCallDescriber((tool, args) => {
    const found = describerOf(tool);

    if (found === undefined) {
        return undefined;
    }

    const { record, spec } = found;
    const label = described(record, tool, "label", spec.label, args, 80);
    const subject =
        spec.subject === undefined
            ? ""
            : described(record, tool, "subject", spec.subject, args, 160);

    if (!label || subject === undefined) {
        return undefined;
    }

    return {
        label,
        subject,
        ...(spec.icon === undefined && spec.iconPath === undefined
            ? {}
            : { iconPath: pathOf(spec) }),
    };
});

setCallSummary((tool, args) => {
    const found = describerOf(tool);

    if (found?.spec.summary === undefined) {
        return undefined;
    }

    const { record, spec } = found;
    let kind;

    try {
        kind = spec.summary(structuredClone(args));
    } catch (error) {
        const key = `${record.module}:${tool}:summary`;

        if (!toldFailures.has(key)) {
            toldFailures.add(key);
            console.error(`${record.title}: summing up a ${tool} call failed`, error);
        }

        return undefined;
    }

    const word = (value) => typeof value === "string" && value.trim() !== "" && value.length <= 60;

    if (
        typeof kind !== "object" ||
        kind === null ||
        !word(kind.verb) ||
        (kind.noun !== undefined && !word(kind.noun)) ||
        (kind.by !== undefined && !word(kind.by))
    ) {
        return undefined;
    }

    return {
        verb: kind.verb.trim(),
        ...(kind.noun === undefined ? {} : { noun: kind.noun.trim() }),
        ...(kind.by === undefined ? {} : { by: kind.by }),
    };
});

// ─── Opening what extensions added ───────────────────────────────────────────

/**
 * Show a module's page in the conversation's place, where the subagents board shows. What is over that place (a sheet,
 * the launcher) closes, so that back closes first what shows on top.
 */
export function openPage(module, id) {
    if (!isId(id)) {
        return;
    }

    store.set({
        page: { module, id },
        sheet: null,
        launcher: false,
        board: false,
        boardAgents: null,
        drawer: false,
    });
}

export const closePage = () => store.set({ page: null });

/**
 * The `close` a page's component gets: it closes that page, of that version of its module, while it shows, and nothing
 * else (another page, the next version's) when called later.
 */
function pageCloser(record, id) {
    return () => {
        const { page } = store.state;

        if (liveRecord(record) && page?.module === record.module && page.id === id) {
            closePage();
        }
    };
}

/** The `close` a sheet's component gets: it closes that sheet of that version while it shows, and no other sheet. */
function sheetCloser(record, id) {
    return () => {
        const { sheet } = store.state;

        if (
            liveRecord(record) &&
            sheet?.type === "ext" &&
            sheet.module === record.module &&
            sheet.sheetId === id
        ) {
            closeSheet();
        }
    };
}

function openExtensionSheet(module, id, props = {}) {
    openSheet({ type: "ext", module, sheetId: id, id: `${module}:${id}`, props });
}

/**
 * Do what a rail button, menu row, or launcher action says: open its page or sheet, or run its function. A function that
 * fails, at once or later (an async one), says so in a notice.
 */
function activate(record, spec) {
    const failed = (error) => {
        console.error(`${record.title}: ${spec.id} failed`, error);
        noticeFrom(record, "error", `${record.title}: ${reason(error)}`);
    };

    try {
        if (spec.page !== undefined) {
            openPage(record.module, spec.page);
        } else if (spec.sheet !== undefined) {
            openExtensionSheet(record.module, spec.sheet);
        } else if (spec.panelTab !== undefined) {
            openExtensionPanel(record.module, spec.panelTab);
        } else if (spec.overlay !== undefined) {
            if (record.closed.delete(spec.overlay)) {
                redraw();
            }
        } else {
            Promise.resolve(spec.run()).catch(failed);
        }
    } catch (error) {
        failed(error);
    }
}

/** What every loaded module added of a kind: modules in the order the server lists them, each's in the order added. */
function added(kind) {
    const at = (record) => {
        const index = order.indexOf(record.module);

        return index === -1 ? order.length : index;
    };

    return [...modules.values()]
        .sort((a, b) => at(a) - at(b))
        .flatMap((record) => [...record.adds[kind].values()].map((spec) => ({ record, spec })));
}

/** An extension's icon: its own path, one of the app's by name, or a square of four when it gave none it knows. */
const pathOf = (spec) => spec.iconPath ?? (iconPath(spec.icon ?? "") || iconPath("grid"));

/** The most of a badge's text kept (its button shows less, cut with an ellipsis), for its button's label. */
const BADGE_TEXT = 24;

/** What tells the characters a reader sees as one (an emoji with its joiners, a letter with its accent), made once. */
const segmenter =
    typeof Intl.Segmenter === "function"
        ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
        : null;
/** How much of a badge's text is looked at: all that can show, and far more. */
const BADGE_HEAD = 1000;

/** The first `count` characters of `text` as a reader sees them, looking at its start only. */
function firstCharacters(text, count) {
    const head = text.slice(0, BADGE_HEAD);
    const characters = [];

    for (const piece of segmenter === null ? head : segmenter.segment(head)) {
        characters.push(typeof piece === "string" ? piece : piece.segment);

        if (characters.length >= count) {
            break;
        }
    }

    return characters;
}

/** What each button's badge shows, worked out once for each version of the button: a draw that changes none reads it. */
const shownBadges = new WeakMap();

function badgeFor(spec) {
    let shown = shownBadges.get(spec);

    if (shown === undefined) {
        shown = badgeOf(spec.badge);
        shownBadges.set(spec, shown);
    }

    return shown;
}

/**
 * A rail button's badge as it shows: as the app's own counts, none at 0 and "99+" above 99 (Infinity too); NaN and
 * -Infinity show nothing, other numbers as they are; text, trimmed, with "" and "0" as nothing, and long text cut whole
 * characters at a time.
 */
function badgeOf(badge) {
    if (typeof badge === "number") {
        if (Number.isNaN(badge) || badge === 0 || badge === -Infinity) {
            return "";
        }

        return badge > 99 ? "99+" : String(badge);
    }

    // Trimmed first, so spaces before it never hide or cut it; only then is its start looked at, which bounds the cost
    // of a huge one without changing what shows of one that fits.
    const text = typeof badge === "string" ? badge.trim() : "";

    if (text === "" || text === "0") {
        return "";
    }

    const characters = firstCharacters(text, BADGE_TEXT + 1);

    return characters.length > BADGE_TEXT || text.length > BADGE_HEAD
        ? `${characters.slice(0, BADGE_TEXT - 1).join("")}…`
        : text;
}

/**
 * How this tab's copy of a module's browser module stands, for the Extensions sheet: `loading`, `ready`, `failed` (with
 * its `error`), or `off` in safe mode; undefined when this tab loads none.
 */
export function browserModuleState(module) {
    const record = modules.get(module);

    if (record === undefined) {
        return safeMode() && order.includes(module) ? { status: "off", error: null } : undefined;
    }

    return { status: record.status, error: record.error };
}

// ─── Where they show ─────────────────────────────────────────────────────────

/**
 * The rail's buttons that extensions added, after the app's own tools: a group that scrolls when they are many, so the
 * folded rail's sessions keep their room.
 */
export function ExtensionRailButtons() {
    const { page } = store.state;
    const buttons = added("rail");

    if (buttons.length === 0) {
        return null;
    }

    return html`<div class="rail-exts">
        ${buttons.map(({ record, spec }) => {
            const open =
                spec.page !== undefined && page?.module === record.module && page.id === spec.page;
            const badge = badgeFor(spec);

            return html`<button
                key=${`${record.module}:${spec.id}`}
                class=${`rail-button rail-ext ${open ? "open" : ""}`}
                data-part="rail-button"
                data-state=${railState(open)}
                title=${spec.title}
                aria-label=${badge === "" ? spec.title : `${spec.title}, ${badge}`}
                aria-pressed=${spec.page === undefined ? undefined : open}
                onClick=${() => (open ? closePage() : activate(record, spec))}
            >
                <${Icon} path=${pathOf(spec)} size=${16} />
                ${badge !== "" && html`<span class="rail-count">${badge}</span>`}
            </button>`;
        })}
    </div>`;
}

/** The menu's rows that extensions added: `{ key, label, hint, run }`, run closing the menu first. */
export function extensionMenuItems() {
    return added("menu").map(({ record, spec }) => ({
        key: `${record.module}:${spec.id}`,
        label: spec.label,
        hint: spec.hint ?? "",
        run: () => {
            // A page shows under the menu, which closes; a sheet takes the menu's place.
            if (spec.sheet === undefined) {
                closeSheet();
            }

            activate(record, spec);
        },
    }));
}

/** The launcher's actions that extensions added, as launcher items. */
export function extensionLauncherItems() {
    return added("launcher").map(({ record, spec }) => ({
        key: `action:ext:${record.module}:${spec.id}`,
        label: spec.label,
        detail: spec.detail ?? record.title,
        iconPath: pathOf(spec),
        keywords: Array.isArray(spec.keywords) ? spec.keywords.join(" ") : "",
        run: () => activate(record, spec),
    }));
}

/**
 * Something an extension draws, which may fail: it says so in its place, and the rest of the app goes on. Whatever was
 * thrown (an empty string, nothing at all) counts.
 */
class Guard extends Component {
    state = { failed: false, message: "" };

    constructor(props) {
        super(props);
        guards++;
    }

    componentWillUnmount() {
        guards--;
    }

    componentDidCatch(error) {
        console.error(`${this.props.name} failed`, error);
        this.setState({ failed: true, message: reason(error) });

        if (this.props.record !== undefined) {
            reportTo(this.props.record, { state: "failed", how: "failed to draw", error: `${this.props.name}: ${reason(error)}` });
        }
    }

    render({ children, name }, { failed, message }) {
        return failed ? html`<div class="error-box">${t("{name} failed: {message}", { name, message })}</div>` : children;
    }
}

// Preact reads `.then` of whatever a component throws while it draws, to tell a pause from a failure, so a thrown `null`
// or `undefined` breaks Preact itself, past every boundary (and, from a component that drew again alone, out of its
// queue, which then drops what else waited to draw). So under a Guard, what Preact calls of a component while it draws
// turns those into an Error first: its render and the lifecycle methods called with it, its class's
// getDerivedStateFromProps, and the effects hooks run before it draws again. Checked again each time it draws, so a
// method it replaces is covered too. A method given by a getter is left as it is, and so is a class's constructor, which
// Preact calls only when its parent draws: what that throws stays under the Guard, in Preact's own words.
//
// Preact's hooks (`_diff`, `_render`) and a vnode's component and parent go by these short names in its build, as
// preact/hooks uses them; the app's own components are left as they are. Should the names change, this does nothing,
// and `Drawn` still keeps such a failure under the Guard, in Preact's own words.
const DIFF_HOOK = "__b";
const RENDER_HOOK = "__r";
const COMPONENT = "__c";
const PARENT = "__";
const NO_REASON = "it gave no reason";
/** What Preact calls of a component while it draws, besides its class's getDerivedStateFromProps. */
const DRAWING = [
    "render",
    "componentWillMount",
    "componentWillReceiveProps",
    "shouldComponentUpdate",
    "componentWillUpdate",
    "getChildContext",
    "getSnapshotBeforeUpdate",
];
/** The wrappers made here, so none is wrapped again. */
const wrappers = new WeakSet();
/** Each component instance, and each class, once known: whether it draws under a Guard. */
const guardedComponents = new WeakMap();
const guardedClasses = new WeakSet();
/** The instances whose inherited methods were checked too, at their first draw: after it, only their own change. */
const scanned = new WeakSet();
/** How many Guards there are: with none, nothing draws under one, and no vnode's parents need a look. */
let guards = 0;
/** The instance whose own methods were checked as its vnode began to draw, so not again right before it draws. */
let checkedNow = null;

/** `run`, but what it throws is never `null` or `undefined`. */
function throwsSomething(run) {
    const wrapped = function (...args) {
        try {
            return run.apply(this, args);
        } catch (error) {
            throw error ?? new Error(NO_REASON);
        }
    };

    wrappers.add(wrapped);

    return wrapped;
}

/**
 * Wrap the methods `names` of `target`, its own, or inherited too, where they are plain functions that can be
 * replaced.
 */
function wrapMethods(target, names, inherited = true) {
    for (const name of names) {
        let owner = target;
        let found = Object.getOwnPropertyDescriptor(owner, name);

        while (found === undefined && inherited) {
            owner = Object.getPrototypeOf(owner);

            if (owner === null || owner === Object.prototype) {
                break;
            }

            found = Object.getOwnPropertyDescriptor(owner, name);
        }

        // None; a getter (left as it is); or one wrapped already.
        if (found === undefined || !("value" in found)) {
            continue;
        }

        if (typeof found.value !== "function" || wrappers.has(found.value)) {
            continue;
        }

        try {
            Object.defineProperty(target, name, {
                value: throwsSomething(found.value),
                writable: true,
                configurable: true,
                enumerable: owner === target ? found.enumerable : false,
            });
        } catch {
            // Frozen, or a property that cannot change: left as it is.
        }
    }
}

const isClass = (type) =>
    typeof type === "function" && typeof type.prototype?.render === "function";

/** Whether a vnode draws under a Guard (not counting a Guard itself). */
function underGuard(vnode) {
    if (guards === 0) {
        return false;
    }

    for (let above = vnode?.[PARENT]; above; above = above[PARENT]) {
        if (above.type === Guard) {
            return true;
        }
    }

    return false;
}

/** Whether a component instance draws under a Guard, worked out once. */
function guarded(component, vnode) {
    if (typeof component !== "object" || component === null) {
        return false;
    }

    let inside = guardedComponents.get(component);

    if (inside === undefined) {
        inside = underGuard(vnode);
        guardedComponents.set(component, inside);
    }

    return inside;
}

/** A class drawn under a Guard: its methods, and its getDerivedStateFromProps, before any of its instances draws. */
function guardClass(type) {
    if (guardedClasses.has(type)) {
        return;
    }

    guardedClasses.add(type);
    wrapMethods(type.prototype, DRAWING);
    wrapMethods(type, ["getDerivedStateFromProps"]);
}

const beforeDiff = options[DIFF_HOOK];
const beforeRender = options[RENDER_HOOK];

// Before a vnode draws: a class under a Guard is guarded before its first instance is made, and its
// getDerivedStateFromProps again if it was replaced since; a component drawing again alone (its own state changed) has
// the methods it may have replaced since wrapped again.
options[DIFF_HOOK] = (vnode) => {
    if (typeof beforeDiff === "function") {
        beforeDiff(vnode);
    }

    checkedNow = null;

    const type = vnode?.type;

    if (isClass(type)) {
        if (guardedClasses.has(type)) {
            wrapMethods(type, ["getDerivedStateFromProps"]);
        } else if (underGuard(vnode)) {
            guardClass(type);
        }
    }

    const component = vnode?.[COMPONENT];

    if (component && guardedComponents.get(component) === true) {
        wrapMethods(component, DRAWING, false);
        checkedNow = component;
    }
};

// Right before a component draws: its methods, and the effects hooks run first when it draws again before they ran.
options[RENDER_HOOK] = (vnode) => {
    const component = vnode?.[COMPONENT];

    if (!guarded(component, vnode)) {
        if (typeof beforeRender === "function") {
            beforeRender(vnode);
        }

        return;
    }

    if (checkedNow !== component) {
        wrapMethods(component, DRAWING, !scanned.has(component));
        scanned.add(component);
    }

    checkedNow = null;

    if (isClass(component.constructor)) {
        guardClass(component.constructor);
    }

    if (typeof beforeRender === "function") {
        try {
            beforeRender(vnode);
        } catch (error) {
            throw error ?? new Error(NO_REASON);
        }
    }
};

/** Between the Guard and an extension's component: what goes wrong in it, however Preact takes it, stays under the Guard. */
function Drawn({ component, props }) {
    return h(component, props);
}

/** Each extension component's number, for its Guard's key: a new component starts with a new Guard. */
const componentIds = new WeakMap();
let nextComponentId = 1;

function componentId(component) {
    if (!componentIds.has(component)) {
        componentIds.set(component, nextComponentId++);
    }

    return componentIds.get(component);
}

/** What a page or sheet shows: its component once its module is ready, else why not. */
function Body({ record, spec, title, props, close }) {
    if (record === undefined) {
        return html`<p class="muted">${t("This extension is off.")}</p>`;
    }

    if (record.status === "failed") {
        return html`<div class="error-box">
            ${failedText(record)}
        </div>`;
    }

    if (spec === undefined) {
        return record.status === "ready"
            ? html`<p class="muted">${t("{title} no longer has this.", { title: record.title })}</p>`
            : html`<${Loader} label=${t("Loading {title}", { title })} />`;
    }

    // A Guard that caught a failure stays with it until its component changes (the page added again, or updated).
    return html`<${Guard} key=${`${record.url}#${componentId(spec.component)}`} name=${title} record=${record}>
        <${Drawn}
            component=${spec.component}
            props=${{ ...props, pocket: record.pocket, close }}
        />
    <//>`;
}

/** An extension's page in the conversation's place: its title, a close button, and what it draws. */
export function ExtensionPage() {
    const target = store.state.page;
    const record = modules.get(target?.module);
    const spec = record?.adds.page.get(target?.id);
    const title = spec?.title ?? record?.title ?? t("Extension");
    // A page that keeps Esc for itself (`escape: false`): read as the key comes, as it may change.
    const keepsEscape = useRef(false);
    const close = useMemo(() => pageCloser(record, target?.id), [record, target?.id]);

    keepsEscape.current = spec?.escape === false;
    useBack(true, closePage);

    // Esc closes it, as it does the subagents board, unless something over it takes Esc first, or the page keeps Esc.
    // Heard before the others (capturing): a sheet over it closes on the same key, and would be gone by the time this
    // heard it. Not while a character is being composed (an input method's Esc cancels that).
    useEffect(() => {
        const onKey = (event) => {
            const { sheet, launcher } = store.state;

            if (
                event.key === "Escape" &&
                !event.isComposing &&
                event.keyCode !== 229 &&
                !event.defaultPrevented &&
                !sheet &&
                !launcher &&
                !keepsEscape.current
            ) {
                event.preventDefault();
                closePage();
            }
        };

        addEventListener("keydown", onKey, true);

        return () => removeEventListener("keydown", onKey, true);
    }, []);

    // A page that keeps sideways swipes (`swipe: false`) starts no swipe back anywhere on it (`gestures.js`).
    return html`<section
        class="ext-page"
        data-part="extension-page"
        aria-label=${title}
        data-module=${target?.module}
        data-no-swipe=${spec?.swipe === false ? "" : undefined}
    >
        <header class="board-head">
            <div class="board-title">
                <h2>${title}</h2>
                ${
                    record &&
                    moduleTitle(record.title) !== title &&
                    html`<div class="board-sub">${moduleTitle(record.title)}</div>`
                }
            </div>
            <button
                class="icon-button"
                title=${t("Back to the conversation (Esc)")}
                aria-label=${t("Close")}
                onClick=${closePage}
            >
                <${Icon} name="close" />
            </button>
        </header>
        <div class="ext-page-body">
            <${Body} record=${record} spec=${spec} title=${title} props=${{}} close=${close} />
        </div>
    </section>`;
}

/**
 * An extension's sheet (`{ type: "ext", module, sheetId, props }`). Its title is its spec's, or one it was opened with
 * (`pocket.openSheet(id, { title })`: a folder's sheet named after the folder).
 */
export function ExtensionSheet({ sheet }) {
    const record = modules.get(sheet.module);
    const spec = record?.adds.sheet.get(sheet.sheetId);
    const title =
        typeof sheet.props?.title === "string" && sheet.props.title.trim() !== "" ? sheet.props.title : (spec?.title ?? record?.title ?? t("Extension"));
    const close = useMemo(() => sheetCloser(record, sheet.sheetId), [record, sheet.sheetId]);

    return html`<${Sheet} title=${title} onClose=${closeSheet} wide=${spec?.wide === true} bare=${spec?.bare === true}>
        <${Body}
            record=${record}
            spec=${spec}
            title=${title}
            props=${sheet.props ?? {}}
            close=${close}
        />
    <//>`;
}

// ─── The dock above the message box (`pocket.dock`, PP-371) ────────────────────────────────

/** Whether a dock shows in a session: its filter says so (one that throws says no, and why in the console). */
function docksIn(record, spec, sessionId) {
    if (spec.sessions === undefined) {
        return true;
    }

    try {
        return spec.sessions(sessionId) === true;
    } catch (error) {
        console.error(`${record.title}: the dock ${spec.id}'s sessions filter failed`, error);

        return false;
    }
}

/** The modules with a dock in a session, newest loaded first: the first `DOCKS` show, the rest wait. */
function docksFor(sessionId) {
    const all = [...modules.values()]
        .filter(liveRecord)
        .map((record) => ({ record, docks: [...record.adds.dock.values()].filter((spec) => docksIn(record, spec, sessionId)) }))
        .filter((each) => each.docks.length > 0)
        .sort((a, b) => b.record.seq - a.record.seq);

    return { shown: all.slice(0, DOCKS), hidden: all.slice(DOCKS) };
}

/**
 * The strips extensions add right above the message box (`composer.js` puts it last in the dock): one line each, at
 * most two modules', the older one first.
 */
export function ExtensionDocks() {
    const sessionId = store.state.conversationId;

    if (sessionId === null) {
        return null;
    }

    const { shown } = docksFor(sessionId);

    if (shown.length === 0) {
        return null;
    }

    return html`<div class="ext-docks" data-part="extension-docks">
        ${[...shown].reverse().map(
            ({ record, docks }) => html`<div class="ext-dock" key=${record.module} data-module=${record.module} aria-label=${record.title}>
                ${docks.map((spec) => html`<${Body} key=${spec.id} record=${record} spec=${spec} title=${record.title} props=${{ sessionId }} />`)}
            </div>`,
        )}
    </div>`;
}

// ─── Floating overlays (`pocket.overlay`, PP-371) ─────────────────────────────────────────

/** Room kept between an overlay and the screen's edges, the top bar, and the message box. */
const EDGE = 8;
const OVERLAY_WIDTH = 240;

/** Where an overlay was dragged, in this browser: `{ x, y }`, or null. */
function placeOf(key) {
    try {
        const place = JSON.parse(localStorage.getItem(key) ?? "null");

        return Number.isFinite(place?.x) && Number.isFinite(place?.y) ? place : null;
    } catch {
        return null;
    }
}

/**
 * An overlay's place on screen: where it was put, kept inside the screen, and on a phone above the message box and the
 * keyboard (what `visualViewport` leaves).
 */
function fitOverlay(box, wanted) {
    if (!box) {
        return;
    }

    const view = visualViewport;
    const width = box.offsetWidth;
    const height = box.offsetHeight;
    const top = (view?.offsetTop ?? 0) + EDGE;
    let bottom = (view ? view.offsetTop + view.height : innerHeight) - EDGE;

    if (BOTTOM_SHEETS.matches) {
        const composer = document.querySelector(".composer-wrap")?.getBoundingClientRect();

        if (composer && composer.height > 0) {
            bottom = Math.min(bottom, composer.top - EDGE);
        }
    }

    const x = wanted?.x ?? innerWidth - width - 2 * EDGE;
    const y = wanted?.y ?? 64;

    box.style.left = `${Math.round(Math.max(EDGE, Math.min(x, innerWidth - width - EDGE)))}px`;
    box.style.top = `${Math.round(Math.max(top, Math.min(y, bottom - height)))}px`;
}

function Overlay({ record, spec }) {
    const box = useRef(null);
    const key = `pocket.overlay:${record.module}:${spec.id}`;
    const wanted = useRef(placeOf(key));
    const close = useCallback(() => {
        if (liveRecord(record) && record.adds.overlay.has(spec.id)) {
            record.closed.add(spec.id);
            redraw();
        }
    }, [record, spec.id]);

    useLayoutEffect(() => fitOverlay(box.current, wanted.current));

    // The screen, the keyboard, or the message box changed: it moves to stay in view and clear of them.
    useEffect(() => {
        const fit = () => fitOverlay(box.current, wanted.current);
        const composer = document.querySelector(".composer-wrap");
        const sizes = new ResizeObserver(fit);

        if (composer) {
            sizes.observe(composer);
        }

        sizes.observe(box.current);
        addEventListener("resize", fit);
        visualViewport?.addEventListener("resize", fit);
        visualViewport?.addEventListener("scroll", fit);

        return () => {
            sizes.disconnect();
            removeEventListener("resize", fit);
            visualViewport?.removeEventListener("resize", fit);
            visualViewport?.removeEventListener("scroll", fit);
        };
    }, []);

    /** Drag by the title: it follows the pointer, and where it is let go is kept. */
    const drag = (event) => {
        if (event.button !== 0 || event.target.closest("button")) {
            return;
        }

        const element = box.current;
        const start = element.getBoundingClientRect();
        const dx = event.clientX - start.left;
        const dy = event.clientY - start.top;
        const head = event.currentTarget;

        event.preventDefault();
        head.setPointerCapture(event.pointerId);

        const move = (moved) => {
            wanted.current = { x: Math.round(moved.clientX - dx), y: Math.round(moved.clientY - dy) };
            fitOverlay(element, wanted.current);
        };
        const end = () => {
            head.removeEventListener("pointermove", move);
            head.removeEventListener("pointerup", end);
            head.removeEventListener("pointercancel", end);

            // What it was let go at, inside the screen.
            const at = element.getBoundingClientRect();

            wanted.current = { x: Math.round(at.left), y: Math.round(at.top) };

            try {
                localStorage.setItem(key, JSON.stringify(wanted.current));
            } catch {
                // No storage: it stays where it is for this page only.
            }
        };

        head.addEventListener("pointermove", move);
        head.addEventListener("pointerup", end);
        head.addEventListener("pointercancel", end);
    };

    return html`<section
        class="ext-overlay"
        data-part="extension-overlay"
        data-module=${record.module}
        role="dialog"
        aria-label=${spec.title}
        ref=${box}
        style=${`width:${spec.width ?? OVERLAY_WIDTH}px`}
    >
        <header class="ext-overlay-head" onPointerDown=${drag}>
            <span class="ext-overlay-title">${spec.title}</span>
            <button class="icon-button small" type="button" aria-label=${t("Close {title}", { title: spec.title })} title=${t("Close")} onClick=${close}>
                <${Icon} name="close" size=${14} />
            </button>
        </header>
        <div class="ext-overlay-body">
            <${Body} record=${record} spec=${spec} title=${spec.title} props=${{}} close=${close} />
        </div>
    </section>`;
}

/** The overlays extensions show now, over the app and under its sheets. */
export function ExtensionOverlays() {
    const shown = added("overlay").filter(({ record, spec }) => !record.closed.has(spec.id));

    return html`${shown.map(({ record, spec }) => html`<${Overlay} key=${`${record.url}:${spec.id}`} record=${record} spec=${spec} />`)}`;
}

// ─── Tabs in the side panel (`pocket.panelTab`, PP-371) ────────────────────────────────────

const PANEL_KEY = "pocket.extensionPanel";

/**
 * Show an extension's tab in the side panel, where Files, Pi's browser and Pi's computer show (one panel at a time):
 * beside the conversation on a wide screen, over it on a phone.
 */
export function openExtensionPanel(module, id) {
    if (!isId(module) || !isId(id)) {
        return;
    }

    sessionStorage.setItem(PANEL_KEY, `${module}:${id}`);
    sessionStorage.removeItem("pocket.files");
    sessionStorage.removeItem("pocket.piBrowser");
    sessionStorage.removeItem("pocket.piComputer");
    closePeople();
    store.set({ extensionPanel: { module, id }, filesOpen: false, browserOpen: false, computerOpen: false, drawer: false, page: null });
}

export function closeExtensionPanel() {
    sessionStorage.removeItem(PANEL_KEY);

    if (document.documentElement.dataset.focus === "extension-panel") {
        document.documentElement.dataset.focus = "pane";
    }

    store.set({ extensionPanel: null });
}

/** The panel this tab had open, kept across reloads (its module loads after). */
export function keptExtensionPanel() {
    const kept = /^([A-Za-z0-9_-]+):([A-Za-z0-9][A-Za-z0-9_.:-]{0,63})$/.exec(sessionStorage.getItem(PANEL_KEY) ?? "");

    return kept === null ? null : { module: kept[1], id: kept[2] };
}

// Files, Pi's browser or Pi's computer taking the panel's place closes it.
store.subscribe((state) => {
    if (state.extensionPanel !== null && (state.filesOpen || state.browserOpen || state.computerOpen)) {
        queueMicrotask(() => {
            if (store.state.extensionPanel !== null && (store.state.filesOpen || store.state.browserOpen || store.state.computerOpen)) {
                closeExtensionPanel();
            }
        });
    }
});

/** The panel shows now: one asked for, in a conversation, outside safe mode. */
export function extensionPanelShown(state = store.state) {
    return state.extensionPanel !== null && state.conversationId !== null && !safeMode();
}

/** The top bar's way to the panel, while extensions have tabs in it: the last one opened, or the first. */
export function ExtensionPanelButton() {
    const tabs = added("panelTab");

    if (tabs.length === 0) {
        return null;
    }

    const shown = extensionPanelShown();
    const last = keptExtensionPanel();
    const open = () => {
        const again = last && tabs.find(({ record, spec }) => record.module === last.module && spec.id === last.id);
        const { record, spec } = again ?? tabs[0];

        openExtensionPanel(record.module, spec.id);
    };

    return html`<button
        class=${`icon-button ${shown ? "on" : ""}`}
        data-part="extension-panel-button"
        aria-label=${shown ? t("Hide the extensions' panel") : t("Extensions' panel")}
        title=${t("Extensions' panel")}
        aria-pressed=${shown}
        onClick=${() => (shown ? closeExtensionPanel() : open())}
    >
        <${Icon} name="sidebar" />
    </button>`;
}

export function ExtensionPanel({ leaving = false }) {
    const target = store.state.extensionPanel ?? keptExtensionPanel();
    const record = modules.get(target?.module);
    const spec = record?.adds.panelTab.get(target?.id);
    const beside = panelsBeside();
    const tabs = added("panelTab");
    const browser = browserAvailable() && piBrowserState()?.open === true;
    const computer = computerAvailable() && computerState() !== null;
    const title = spec?.title ?? record?.title ?? t("Extension");

    useBack(!beside && !leaving, closeExtensionPanel);

    return html`<section
        class=${`files-tile window ext-panel ${leaving ? "leaving" : ""}`}
        data-part="extension-panel"
        data-module=${target?.module}
        data-state=${leaving ? "closing" : undefined}
        role=${beside ? undefined : "dialog"}
        aria-modal=${beside ? undefined : "true"}
        aria-label=${title}
        tabindex="-1"
        inert=${leaving}
    >
        <header class="files-bar ext-panel-bar">
            ${
                !beside &&
                html`<button class="icon-button files-back" type="button" aria-label=${t("Back to the conversation")} onClick=${closeExtensionPanel}>
                    <${Icon} name="back" size=${22} />
                </button>`
            }
            <div class="ext-panel-tabs" role="tablist" aria-label=${t("Side panel")}>
                ${browser && html`<button class="ext-panel-tab" role="tab" aria-selected="false" onClick=${() => setBrowserOpen(true)}><${Icon} name="globe" size=${14} />${t("Browser")}</button>`}
                ${computer && html`<button class="ext-panel-tab" role="tab" aria-selected="false" onClick=${() => setComputerOpen(true)}><${Icon} name="monitor" size=${14} />${t("Computer")}</button>`}
                ${tabs.map(({ record: each, spec: tab }) => {
                    const on = each.module === target?.module && tab.id === target?.id;

                    return html`<button
                        key=${`${each.module}:${tab.id}`}
                        class=${`ext-panel-tab ${on ? "on" : ""}`}
                        role="tab"
                        aria-selected=${on}
                        onClick=${() => !on && openExtensionPanel(each.module, tab.id)}
                    >
                        <${Icon} path=${pathOf(tab)} size=${14} />${tab.title}
                    </button>`;
                })}
            </div>
            ${
                beside &&
                html`<button class="icon-button" type="button" aria-label=${t("Close the panel")} title=${t("Close")} onClick=${closeExtensionPanel}>
                    <${Icon} name="close" size=${16} />
                </button>`
            }
        </header>
        <div class="ext-panel-body">
            <${Body} record=${record} spec=${spec} title=${title} props=${{ sessionId: store.state.conversationId }} close=${closeExtensionPanel} />
        </div>
    </section>`;
}

// ─── A session's menu (`pocket.sessionMenu`, PP-371) ───────────────────────────────────────

/** The rows extensions add to a session's menu: `{ key, label, hint, run }`, `run` given the session's id. */
export function extensionSessionMenuItems(sessionId) {
    return added("sessionMenu").map(({ record, spec }) => ({
        key: `${record.module}:${spec.id}`,
        label: spec.label,
        hint: spec.hint ?? "",
        run: () => {
            closeSheet();

            try {
                Promise.resolve(spec.run(sessionId)).catch((error) => noticeFrom(record, "error", `${record.title}: ${reason(error)}`));
            } catch (error) {
                noticeFrom(record, "error", `${record.title}: ${reason(error)}`);
            }
        },
    }));
}
