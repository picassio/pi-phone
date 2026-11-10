// Skills & commands (PP-467) in a real browser at 390, 1280 and 1920 px: the Menu's rows; the session menu's sheet, a
// switch per library item with "From board" and "Every session" as states; a library command in the composer fills the
// message box (/library-command) and sends nothing; the page's tabs, list, detail (pins, editor, versions, Undo, the
// Delete card), New skill and Keep on the rail; and the board settings' pins. Nothing runs past the screen, and every
// must-fix kind of the layout check is zero in what this change draws. With PHONE_SHOTS, screenshots and the layout
// check's reports go there. Each test starts from the same pins, and a pin switch waits for its answer before it takes
// another tap (PP-478).
import { type App, cleanUp, cleanUpAll, modelTexts, newSession, openApp, owner, root, scriptedModel } from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { ConversationId } from "@earendil-works/pi-durable";
import { createHandler } from "../src/server/http.ts";
import { describeLayout, layoutCheck, parseLayout } from "../src/server/layout-check.ts";
import { Projects } from "../src/server/projects.ts";
import { Browsers } from "./support/browser.ts";
import { findBrowser } from "./support/browser/discovery.ts";
import type { BrowserPage } from "./support/browser/page.ts";
import { VIEWPORTS } from "./support/browser/viewport.ts";

const real = { skip: findBrowser() === undefined ? "no Chromium-based browser on this machine" : false } as const;
const SHOTS = process.env.PHONE_SHOTS;
const LARGE = { width: 1920, height: 1080, scale: 1, mobile: false };
const MUST_FIX = ["cut", "covered", "contrast", "small-text", "emoji", "small-target"];

let app: App;
let server: Server;
let browsers: Browsers;
let page: BrowserPage;
let base = "";
let id: ConversationId;
/** While set, the server holds back its answers to PUTs on the library (pins) here, until the test lets them go. */
let held: (() => void)[] | undefined;

const skillMd = (name: string, description: string) => `---\nname: ${name}\ndescription: ${JSON.stringify(description)}\n---\n\nThe steps of ${name}.\n`;

before(async () => {
    if (real.skip) {
        return;
    }

    app = await openApp(scriptedModel());
    const handler = createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} });

    server = createServer((request, response) => {
        const answers = held;

        if (answers !== undefined && request.method === "PUT" && /\/library\b/.test(request.url ?? "")) {
            const end = response.end.bind(response);

            response.end = ((...args: Parameters<typeof end>) => {
                answers.push(() => end(...args));

                return response;
            }) as typeof response.end;
        }

        void handler(request, response);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

    const me = owner(app);

    // Boards: the Projects extension, off in tests unless turned on.
    await app.setExtensionEnabled(me, "projects.ts", true);
    await until(() => app.loader.extensionNames().includes("pocket-projects"), "the projects extension");
    id = await newSession(app);
    app.librarySave(me, "skill", "ssp-notes", { files: { "SKILL.md": skillMd("ssp-notes", "How to write notes for an SSP task: what changed, why, and what to check next.") } }, "made");
    app.librarySave(me, "skill", "board-rules", { files: { "SKILL.md": skillMd("board-rules", "The SSP board's rules for tasks and reviews.") } }, "made");
    app.librarySave(me, "skill", "house-style", { files: { "SKILL.md": skillMd("house-style", "How we write: short, plain, no filler.") } }, "made");
    app.librarySave(me, "command", "ssp-review", { content: "---\ndescription: Review an SSP task.\nargument-hint: <task> [focus]\n---\nReview task $1 for $ARGUMENTS.\n" }, "made");

    const boards = new Projects(app.dataDir, () => app.config.users.map((user) => ({ id: user.id, name: user.name, role: user.role })));
    const actor = { kind: "person" as const, person: { id: me.id, name: me.name, role: me.role } };

    boards.create(actor, { key: "SSP", name: "SSP work" });
    boards.setBoardMode(actor, String(id), true, "SSP");
    boards.close();
    cleanPins(false);

    browsers = new Browsers({ dataDir: mkdtempSync(join(root, "library-ui-")), load: async () => undefined, save: () => {} });
    page = await browsers.open(1);
    await page.setViewport(VIEWPORTS.mobile);
    await page.navigate(`${base}/login?token=${encodeURIComponent(app.config.ownerToken)}`);
});

