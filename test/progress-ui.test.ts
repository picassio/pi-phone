// The floating progress board's page in a real browser (PP-283): `/?board=1` lists the session at work with what it
// does and its count in the title, and says nothing runs once it is done; This phone (in the app) has the board's
// switches, the bubble only once Android allows it. Nothing runs past a phone's screen.
import { type App, cleanUp, cleanUpAll, lastText, newSession, openApp, owner, root, scriptedModel, until } from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { Browsers } from "./support/browser.ts";
import { findBrowser } from "./support/browser/discovery.ts";
import type { BrowserPage } from "./support/browser/page.ts";
import { VIEWPORTS } from "./support/browser/viewport.ts";
import { createHandler } from "../src/server/http.ts";

const chromium = findBrowser();
const real = { skip: chromium === undefined ? "no Chromium-based browser on this machine" : false } as const;
const SHOTS = process.env.PROGRESS_SHOTS;

const route: FauxResponseStep = (request) => {
    const { role, text } = lastText(request as never);
    const subagent = /You are the subagent \\"([^\\]+)\\"/.exec(JSON.stringify(request))?.[1];

    if (subagent !== undefined && role !== "toolResult") {
        return fauxAssistantMessage([fauxToolCall("bash", { command: "sleep 8" })], { stopReason: "toolUse" });
    }

    if (subagent !== undefined) {
        return fauxAssistantMessage([fauxText(`${subagent} done`)]);
    }

    if (role === "user" && text === "build the thing") {
        return fauxAssistantMessage([fauxToolCall("bash", { command: "sleep 4" })], { stopReason: "toolUse" });
    }

    if (role === "user" && text.startsWith("busy ")) {
        return fauxAssistantMessage([fauxToolCall("bash", { command: "sleep 8" })], { stopReason: "toolUse" });
    }

    if (role === "user" && text === "split it") {
        return fauxAssistantMessage(
            ["part-a", "part-b"].map((name) => fauxToolCall("subagent", { action: "spawn", name, message: `Do ${name}.` })),
            { stopReason: "toolUse" },
        );
    }

    return fauxAssistantMessage([fauxText("built")]);
};

let app: App;
let server: Server;
let browsers: Browsers;
let page: BrowserPage;
let base = "";

const inPage = async <T>(script: string): Promise<T> => JSON.parse(await page.evaluate(script)) as T;
const see = (script: string, what: string, timeoutMs?: number) => until(async () => (await inPage<boolean>(script)) === true, what, timeoutMs);

async function shot(name: string): Promise<void> {
    if (SHOTS !== undefined) {
        const { mkdirSync, writeFileSync } = await import("node:fs");

        mkdirSync(SHOTS, { recursive: true });
        await new Promise((resolve) => setTimeout(resolve, 400));
        writeFileSync(join(SHOTS, `${name}.jpg`), Buffer.from((await page.screenshot()).data, "base64"));
    }
}

const outside = () =>
    inPage<string[]>(`
        const out = [...document.querySelectorAll("body *")].filter((each) => {
            const box = each.getBoundingClientRect();

            return box.width > 0 && box.right > innerWidth + 0.5;
        }).map((each) => each.className || each.tagName);

        return JSON.stringify(document.documentElement.scrollWidth > innerWidth + 1 ? [...out, "page scrolls sideways"] : out);
    `);

