// The session list's Priority view in a real Chromium (PP-346, from pi-pocket 0.27): sessions by what they ask of you,
// a call answered in its row, a failure dismissed and undone, Ready to read marked read, the count on the rail, and what
// the list opens on. At phone size first; with PHONE_SHOTS, screenshots at 390 and 1280 px go there.
import { type App, cleanUp, cleanUpAll, context, lastText, newSession, openApp, owner, root, say, scriptedModel, until } from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai/providers/faux";
import type { ConversationId } from "@earendil-works/pi-durable";
import { Browsers } from "./support/browser.ts";
import { findBrowser } from "./support/browser/discovery.ts";
import type { BrowserPage } from "./support/browser/page.ts";
import { VIEWPORTS } from "./support/browser/viewport.ts";
import { createHandler } from "../src/server/http.ts";
import type { ApprovalAnswer } from "../src/server/host.ts";

const chromium = findBrowser();
const real = { skip: chromium === undefined ? "no Chromium-based browser on this machine" : false } as const;
const SHOTS = process.env.PHONE_SHOTS;

/** "fail now" ends the run in an error; the rest is echoed. */
const route: FauxResponseStep = (request) => {
    const { role, text } = lastText(request as never);

    return role === "user" && text.endsWith("fail now")
        ? fauxAssistantMessage([], { stopReason: "error", errorMessage: "Invalid request: unsupported parameter" })
        : fauxAssistantMessage([fauxText(`echo: ${text}`)]);
};

let app: App;
let server: Server;
let browsers: Browsers;
let page: BrowserPage;
let base = "";
let calls = 0;
let asking: ConversationId;
let failing: ConversationId;
let finished: ConversationId;
let quiet: ConversationId;

async function inPage<T>(script: string): Promise<T> {
    return JSON.parse(await page.evaluate(script)) as T;
}

const shot = async (name: string) => {
    if (SHOTS !== undefined) {
        mkdirSync(SHOTS, { recursive: true });
        await new Promise((resolve) => setTimeout(resolve, 400));
        writeFileSync(join(SHOTS, name), Buffer.from((await page.screenshot()).data, "base64"));
    }
};

/** A call waiting in `id`; the promise is the answer it gets. */
function ask(id: ConversationId, subject: string, createdAt: number): Promise<ApprovalAnswer> {
    return app.approvals.request(
        { id: `priority-ui-${++calls}`, conversationId: id, taskId: calls as never, callId: `call-${calls}`, tool: "bash", subject, reason: "Publishes to a package registry", createdAt },
        context,
    );
}

const list = () => `.home-list .session-row[data-id="${quiet}"]`;
const group = (name: string) => `.home-list [data-group="priority:${name}"]`;
const rowIn = (name: string, id: ConversationId) => `${group(name)} .session-row[data-id="${id}"]`;
const exists = (selector: string) => inPage<boolean>(`return JSON.stringify(document.querySelector(${JSON.stringify(selector)}) !== null)`);
const click = (selector: string) => page.evaluate(`document.querySelector(${JSON.stringify(selector)}).click(); return "null";`);
const present = (selector: string, what: string) => until(() => exists(selector), what);
const gone = (selector: string, what: string) => until(async () => !(await exists(selector)), what);

/** Choose a scope in the list's picker, by its option's position text. */
async function chooseScope(label: string): Promise<void> {
    await click(`.home-list [data-part="session-scope"] .session-scope-button`);
    await present(`.home-list [data-part="session-scope"] [role="option"]`, "the scope menu");
    await page.evaluate(`[...document.querySelectorAll('.home-list [data-part="session-scope"] [role="option"]')].find((option) => option.querySelector(".scope-label")?.textContent.trim() === ${JSON.stringify(label)}).click(); return "null";`);
}