after(() =>
    cleanUpAll(
        () => browsers?.closeAll({ final: true }),
        () => server?.closeAllConnections(),
        () => server?.close(),
        () => app?.close(),
        () => cleanUp(),
    ),
);

/**
 * The pins each test starts from (PP-478): board-rules on the board SSP, house-style in every session, and with
 * `reviewHere` /ssp-review in the test's session (what the session sheet's test pins), nothing else. A test that stopped
 * half-way (a pin left on, or one not made) cannot change what the next tests read.
 */
function cleanPins(reviewHere: boolean) {
    const me = owner(app);

    for (const item of app.library.list()) {
        for (const pin of item.pins) {
            app.librarySetPin(me, item.kind, item.name, pin.scope, pin.target, false);
        }
    }

    app.librarySetPin(me, "skill", "board-rules", "board", "SSP", true);
    app.librarySetPin(me, "skill", "house-style", "all", undefined, true);

    if (reviewHere) {
        app.librarySetPin(me, "command", "ssp-review", "session", String(id), true);
    }
}

async function until(check: () => Promise<boolean> | boolean, what: string, timeoutMs = 20_000): Promise<void> {
    const started = Date.now();

    while (!(await check())) {
        if (Date.now() - started > timeoutMs) {
            throw new Error(`Timed out waiting for ${what}`);
        }

        await new Promise((resolve) => setTimeout(resolve, 50));
    }
}

const inPage = async <T>(script: string): Promise<T> => JSON.parse(await page.evaluate(script)) as T;
/** Wait for `selector`; a timeout says what the page shows instead. */
const present = (selector: string, what: string) =>
    until(() => inPage<boolean>(`return JSON.stringify(document.querySelector(${JSON.stringify(selector)}) !== null)`), what).catch(async (error: Error) => {
        throw new Error(`${error.message}; the page at ${await inPage<string>("return JSON.stringify(location.href)")} shows: ${(await inPage<string>("return JSON.stringify(document.body.innerText)")).slice(0, 400)}`);
    });
const textOf = (selector: string) => inPage<string>(`return JSON.stringify((document.querySelector(${JSON.stringify(selector)})?.innerText ?? "").trim().replace(/\\s+/g, " "))`);
const click = (selector: string) => page.evaluate(`document.querySelector(${JSON.stringify(selector)}).click(); return "true";`);

/** The layout check's report now; with PHONE_SHOTS, a picture and the report saved too. */
async function measure(name: string, width: number) {
    // A passing notice ("Saved as version 2.") floats over the page by design: measured without it.
    await page.evaluate(`(await import("/store.js")).store.set({ notices: [] }); return "true";`);
    await new Promise((resolve) => setTimeout(resolve, 600));
    const report = parseLayout(JSON.parse(await page.evaluate(`return JSON.stringify(${layoutCheck(width)})`)), width);

    assert.ok(report !== undefined, "the layout check answered");

    if (SHOTS !== undefined) {
        mkdirSync(SHOTS, { recursive: true });
        writeFileSync(join(SHOTS, `${name}.jpg`), Buffer.from((await page.screenshot()).data, "base64"));
        writeFileSync(join(SHOTS, `${name}.layout.txt`), `${describeLayout(report)}\nRAW ${JSON.stringify(report.found)}\n`);
    }

    return report;
}

/**
 * The must-fix findings whose element is in `scope` (what this change draws), not the app around it. A muted hint
 * (`.muted`) at 3:1 or more is the app's hint colour, which ui-verify lets stay when the report names it: not counted.
 */
async function mustFix(report: Awaited<ReturnType<typeof measure>>, scope: string) {
    const kinds = report.found.filter(
        (each) => MUST_FIX.includes(each.kind) && !(each.kind === "contrast" && /^[a-z0-9]+\.muted\b/.test(each.what) && Number((each as { ratio?: number }).ratio) >= 3),
    );
    const inside = await inPage<boolean[]>(
        `return JSON.stringify(${JSON.stringify(kinds.map((each) => each.what.split(" ")[0]))}.map((selector) => { try { return document.querySelector(${JSON.stringify(scope)}).querySelector(selector) !== null; } catch { return true; } }))`,
    );

    return kinds.filter((_, index) => inside[index]);
}

const switchState = (selector: string) =>
    inPage<{ on: string; disabled: boolean }>(
        `const each = document.querySelector(${JSON.stringify(selector)}); return JSON.stringify({ on: each.getAttribute("aria-checked"), disabled: each.disabled });`,
    );

