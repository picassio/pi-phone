// Settings › Hooks (PP-419) in a real browser at 390, 1280 and 1920 px: the Menu has the row; the sheet lists each hook
// with its words, a state and a switch, and the built-in behaviours beside them with their own setting's value; a switch
// turns its hook off in the app and back on; nothing runs past the screen, and every control takes a 40 px tap on a
// phone. With PHONE_SHOTS, screenshots and the layout check's report go there.
import { type App, cleanUp, cleanUpAll, context, lastText, newSession, openApp, owner, root, scriptedModel, work } from "./helpers.ts";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { createHandler } from "../src/server/http.ts";
import { describeLayout, layoutCheck, parseLayout } from "../src/server/layout-check.ts";
import { Browsers } from "./support/browser.ts";
import { findBrowser } from "./support/browser/discovery.ts";
import type { BrowserPage } from "./support/browser/page.ts";
import { VIEWPORTS } from "./support/browser/viewport.ts";

const real = { skip: findBrowser() === undefined ? "no Chromium-based browser on this machine" : false } as const;
const SHOTS = process.env.PHONE_SHOTS;
const LARGE = { width: 1920, height: 1080, scale: 1, mobile: false };
/** Pi edits a stylesheet once and ends without a look: the reminder hook's case (PP-422). */
const route: FauxResponseStep = (request) => {
    const { role, text } = lastText(request as never);

    return role === "user" && text.endsWith("edit the css")
        ? fauxAssistantMessage([fauxToolCall("write", { path: join(work, "site", "style.css"), content: "a { color: #111 }\n" })], { stopReason: "toolUse" })
        : fauxAssistantMessage([fauxText(role === "user" && text.startsWith("[via hook ui-reminder] ") ? "Checked: nothing to fix." : "Edited the stylesheet.")]);
};

let app: App;
let server: Server;
let browsers: Browsers;
let page: BrowserPage;
let base = "";

