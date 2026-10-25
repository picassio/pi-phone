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
import { accountProvider } from "../src/server/accounts.ts";
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

/** Claude's usage endpoint: the default account's 5-hour window is full; Work, Home and the team's have room. */
const USED: Record<string, number> = { "tok-default": 100, "tok-work": 18, "tok-home": 42, "tok-team": 7 };
const usageFetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    const token = String(new Headers(init?.headers).get("authorization") ?? "").replace(/^Bearer /, "");
    const five = USED[token] ?? 0;

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
    writeFileSync(join(agent, "auth.json"), signIns({ anthropic: "tok-default", "anthropic~work": "tok-work", "anthropic~home": "tok-home", "anthropic~team-x": "tok-team" }));
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
    app.accounts.add("anthropic", "Home");
    // A team account's provider, as the team server's sync registers one here.
    app.models.registerNativeProvider(accountProvider(localAnthropic(provider.url), "anthropic~team-x", "Team X"));
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
/** The card's dropdown and Move: the account picked, what the dropdown shows, and Move's name for a screen reader. */
const picked = () =>
    inPage<{ to: string; shown: string; label: string } | null>(`
        const move = document.querySelector(".limit-card-move");

        return JSON.stringify(move === null ? null : {
            to: move.dataset.to,
            shown: move.querySelector(".choice").innerText.trim().split(/\\s*\\n\\s*/).join("\\n"),
            label: move.querySelector(".button")?.getAttribute("aria-label") ?? "",
        });
    `);

/** The dropdown's list, opened: each account's name and its window's use, in order. */
async function choices(): Promise<string[][]> {
    await page.click({ selector: ".limit-card-move .choice" });
    await until(async () => await inPage<boolean>(`return JSON.stringify(document.querySelector(".choice-menu .pop-menu-row") !== null)`), "the dropdown's list");

    return await inPage<string[][]>(`
        return JSON.stringify([...document.querySelectorAll(".choice-menu .pop-menu-row")].map((row) => [
            row.querySelector(".pop-menu-row-name").innerText.trim(),
            row.querySelector(".pop-menu-row-sub")?.innerText.trim() ?? "",
        ]));
    `);
}

/** The older usage banner over the composer (`usage.js`, UsageWarning) is on screen. */
const banner = () => inPage<boolean>(`return JSON.stringify(document.querySelector(".usage-warning") !== null)`);
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