/**
 * Taps a pin switch with the server's answer held back (PP-478): the server has the change before the page has its
 * answer, as under load. The switch waits for the answer, so a second tap cannot send the state the page still shows;
 * then the answer goes, and the page shows the switch flipped and ready, as a person sees it before tapping again.
 */
async function toggleHeld(selector: string, changed: () => boolean, what: string) {
    const answers: (() => void)[] = [];
    const was = (await switchState(selector)).on;

    held = answers;

    try {
        await click(selector);
        await until(() => answers.length === 1, `the answer to ${what}`);
        assert.ok(changed(), what);
        assert.deepEqual(await switchState(selector), { on: was, disabled: true }, "the switch waits for the answer");
        await click(selector);
        await new Promise((resolve) => setTimeout(resolve, 300));
        assert.equal(answers.length, 1, "a tap while the answer is on its way sends nothing");
    } finally {
        held = undefined;

        for (const release of answers) {
            release();
        }
    }

    const now = was === "true" ? "false" : "true";

    await until(async () => (await switchState(selector)).on === now && !(await switchState(selector)).disabled, `the switch ${now === "true" ? "on" : "off"} and ready`);
}

const menuRow = (start: string) =>
    inPage<string[]>(`return JSON.stringify([...document.querySelectorAll(".sheet .list-item")].map((each) => each.innerText.trim().replace(/\\s+/g, " ")).filter((text) => text.startsWith(${JSON.stringify(start)})))`);