before(async () => {
    if (real.skip) {
        return;
    }

    app = await openApp(scriptedModel(route));
    server = createServer(createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    browsers = new Browsers({ dataDir: mkdtempSync(join(root, "hooks-ui-")), load: async () => undefined, save: () => {} });
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

/**
 * The kinds the ui-verify skill must bring to zero, of what is in the sheet (the session list behind it is not this
 * change's): a finding counts when its element (`span.name`, the words before its text) is found in the sheet.
 */
async function mustFix(report: Awaited<ReturnType<typeof measure>>) {
    const kinds = report.found.filter((each) => ["cut", "covered", "contrast", "small-text", "emoji", "small-target"].includes(each.kind));
    const inSheet = await inPage<boolean[]>(
        `return JSON.stringify(${JSON.stringify(kinds.map((each) => each.what.split(" ")[0]))}.map((selector) => { try { return document.querySelector(".sheet").querySelector(selector) !== null; } catch { return true; } }))`,
    );

    return kinds.filter((_, index) => inSheet[index]);
}

for (const [viewport, label] of [[VIEWPORTS.mobile, "390"], [VIEWPORTS.desktop, "1280"], [LARGE, "1920"]] as const) {
    test(`at ${label} px: the Menu's Hooks row opens Settings › Hooks; a switch turns its hook off and on (PP-419)`, real, async () => {
        await page.setViewport(viewport);
        await page.navigate(`${base}/`);
        await present(".rail, .sessions", "the app");
        await page.evaluate(`(await import("/store.js")).openSheet({ type: "menu" }); return "true";`);
        await present(".sheet .list-item", "the menu");

        const row = await inPage<string>(`return JSON.stringify([...document.querySelectorAll(".sheet .list-item")].map((each) => each.innerText.trim().replace(/\\s+/g, " ")).find((text) => text.startsWith("Hooks")) ?? "")`);

        assert.equal(row, "Hooks checks Pi cannot skip");
        await page.evaluate(`[...document.querySelectorAll(".sheet .list-item")].find((each) => each.innerText.trim().startsWith("Hooks")).click(); return "true";`);
        await present('[data-part="hook"]', "the hooks");

        const hooks = await inPage<{ id: string; text: string; state: string; checked: string | null }[]>(`return JSON.stringify([...document.querySelectorAll('[data-part="hook"]')].map((each) => ({
            id: each.dataset.hook,
            text: each.innerText.trim().replace(/\\s+/g, " "),
            state: each.querySelector('[data-part="state-tag"]').innerText.trim(),
            checked: each.querySelector('[role="switch"]').getAttribute("aria-checked"),
        })))`);

        assert.deepEqual(hooks.map((hook) => [hook.id, hook.state, hook.checked]), [["artifactCheck", "On", "true"], ["uiReminder", "On", "true"]]);
        assert.match(hooks[0]!.text, /^Check artifacts on publish On Renders the artifact at 390, 1280 and 1920 px/);
        assert.match(hooks[1]!.text, /^Remind to check UI before finishing On Sends Pi one follow-up/);

        const builtIn = await inPage<string[]>(`return JSON.stringify([...document.querySelectorAll('[data-part="hook-built-in"]')].map((each) => each.innerText.trim().replace(/\\s+/g, " ")))`);

        assert.equal(builtIn.length, 2);
        assert.match(builtIn[0]!, /^Capture idle sessions into the wiki After \d+ min idle/);
        assert.match(builtIn[1]!, /^Compact a full context When nearly full/);

        const before = await measure(`hooks-${label}`, viewport.width);

        assert.deepEqual(await mustFix(before), [], describeLayout(before));
        assert.equal(before.issues.length, 0, describeLayout(before));

        // Off from its switch: the app's setting, and the row says so.
        await page.evaluate(`document.querySelector('[data-hook="uiReminder"] [role="switch"]').click(); return "true";`);
        await until(() => !app.config.hookOn("uiReminder"), "the reminder off in the app");
        await until(async () => (await inPage<string>(`return JSON.stringify(document.querySelector('[data-hook="uiReminder"] [data-part="state-tag"]').innerText.trim())`)) === "Off", "the row says Off");
        await measure(`hooks-off-${label}`, viewport.width);
        await page.evaluate(`document.querySelector('[data-hook="uiReminder"] [role="switch"]').click(); return "true";`);
        await until(() => app.config.hookOn("uiReminder"), "the reminder on again");
    });
}

test("the reminder shows in the session as sent by the hook, by its name (PP-422)", real, async () => {
    const id = await newSession(app);
    const { submissionId } = await app.commands.submit(id, owner(app), { text: "edit the css", requestId: crypto.randomUUID() });

    await (await app.harness.submission(submissionId, context))!.wait(context);
    await app.harness.waitForIdle(context);

    for (const [viewport, label] of [[VIEWPORTS.mobile, "390"], [LARGE, "1920"]] as const) {
        await page.setViewport(viewport);
        await page.navigate(`${base}/s/${String(id)}`);
        await present('[data-part="prompt-row"]', "the transcript");
        await until(async () => (await inPage<string[]>(`return JSON.stringify([...document.querySelectorAll('[data-part="prompt-head"]')].map((each) => each.innerText.trim().replace(/\\s+/g, " ")))`)).length >= 2, "both messages");

        const heads = await inPage<string[]>(`return JSON.stringify([...document.querySelectorAll('[data-part="prompt-head"]')].map((each) => each.innerText.trim().replace(/\\s+/g, " ")))`);
        const texts = await inPage<string[]>(`return JSON.stringify([...document.querySelectorAll('[data-part="prompt-text"]')].map((each) => each.innerText.trim()))`);

        assert.match(heads[1]!, /via the hook Remind to check UI before finishing$/);
        assert.match(texts[1]!, /^You changed UI after your last look at it: .*style\.css\./);
        await measure(`reminder-${label}`, viewport.width);
    }
});

test("Settings › Hooks opens by link, for Pi's screenshots (/?sheet=hooks)", real, async () => {
    await page.setViewport(VIEWPORTS.mobile);
    await page.navigate(`${base}/?sheet=hooks`);
    await present('[data-hook="artifactCheck"]', "the sheet by link");
});
