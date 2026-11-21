// The rail's "needs you" badge in a real Chromium (PP-535): a control of its own at the Sessions button's corner, red
// when only failures are counted and amber when a session waits for an answer, its label naming the kinds; a tap shows
// Priority's Needs you, from All, with the sidebar folded beside a conversation, and on a phone from the drawer. The
// Sessions button itself still only folds the list. With PHONE_SHOTS, pictures of the rail go there.
import { type App, cleanUp, cleanUpAll, context, lastText, newSession, openApp, owner, root, say, scriptedModel, until } from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { ConversationId } from "@earendil-works/pi-durable";
import { Browsers } from "./support/browser.ts";
import { findBrowser } from "./support/browser/discovery.ts";
import type { BrowserPage } from "./support/browser/page.ts";
import { VIEWPORTS } from "./support/browser/viewport.ts";
import { createHandler } from "../src/server/http.ts";

const chromium = findBrowser();
const real = { skip: chromium === undefined ? "no Chromium-based browser on this machine" : false } as const;
const SHOTS = process.env.PHONE_SHOTS;

/** "start a helper" starts a subagent whose own run fails; the rest is echoed. */
const route: FauxResponseStep = (request) => {
    const all = JSON.stringify((request as { messages: unknown[] }).messages);
    const { role, text } = lastText(request as never);

    if (/You are the subagent \\"flaky\\"/.test(all)) {
        return fauxAssistantMessage([], { stopReason: "error", errorMessage: "Bad request" });
    }

    if (role === "user" && text.endsWith("start a helper")) {
        return fauxAssistantMessage([fauxToolCall("subagent", { action: "spawn", name: "flaky", message: "look around" })], { stopReason: "toolUse" });
    }

    return fauxAssistantMessage([fauxText(`echo: ${text}`)]);
};

let app: App;
let server: Server;
let browsers: Browsers;
let page: BrowserPage;
let base = "";
let helper: ConversationId;
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

/** A finger on `selector`, `dx`, `dy` px off its centre: inside a hit area that reaches past it. */
async function tapNear(selector: string, dx: number, dy: number): Promise<void> {
    // Where it rests: not while the drawer still slides in and grows.
    await until(
        () => inPage<boolean>(`const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return JSON.stringify(r.left >= 0 && r.width >= 16 && document.getAnimations().every((each) => each.playState !== "running"));`),
        `${selector} at rest`,
    );
    const at = await inPage<{ x: number; y: number }>(
        `const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return JSON.stringify({ x: r.left + r.width / 2 + ${dx}, y: r.top + r.height / 2 + ${dy} });`,
    );

    await page.tap(at);
}

const exists = (selector: string) => inPage<boolean>(`return JSON.stringify(document.querySelector(${JSON.stringify(selector)}) !== null)`);
const click = (selector: string) => page.evaluate(`document.querySelector(${JSON.stringify(selector)}).click(); return "null";`);
const present = (selector: string, what: string) => until(() => exists(selector), what);
const gone = (selector: string, what: string) => until(async () => !(await exists(selector)), what);
const row = (id: ConversationId) => app.sessions(owner(app)).find((each) => each.id === Number(id))!;

/** The badge in `where`: its words, label, state, and whether its colour is the app's error or warning colour. */
const badgeIn = (where: string) =>
    inPage<{ text: string; label: string | null; tag: string; state: string | null; colour: string; err: string; warn: string } | null>(`
        const badge = document.querySelector(${JSON.stringify(`${where} [data-part="rail-needs"]`)});
        if (badge === null) return "null";
        const probe = (name) => { const span = document.createElement("span"); span.style.color = "var(" + name + ")"; document.body.append(span); const colour = getComputedStyle(span).color; span.remove(); return colour; };
        return JSON.stringify({ text: badge.textContent.trim(), label: badge.getAttribute("aria-label"), tag: badge.tagName, state: badge.dataset.state ?? null, colour: getComputedStyle(badge).backgroundColor, err: probe("--err"), warn: probe("--warn") });
    `);

/** The scope the list in `where` shows, by its picker's label. */
const scopeIn = (where: string) => inPage<string>(`return JSON.stringify(document.querySelector(${JSON.stringify(`${where} [data-part="session-scope"] .scope-label`)})?.textContent.trim() ?? "")`);

/** Whether the helper's "subagent failed" card is in Needs you in `where`, and in view. */
const failedCardInView = (where: string) =>
    inPage<boolean>(`
        const card = document.querySelector(${JSON.stringify(`${where} [data-group="priority:needs"] .session-row[data-id="${Number(helper)}"] .need-failed`)});
        if (card === null) return "false";
        const r = card.getBoundingClientRect();
        return JSON.stringify(r.height > 0 && r.top >= 0 && r.bottom <= innerHeight && /subagent/i.test(card.textContent));
    `);

/** The list starts on All, as a person left it. */
const onAll = () => page.evaluate(`localStorage.setItem("pocket.sessionScope", "all"); return "null";`);

