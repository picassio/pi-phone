// The owner's card before a click or step that may pay, send, book or delete (PP-455), in a real browser at 390, 1280
// and 1920 px: what Pi would click (in the page's words), where, and why it asks, with Deny and Approve once; Approve
// once answers the card; nothing in it runs past the screen, its text keeps its contrast and size, and its buttons take
// a 40 px tap on a phone. With PHONE_SHOTS, screenshots and the layout check's report go there.
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
    browsers = new Browsers({ dataDir: mkdtempSync(join(root, "risky-ui-")), load: async () => undefined, save: () => {} });
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

/** A card as browser_click asks it before Pay, waiting in the session; the promise is its answer. */
function ask(place: "browser" | "computer"): Promise<ApprovalAnswer> {
    cards += 1;

    return app.approvals.request(
        {
            id: `risky-ui-${cards}`,
            conversationId: session,
            taskId: cards as never,
            callId: `call-${cards}`,
            tool: place === "browser" ? "browser_click" : "computer_act",
            subject: place === "browser" ? "Pay 49.00 EUR now" : "push button Send",
            reason: "It may pay, send, book or delete (pay). Approve once lets this one action go ahead; Deny stops it.",
            form:
                place === "browser"
                    ? { type: "risky", control: "Pay 49.00 EUR now", word: "pay", found: "name", where: "Your cart \u2014 https://shop.example.test/cart", place }
                    : { type: "risky", control: "push button Send", word: "send", found: "name", where: "Mail \u2014 Mail", place },
            createdAt: Date.now(),
        },
        context,
    );
}

/** The layout check's report now, as the screenshot tool gives it; with PHONE_SHOTS, a picture and the report saved too. */
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

/** The kinds the ui-verify skill must bring to zero, of what is in the card. */
async function mustFix(report: Awaited<ReturnType<typeof measure>>) {
    const kinds = report.found.filter((each) => ["cut", "covered", "contrast", "small-text", "emoji", "small-target"].includes(each.kind));
    const inCard = await inPage<boolean[]>(
        `return JSON.stringify(${JSON.stringify(kinds.map((each) => each.what.split(" ")[0]))}.map((selector) => { try { return document.querySelector("[data-risky]").querySelector(selector) !== null; } catch { return true; } }))`,
    );

    return kinds.filter((_, index) => inCard[index]);
}

for (const [viewport, label] of [[VIEWPORTS.mobile, "390"], [VIEWPORTS.desktop, "1280"], [LARGE, "1920"]] as const) {
    test(`at ${label} px: the card says what Pi would click, where and why; Approve once answers it (PP-455)`, real, async () => {
        await page.setViewport(viewport);
        const answered = ask("browser");

        await page.navigate(`${base}/s/${Number(session)}`);
        await present("[data-risky]", "the card");

        const text = await inPage<string>(`return JSON.stringify(document.querySelector("[data-risky]").innerText.trim().replace(/\\s+/g, " "))`);

        assert.equal(
            text,
            "Pi asks before this click in its browser It may pay, send, book or delete. Approve once lets this one action go ahead; Deny stops it. Pay 49.00 EUR now Your cart \u2014 https://shop.example.test/cart Its name says \u201cpay\u201d. Deny Approve once",
        );

        const report = await measure(`risky-card-${label}`, viewport.width);

        assert.deepEqual(await mustFix(report), [], describeLayout(report));
        await page.evaluate(`[...document.querySelectorAll("[data-risky] button")].find((each) => each.innerText.trim() === "Approve once").click(); return "true";`);
        assert.deepEqual(await answered, { allow: true, by: owner(app).name });
        await until(async () => !(await inPage<boolean>(`return JSON.stringify(document.querySelector("[data-risky]") !== null)`)), "the card to go");
    });
}

test("at 390 px: computer control's card says it is a step on your computer; Deny answers it (PP-455)", real, async () => {
    await page.setViewport(VIEWPORTS.mobile);
    const answered = ask("computer");

    await page.navigate(`${base}/s/${Number(session)}`);
    await present("[data-risky]", "the card");
    assert.match(await inPage<string>(`return JSON.stringify(document.querySelector("[data-risky]").innerText)`), /^Pi asks before this step on your computer[\s\S]*push button Send[\s\S]*Mail \u2014 Mail/);
    await measure("risky-card-computer-390", 390);
    await page.evaluate(`[...document.querySelectorAll("[data-risky] button")].find((each) => each.innerText.trim() === "Deny").click(); return "true";`);
    assert.equal((await answered).allow, false);
});