for (const [viewport, label] of [[VIEWPORTS.mobile, "390"], [VIEWPORTS.desktop, "1280"], [LARGE, "1920"]] as const) {
    test(`at ${label} px: the menus, the session's sheet, and a library command filling the message box (PP-467)`, real, async () => {
        cleanPins(false);
        await page.setViewport(viewport);
        await page.navigate(`${base}/s/${id}`);
        await present(".composer textarea", "the session");
        await page.evaluate(`(await import("/store.js")).openSheet({ type: "menu" }); return "true";`);
        await present(".sheet .list-item", "the menu");
        assert.deepEqual(await mustFix(await measure(`menu-${label}`, viewport.width), ".sheet"), []);
        // Two rows: the session's (pin to it) and the App's (the page).
        assert.deepEqual(await menuRow("Skills & commands"), ["Skills & commands pin your own to this session", "Skills & commands your own, pinned where you want them"]);

        await page.evaluate(`[...document.querySelectorAll(".sheet .list-item")].find((each) => each.innerText.includes("pin your own to this session")).click(); return "true";`);
        await present('[data-part="library-session-item"]', "the session's skills and commands");

        const rows = await inPage<{ name: string; text: string; on: string }[]>(`return JSON.stringify([...document.querySelectorAll('[data-part="library-session-item"]')].map((each) => ({
            name: each.dataset.name,
            text: each.innerText.trim().replace(/\\s+/g, " "),
            on: each.querySelector('[role="switch"]').getAttribute("aria-checked"),
        })))`);

        const named = (name: string) => rows.find((row) => row.name === name)!;

        assert.deepEqual(rows.map((row) => row.name).filter((name) => !name.startsWith("made-")), ["board-rules", "house-style", "ssp-notes", "ssp-review"]);
        assert.match(named("board-rules").text, /^board-rules From board SSP The SSP board's rules/);
        assert.match(named("house-style").text, /^house-style Every session How we write/);
        assert.match(named("ssp-review").text, /^\/ssp-review Review an SSP task\./);
        assert.deepEqual(await mustFix(await measure(`session-sheet-${label}`, viewport.width), ".sheet"), []);

        // The switch pins /ssp-review to this session.
        assert.equal(named("ssp-review").on, "false");
        await click('[data-name="ssp-review"] [role="switch"]');
        await until(() => app.libraryPinned(id).some((item) => item.name === "ssp-review" && item.pin.scope === "session"), "the pin");
        await until(async () => (await switchState('[data-name="ssp-review"] [role="switch"]')).on === "true", "the switch on");

        await page.evaluate(`(await import("/store.js")).closeSheet(); return "true";`);
        await until(async () => !(await inPage<boolean>(`return JSON.stringify(document.querySelector(".sheet") !== null)`)), "the sheet closed");

        // A library command in the box: Send fills the box with its template, and sends nothing.
        const sent = (await modelTexts(app, id)).length;

        await page.type({ selector: ".composer textarea" }, "/ssp-review PP-12 the pins");
        await present(".command-hint", "the command's hint");
        assert.match(await textOf(".command-hint"), /\/ssp-review <task> \[focus\] · your command · Enter fills the message box/);
        await click('[data-part="send-button"]');
        await until(async () => (await inPage<string>(`return JSON.stringify(document.querySelector(".composer textarea").value)`)) === "Review task PP-12 for PP-12 the pins.", "the box filled");
        assert.equal((await modelTexts(app, id)).length, sent, "nothing was sent");
        await page.evaluate(`const box = document.querySelector(".composer textarea"); box.value = ""; box.dispatchEvent(new Event("input", { bubbles: true })); return "true";`);
    });

    test(`at ${label} px: Skills & commands: tabs, list, an item's pins, editor, versions, Delete card, New skill, Keep on the rail (PP-467)`, real, async () => {
        const me = owner(app);

        cleanPins(true);
        await page.setViewport(viewport);
        await page.navigate(`${base}/?page=library:skills`);
        await present('[data-part="library-item"]', "the list");

        const list = await inPage<string[]>(`return JSON.stringify([...document.querySelectorAll('[data-part="library-item"]')].map((each) => each.innerText.trim().replace(/\\s+/g, " ")))`);

        assert.match(list[0]!, /^board-rules The SSP board's rules for tasks and reviews\. board SSP 1 version$/);
        assert.match(list[1]!, /^house-style How we write: short, plain, no filler\. Every session 1 version$/);
        assert.equal(await textOf('[data-part="library-tab"][data-tab="skills"]'), `Skills · ${list.length}`);
        assert.deepEqual(await mustFix(await measure(`library-list-${label}`, viewport.width), ".lib-page"), []);

        // Search narrows the list.
        await page.type({ selector: ".lib-tools input" }, "notes");
        await until(async () => (await inPage<number>(`return JSON.stringify(document.querySelectorAll('[data-part="library-item"]').length)`)) === 1, "one match");
        await page.evaluate(`const box = document.querySelector(".lib-tools input"); box.value = ""; box.dispatchEvent(new Event("input", { bubbles: true })); return "true";`);

        // An item: its pins, its editor, its versions.
        await click('[data-part="library-item"][data-name="ssp-notes"]');
        await present('[data-part="library-text"]', "the editor");
        await present('[data-part="library-version"]', "the versions");
        assert.match(await textOf(".lib-detail-head"), /^ssp-notes Version \d+ of \d+/);
        assert.deepEqual(await mustFix(await measure(`library-detail-${label}`, viewport.width), ".lib-page"), []);

        // Every session, on and off again.
        await toggleHeld('.lib-every [role="switch"]', () => app.library.item("skill", "ssp-notes").pins.some((pin) => pin.scope === "all"), "pinned to every session");
        await click('.lib-every [role="switch"]');
        await until(() => !app.library.item("skill", "ssp-notes").pins.some((pin) => pin.scope === "all"), "unpinned");

        // Edit and save: a new version; Undo goes back.
        const was = app.library.item("skill", "ssp-notes").version;

        await page.evaluate(`const box = document.querySelector('[data-part="library-text"]'); box.value = box.value + "\\nOne more step.\\n"; box.dispatchEvent(new Event("input", { bubbles: true })); return "true";`);
        await click('[data-part="library-save"]');
        await until(() => app.library.item("skill", "ssp-notes").version > was, "a new version");
        assert.match(app.library.files("skill", "ssp-notes")["SKILL.md"]!, /One more step\./);
        await until(async () => (await inPage<boolean>(`return JSON.stringify(document.querySelector('[data-part="library-undo"]')?.disabled === false)`)), "Undo on");
        await click('[data-part="library-undo"]');
        await until(() => app.library.item("skill", "ssp-notes").version < app.library.versions("skill", "ssp-notes")[0]!.n, "back one version");

        // Delete asks on a card; Keep it leaves it.
        await click('[data-part="library-delete"]');
        await present('[data-part="library-delete-card"]', "the Delete card");
        assert.match(await textOf('[data-part="library-delete-card"]'), /^Delete ssp-notes\? Its versions and pins go too\./);
        assert.deepEqual(await mustFix(await measure(`library-delete-${label}`, viewport.width), ".lib-page"), []);
        await page.evaluate(`[...document.querySelectorAll('[data-part="library-delete-card"] button')].find((each) => each.innerText.trim() === "Keep it").click(); return "true";`);
        assert.ok(app.library.list().some((item) => item.name === "ssp-notes"));

        // New skill: made as version 1.
        await page.navigate(`${base}/?page=library:skills`);
        await present('[data-part="library-new-button"]', "New skill");
        await click('[data-part="library-new-button"]');
        await present('[data-part="library-new"]', "the form");
        assert.deepEqual(await mustFix(await measure(`library-new-${label}`, viewport.width), ".lib-page"), []);
        await page.type({ selector: '[data-part="library-new"] input' }, `made-${label}`);
        await page.type({ selector: '[data-part="library-new"] label:nth-of-type(2) input' }, "A skill made on the page.");
        await page.type({ selector: '[data-part="library-new"] textarea' }, "Do the thing.");
        await click('[data-part="library-make"]');
        await until(() => app.library.list().some((item) => item.name === `made-${label}`), "the new skill");
        assert.match(app.library.files("skill", `made-${label}`)["SKILL.md"]!, /^---\nname: made-\d+\ndescription: "A skill made on the page\."\n---\n\nDo the thing\.\n$/);

        // Commands tab: the list once the tab has closed the form (on a phone the form hides it, and a hidden row reads
        // without spaces).
        await click('[data-part="library-tab"][data-tab="commands"]');
        await present('.lib-layout:not(.open) [data-part="library-item"][data-name="ssp-review"]', "the commands");
        assert.match(await textOf('[data-part="library-item"][data-name="ssp-review"]'), /^\/ssp-review Review an SSP task\. 1 session 1 version$/);
        assert.deepEqual(await mustFix(await measure(`library-commands-${label}`, viewport.width), ".lib-page"), []);

        // Keep on the rail: the owner's setting, and a rail button on a wide screen.
        if (app.config.userById(me.id)?.libraryOnRail !== true) {
            await click('[data-part="library-keep"]');
            await until(() => app.config.userById(me.id)?.libraryOnRail === true, "kept on the rail");
        }

        if (label !== "390") {
            await present('[data-rail="library"]', "the rail button");
        }
    });

    test(`at ${label} px: a board's settings pin library items to it (PP-467)`, real, async () => {
        cleanPins(true);
        await page.setViewport(viewport);
        await page.navigate(`${base}/`);
        // The project's settings, once the Projects extension has loaded (its sheet by name, with the board's key).
        await until(
            async () =>
                (await inPage<boolean>(
                    `const store = await import("/store.js"); if (!document.querySelector(".sheet")) { store.openSheet({ type: "ext", module: "projects", sheetId: "project", id: "projects:project", props: { project: "SSP" } }); } return JSON.stringify(document.querySelector('[data-part="board-library-item"]') !== null);`,
                )) === true,
            "the board's pins",
            60_000,
        ).catch(async (error: Error) => {
            throw new Error(`${error.message}; the page shows: ${(await inPage<string>("return JSON.stringify(document.body.innerText)")).slice(0, 600)}`);
        });

        const items = await inPage<{ name: string; on: string; text: string }[]>(`return JSON.stringify([...document.querySelectorAll('[data-part="board-library-item"]')].map((each) => ({
            name: each.dataset.name,
            on: each.querySelector('[role="switch"]').getAttribute("aria-checked"),
            text: each.innerText.trim().replace(/\\s+/g, " "),
        })))`);

        assert.deepEqual(items.find((item) => item.name === "board-rules")?.on, "true");
        assert.match(items.find((item) => item.name === "board-rules")!.text, /^board-rules On this board The SSP board's rules/);
        await page.evaluate(`document.querySelector('[data-part="board-library"]').scrollIntoView(); return "true";`);
        assert.deepEqual(await mustFix(await measure(`board-${label}`, viewport.width), '[data-part="board-library"]'), []);

        const pinned = () => app.library.item("command", "ssp-review").pins.some((pin) => pin.scope === "board" && pin.target === "SSP");
        const was = pinned();

        await toggleHeld('[data-part="board-library-item"][data-name="ssp-review"] [role="switch"]', () => pinned() !== was, "the board pin changed");
        await click('[data-part="board-library-item"][data-name="ssp-review"] [role="switch"]');
        await until(() => pinned() === was, "and back");
    });
}
