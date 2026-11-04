import { type App, cleanUp, cleanUpAll, newSession, openApp, owner, root, scriptedModel, until } from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { ConversationId } from "@earendil-works/pi-durable";
import { Browsers } from "./support/browser.ts";
import { findBrowser } from "./support/browser/discovery.ts";
import type { BrowserPage } from "./support/browser/page.ts";
import { type Viewport, VIEWPORTS } from "./support/browser/viewport.ts";
import { createHandler } from "../src/server/http.ts";

const chromium = findBrowser();
const real = {
    skip: chromium === undefined ? "no Chromium-based browser on this machine" : false,
} as const;
const BOX = ".composer textarea";
// With PHONE_SHOTS set to a folder, screenshots at 390 and 1280 px go there.
const SHOTS = process.env.PHONE_SHOTS;
let app: App;
let server: Server;
let browsers: Browsers;
let page: BrowserPage;
let base = "";
let one: ConversationId;
let two: ConversationId;

async function inPage<T>(script: string): Promise<T> {
    return JSON.parse(await page.evaluate(script)) as T;
}

async function shot(name: string): Promise<void> {
    if (SHOTS === undefined) {
        return;
    }

    mkdirSync(SHOTS, { recursive: true });
    await new Promise((resolve) => setTimeout(resolve, 400));
    writeFileSync(join(SHOTS, `${name}.jpg`), Buffer.from((await page.screenshot()).data, "base64"));
}

const boxFocused = () =>
    inPage<boolean>(
        `return JSON.stringify(document.activeElement?.matches(${JSON.stringify(BOX)}) ?? false)`,
    );

/** The session `id` open with its message box, a few frames on: by then the box has the focus if it takes it. */
async function opened(id: ConversationId): Promise<void> {
    await until(
        async () =>
            await inPage<boolean>(`
                const { store } = await import("/store.js");

                return JSON.stringify(
                    location.pathname === "/s/${Number(id)}" &&
                        store.state.view.conversation?.id === ${Number(id)} &&
                        document.querySelector(${JSON.stringify(BOX)}) !== null,
                );
            `),
        `session ${id} open`,
    );
    await page.evaluate(`
        for (let frame = 0; frame < 6; frame++) {
            await new Promise((resolve) => requestAnimationFrame(resolve));
        }
    `);
}

/** The session list, loaded afresh at `viewport`. */
async function home(viewport: Viewport): Promise<void> {
    await page.setViewport(viewport);
    await page.navigate(`${base}/`);
    await until(
        async () =>
            await inPage<boolean>(
                `return JSON.stringify(document.querySelector('.session-row[data-id="${Number(one)}"]') !== null)`,
            ),
        "the session list",
        20_000,
    );
}

