// A Gemini Enterprise account in the model picker and the top bar, in a real browser (PP-555): its catalog (one model
// per effort, no families, as captured) shows one model per family with the efforts as thinking levels, its sorted
// ones first and then its other agent models (Gemini 4 Neon, Claude); each row's plan figures are its own model's
// buckets, named by the effort, without Google's one group name "All Models"; the session's meter and its bars are the
// session model's; a model the license's administrator has not enabled says so in the session, once. Google is stood
// in for with the captured catalog and quota (neutral values). With PHONE_SHOTS, screenshots and layout reports go there.
import { type App, cleanUp, cleanUpAll, home, owner, pastWelcome, root, say, work } from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { AGY_PROVIDER, type AgySend } from "../src/server/antigravity.ts";
import { createHandler } from "../src/server/http.ts";
import { describeLayout, layoutCheck, parseLayout } from "../src/server/layout-check.ts";
import { Browsers } from "./support/browser.ts";
import { findBrowser } from "./support/browser/discovery.ts";
import type { BrowserPage } from "./support/browser/page.ts";
import { VIEWPORTS } from "./support/browser/viewport.ts";
import { ENTERPRISE_FULL_CATALOG, ENTERPRISE_FULL_QUOTA } from "./support/enterprise-catalog.ts";

const { PocketApp } = await import("../src/server/app.ts");

const real = { skip: findBrowser() === undefined ? "no Chromium-based browser on this machine" : false } as const;
const SHOTS = process.env.PHONE_SHOTS;
const WORK = `${AGY_PROVIDER}~work`;

let app: App;
let server: Server;
let browsers: Browsers;
let page: BrowserPage;
let base = "";

let turns = 0;

/**
 * Google, as captured for a Gemini Enterprise license: its catalog and its quota; a turn is refused as one on a model
 * its administrator has not enabled; anything else answers empty.
 */
const send: AgySend = async (url) => {
    const turn = url.includes(":streamGenerateContent");
    const body = url.includes(":fetchAvailableModels")
        ? ENTERPRISE_FULL_CATALOG
        : url.includes(":retrieveUserQuotaSummary")
          ? ENTERPRISE_FULL_QUOTA
          : turn
            ? { error: { code: 403, status: "PERMISSION_DENIED", message: "Requested model is not allowed by your administrator. Select a different model or reach out to your administrator to enable 'gemini-4-neon-high'." } }
            : {};

    turns += turn ? 1 : 0;

    return {
        status: turn ? 403 : 200,
        headers: new Headers({ "content-type": "application/json" }),
        body: (async function* () {
            yield new TextEncoder().encode(JSON.stringify(body));
        })(),
    };
};