before(async () => {
    if (chromium === undefined) {
        return;
    }

    app = await openApp(scriptedModel(route));
    server = createServer(createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    browsers = new Browsers({ dataDir: mkdtempSync(join(root, "rail-needs-ui-")), load: async () => undefined, save: () => {} });
    page = await browsers.open(1);
    await page.setViewport(VIEWPORTS.desktop);
    await page.navigate(`${base}/login?token=${encodeURIComponent(app.config.ownerToken)}`);
    quiet = await newSession(app);
    await say(app, quiet, "hello");
    helper = await newSession(app);
    await app.commands.submit(helper, owner(app), { text: "start a helper", requestId: "rail-needs-helper" });
    await until(() => (row(helper).failedAgents?.length ?? 0) === 1 && !app.isBusy(helper), "the failed subagent", 30_000);
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

test("failed subagents make the rail's badge red, named; a tap shows Needs you from All with the sidebar folded, and the Sessions button still only folds", real, async () => {
    const title = row(helper).title ?? "New session";

    await page.navigate(`${base}/s/${quiet}`);
    await onAll();
    await page.evaluate(`(await import("/theme.js")).setPrefs({ sidebar: "rail" }); return "null";`);
    await present(`.sidebar [data-part="rail-needs"]`, "the badge on the folded rail");
    await gone(`.sidebar .sessions`, "the list folded");

    const badge = (await badgeIn(".sidebar"))!;

    assert.equal(badge.tag, "BUTTON", "a control of its own");
    assert.equal(badge.text, "1");
    assert.equal(badge.state, "fails");
    assert.equal(badge.colour, badge.err, "red: failures only");
    assert.equal(badge.label, `1 needs you: 1 subagent failed in ${title}`);
    // Beside the Sessions button, not in it.
    assert.equal(await exists(`.sidebar [data-part="rail-button"] [data-part="rail-needs"]`), false);
    await shot("rail-fails-1280.jpg");

    // The Sessions button folds and unfolds, and leaves the scope as it was.
    await click(`.sidebar button[data-part="rail-button"][aria-expanded]`);
    await present(`.sidebar .sessions`, "the list unfolded by the Sessions button");
    assert.equal(await scopeIn(".sidebar"), "All");
    await click(`.sidebar button[data-part="rail-button"][aria-expanded]`);
    await gone(`.sidebar .sessions`, "folded again");

    // The badge: the list unfolds on Priority, the failure in view.
    await click(`.sidebar [data-part="rail-needs"]`);
    await present(`.sidebar .sessions`, "the list unfolded by the badge");
    await until(async () => (await scopeIn(".sidebar")) === "Priority", "Priority from All");
    await until(() => failedCardInView(".sidebar"), "the subagent's failure in view in Needs you");
    assert.equal(await inPage<string>(`return JSON.stringify(localStorage.getItem("pocket.sessionScope"))`), "priority");
});

test("on a phone, the badge in the drawer goes to the session list on Priority, and a call waiting makes it amber", real, async () => {
    await page.setViewport(VIEWPORTS.mobile);
    await onAll();
    await page.navigate(`${base}/s/${quiet}`);
    await page.evaluate(`(await import("/store.js")).store.set({ drawer: true }); return "null";`);
    await present(`.drawer [data-part="rail-needs"]`, "the badge in the drawer");
    assert.equal((await badgeIn(".drawer"))!.state, "fails");
    await until(async () => (await scopeIn(".drawer")) === "All", "the drawer's list on All");
    await shot("rail-fails-390.jpg");

    // A finger past the dot, within its 40 px.
    await tapNear(`.drawer [data-part="rail-needs"]`, -10, 10);
    await gone(`.drawer`, "the drawer closed");
    await present(`.home-list .sessions`, "the session list");
    await until(async () => (await scopeIn(".home-list")) === "Priority", "Priority on the phone");
    await until(() => failedCardInView(".home-list"), "the subagent's failure in view on the phone");

    // A call that waits for the person: amber, and the label counts both kinds.
    const answer = app.approvals.request(
        { id: "rail-needs-1", conversationId: quiet, taskId: 1 as never, callId: "call-1", tool: "bash", subject: "npm publish", reason: "Publishes", createdAt: Date.now() },
        context,
    );

    await until(async () => (await badgeIn(".home-list"))?.state === "asks", "the badge amber");
    const badge = (await badgeIn(".home-list"))!;

    assert.equal(badge.colour, badge.warn, "amber: one waits for an answer");
    assert.equal(badge.text, "2");
    assert.equal(badge.label, "2 need you: 1 waits for your answer, 1 with failed subagents");
    await shot("rail-asks-390.jpg");
    app.approvals.answer("rail-needs-1", { allow: false, by: "test" });
    await answer;
    await until(async () => (await badgeIn(".home-list"))?.state === "fails", "red again once answered");
});