before(async () => {
    if (chromium === undefined) {
        return;
    }

    app = await openApp(scriptedModel());
    one = await newSession(app);
    two = await newSession(app);
    const handler = createHandler({
        app,
        listen: { host: "127.0.0.1", port: 0 },
        restart: () => {},
    });

    server = createServer((request, response) => {
        void handler(request, response);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    browsers = new Browsers({
        dataDir: mkdtempSync(join(root, "composer-focus-ui-")),
        load: async () => undefined,
        save: () => {},
        // A mouse, whatever this machine has; the phone size's touch emulation still makes it a touch screen.
        args: [
            "--blink-settings=primaryHoverType=2,availableHoverTypes=2,primaryPointerType=4,availablePointerTypes=4",
        ],
    });
    page = await browsers.open(1);
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

// Issue #83, reported by @vitalNohj: Enter after a click on Plan pressed it again, and plan mode went back off.
test("a click on Plan leaves the focus in the message box", real, async () => {
    await home(VIEWPORTS.desktop);
    await page.click({ selector: `.sidebar .session-row[data-id="${Number(one)}"] > .session` });
    await opened(one);
    await until(boxFocused, "the box");
    await page.click({ selector: ".composer .plan-chip" });
    await until(
        async () =>
            await inPage<boolean>(
                `return JSON.stringify((await import("/store.js")).store.state.view.plan?.on === true)`,
            ),
        "plan mode on",
    );
    assert.equal(await boxFocused(), true, "Enter goes on to send, not to the chip");
});

test(
    "recall uses this session for arrows and search, and Down restores the draft",
    real,
    async () => {
        await home(VIEWPORTS.desktop);

        for (const [id, text] of [
            [one, "recall A marker"],
            [two, "recall B marker"],
        ] as const) {
            await page.navigate(`${base}/s/${Number(id)}`);
            await opened(id);
            await page.type({ selector: BOX }, text);
            await page.press("Enter");
            await until(
                () =>
                    inPage<boolean>(
                        `return JSON.stringify(document.querySelector('${BOX}').value === '')`,
                    ),
                "message sent",
            );
        }

        await page.navigate(`${base}/s/${Number(one)}`);
        await opened(one);
        await page.type({ selector: BOX }, "draft");
        await page.press("Home");
        await page.press("ArrowUp");
        const value = () =>
            inPage<string>(`return JSON.stringify(document.querySelector('${BOX}').value)`);

        assert.equal(await value(), "recall A marker");
        await page.press("ArrowDown");
        assert.equal(await value(), "draft");
        await page.type({ selector: BOX }, "recall");
        await page.press("Control+R");
        await until(
            () =>
                inPage<boolean>(
                    `return JSON.stringify(document.querySelector('.history-options') !== null)`,
                ),
            "recall search open",
        );
        assert.deepEqual(
            await inPage<string[]>(
                `return JSON.stringify([...document.querySelectorAll('.history-options [role="option"]')].map(each => each.textContent.trim()))`,
            ),
            ["recall A marker"],
        );
        await page.press("Escape");
    },
);

/** Pretend Pi works in the open session, or stops: the composer reads `view.live.busy`. */
const setBusy = (busy: boolean) =>
    page.evaluate(`
        const { store } = await import("/store.js");
        store.set((state) => ({ view: { ...state.view, live: { ...state.view.live, busy: ${busy} } } }));
        for (let frame = 0; frame < 3; frame++) {
            await new Promise((resolve) => requestAnimationFrame(resolve));
        }
    `);
const modes = () =>
    inPage<Record<string, string | null>>(`
        return JSON.stringify(Object.fromEntries([...document.querySelectorAll(".mode-switch [role=radio]")]
            .map((each) => [each.textContent.trim(), each.getAttribute("aria-checked")])));
    `);

test("an Interrupt chosen but not used does not stay armed for the next run", real, async () => {
    await home(VIEWPORTS.desktop);
    await page.navigate(`${base}/s/${Number(one)}`);
    await opened(one);
    await setBusy(true);
    await page.click({ selector: ".mode-switch .interrupt" });
    assert.equal((await modes()).Interrupt, "true");
    await setBusy(false);
    await setBusy(true);
    assert.deepEqual(await modes(), { Steer: "true", Queue: "false", Interrupt: "false" });
    await setBusy(false);
});

test("a chosen Queue stays chosen for the next run", real, async () => {
    await home(VIEWPORTS.desktop);
    await page.navigate(`${base}/s/${Number(one)}`);
    await opened(one);
    await setBusy(true);
    await page.click({ selector: '.mode-switch [role="radio"]:nth-child(2)' });
    assert.equal((await modes()).Queue, "true");
    await setBusy(false);
    await setBusy(true);
    assert.deepEqual(await modes(), { Steer: "false", Queue: "true", Interrupt: "false" });
    await setBusy(false);
});

test("at 320 px wide, Stop stays inside the message box while Pi works", real, async () => {
    await home({ width: 320, height: 700, scale: 2, mobile: true });
    await page.navigate(`${base}/s/${Number(one)}`);
    await opened(one);

    // With the mic turned on (Menu › Dictation) and off, each with an empty box (the mic) and with words in it (Send in
    // the mic's place).
    for (const [mic, words] of [
        [true, ""],
        [true, "a few words"],
        [false, ""],
        [false, "a few words"],
    ] as const) {
        app.setAppearance(owner(app), "micButton", mic);
        await until(
            async () => (await inPage<boolean>(`return JSON.stringify(document.querySelector(".composer-mic") !== null)`)) === mic,
            mic ? "the mic on" : "the mic off",
        );
        await page.type({ selector: BOX }, words);
        await setBusy(true);
        const fit = await inPage<{ scroll: number; client: number; stop: number; right: number; parts: string[] }>(`
            const row = document.querySelector(".composer-row");
            const stop = row.querySelector(".stop-button").getBoundingClientRect();
            return JSON.stringify({
                scroll: row.scrollWidth,
                client: row.clientWidth,
                stop: stop.right,
                right: row.getBoundingClientRect().right,
                // What takes the room, for a failure's message.
                parts: [...row.children].map((part) => part.className.split(" ")[0] + " " + Math.round(part.getBoundingClientRect().width * 10) / 10),
            });
        `);

        await setBusy(false);
        assert.ok(fit.scroll <= fit.client, `the row overflows: ${JSON.stringify(fit)}`);
        assert.ok(fit.stop <= fit.right, `Stop is outside the row: ${JSON.stringify(fit)}`);
    }

    await page.type({ selector: BOX }, "");
});

const SLASH = ".composer .slash-button";
/** The message box's text, where its caret is, and whether it has the focus. */
const boxState = () =>
    inPage<{ value: string; caret: number; focused: boolean }>(`
        const box = document.querySelector(${JSON.stringify(BOX)});
        return JSON.stringify({ value: box.value, caret: box.selectionStart, focused: document.activeElement === box });
    `);
/** The command list's names, as shown. */
const commandNames = () =>
    inPage<string[]>(
        `return JSON.stringify([...document.querySelectorAll('.commands:not(.file-options):not(.history-options) [role="option"] .command-name')].map((each) => each.textContent.trim()))`,
    );

async function boxIs(want: { value: string; caret: number; focused: boolean }, what: string): Promise<void> {
    await until(async () => JSON.stringify(await boxState()) === JSON.stringify(want), what);
}

// GitHub #6 (PP-383): the command list without typing "/".
test("the / button beside Attach opens the command list, and a pick waits in the box for its arguments", real, async () => {
    for (const [size, viewport] of [
        ["390", VIEWPORTS.mobile],
        ["1280", VIEWPORTS.desktop],
    ] as const) {
        await home(viewport);
        await page.navigate(`${base}/s/${Number(one)}`);
        await opened(one);
        await page.type({ selector: BOX }, "");

        // Right of Attach, as an icon button of the row.
        const placed = await inPage<{ gap: number; top: number; label: string; icon: boolean }>(`
            const attach = document.querySelector(".composer .attach-button").getBoundingClientRect();
            const slash = document.querySelector(${JSON.stringify(SLASH)});
            const at = slash.getBoundingClientRect();
            return JSON.stringify({
                gap: Math.round(at.left - attach.right),
                top: Math.round(at.top - attach.top),
                label: slash.getAttribute("aria-label"),
                icon: slash.querySelector("svg") !== null,
            });
        `);

        assert.ok(placed.gap >= 0 && placed.gap <= 8, `right after Attach: ${JSON.stringify(placed)}`);
        assert.equal(placed.top, 0);
        assert.equal(placed.label, "Commands");
        assert.ok(placed.icon);

        // An empty box: the whole list, scrolling, and the caret after the "/" to filter it.
        await page.click({ selector: SLASH });
        await until(async () => (await commandNames()).length > 10, "the whole list");
        await boxIs({ value: "/", caret: 1, focused: true }, "a / in the box");
        assert.equal(
            await inPage<string>(`return JSON.stringify(getComputedStyle(document.querySelector(".commands")).overflowY)`),
            "auto",
        );
        await shot(`composer-commands-${size}`);

        // Typing filters it; a command that takes nothing goes into the box too, not run.
        await page.type(undefined, "expo", { append: true });
        await until(async () => (await commandNames()).join() === "/export", "only /export");
        await page.click({ selector: '.commands [role="option"]' });
        await boxIs({ value: "/export ", caret: 8, focused: true }, "/export in the box");
        assert.deepEqual(await commandNames(), [], "the list closes");

        // A draft stays, after the command picked with Tab.
        await page.type({ selector: BOX }, "keep the tests");
        await page.click({ selector: SLASH });
        await boxIs({ value: "/ keep the tests", caret: 1, focused: true }, "a / before the draft");
        await until(async () => (await commandNames()).length > 10, "the list before a draft");
        await page.type(undefined, "compa", { append: true });
        await until(async () => (await commandNames())[0] === "/compact", "/compact first");
        await page.press("Tab");
        await boxIs({ value: "/compact keep the tests", caret: 9, focused: true }, "/compact before the draft");

        // A tap while it shows closes it.
        await page.type({ selector: BOX }, "");
        await page.click({ selector: SLASH });
        await until(async () => (await commandNames()).length > 0, "the list");
        await page.click({ selector: SLASH });
        await until(async () => (await commandNames()).length === 0, "closed");
        await page.type({ selector: BOX }, "");
    }
});

const MIC_SWITCH = '[data-part="dictation-mic"] [role="switch"]';
/** The mic in the message box, the model chip's width, and whether the row overflows. */
const toolRow = () =>
    inPage<{ mic: boolean; chip: number; overflows: boolean }>(`
        const row = document.querySelector(".composer-row");
        return JSON.stringify({
            mic: row.querySelector(".composer-mic") !== null,
            chip: Math.round(row.querySelector(".model-chip").getBoundingClientRect().width),
            overflows: row.scrollWidth > row.clientWidth,
        });
    `);
const switchOn = () =>
    inPage<string | null>(`return JSON.stringify(document.querySelector(${JSON.stringify(MIC_SWITCH)})?.getAttribute("aria-checked") ?? null)`);

// GitHub #7 (PP-384): keyboards have voice input of their own, so the mic is hidden until a person turns it on.
test("the message box's mic is hidden until Menu › Dictation's switch turns it on", real, async () => {
    for (const [size, viewport] of [
        ["390", VIEWPORTS.mobile],
        ["1280", VIEWPORTS.desktop],
    ] as const) {
        // A person who never chose: nothing kept with them.
        const kept = { ...app.config.userById(owner(app).id)?.appearance };

        delete kept.micButton;
        app.config.updateUser(owner(app).id, { appearance: kept });
        await home(viewport);
        await page.navigate(`${base}/s/${Number(one)}`);
        await opened(one);
        const hidden = await toolRow();

        assert.equal(hidden.mic, false, "no mic by default");
        assert.equal(hidden.overflows, false);
        await shot(`composer-no-mic-${size}`);
        await page.evaluate(`(await import("/store.js")).openSheet({ type: "dictation" })`);
        await until(async () => (await switchOn()) === "false", "the switch, off");
        // The sheet comes in moving: a click before it stands still can land beside the switch.
        await until(
            () =>
                inPage<boolean>(
                    `return JSON.stringify(document.getAnimations().every((each) => each.playState !== "running" || !(each.effect?.target instanceof Element) || !each.effect.target.contains(document.querySelector(${JSON.stringify(MIC_SWITCH)}))))`,
                ),
            "the sheet standing still",
        );
        await shot(`dictation-sheet-${size}`);
        await page.click({ selector: MIC_SWITCH });
        await until(async () => (await switchOn()) === "true", "the switch, on");
        await until(() => app.config.userById(owner(app).id)?.appearance?.micButton === true, "kept with the person");
        await page.evaluate(`(await import("/store.js")).closeSheet()`);
        await until(async () => (await toolRow()).mic === true, "the mic shown");
        const shown = await toolRow();

        assert.equal(shown.overflows, false);
        assert.ok(hidden.chip >= shown.chip, `the hidden mic's room goes to the row: ${JSON.stringify({ shown, hidden })}`);

        // Pi's dictation.micButton (the same option) hides it again in the open tab.
        app.setAppearance(owner(app), "micButton", false);
        await until(async () => (await toolRow()).mic === false, "the mic gone");
    }
});
