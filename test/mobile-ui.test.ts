import {
    type App,
    cleanUp,
    newSession,
    openApp,
    root,
    say,
    scriptedModel,
    until,
    work,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { ConversationId } from "@earendil-works/pi-durable";
import { Browsers } from "./support/browser.ts";
import { findBrowser } from "./support/browser/discovery.ts";
import type { BrowserPage } from "./support/browser/page.ts";
import { VIEWPORTS } from "./support/browser/viewport.ts";
import { createHandler } from "../src/server/http.ts";

const chromium = findBrowser();
const real = {
    skip: chromium === undefined ? "no Chromium-based browser on this machine" : false,
} as const;

let app: App;
let server: Server;
let browsers: Browsers;
let page: BrowserPage;
let base = "";
let first: ConversationId;

/** Run a script in the page and read back the JSON it returns. */
async function inPage<T>(script: string): Promise<T> {
    return JSON.parse(await page.evaluate(script)) as T;
}

type Where = {
    path: string;
    layers: number;
    sheet: string | null;
    files: boolean;
    file: string | null;
};

/** Where the app is: its address, how many layers its history entry stands for, and what is open. */
const where = () =>
    inPage<Where>(`
        const { store } = await import("/store.js");

        return JSON.stringify({
            path: location.pathname,
            layers: history.state?.pocket?.layers ?? 0,
            sheet: store.state.sheet?.type ?? null,
            files: document.querySelector(".files-tile:not(.leaving)") !== null,
            file: document.querySelector(".ft-view:not(.leaving) .ft-view-name")?.textContent ?? null,
        });
    `);

/** Wait until the app is where `expected` says, in the fields it names. */
async function reach(expected: Partial<Where>, what: string): Promise<void> {
    let last: Where | undefined;

    try {
        await until(async () => {
            last = await where();

            return Object.entries(expected).every(
                ([key, value]) => last![key as keyof Where] === value,
            );
        }, what);
    } catch {
        assert.fail(`${what}: the app is at ${JSON.stringify(last)}`);
    }
}

/** Back, as a phone's back gesture or button does it. */
const back = () => page.evaluate(`history.back()`);

const tap = async (selector: string) => {
    await until(
        async () =>
            (await inPage<boolean>(
                `return JSON.stringify(document.querySelector(${JSON.stringify(selector)}) !== null)`,
            )) === true,
        selector,
    );
    await page.evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
};

const row = (id: ConversationId) => `.home-list .session-row[data-id="${id}"] .session`;

/** Open the Files tile from the menu's tiles, where the top bar keeps it while it is closed. */
async function openFiles(): Promise<void> {
    await tap('.topbar [aria-label="Menu"]');
    await reach({ sheet: "menu" }, "the menu");
    await tap('.place[data-place="files"]');
}

/** The session list, freshly loaded at phone size with no panel open: each test starts from here. */
async function fresh(): Promise<void> {
    await page.setViewport(VIEWPORTS.mobile);
    await page.evaluate(`
        for (const key of Object.keys(sessionStorage)) {
            if (/^pocket\.(files|browser)/.test(key)) {
                sessionStorage.removeItem(key);
            }
        }
    `);
    await page.navigate(`${base}/`);
    await until(
        async () =>
            (await inPage<boolean>(
                `return JSON.stringify(document.querySelector(${JSON.stringify(row(first))}) !== null)`,
            )) === true,
        "the session list",
        20_000,
    );
}

/** Go to a session from inside the app, as a peek tile or a subagent's link does. */
const goTo = (id: ConversationId) =>
    page.evaluate(`(await import("/store.js")).navigate(${Number(id)})`);

before(async () => {
    if (chromium === undefined) {
        return;
    }

    writeFileSync(join(work, "README.md"), "# Hello\n\nA file to read.\n");
    writeFileSync(join(work, "web.env"), "PORT=3000\nHOST=127.0.0.1\n");
    app = await openApp(scriptedModel());
    server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    browsers = new Browsers({
        dataDir: mkdtempSync(join(root, "mobile-ui-")),
        load: async () => undefined,
        save: () => {},
    });
    first = await newSession(app);
    page = await browsers.open(1);
    await page.setViewport(VIEWPORTS.mobile);
    await page.navigate(`${base}/login?token=${encodeURIComponent(app.config.ownerToken)}`);
    await until(
        async () =>
            (await inPage<boolean>(
                `return JSON.stringify(document.querySelector(${JSON.stringify(row(first))}) !== null)`,
            )) === true,
        "the session list",
        20_000,
    );
});

after(async () => {
    await browsers?.closeAll({ final: true });
    server?.closeAllConnections();
    server?.close();
    await app?.close();
    cleanUp();
});

test("back closes the open file, then the Files tile, then leaves the session", real, async () => {
    await fresh();
    await tap(row(first));
    await reach({ path: `/s/${first}` }, "the session");
    await openFiles();
    await reach({ files: true, layers: 1 }, "the Files tile");
    await tap('.ft-row[data-path$="/README.md"]');
    await reach({ file: "README.md", layers: 2 }, "the file, over the tree");

    await back();
    await reach({ files: true, file: null, layers: 1 }, "back to the tree");
    await back();
    await reach({ files: false, layers: 0, path: `/s/${first}` }, "back to the conversation");
    await back();
    await reach({ path: "/" }, "back to the list");
});

// Issue #2: on a phone, Enter from the on-screen keyboard makes a new line; from a physical keyboard (Bluetooth) it sends,
// and Shift+Enter makes a new line. The on-screen keyboard's key events have no `code`; a physical keyboard's say "Enter".
test("on a phone, Enter from a physical keyboard sends, from the on-screen keyboard it makes a new line", real, async () => {
    await fresh();
    await tap(row(first));
    await reach({ path: `/s/${first}` }, "the session");
    await until(async () => await inPage<boolean>(`return JSON.stringify(document.querySelector(".composer textarea") !== null)`), "the message box");

    /** Type `text` into the message box, then press Enter as `code` and the modifiers say: whether the page took the key. */
    const enter = (text: string, code: string, shift = false, ctrl = false) =>
        inPage<{ coarse: boolean; taken: boolean; left: string }>(`
            const box = document.querySelector(".composer textarea");
            box.focus();
            box.value = ${JSON.stringify(text)};
            box.dispatchEvent(new Event("input", { bubbles: true }));
            box.setSelectionRange(box.value.length, box.value.length);
            await new Promise((resolve) => requestAnimationFrame(resolve));
            const taken = !box.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: ${JSON.stringify(code)}, shiftKey: ${shift}, ctrlKey: ${ctrl}, bubbles: true, cancelable: true }));
            await new Promise((resolve) => setTimeout(resolve, 300));
            return JSON.stringify({ coarse: matchMedia("(pointer: coarse)").matches, taken, left: document.querySelector(".composer textarea").value });
        `);

    const onScreen = await enter("from the on-screen keyboard", "");

    assert.equal(onScreen.coarse, true, "a touch screen");
    assert.equal(onScreen.taken, false, "the on-screen keyboard's Enter is left to make a new line");
    assert.equal(onScreen.left, "from the on-screen keyboard", "nothing sent");

    const shifted = await enter("two lines", "Enter", true);

    assert.equal(shifted.taken, false, "Shift+Enter on a physical keyboard makes a new line");
    assert.equal(shifted.left, "two lines", "nothing sent");

    const physical = await enter("sent from a Bluetooth keyboard", "Enter");

    assert.equal(physical.taken, true, "a physical keyboard's Enter sends");
    await until(
        async () => await inPage<boolean>(`return JSON.stringify(document.body.innerText.includes("sent from a Bluetooth keyboard") && document.querySelector(".composer textarea").value === "")`),
        "the message sent and the box emptied",
    );

    // In the app with a physical keyboard connected (it says so), whatever an input method does to its keys (Sogou: a
    // plain Enter with no code, Shift kept for itself): Enter sends; Ctrl+Enter makes a new line; Shift+Enter too.
    await page.evaluate(`window.PiPhoneApp = { hardKeyboard: () => true }`);

    try {
        const viaInputMethod = await enter("sent through Sogou", "");

        assert.equal(viaInputMethod.taken, true, "Enter with no code sends when a keyboard is connected");
        await until(
            async () => await inPage<boolean>(`return JSON.stringify(document.body.innerText.includes("sent through Sogou") && document.querySelector(".composer textarea").value === "")`),
            "the message through the input method sent",
        );

        const ctrl = await enter("line one", "Enter", false, true);

        assert.equal(ctrl.taken, true, "Ctrl+Enter is the page's");
        assert.equal(ctrl.left, "line one\n", "a new line, nothing sent");

        const shifted = await enter("line two", "", true);

        assert.equal(shifted.taken, false, "Shift+Enter is left to make a new line");
        assert.equal(shifted.left, "line two");
    } finally {
        await page.evaluate(`delete window.PiPhoneApp`);
    }
});

test("local Markdown file links use the viewer", real, async () => {
    const linked = await newSession(app);

    await say(
        app,
        linked,
        [
            "[web.env](web.env)",
            "[Website](https://example.com/web.env)",
            "[Unsafe](javascript:alert%281%29)",
            '<a href="https://example.com" data-path="web.env">Forged</a>',
        ].join("\n\n"),
    );
    await fresh();
    await goTo(linked);
    await reach({ path: `/s/${linked}` }, "the reply with file links");
    await until(
        async () =>
            (await inPage<boolean>(
                `return JSON.stringify(document.querySelector('.reply .md a[data-path="web.env"]') !== null)`,
            )) === true,
        "the rendered links",
    );
    const links = await inPage<
        Record<string, { path: string | null; target: string | null; href: string | null }>
    >(`
        return JSON.stringify(Object.fromEntries(
            [...document.querySelectorAll(".reply .md a")].map((link) => [link.textContent, {
                path: link.getAttribute("data-path"),
                target: link.getAttribute("target"),
                href: link.getAttribute("href"),
            }]),
        ));
    `);

    assert.equal(links["web.env"]?.path, "web.env");
    assert.equal(links["web.env"]?.target, null, "local links stay in the app");

    for (const label of ["Website", "Unsafe", "Forged"]) {
        assert.equal(links[label]?.path, null, `${label} stays outside the file viewer`);
    }

    assert.equal(links.Unsafe?.href, null, "unsafe schemes are still stripped");
    await page.evaluate(`document.querySelector('.reply .md a[data-path="web.env"]').focus()`);
    await page.press("Enter");
    await reach({ sheet: "file", layers: 1 }, "the file opened by keyboard");
    await until(
        async () =>
            (await inPage<boolean>(
                `return JSON.stringify(document.querySelector(".file-viewer")?.textContent.includes("PORT=3000") === true)`,
            )) === true,
        "the environment file contents",
    );
});

test(
    "on a phone, an invite lasts as long as chosen, and the one it replaces ends",
    real,
    async () => {
        const code = () =>
            inPage<string | null>(
                `return JSON.stringify(document.querySelector(".invite-code-value")?.textContent.replace(/\\s/g, "") ?? null)`,
            );
        const status = async (invite: string | null) =>
            (await fetch(`${base}/join/${invite}`)).status;

        await fresh();
        await page.evaluate(`(await import("/store.js")).openSheet({ type: "invite" })`);
        await until(async () => (await code()) !== null, "the first invite");
        const first = await code();

        await page.evaluate(
            `[...document.querySelectorAll(".sheet .segmented button")].find((each) => each.textContent.trim() === "1 week").click()`,
        );
        await until(async () => ![null, first].includes(await code()), "the week's invite");
        const week = await code();

        assert.equal(await status(week), 200);
        await until(async () => (await status(first)) === 410, "the 15 minutes' invite, ended");

        await tap('.sheet label.check input[type="checkbox"]');
        await until(async () => ![null, week].includes(await code()), "the owner's invite");
        await until(async () => (await status(week)) === 410, "the week's invite, ended");
        await tap('.sheet label.check input[type="checkbox"]');
        await until(async () => (await code()) !== null, "a guest's invite again");
        const steer = await code();

        // Not for a frame does the sheet show an invite made for other settings: View only shows no Steer invite.
        await page.evaluate(`
            window.frames = [];
            const watch = () => {
                const on = document.querySelector(".sheet .segmented .on")?.textContent.trim();
                const code = document.querySelector(".invite-code-value")?.textContent.replace(/\\s/g, "");

                window.frames.push([on, code ?? null]);

                if (window.frames.length < 60) {
                    requestAnimationFrame(watch);
                }
            };

            requestAnimationFrame(watch);
            [...document.querySelectorAll(".sheet .segmented button")].find((each) => each.textContent.trim() === "View only").click();
        `);
        await until(async () => ![null, steer].includes(await code()), "the view-only invite");
        const frames = await inPage<[string, string | null][]>(
            `return JSON.stringify(window.frames)`,
        );

        assert.ok(
            !frames.some(([on, shown]) => on === "View only" && shown === steer),
            "no frame shows the Steer invite under View only",
        );
        const viewOnly = await code();

        // New invite makes another and leaves the one before working; closing leaves the last one working.
        await tap(".sheet .button.wide:last-of-type");
        await until(async () => ![null, viewOnly].includes(await code()), "another invite");
        const another = await code();

        assert.equal(await status(viewOnly), 200, "the one before New invite still works");
        await back();
        await reach({ sheet: null, layers: 0 }, "closed");
        assert.equal(await status(another), 200, "the last one shown still works");
    },
);

test(
    "a streamed update draws only the answer's last block, and not the session list",
    real,
    async () => {
        await fresh();
        // Wide, where the sidebar's list shows beside the session: a phone in a session draws no list at all.
        await page.setViewport(VIEWPORTS.desktop);
        await goTo(first);
        await reach({ path: `/s/${first}` }, "the session");
        await until(
            async () =>
                (await inPage<boolean>(
                    `return JSON.stringify((await import("/store.js")).store.state.view.conversation?.id === ${Number(first)})`,
                )) === true,
            "its view",
        );
        const drawn = await inPage<{
            kept: boolean;
            text: string;
            quiet: number;
            same: number;
            listed: string[];
            image: string | null;
        }>(`
        const { h, options, render } = await import("preact");
        const { Markdown } = await import("/ui.js");
        const { store } = await import("/store.js");
        const settle = () => new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve)));
        const box = document.createElement("div");

        render(h(Markdown, { text: "First block.\\n\\n![x](a.png)\\n\\nSecond", cache: false }), box);
        const first = box.querySelector("p");

        render(h(Markdown, { text: "First block.\\n\\n![x](a.png)\\n\\nSecond, longer", cache: false }), box);
        let rows = [];
        const diffed = options.diffed;

        let quiet;
        let same;

        options.diffed = (vnode) => {
            if (vnode.type?.name === "SessionRow") {
                rows.push(vnode.props.session.title ?? "");
            }

            diffed?.(vnode);
        };

        try {
            store.set((state) => ({ view: { ...state.view } }));
            await settle();
            quiet = rows.length;
            // The same sessions in a new list: no row has anything new to show.
            store.set((state) => ({ sessions: [...state.sessions] }));
            await settle();
            same = rows.length - quiet;
            rows = [];
            // One session renamed: its row, and no other.
            store.set((state) => ({
                sessions: state.sessions.map((session) =>
                    session.id === ${Number(first)} ? { ...session, title: "Renamed here" } : session,
                ),
            }));
            await settle();
        } finally {
            options.diffed = diffed;
        }

        return JSON.stringify({ kept: box.querySelector("p") === first, text: box.textContent, quiet, same, listed: rows, image: box.querySelector("img")?.getAttribute("src") ?? null });
    `);

        assert.ok(drawn.kept, "the first block stays as it was drawn");
        assert.match(drawn.text, /Second, longer/, "the last block grows");
        // Relative in pi-phone, so it resolves under a shared space's <base> too (PP-54).
        assert.match(drawn.image ?? "", /^api\/c\/\d+\/file\?path=/, "an image path points at the server");
        assert.equal(drawn.quiet, 0, "a new view leaves the session list alone");
        assert.equal(drawn.same, 0, "the same sessions again draw no row");
        assert.deepEqual(drawn.listed, ["Renamed here"], "a changed session draws its row alone");
    },
);

// From pi-pocket 0.21.0 (#138, by nohj), adapted to pi-phone (PP-133): Back to the list draws only what changed.
test("a reconnect that brings the same data keeps it, and draws no session row", real, async () => {
    await fresh();

    const after = await inPage<{ same: string[]; rows: number }>(`
        const { options } = await import("preact");
        const { connect, store } = await import("/store.js");
        const settle = () => new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve)));
        // Not users: the server tells everyone when this person was last here, which a reconnect changes.
        const keys = ["me", "models", "guard", "server", "themeList", "folderFavorites", "former", "sessionGroups", "sessions", "moving"];
        const before = Object.fromEntries(keys.map((key) => [key, store.state[key]]));
        const stream = store.state.streamId;
        const Source = window.EventSource;
        let rows = 0;
        let received;
        const listed = new Promise((resolve) => (received = resolve));
        const diffed = options.diffed;

        options.diffed = (vnode) => {
            rows += vnode.type?.name === "SessionRow" ? 1 : 0;
            diffed?.(vnode);
        };
        // The reconnect's own list must arrive before identity and draws are checked.
        window.EventSource = class extends Source {
            constructor(url) {
                super(url);
                this.addEventListener("sessions", received, { once: true });
            }
        };

        try {
            connect();
            await listed;
            await settle();
        } finally {
            window.EventSource = Source;
            options.diffed = diffed;
        }

        if (store.state.streamId === stream) {
            throw new Error("the reconnect did not receive a new stream");
        }

        return JSON.stringify({ same: keys.filter((key) => store.state[key] !== before[key]), rows });
    `);

    assert.deepEqual(after.same, [], "every equal value keeps its identity");
    assert.equal(after.rows, 0, "no session row draws again");
});

test("back to the list slides it in whole, and its rows do not rise in again", real, async () => {
    await fresh();
    await tap(row(first));
    await reach({ path: `/s/${first}` }, "the session");
    await page.evaluate(`
        window.listRoutes = [];
        window.listRouteObserver = new MutationObserver((records) => {
            window.listRoutes.push(...records.flatMap((record) =>
                [record.target.dataset.route, record.oldValue]));
        });
        window.listRouteObserver.observe(document.documentElement, {
            attributes: true, subtree: true, attributeFilter: ["data-route"], attributeOldValue: true,
        });
    `);
    await back();
    await reach({ path: "/" }, "back to the list");

    const shown = await inPage<{ rows: number; animating: number; slide: boolean }>(`
        await new Promise((resolve) => requestAnimationFrame(resolve));
        const rows = [...document.querySelectorAll(".home-list .session-row")];

        window.listRouteObserver.disconnect();

        return JSON.stringify({
            rows: rows.length,
            animating: rows.filter((each) => each.classList.contains("arriving") || each.getAnimations().length).length,
            slide: window.listRoutes.includes("back"),
        });
    `);

    assert.ok(shown.rows > 0, "the list shows its rows");
    assert.equal(shown.animating, 0, "no row rises in again");
    assert.ok(shown.slide, "the list slides in from the left");
});

test("a phone draws no sidebar, no splash, and no row buttons it would hide", real, async () => {
    await fresh();
    const phone = await inPage<Record<string, number>>(`
        return JSON.stringify({
            width: innerWidth,
            sidebarLists: document.querySelectorAll(".sidebar .sessions, .sidebar .rail").length,
            homeLists: document.querySelectorAll(".home-list .sessions").length,
            splash: document.querySelectorAll(".splash").length,
            rowButtons: document.querySelectorAll(".session-actions").length,
        });
    `);

    assert.deepEqual(phone, {
        width: 390,
        sidebarLists: 0,
        homeLists: 1,
        splash: 0,
        rowButtons: 0,
    });

    // Widened, the sidebar and the splash come back at once.
    await page.setViewport(VIEWPORTS.desktop);
    await until(
        () =>
            inPage<boolean>(`
                return JSON.stringify(document.querySelector(".sidebar .sessions") !== null &&
                    document.querySelector(".splash") !== null);
            `),
        "the sidebar's list and the splash, on a wide screen",
    );
});

test("replayed data keeps equal items but applies changed facts and a fresh clock", real, async () => {
    await fresh();
    const result = await inPage<Record<string, boolean>>(`
        const { connect, serverClockOffset, store } = await import("/store.js");
        const Source = window.EventSource;
        let source;

        window.EventSource = class extends EventTarget {
            constructor() { super(); source = this; }
            close() {}
        };
        connect();
        const send = (name, data) => source.dispatchEvent(new MessageEvent(name, {
            data: JSON.stringify(data),
        }));
        const before = store.state;
        let changes = 0;
        const stop = store.subscribe(() => changes++);
        const hello = {
            user: before.me, users: before.users, models: before.models, guard: before.guard,
            server: { ...before.server, now: Date.now() + 120_000 },
            themes: before.themeList, folderFavorites: before.folderFavorites,
            former: before.former, sessionGroups: before.sessionGroups,
        };
        let result;

        try {
            send("hello", hello);
            send("sessions", before.sessions);
            send("users", before.users);
            const equalIsQuiet = changes === 0;
            const clockIsFresh = Math.abs(serverClockOffset() - 120_000) < 1000;
            const serverIsKept = store.state.server === before.server;
            const changed = before.sessions.map((session) => session.id === ${Number(first)}
                ? { ...session, title: "A changed server title" } : session).reverse();

            send("sessions", changed);
            const list = store.state.sessions;
            const changedSession = list.find((session) => session.id === ${Number(first)});
            const changedIsNew = changedSession !== before.sessions.find((session) => session.id === ${Number(first)}) &&
                changedSession.title === "A changed server title";
            const othersAreKept = list.filter((session) => session.id !== ${Number(first)})
                .every((session) => before.sessions.includes(session));
            const orderIsNew = list.every((session, index) => session.id === changed[index].id);
            const count = changes;

            send("sessions", changed);
            const replayIsQuiet = store.state.sessions === list && changes === count;

            send("hello", { ...hello, user: { ...hello.user, name: "A changed person" },
                server: { ...hello.server, home: "/a/changed/home" } });
            result = {
                equalIsQuiet, clockIsFresh, serverIsKept, changedIsNew, othersAreKept, orderIsNew, replayIsQuiet,
                factsAreFresh: store.state.me.name === "A changed person" &&
                    store.state.server.home === "/a/changed/home",
            };
        } finally {
            stop();
            window.EventSource = Source;
            connect();
        }

        return JSON.stringify(result);
    `);

    assert.deepEqual(
        Object.entries(result).filter(([, passed]) => !passed),
        [],
        "equal events are quiet, but changed values, order, and the clock still update",
    );
});

test("the session list reads only the store keys it declares", real, async () => {
    await fresh();
    const reads = await inPage<Record<string, { observed: string[]; declared: string[] }>>(`
        const { h, options, render } = await import("preact");
        const { SessionList } = await import("/sessions.js");
        const { store } = await import("/store.js");
        const state = store.state;
        const result = {};
        const box = document.createElement("div");
        const diffed = options.diffed;
        const features = { ...state, server: { ...state.server, collab: 2 } };

        document.body.append(box);

        try {
            // This observes these branches, not every possible interaction state.
            for (const [name, props, data] of [
                ["list", {}, state],
                ["list-features", { compact: true }, features],
            ]) {
                const keys = new Set();
                let declared = [];

                options.diffed = (vnode) => {
                    if (vnode.type?.name === "DrawnFor") {
                        declared = [...vnode.props.keys];
                    }
                    diffed?.(vnode);
                };
                store.state = new Proxy(data, { get(target, key) {
                    if (typeof key === "string") { keys.add(key); }
                    return target[key];
                } });
                render(h(SessionList, props), box);
                result[name] = { observed: [...keys].sort(), declared };
                store.state = state;
                render(null, box);
            }
        } finally {
            options.diffed = diffed;
            store.state = state;
            render(null, box);
            box.remove();
        }

        return JSON.stringify(result);
    `);

    assert.equal(Object.keys(reads).length, 2, "all audit cases ran");

    for (const [name, { observed, declared }] of Object.entries(reads)) {
        assert.ok(declared.length > 0, "the audit captured the wrapper's actual dependencies");
        assert.deepEqual(
            observed.filter((key) => !declared.includes(key)),
            [],
            `${name} must invalidate every store key it reads`,
        );
        assert.ok(observed.includes("sessions"), "the audit observed a real draw");
    }
});
