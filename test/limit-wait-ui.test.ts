// A run waiting for a provider's limit, in a real browser (PP-135): the live line says whose limit and when it tries
// again, with Retry now and Stop; the session's row has the limited square; the account card offers the other account
// and Move sends the request there; the Providers sheet has the longest wait and the notice switch. On a phone the line
// and the card stay inside the column. With LIMITS_SHOTS set to a folder, screenshots at 390 and 1280 px go there.
import { type App, cleanUp, home, owner, root, work } from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { ConversationId } from "@earendil-works/pi-durable";
import { createHandler } from "../src/server/http.ts";
import { Browsers } from "./support/browser.ts";
import { findBrowser } from "./support/browser/discovery.ts";
import type { BrowserPage } from "./support/browser/page.ts";
import { VIEWPORTS } from "./support/browser/viewport.ts";
import { type FakeReply, fakeAnthropic, fiveHourLimit, localAnthropic, MODEL_ID, signIns } from "./support/fake-anthropic.ts";

const { PocketApp } = await import("../src/server/app.ts");

const real = { skip: findBrowser() === undefined ? "no Chromium-based browser on this machine" : false } as const;
const SHOTS = process.env.LIMITS_SHOTS;

let behave: (token: string, call: number) => FakeReply = () => ({ text: "answered" });
let provider: Awaited<ReturnType<typeof fakeAnthropic>>;
let app: App;
let server: Server;
let browsers: Browsers;
let page: BrowserPage;
let base = "";
const reset = Date.now() + 2 * 3_600_000 + 15 * 60_000;

/** Claude's usage endpoint: the default account's 5-hour window is full, Work has room. */
const usageFetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    const token = String(new Headers(init?.headers).get("authorization") ?? "").replace(/^Bearer /, "");
    const five = token === "tok-default" ? 100 : 18;

    return Response.json({
        five_hour: { utilization: five, resets_at: new Date(reset).toISOString() },
        seven_day: { utilization: 31, resets_at: new Date(Date.now() + 4 * 86_400_000).toISOString() },
    });
}) as typeof fetch;

