// Decision cards the person cannot miss (PP-284): a card Pi asks with interview is pinned at the top of its session
// until answered, and Answer opens its form; the session list says "Pi asks you" and its "Waits for you" scope lists
// it. Answered, all of it goes. Nothing runs past a phone's screen or a desktop's.
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
const SHOTS = process.env.DECISION_SHOTS;

const QUESTIONS = JSON.stringify({
    title: "Which first",
    questions: [
        { id: "order", type: "single", question: "Which do we build first?", options: ["The board", "The cards"], recommended: "The board" },
        { id: "why", type: "text", question: "Anything to add?" },
    ],
});

const route: FauxResponseStep = (request) => {
    const { role, text } = lastText(request as never);

    if (role === "user" && text === "ask me") {
        return fauxAssistantMessage([fauxToolCall("interview", { questions: QUESTIONS, async: true })], { stopReason: "toolUse" });
    }

    return fauxAssistantMessage([fauxText("asked")]);
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
        const out = [...document.querySelectorAll(".decision-bar *, .session-scope-menu *")].filter((each) => {
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
    browsers = new Browsers({ dataDir: mkdtempSync(join(root, "decision-ui-")), load: async () => undefined, save: () => {} });
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

test("a card Pi asks is pinned at the top until answered; the list says Pi asks you, and Waits for you lists it", real, async () => {
    const id = await newSession(app);
    const other = await newSession(app);

    await app.commands.submit(id, owner(app), { text: "ask me", requestId: `ask-${id}` });
    await until(() => app.approvals.forConversation(id).some((each) => each.form?.type === "interview"), "the card");
    assert.equal(app.sessions().find((each) => each.id === Number(id))?.asks, "Which first");

    await page.setViewport(VIEWPORTS.mobile);
    await page.navigate(`${base}/s/${id}`);
    await see(`return JSON.stringify(document.querySelector('[data-part="decision-bar"] .decision') !== null)`, "the pinned bar");

    const bar = await inPage<{ title: string; detail: string; top: number }>(`
        const one = document.querySelector('[data-part="decision-bar"] .decision');

        return JSON.stringify({ title: one.querySelector("b").textContent.trim(), detail: one.querySelector("small").textContent.trim(), top: getComputedStyle(one.parentElement).position });
    `);

    assert.equal(bar.title, "Pi asks you: Which first");
    assert.match(bar.detail, /^2 questions · /);
    assert.equal(bar.top, "sticky", "it stays however far the chat scrolls");
    assert.deepEqual(await outside(), []);
    await shot("decision-bar-390");

    // Answer opens the card's form.
    await page.evaluate(`document.querySelector('[data-part="decision-bar"] .decision').click(); return "true";`);
    await see(`return JSON.stringify((await import("/store.js")).store.state.sheet?.type === "interview")`, "the form");
    await page.evaluate(`(await import("/store.js")).closeSheet(); return "true";`);

    // The list: Pi asks you, and the Waits for you scope with this session alone.
    void other;
    await page.navigate(`${base}/`);
    await see(`return JSON.stringify(document.querySelector('[data-part="session-scope"] button') !== null)`, "the list");
    await page.evaluate(`document.querySelector('[data-part="session-scope"] button').click(); return "true";`);
    await see(`return JSON.stringify([...document.querySelectorAll('.session-scope-menu [role="option"]')].some((each) => each.textContent.includes("Waits for you")))`, "the scope");
    await page.evaluate(`[...document.querySelectorAll('.session-scope-menu [role="option"]')].find((each) => each.textContent.includes("Waits for you")).click(); return "true";`);
    await see(`return JSON.stringify(document.querySelectorAll('[data-part="session-row"], .session-row').length >= 1)`, "a row");
    const rows = await inPage<string[]>(`return JSON.stringify([...document.querySelectorAll('[data-part="session-mark"] [title]')].map((each) => each.getAttribute("title")))`);

    assert.deepEqual(rows, ["Pi asks you: Which first"]);
    assert.deepEqual(await outside(), []);
    await shot("waits-for-you-390");
    await page.evaluate(`localStorage.setItem("pocket.sessionScope", "all"); return "true";`);

    // Answered: the bar goes.
    await page.navigate(`${base}/s/${id}`);
    await see(`return JSON.stringify(document.querySelector('[data-part="decision-bar"]') !== null)`, "the bar again");
    const card = app.approvals.forConversation(id).find((each) => each.form?.type === "interview")!;

    await app.answerApproval(card.id, false, owner(app));
    await see(`return JSON.stringify(document.querySelector('[data-part="decision-bar"]') === null)`, "the bar gone");
    assert.equal(app.sessions().find((each) => each.id === Number(id))?.asks, undefined);
    await page.setViewport(VIEWPORTS.desktop);
});