test("the live line, the limited square, the account card with every account, and Move on the one chosen, at 1280 and 390 px", real, async () => {
    behave = (token) => (token === "tok-default" ? fiveHourLimit(reset) : { text: `Answered with ${token}.` });

    const id = await session("refactor the parser");

    await page.setViewport(VIEWPORTS.desktop);
    await page.navigate(`${base}/s/${id}`);
    await until(async () => /Waiting for Anthropic's 5-hour limit.*next try in.*resets.*Retry now.*Stop/s.test(await text(".live-line")), "the live line");
    await until(async () => (await picked()) !== null, "the account card");
    assert.match(await text(".limit-card"), /Anthropic hit its 5-hour limit\. It resets at .+\(in 2h 1\dm\)\./);
    // The first listed is picked: the person's own emptiest.
    assert.deepEqual(await picked(), { to: "anthropic~work", shown: "Anthropic · Work\n18% of 5-hour used", label: "Move to Anthropic · Work" });
    assert.match(await text(".limit-card-actions"), /^Wait until .+$/);
    assert.ok(await inPage<boolean>(`return JSON.stringify(document.querySelector('.sidebar .session-row[data-id="${id}"] .status-limit') !== null)`), "the row's limited square");
    assert.equal(await inPage<string>(`return JSON.stringify(document.querySelector('.sidebar .session-row[data-id="${id}"]').dataset.state)`), "limited");
    assert.equal(await banner(), false, "the usage banner over the composer is hidden while the card is up");
    await shot("limit-wait-1280");

    await page.setViewport(VIEWPORTS.mobile);
    await page.navigate(`${base}/s/${id}`);
    await until(async () => /Retry now/.test(await text(".live-line")) && (await picked()) !== null, "the phone's view");
    assert.equal(await fits([".live-retry", ".live-line .stop", ".limit-card", ".limit-card-move .choice", ".limit-card-move .button", ".limit-card-actions .button"]), true, "inside the column, no sideways scroll");
    // The dropdown and Move are touch-sized, and Wait is as wide as the card.
    const heights = await inPage<number[]>(`return JSON.stringify([".limit-card-move .choice", ".limit-card-move .button"].map((selector) => Math.round(document.querySelector(selector).getBoundingClientRect().height)))`);

    assert.ok(heights.every((height) => height >= 44), JSON.stringify(heights));
    const answers = await inPage<{ widths: number[]; row: number; flex: string }>(`
        const row = document.querySelector(".limit-card-actions");
        const buttons = [...row.querySelectorAll(".button")];

        return JSON.stringify({ widths: buttons.map((each) => Math.round(each.getBoundingClientRect().width)), row: Math.round(row.getBoundingClientRect().width), flex: getComputedStyle(buttons[0]).flex });
    `);

    assert.ok(answers.widths.every((width) => width === answers.row), JSON.stringify(answers));
    assert.equal(await banner(), false);
    await shot("limit-wait-390");

    // The dropdown lists every account: the person's own first, then the team's, marked, each the emptiest first.
    assert.deepEqual(await choices(), [
        ["Anthropic · Work", "18% of 5-hour used"],
        ["Anthropic · Home", "42% of 5-hour used"],
        ["Anthropic · Team X (team)", "7% of 5-hour used"],
    ]);
    await shot("limit-wait-390-open");

    // The person picks the second, not the emptiest, and moves: the request goes through Home, and the session answers.
    await page.click({ selector: ".choice-menu .pop-menu-row:nth-child(2)" });
    await until(async () => (await picked())?.to === "anthropic~home", "Home picked");
    assert.equal((await picked())?.label, "Move to Anthropic · Home");
    await page.click({ selector: ".limit-card-move .button" });
    await until(async () => (await app.agentState(id))?.model?.provider === "anthropic~home" && !app.isBusy(id), "the move and the answer");
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

    // The notice switch, as the owner turns it off and on. On a loaded machine the sheet may still slide in when the first
    // tap lands: tap again until it takes.
    const flip = async (on: boolean) => {
        for (let tries = 0; tries < 5 && app.config.limitNotice !== on; tries++) {
            await page.click({ selector: ".limit-wait .switch" });
            await until(() => app.config.limitNotice === on, `the notice ${on ? "on" : "off"}`, 3000).catch(() => undefined);
        }

        assert.equal(app.config.limitNotice, on);
    };

    await flip(false);
    await flip(true);

    await page.press("Escape");
    await page.navigate(`${base}/s/${id}`);
    await until(async () => /Retry now/.test(await text(".live-line")) && (await text(".limit-card")) !== "", "the live line and the card");
    assert.equal(await banner(), false, "no banner while the card is up");

    // Wait puts the card away: the banner of the full window shows again.
    await page.click({ selector: ".limit-card-actions .button" });
    await until(async () => (await text(".limit-card")) === "" && (await banner()), "the card gone, the banner back");
    assert.match(await text(".usage-warning"), /Default: 5-hour limit at 100%/);
    behave = () => ({ text: "answered" });
    await page.click({ selector: ".live-retry" });
    await until(() => !app.isBusy(id), "the answer after Retry now");
});

test("with none of the person's own accounts left, the card lists the team's, marked team, and Move goes there", real, async () => {
    await app.accounts.remove("anthropic~work");
    await app.accounts.remove("anthropic~home");
    behave = (token) => (token === "tok-team" ? { text: "Answered on the team's account." } : fiveHourLimit(reset));

    const id = await session("tidy the docs");

    await page.setViewport(VIEWPORTS.desktop);
    await page.navigate(`${base}/s/${id}`);
    await until(async () => (await picked()) !== null, "the team account's card");
    assert.deepEqual(await picked(), { to: "anthropic~team-x", shown: "Anthropic · Team X (team)\n7% of 5-hour used", label: "Move to Anthropic · Team X (team)" });
    assert.deepEqual(await choices(), [["Anthropic · Team X (team)", "7% of 5-hour used"]]);
    await page.press("Escape");
    await shot("limit-team-1280");
    await page.setViewport(VIEWPORTS.mobile);
    await page.navigate(`${base}/s/${id}`);
    await until(async () => (await text(".limit-card")) !== "", "the phone's card");
    await shot("limit-team-390");
    await page.click({ selector: ".limit-card-move .button" });
    await until(async () => (await app.agentState(id))?.model?.provider === "anthropic~team-x" && !app.isBusy(id), "the move and the answer");
});

test("the top bar's usage meter opens as a pop-up: a tap outside or Escape closes it, and another session starts with it closed", real, async () => {
    const make = async () => {
        const { id } = await app.commands.createSession(owner(app), { cwd: work });

        await app.commands.configure(id, owner(app), { model: { provider: "anthropic", modelId: MODEL_ID }, thinkingLevel: "off" });

        return id;
    };
    const first = await make();
    const second = await make();
    const panel = () => inPage<boolean>(`return JSON.stringify(document.querySelector(".usage-meter-panel") !== null)`);
    const openIt = async () => {
        await page.evaluate(`document.querySelector(".usage-meter").click()`);
        await until(panel, "the panel open");
    };

    await page.setViewport(VIEWPORTS.desktop);
    await page.navigate(`${base}/s/${first}`);
    await until(async () => inPage<boolean>(`return JSON.stringify(document.querySelector(".usage-meter") !== null)`), "the meter");
    await openIt();
    // A tap anywhere outside it.
    await page.evaluate(`document.querySelector("main").dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }))`);
    await until(async () => !(await panel()), "closed by a tap outside");
    await openIt();
    await page.press("Escape");
    await until(async () => !(await panel()), "closed by Escape");
    // Open, then another session: it starts closed (it was kept open on the device, and so open in every session).
    await openIt();
    await page.navigate(`${base}/s/${second}`);
    await until(async () => inPage<boolean>(`return JSON.stringify(document.querySelector(".usage-meter") !== null)`), "its meter");
    assert.equal(await panel(), false, "another session starts with it closed");
});