before(async () => {
    if (chromium === undefined) {
        return;
    }

    app = await openApp(scriptedModel(route));
    server = createServer(createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    browsers = new Browsers({ dataDir: mkdtempSync(join(root, "progress-ui-")), load: async () => undefined, save: () => {} });
    page = await browsers.open(1);
    await page.navigate(`${base}/login?token=${encodeURIComponent(app.config.ownerToken)}`);
    await see(`return JSON.stringify((await import("/store.js")).store.state.me?.role === "owner")`, "signed in");
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

test("the board page: the session at work with what it does, counted in the title; then nothing runs", real, async () => {
    const id = await newSession(app);

    await app.commands.submit(id, owner(app), { text: "build the thing", requestId: `build-${id}` });
    await page.setViewport(VIEWPORTS.mobile);
    await page.navigate(`${base}/?board=1`);
    await see(`return JSON.stringify(document.querySelector('[data-part="pgb-row"] small')?.textContent.startsWith("running sleep 4") === true)`, "the row at work", 15_000);

    const shown = await inPage<{ heading: string; title: string; state: string; app: boolean }>(`
        const row = document.querySelector('[data-part="pgb-row"]');

        return JSON.stringify({
            heading: document.querySelector(".pgb-counts").textContent.trim(),
            title: row.querySelector("b").textContent.trim(),
            state: row.dataset.state,
            app: document.querySelector(".sessions, .composer") !== null,
        });
    `);

    assert.deepEqual(shown, { heading: "1 working", title: "build the thing", state: "working", app: false });
    assert.deepEqual(await outside(), []);
    await shot("board-390");

    // A row opens its session in the panel (the owner's ask): its transcript, a line to write to Pi, and back.
    await page.evaluate(`document.querySelector('[data-part="pgb-row"] .pgb-text').click(); return "true";`);
    await see(`return JSON.stringify(document.querySelector('[data-part="board-session"] [data-part="transcript"]')?.textContent.includes("build the thing") === true)`, "the session in the panel");
    assert.equal(await inPage<boolean>(`return JSON.stringify(document.querySelector('.pgb-reply input') !== null)`), true);
    assert.deepEqual(await outside(), []);
    await shot("board-session-390");
    await page.evaluate(`document.querySelector('[data-part="board-session"] .pgb-head .icon-button').click(); return "true";`);
    await see(`return JSON.stringify(document.querySelector('[data-part="pgb-row"], .pgb-empty') !== null)`, "back to the board");

    // Done, it moves to the Done section (PP-287), with Pi's last words.
    await see(`return JSON.stringify(document.querySelector('[data-part="pgb-row"]')?.dataset.state === "done" && document.querySelector('[data-part="pgb-row"] small').textContent.trim() === "built")`, "nothing runs", 20_000);
    assert.equal(await inPage<string>(`return JSON.stringify(document.querySelector(".pgb-counts").textContent.trim())`), "Pi is idle · 1 done");
    assert.equal(await inPage<string>(`return JSON.stringify(document.querySelector(".pgb-foot span").textContent.trim())`), "1 done in the last hour");
});

test("many sessions: every one on the board, chips to filter, a session's subagents folded under it", real, async () => {
    for (const name of ["one", "two", "three"]) {
        const each = await newSession(app);

        await app.commands.submit(each, owner(app), { text: `busy ${name}`, requestId: `busy-${name}-${each}` });
    }

    const parent = await newSession(app);

    await app.commands.submit(parent, owner(app), { text: "split it", requestId: `split-${parent}` });
    await page.setViewport(VIEWPORTS.mobile);
    await page.navigate(`${base}/?board=1`);
    await see(`return JSON.stringify(document.querySelector('[data-part="pgb-fold"]')?.textContent.includes("2 subagents working") === true)`, "the folded subagents", 20_000);

    const shown = await inPage<{ rows: number; chips: string[]; subs: number }>(`
        return JSON.stringify({
            rows: document.querySelectorAll('[data-part="pgb-row"]').length,
            chips: [...document.querySelectorAll(".pgb-tab")].map((each) => each.textContent.trim()),
            subs: document.querySelectorAll('[data-part="pgb-sub"]').length,
        });
    `);

    assert.equal(shown.rows, 5, "three sessions and the one with subagents, past five shown too if there were, and the one done before");
    assert.deepEqual(shown.chips, ["All 5", "Waiting 0", "Working 4", "Done 1"]);
    assert.equal(shown.subs, 0, "folded");
    await page.evaluate(`document.querySelector('[data-part="pgb-fold"]').click(); return "true";`);
    await see(`return JSON.stringify(document.querySelectorAll('[data-part="pgb-sub"]').length === 2)`, "the subagents shown");
    assert.deepEqual(await outside(), []);
    await shot("board-many-390");

    // The Waits for you chip: nothing waits; kept for the next time the board opens.
    await page.evaluate(`document.querySelector('[data-part="pgb-chip-waiting"]').click(); return "true";`);
    await see(`return JSON.stringify(document.querySelectorAll('[data-part="pgb-row"]').length === 0)`, "nothing waits");
    assert.equal(await inPage<string>(`return JSON.stringify(localStorage.getItem("pocket.boardFilter"))`), "waiting");

    // The Done tab (PP-287): the session done before, with Pi's last words and a blue dot until it is opened. It ended
    // open in the panel, so seen: this phone forgets that it looked, as if it had not.
    await page.evaluate(`
        for (const key of Object.keys(localStorage).filter((each) => each.startsWith("pocket.peekSeen."))) localStorage.removeItem(key);
        localStorage.setItem("pocket.boardFilter", "done");
        return "true";
    `);
    await page.navigate(`${base}/?board=1`);
    await see(`return JSON.stringify(document.querySelector('[data-part="pgb-chip-done"]') !== null)`, "the board again", 20_000);
    await page.evaluate(`document.querySelector('[data-part="pgb-chip-done"]').click(); return "true";`);
    await see(`return JSON.stringify(document.querySelectorAll('[data-part="pgb-row"]').length === 1)`, "the one done");
    const done = await inPage<{ state: string; title: string; doing: string; badge: string; dot: boolean }>(`
        const row = document.querySelector('[data-part="pgb-row"]');

        return JSON.stringify({
            state: row.dataset.state,
            title: row.querySelector(".pgb-text b").textContent.trim(),
            doing: row.querySelector(".pgb-text small").textContent.trim(),
            badge: row.querySelector(".pgb-badge").textContent.trim(),
            dot: row.querySelector('[data-part="pgb-unseen"]') !== null,
        });
    `);

    assert.deepEqual(done, { state: "done", title: "build the thing", doing: "built", badge: "done", dot: true });
    assert.deepEqual(await outside(), []);
    await shot("board-done-390");
    await page.evaluate(`document.querySelector('[data-part="pgb-row"] .pgb-text').click(); return "true";`);
    await see(`return JSON.stringify(document.querySelector('[data-part="board-session"]') !== null)`, "the session in the panel");
    await page.evaluate(`document.querySelector('[data-part="board-session"] .pgb-head .icon-button').click(); return "true";`);
    await see(`return JSON.stringify(document.querySelector('[data-part="pgb-row"]') !== null && document.querySelector('[data-part="pgb-unseen"]') === null)`, "seen once opened");
    await page.evaluate(`localStorage.setItem("pocket.boardFilter", "all"); return "true";`);
});

test("This phone, in the app: the board's switches; the bubble once Android allows pi over other apps", real, async () => {
    const id = await newSession(app);

    await page.setViewport(VIEWPORTS.mobile);
    await page.navigate(`${base}/s/${id}`);
    await see(`return JSON.stringify(document.querySelector(".composer textarea") !== null)`, "the session");
    await page.evaluate(`
        window.__allowed = false;
        window.PiPhoneApp = { notificationsEnabled: () => true, runsUnrestricted: () => true, overlayAllowed: () => window.__allowed, askOverlay: () => { window.__asked = true; } };
        (await import("/store.js")).openSheet({ type: "phone" });
        return "true";
    `);
    await see(`return JSON.stringify(document.querySelector('[data-part="progress-bubble"]') !== null)`, "the switches");
    assert.equal(await inPage<number>(`return JSON.stringify(document.querySelectorAll('[data-part="progress-hideIdle"]').length)`), 0, "hiding, only with the bubble on");

    // Not allowed yet: Android's page is asked for, and nothing turns on until it is allowed.
    await page.evaluate(`document.querySelector('[data-part="progress-bubble"] [role="switch"]').click(); return "true";`);
    assert.equal(await inPage<boolean>(`return JSON.stringify(window.__asked === true)`), true);
    assert.equal(app.config.progressBoard.bubble, false);
    await page.evaluate(`window.__allowed = true; window.dispatchEvent(new Event("focus")); return "true";`);
    await until(() => app.config.progressBoard.bubble, "the bubble on");
    await see(`return JSON.stringify(document.querySelector('[data-part="progress-hideIdle"]') !== null)`, "hiding, with the bubble on");

    await page.evaluate(`document.querySelector('[data-part="progress-notification"] [role="switch"]').click(); return "true";`);
    await until(() => !app.config.progressBoard.notification, "the notification's rows off");

    // The floating panel's opacity (PP-286): a slider with the bubble on, saved when let go; the board page takes it whole.
    assert.equal(await inPage<string>(`return JSON.stringify(document.querySelector('[data-part="progress-opacity"]').textContent.includes("Panel opacity · 100%"))`), true);
    await page.evaluate(`
        const slider = document.querySelector('[data-part="progress-opacity"] input[type="range"]');
        slider.value = "70";
        slider.dispatchEvent(new Event("input", { bubbles: true }));
        slider.dispatchEvent(new Event("change", { bubbles: true }));
        return "true";
    `);
    await until(() => app.config.progressBoard.opacity === 70, "the panel at 70%");
    await see(`return JSON.stringify(document.querySelector('[data-part="progress-opacity"]').textContent.includes("Panel opacity · 70%"))`, "the slider's label");
    assert.deepEqual(await outside(), []);
    await page.evaluate(`document.querySelector('[data-part="progress-opacity"]').scrollIntoView({ block: "end" }); return "true";`);
    await shot("this-phone-390");

    await page.navigate(`${base}/?board=1`);
    await see(`return JSON.stringify(document.body.style.opacity === "0.7" && document.querySelector('[data-part="progress-board"]') !== null)`, "the board at 70%");
    await app.setProgressBoard(owner(app), "opacity", 100);
});