before(async () => {
    if (chromium === undefined) {
        return;
    }

    app = await openApp(scriptedModel(route));
    server = createServer(createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    browsers = new Browsers({ dataDir: mkdtempSync(join(root, "priority-ui-")), load: async () => undefined, save: () => {} });
    page = await browsers.open(1);
    await page.setViewport(VIEWPORTS.mobile);
    await page.navigate(`${base}/login?token=${encodeURIComponent(app.config.ownerToken)}`);
    asking = await newSession(app);
    failing = await newSession(app);
    finished = await newSession(app);
    quiet = await newSession(app);
    await page.navigate(`${base}/`);
    await until(async () => await exists(list()), "the session list", 20_000);
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

test("Priority puts what needs you first, answers a call in its row, and marks what finished read", real, async () => {
    await say(app, quiet, "an old question");
    // Seen once the list has its run's end, before the others finish: the quiet one is read.
    await page.evaluate(`import("/store.js").then((module) => (window.pageStore = module.store)); return "null";`);
    await until(
        async () => await inPage<boolean>(`return JSON.stringify(typeof window.pageStore?.state.sessions.find((each) => each.id === ${Number(quiet)})?.endedAt === "number")`),
        "the quiet session's end in the list",
    );
    await page.evaluate(`(async () => (await import("/seen.js")).markSeen(${Number(quiet)}))(); return "null";`);
    await say(app, finished, "a question whose answer you have not read");
    await app.commands.submit(failing, owner(app), { text: "fail now", requestId: "fail-ui-1" });
    await until(() => app.sessions(owner(app)).find((each) => each.id === Number(failing))?.failed === true, "the failed run");
    const answer = ask(asking, "npm publish", Date.now());

    await chooseScope("Priority");
    await present(rowIn("needs", asking), "the call in Needs you");
    await present(rowIn("needs", failing), "the failed run in Needs you");
    await present(rowIn("ready", finished), "the finished session in Ready to read");
    await present(`${group("quiet")}.closed`, "Quiet, folded at first");
    assert.equal(await exists(rowIn("needs", quiet)), false);
    // The order of Needs you: the call first, then the failure; and the rail's count.
    assert.deepEqual(
        await inPage<number[]>(`return JSON.stringify([...document.querySelectorAll('${group("needs")} .session-row')].map((row) => Number(row.dataset.id)))`),
        [Number(asking), Number(failing)],
    );
    assert.equal(await inPage<string>(`return JSON.stringify(document.querySelector('[data-part="rail-needs"]')?.textContent.trim() ?? "")`), "2");
    assert.ok(await exists(`${rowIn("needs", asking)} [data-part="session-ask-command"]`), "the command in the row");
    await shot("priority-390.jpg");
    await page.setViewport(VIEWPORTS.desktop);
    await shot("priority-1280.jpg");
    await page.setViewport(VIEWPORTS.mobile);

    // Allowed from its row, the call is answered and the session leaves Needs you.
    await page.evaluate(`[...document.querySelectorAll('${rowIn("needs", asking)} .peek-actions button')].find((button) => button.textContent.trim() === "Allow").click(); return "null";`);
    assert.equal((await answer).allow, true);
    await gone(rowIn("needs", asking), "the answered call out of Needs you");

    // The failure dismissed, and the notice undoes it.
    await click(`${rowIn("needs", failing)} [data-part="session-dismiss"]`);
    await gone(rowIn("needs", failing), "the failure dismissed");
    await page.evaluate(`[...document.querySelectorAll(".notice, [role=status] button, .toast")].find((each) => /undo/i.test(each.textContent))?.click(); return "null";`);
    await present(rowIn("needs", failing), "the failure back after Undo");
    await click(`${rowIn("needs", failing)} [data-part="session-dismiss"]`);
    await gone(rowIn("needs", failing), "dismissed again");
    await present(`[data-part="session-clear"]`, "Nothing needs you");

    // Ready to read, marked read all at once.
    await page.evaluate(`[...document.querySelectorAll('${group("ready")} [data-part="session-group-action"]')][0].click(); return "null";`);
    await gone(group("ready"), "Ready to read emptied");
    await gone(`[data-part="rail-needs"]`, "no count on the rail");
});

test("the list opens on what the person chose: Priority, on the next start", real, async () => {
    await chooseScope("All");
    app.setListOpens(owner(app), "priority");
    await page.navigate(`${base}/`);
    await until(async () => await exists(list()), "the session list again");
    await until(async () => (await inPage<string>(`return JSON.stringify(document.querySelector('.home-list [data-part="session-scope"] .scope-label')?.textContent.trim() ?? "")`)) === "Priority", "Priority as the app opens");

    // Appearance names the choice.
    await page.evaluate(`(async () => (await import("/store.js")).openSheet({ type: "appearance" }))(); return "null";`);
    await until(
        async () => await inPage<boolean>(`return JSON.stringify([...document.querySelectorAll(".setting-row")].some((row) => row.textContent.includes("Session list opens on") && row.querySelector("button.on")?.textContent.trim() === "Priority"))`),
        "the setting in Appearance",
    );
    await inPage(`[...document.querySelectorAll(".setting-row")].find((row) => row.textContent.includes("Session list opens on")).scrollIntoView({ block: "center" }); return "null";`);
    await shot("priority-setting-390.jpg");
    app.setListOpens(owner(app), "last");
});
