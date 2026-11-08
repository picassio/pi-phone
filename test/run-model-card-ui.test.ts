// Pi's run model on a real site (PP-456) in a real browser at 390, 1280 and 1920 px: the owner's card names the site,
// the setting's model and Pi's, and who gets the pages, with Deny and Approve once; Settings › Pi's browser has the
// test sites field, which saves browser.testSites. Nothing in them runs past the screen, their text keeps its contrast
// and size, and their controls take a 40 px tap on a phone. With PHONE_SHOTS, screenshots and the layout check's
// report go there.
import { type App, cleanUp, cleanUpAll, context, newSession, openApp, owner, root, scriptedModel } from "./helpers.ts";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai/providers/faux";
import type { ConversationId } from "@earendil-works/pi-durable";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { ApprovalAnswer } from "../src/server/host.ts";
import { createHandler } from "../src/server/http.ts";
import { describeLayout, layoutCheck, parseLayout } from "../src/server/layout-check.ts";
import { Browsers } from "./support/browser.ts";
import { findBrowser } from "./support/browser/discovery.ts";
import type { BrowserPage } from "./support/browser/page.ts";
import { VIEWPORTS } from "./support/browser/viewport.ts";

const real = { skip: findBrowser() === undefined ? "no Chromium-based browser on this machine" : false } as const;
const SHOTS = process.env.PHONE_SHOTS;
const LARGE = { width: 1920, height: 1080, scale: 1, mobile: false };
const WIDTHS = [[VIEWPORTS.mobile, "390"], [VIEWPORTS.desktop, "1280"], [LARGE, "1920"]] as const;

let app: App;
let server: Server;
let browsers: Browsers;
let page: BrowserPage;
let base = "";
let session: ConversationId;
let cards = 0;

before(async () => {
    if (real.skip) {
        return;
    }

    app = await openApp(scriptedModel(() => fauxAssistantMessage([fauxText("ok")])));
    server = createServer(createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    browsers = new Browsers({ dataDir: mkdtempSync(join(root, "run-model-card-ui-")), load: async () => undefined, save: () => {} });
    page = await browsers.open(1);
    await page.setViewport(VIEWPORTS.mobile);
    await page.navigate(`${base}/login?token=${encodeURIComponent(app.config.ownerToken)}`);
    session = await newSession(app);
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

/** The card browser_run asks with Jev on example.com, waiting in the session; the promise is its answer. */
function ask(): Promise<ApprovalAnswer> {
    cards += 1;

    return app.approvals.request(
        {
            id: `run-model-ui-${cards}`,
            conversationId: session,
            taskId: cards as never,
            callId: `call-${cards}`,
            tool: "browser_run",
            subject: "shop.example.com",
            reason: "browser_run would send this site's pages to typesafe/jev-1.14 through OpenRouter (openrouter.ai), not the setting's this session's model.",
            form: { type: "run-model", site: "shop.example.com", setting: "session", asked: "typesafe/jev-1.14", provider: "openrouter", place: "browser" },
            createdAt: Date.now(),
        },
        context,
    );
}

/** The layout check's report now; with PHONE_SHOTS, a picture and the report saved too. */
async function measure(name: string, width: number) {
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

/** The kinds the ui-verify skill must bring to zero, of what is in `within`. */
async function mustFix(report: Awaited<ReturnType<typeof measure>>, within: string) {
    const kinds = report.found.filter((each) => ["cut", "covered", "contrast", "small-text", "emoji", "small-target"].includes(each.kind));
    const inside = await inPage<boolean[]>(
        `return JSON.stringify(${JSON.stringify(kinds.map((each) => each.what.split(" ")[0]))}.map((selector) => { try { return document.querySelector(${JSON.stringify(within)}).querySelector(selector) !== null; } catch { return true; } }))`,
    );

    return kinds.filter((_, index) => inside[index]);
}

for (const [viewport, label] of WIDTHS) {
    test(`at ${label} px: the card names the site, the setting's model and Pi's, and OpenRouter; Approve once answers it (PP-456)`, real, async () => {
        await page.setViewport(viewport);
        const answered = ask();

        await page.navigate(`${base}/s/${Number(session)}`);
        await present("[data-run-model]", "the card");

        const text = await inPage<string>(`return JSON.stringify(document.querySelector("[data-run-model]").innerText.trim().replace(/\\s+/g, " "))`);

        assert.equal(
            text,
            "Pi asks to use another run model on this site Each step's page then goes to OpenRouter (openrouter.ai). Approve once is for this run; Deny runs it with the setting's model. shop.example.com The setting: the session's own model Pi asks for: typesafe/jev-1.14 Deny Approve once",
        );

        const report = await measure(`run-model-card-${label}`, viewport.width);

        assert.deepEqual(await mustFix(report, "[data-run-model]"), [], describeLayout(report));
        await page.evaluate(`[...document.querySelectorAll("[data-run-model] button")].find((each) => each.innerText.trim() === "Approve once").click(); return "true";`);
        assert.deepEqual(await answered, { allow: true, by: owner(app).name });
    });

    test(`at ${label} px: Settings › Pi's browser › Test sites saves browser.testSites (PP-456)`, real, async () => {
        app.setBrowserTestSites(owner(app), "none");
        await page.setViewport(viewport);
        await page.navigate(`${base}/?sheet=browser`);
        await present("[data-part=browser-test-sites] input", "the test sites row");
        await page.evaluate(`document.querySelector('[data-part=browser-test-sites]').scrollIntoView({ block: "center" }); return "true";`);

        const report = await measure(`browser-test-sites-${label}`, viewport.width);

        assert.deepEqual(await mustFix(report, "[data-part=browser-test-sites]"), [], describeLayout(report));
        await page.evaluate(`
            const input = document.querySelector('[data-part=browser-test-sites] input');
            input.value = "*.ts.net, Staging.Example.com";
            input.dispatchEvent(new Event('input', { bubbles: true }));
            return "true";`);
        await page.evaluate(`document.querySelector('[data-part=browser-test-sites] button').click(); return "true";`);
        await until(() => app.config.browserTestSites.join(",") === "*.ts.net,staging.example.com", "kept as browser.testSites");
        await until(() => inPage<boolean>(`return JSON.stringify(document.querySelector('[data-part=browser-test-sites]').innerText.includes("Saved."))`), "said saved");
        assert.equal(await inPage<string>(`return JSON.stringify(document.querySelector('[data-part=browser-test-sites] input').value)`), "*.ts.net, staging.example.com");
    });
}