before(async () => {
    if (real.skip) {
        return;
    }

    const agent = join(root, "agent");

    mkdirSync(agent, { recursive: true });
    // A Gemini Enterprise sign-in as `antigravity.ts` keeps one (a stand-in token, a neutral project).
    writeFileSync(
        join(agent, "auth.json"),
        JSON.stringify({
            [WORK]: {
                type: "oauth",
                access: "ya29.stand-in",
                refresh: "1//stand-in",
                expires: Date.now() + 30 * 86_400_000,
                projectId: "example-project-123",
                osType: "linux",
                arch: "amd64",
                authMethod: "gcp",
                location: "global",
                userTier: "gcp-ge-plus-tier",
                tierName: "Gemini Enterprise Plus",
            },
        }),
    );
    app = await PocketApp.open({
        dataDir: join(root, "agy-enterprise-ui-data"),
        defaultCwd: work,
        supervised: false,
        log: () => {},
        home,
        antigravity: { send, platform: { osType: "linux", arch: "amd64" } },
        officecli: { runs: false },
    });
    pastWelcome(app);
    app.accounts.add(AGY_PROVIDER, "Work");
    await app.models.refresh({ providers: [WORK], allowNetwork: true, force: true });
    app.providers.modelsChanged();
    await app.usageLimits.get(WORK, true);
    server = createServer(createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    browsers = new Browsers({ dataDir: mkdtempSync(join(root, "agy-enterprise-ui-")), load: async () => undefined, save: () => {} });
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
const present = (selector: string, what: string) => until(() => inPage<boolean>(`return JSON.stringify(document.querySelector(${JSON.stringify(selector)}) !== null)`), what);
const rect = (selector: string) => page.evaluate(`const box = document.querySelector(${JSON.stringify(selector)})?.getBoundingClientRect(); return JSON.stringify(box ? [box.x, box.y, box.width, box.height] : null);`);

/** A real click on what the selector finds, once it stands still. */
async function click(selector: string): Promise<void> {
    let last = "";

    await until(async () => {
        const now = await rect(selector);
        const still = now !== "null" && now === last;

        last = now;
        await new Promise((resolve) => setTimeout(resolve, 100));

        return still;
    }, `${selector} standing still`);
    await page.click({ selector });
}

/** The open picker's rows: name and line, for the Work account's models. */
const rows = () =>
    inPage<string[]>(
        `return JSON.stringify([...document.querySelectorAll(".model-menu .pop-menu-row")].map((row) => row.innerText.trim().split(/\\s*\\n\\s*/).join(" | ")).filter((row) => /Work account/.test(row)))`,
    );

/** A picture and the layout check's report, with PHONE_SHOTS. */
async function shot(name: string, width: number): Promise<void> {
    if (SHOTS === undefined) {
        return;
    }

    mkdirSync(SHOTS, { recursive: true });
    await new Promise((resolve) => setTimeout(resolve, 600));
    const report = parseLayout(JSON.parse(await page.evaluate(`return JSON.stringify(${layoutCheck(width)})`)), width);

    writeFileSync(join(SHOTS, `${name}.jpg`), Buffer.from((await page.screenshot()).data, "base64"));
    writeFileSync(join(SHOTS, `${name}.layout.txt`), `${report === undefined ? "no report" : describeLayout(report)}\n`);
}

for (const [viewport, label] of [
    [VIEWPORTS.mobile, "390"],
    [VIEWPORTS.desktop, "1280"],
    [{ ...VIEWPORTS.desktop, width: 1920 }, "1920"],
] as const) {
    test(`at ${label} px: the Gemini Enterprise account's models are its families, each with its own plan figures`, real, async () => {
        await page.setViewport(viewport);
        await page.navigate(`${base}/?sheet=para:settings`);
        await present('[data-part="wiki-capture-model"] .choice', "Wiki settings");
        await click('[data-part="wiki-capture-model"] .choice');
        await present(".model-menu", "the model picker");
        await until(async () => (await rows()).some((row) => /High 25%/.test(row)), "the account's figures");

        const listed = await rows();

        assert.deepEqual(
            listed.map((row) => row.split(" | ")[0]),
            ["Gemini 4 Carbon", "Gemini 4 Hydrogen", "Gemini 4 Argon", "Gemini 3.8 Flash", "Gemini 3.7 Flash", "Gemini 3.6 Flash", "Gemini 3.1 Pro", "Gemini 4 Neon", "Claude Opus 5.5"],
            "one model per family: the sorted ones, then the license's other agent models",
        );
        assert.equal(listed[0], "Gemini 4 Carbon | google-antigravity · Work account · Medium 0% · High 25% · Low 0%", "its own buckets, by effort");
        assert.equal(listed[1], "Gemini 4 Hydrogen | google-antigravity · Work account · High 50% · Medium 0%");
        assert.equal(listed[2], "Gemini 4 Argon | google-antigravity · Work account", "a model with no bucket: no figures");
        assert.equal(listed[7], "Gemini 4 Neon | google-antigravity · Work account · High 0% · XHigh 0%");
        assert.equal(listed[8], "Claude Opus 5.5 | google-antigravity · Work account · High 0%");
        assert.doesNotMatch(listed.join("\n"), /All Models|Flash Lite|Image/);
        await shot(`agy-enterprise-picker-${label}`, viewport.width);
        await page.press("Escape");
    });
}

test("a session on its model: the top bar's meter is that model's fullest bucket, and its bars are that model's efforts", real, async () => {
    await page.setViewport(VIEWPORTS.mobile);
    const { id } = await app.commands.createSession(owner(app), { cwd: work });

    await app.commands.configure(id, owner(app), { model: { provider: WORK, modelId: "gemini-4-carbon" }, thinkingLevel: "medium" });
    await page.navigate(`${base}/s/${id}`);
    await present(".usage-meter", "the usage meter");
    await until(async () => (await inPage<string>(`return JSON.stringify(document.querySelector(".usage-meter").innerText.trim())`)) === "High 25%", "the meter on the model's fullest bucket");
    await click(".usage-meter");
    await present(".usage-meter-panel .usage-window", "the bars");

    const bars = await inPage<string[]>(`return JSON.stringify([...document.querySelectorAll(".usage-meter-panel .usage-head")].map((head) => head.innerText.trim().split(/\\s*\\n\\s*/).join(" | ")))`);

    assert.deepEqual(bars, ["Medium | 0% used", "High | 25% used", "Low | 0% used"]);
    await shot("agy-enterprise-meter-390", 390);
});

test("a turn on a model the license's administrator has not enabled says so in the session, once, with no limit card", real, async () => {
    await page.setViewport(VIEWPORTS.mobile);
    const { id } = await app.commands.createSession(owner(app), { cwd: work });

    await app.commands.configure(id, owner(app), { model: { provider: WORK, modelId: "gemini-4-neon" }, thinkingLevel: "high" });
    await page.navigate(`${base}/s/${id}`);
    turns = 0;
    await say(app, id, "Reply with exactly: pong");
    await present(".error-box", "the error");

    const shown = await inPage<{ error: string; cards: number }>(
        `return JSON.stringify({ error: document.querySelector(".error-box").innerText.trim(), cards: document.querySelectorAll(".limit-switch, .limit-card, .live-limit").length })`,
    );

    assert.equal(shown.error, "Google Antigravity (403): Gemini 4 Neon is not enabled for this Gemini Enterprise license. Pick another model, or ask the license's administrator to enable it.");
    assert.equal(shown.cards, 0, "no limit's card nor wait");
    assert.equal(turns, 1, "asked once: no retry");
    await shot("agy-enterprise-not-allowed-390", 390);
});
