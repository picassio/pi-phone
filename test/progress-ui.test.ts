// The floating progress board's page in a real browser (PP-283): `/?board=1` lists the session at work with what it
// does and its count in the title, and says nothing runs once it is done; This phone (in the app) has the board's
// switches, the bubble only once Android allows it. Nothing runs past a phone's screen.
import { type App, cleanUp, lastText, newSession, openApp, owner, root, scriptedModel, until } from "./helpers.ts";
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

after(async () => {
    await browsers?.closeAll({ final: true });
    server?.closeAllConnections();
    server?.close();
    await app?.close();
    cleanUp();
});

test("the board page: the session at work with what it does, counted in the title; then nothing runs", real, async () => {
    const id = await newSession(app);

    await app.commands.submit(id, owner(app), { text: "build the thing", requestId: `build-${id}` });
    await page.setViewport(VIEWPORTS.mobile);
    await page.navigate(`${base}/?board=1`);
    await see(`return JSON.stringify(document.querySelector('[data-part="pgb-row"] small')?.textContent.startsWith("running sleep 4") === true)`, "the row at work", 15_000);

    const shown = await inPage<{ heading: string; title: string; state: string; app: boolean }>(`
        const row = document.querySelector('[data-part="pgb-row"]');

        return JSON.stringify({
            heading: document.querySelector(".pgb-head b").textContent.trim(),
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

    await see(`return JSON.stringify(document.querySelector(".pgb-empty")?.textContent.trim() === "Nothing runs now.")`, "nothing runs", 20_000);
    assert.equal(await inPage<string>(`return JSON.stringify(document.querySelector(".pgb-head b").textContent.trim())`), "Pi is idle · 1 done");
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
            chips: [...document.querySelectorAll(".pgb-chip")].map((each) => each.textContent.trim()),
            subs: document.querySelectorAll('[data-part="pgb-sub"]').length,
        });
    `);

    assert.equal(shown.rows, 4, "three sessions and the one with subagents, past five shown too if there were");
    assert.deepEqual(shown.chips, ["All 4", "Waits for you 0", "Working 4"]);
    assert.equal(shown.subs, 0, "folded");
    await page.evaluate(`document.querySelector('[data-part="pgb-fold"]').click(); return "true";`);
    await see(`return JSON.stringify(document.querySelectorAll('[data-part="pgb-sub"]').length === 2)`, "the subagents shown");
    assert.deepEqual(await outside(), []);
    await shot("board-many-390");

    // The Waits for you chip: nothing waits; kept for the next time the board opens.
    await page.evaluate(`document.querySelector('[data-part="pgb-chip-waiting"]').click(); return "true";`);
    await see(`return JSON.stringify(document.querySelectorAll('[data-part="pgb-row"]').length === 0)`, "nothing waits");
    assert.equal(await inPage<string>(`return JSON.stringify(localStorage.getItem("pocket.boardFilter"))`), "waiting");
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
    assert.deepEqual(await outside(), []);
    await shot("this-phone-390");
});