before(async () => {
    if (real.skip) {
        return;
    }

    provider = await fakeAnthropic((token, call) => behave(token, call));

    const agent = join(root, "agent");

    mkdirSync(agent, { recursive: true });
    writeFileSync(join(agent, "auth.json"), signIns({ anthropic: "tok-default", "anthropic~work": "tok-work" }));
    app = await PocketApp.open({
        dataDir: join(root, "limit-ui-data"),
        defaultCwd: work,
        supervised: false,
        log: () => {},
        home,
        configureModels: (models) => models.registerNativeProvider(localAnthropic(provider.url)),
        accountProviders: { anthropic: () => localAnthropic(provider.url) },
        usageFetch,
        limits: { minWaitMs: 50, resetJitterMs: [0, 0] },
        officecli: { runs: false },
    });
    app.accounts.add("anthropic", "Work");
    server = createServer(createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    browsers = new Browsers({ dataDir: mkdtempSync(join(root, "limit-ui-")), load: async () => undefined, save: () => {} });
    page = await browsers.open(1);
    await page.navigate(`${base}/login?token=${encodeURIComponent(app.config.ownerToken)}`);
});

after(async () => {
    await browsers?.closeAll({ final: true });
    server?.closeAllConnections();
    server?.close();
    await app?.close();
    provider?.close();
    cleanUp();
});

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
const text = (selector: string) => inPage<string>(`return JSON.stringify(document.querySelector(${JSON.stringify(selector)})?.innerText ?? "")`);

async function shot(name: string): Promise<void> {
    if (SHOTS === undefined) {
        return;
    }

    mkdirSync(SHOTS, { recursive: true });
    await new Promise((resolve) => setTimeout(resolve, 400));
    writeFileSync(join(SHOTS, `${name}.jpg`), Buffer.from((await page.screenshot()).data, "base64"));
}

async function session(title: string): Promise<ConversationId> {
    app.config.lastModel ??= { provider: "anthropic", modelId: MODEL_ID, thinkingLevel: "off" };
    const { id } = await app.commands.createSession(owner(app), { cwd: work });

    await app.commands.configure(id, owner(app), { model: { provider: "anthropic", modelId: MODEL_ID }, thinkingLevel: "off" });
    await app.commands.submit(id, owner(app), { text: title, requestId: crypto.randomUUID() });
    await until(() => app.limits.waitFor(Number(id)) !== undefined, "the wait");

    return id;
}

/** Nothing is wider than the screen, and these stay inside it. */
const fits = (selectors: string[]) =>
    inPage<boolean>(`
        const scroller = document.querySelector("main.scroller");
        const inside = ${JSON.stringify(selectors)}.every((selector) => {
            const box = document.querySelector(selector)?.getBoundingClientRect();

            return box !== undefined && box.left >= 0 && box.right <= innerWidth + 0.5;
        });

        return JSON.stringify(inside && scroller.scrollWidth <= scroller.clientWidth);
    `);

test("the live line, the limited square, the account card, and Move, at 1280 and 390 px", real, async () => {
    behave = (token) => (token === "tok-work" ? { text: "Answered through the Work account." } : fiveHourLimit(reset));

    const id = await session("refactor the parser");

    await page.setViewport(VIEWPORTS.desktop);
    await page.navigate(`${base}/s/${id}`);
    await until(async () => /Waiting for Anthropic's 5-hour limit.*next try in.*resets.*Retry now.*Stop/s.test(await text(".live-line")), "the live line");
    await until(async () => /Move to Anthropic · Work/.test(await text(".limit-card")), "the account card");
    assert.match(await text(".limit-card"), /Anthropic hit its 5-hour limit\. It resets at .+\(in 2h 1\dm\)\./);
    assert.match(await text(".limit-card"), /Anthropic · Work has room: 18% of its 5-hour used\./);
    assert.ok(await inPage<boolean>(`return JSON.stringify(document.querySelector('.sidebar .session-row[data-id="${id}"] .status-limit') !== null)`), "the row's limited square");
    assert.equal(await inPage<string>(`return JSON.stringify(document.querySelector('.sidebar .session-row[data-id="${id}"]').dataset.state)`), "limited");
    await shot("limit-wait-1280");

    await page.setViewport(VIEWPORTS.mobile);
    await page.navigate(`${base}/s/${id}`);
    await until(async () => /Retry now/.test(await text(".live-line")) && (await text(".limit-card")) !== "", "the phone's view");
    assert.equal(await fits([".live-retry", ".live-line .stop", ".limit-card", ".limit-card .button.primary"]), true, "inside the column, no sideways scroll");
    // The card's two answers, one above the other, each as wide as the card's row.
    const answers = await inPage<{ widths: number[]; row: number; flex: string }>(`
        const row = document.querySelector(".limit-card-actions");
        const buttons = [...row.querySelectorAll(".button")];

        return JSON.stringify({ widths: buttons.map((each) => Math.round(each.getBoundingClientRect().width)), row: Math.round(row.getBoundingClientRect().width), flex: getComputedStyle(buttons[0]).flex });
    `);

    assert.ok(answers.widths.every((width) => width === answers.row), JSON.stringify(answers));
    await shot("limit-wait-390");

    // Move: the request goes through Work, and the session answers.
    await page.click({ selector: ".limit-card .button.primary" });
    await until(async () => (await app.agentState(id))?.model?.provider === "anthropic~work" && !app.isBusy(id), "the move and the answer");
    await until(async () => (await text(".limit-card")) === "", "the card to go");
});

test("Retry now sends the request; the phone's list shows the square; Providers has the wait and the notice switch", real, async () => {
    behave = () => fiveHourLimit(reset);

    const id = await session("check the logs");

    await page.setViewport(VIEWPORTS.mobile);
    await page.navigate(`${base}/`);
    await until(async () => await inPage<boolean>(`return JSON.stringify(document.querySelector('.home-list .session-row[data-id="${id}"] .status-limit') !== null)`), "the phone list's square");
    await shot("limit-list-390");

    await page.setViewport(VIEWPORTS.desktop);
    await inPage(`const { openSheet } = await import("/store.js"); openSheet({ type: "providers" }); return "1"`);
    await until(async () => /Wait for a limit.*Off.*1 h.*6 h.*12 h.*24 h.*Tell me when a run waits 10 minutes or more/s.test(await text(".limit-wait")), "the setting");
    assert.equal(await inPage<string>(`return JSON.stringify([...document.querySelectorAll(".limit-wait .segmented button")].find((each) => each.classList.contains("on"))?.innerText.trim())`), "6 h");
    await shot("limit-providers-1280");
    await page.setViewport(VIEWPORTS.mobile);
    await shot("limit-providers-390");

    // The notice switch, as the owner turns it off and on.
    await page.click({ selector: ".limit-wait .switch" });
    await until(() => !app.config.limitNotice, "the notice off");
    await page.click({ selector: ".limit-wait .switch" });
    await until(() => app.config.limitNotice, "the notice on");

    await page.press("Escape");
    await page.navigate(`${base}/s/${id}`);
    await until(async () => /Retry now/.test(await text(".live-line")), "the live line");
    behave = () => ({ text: "answered" });
    await page.click({ selector: ".live-retry" });
    await until(() => !app.isBusy(id), "the answer after Retry now");
});
