// No side stripes in pi-phone's own screens (PP-416, the owner's picks of 2026-11-06 on the mockup pp416-side-tab-mockup,
// after Impeccable's scan in PP-411): a key question in an interview has its accent border and a "Key decision" tag; the
// quoted passage above the message box a hairline frame with the reply arrow in the accent; a review comment and a file
// note in Changes their tint, rounded all round, led by the chat icon. The layout check finds no side-tab on any of them.
// In a real browser at a phone's width and a desktop's. With PHONE_SHOTS, screenshots and layout reports go there.
import { type App, cleanUp, cleanUpAll, lastText, newSession, openApp, owner, root, scriptedModel, until } from "./helpers.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createHandler } from "../src/server/http.ts";
import { describeLayout, layoutCheck, type LayoutReport, parseLayout } from "../src/server/layout-check.ts";
import { Browsers } from "./support/browser.ts";
import { findBrowser } from "./support/browser/discovery.ts";
import type { BrowserPage } from "./support/browser/page.ts";
import { VIEWPORTS } from "./support/browser/viewport.ts";

const real = { skip: findBrowser() === undefined ? "no Chromium-based browser on this machine" : false } as const;
const SHOTS = process.env.PHONE_SHOTS;
const repo = join(root, "side-stripes-repo");
const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
const QUESTIONS = JSON.stringify({
    title: "Where it lives",
    questions: [
        { id: "storage", type: "single", question: "Where do the session files live?", options: ["On the phone", "On a machine"], recommended: "On the phone", weight: "critical" },
        { id: "theme", type: "single", question: "Which theme for the new screen?", options: ["Tokyo night", "Light"] },
    ],
});
const route: FauxResponseStep = (request) => {
    const { role, text } = lastText(request as never);

    if (role === "user" && text === "ask") {
        return fauxAssistantMessage([fauxToolCall("interview", { questions: QUESTIONS, async: true })], { stopReason: "toolUse" });
    }

    return fauxAssistantMessage([fauxText("The build passes on the devbox. The tests that touch the composer ran twice, both green.")]);
};

let app: App;
let server: Server;
let browsers: Browsers;
let page: BrowserPage;
let base = "";

const inPage = async <T>(script: string): Promise<T> => JSON.parse(await page.evaluate(script)) as T;
const see = (script: string, what: string) => until(async () => (await inPage<boolean>(script)) === true, what, 30_000);
const click = (selector: string) => page.evaluate(`document.querySelector(${JSON.stringify(selector)}).click(); return "true";`);
const typeInto = (selector: string, text: string) =>
    page.evaluate(`const field = document.querySelector(${JSON.stringify(selector)}); field.value = ${JSON.stringify(text)}; field.dispatchEvent(new Event("input", { bubbles: true })); return "true";`);

/** The layout check on the page as it shows (and its picture and words, with PHONE_SHOTS). */
async function checked(name: string, width: number): Promise<LayoutReport> {
    await new Promise((resolve) => setTimeout(resolve, 600));
    const report = parseLayout(JSON.parse(await page.evaluate(`return JSON.stringify(${layoutCheck(width)})`)), width);

    assert.ok(report !== undefined, `${name}: a layout report`);

    if (SHOTS !== undefined) {
        mkdirSync(SHOTS, { recursive: true });
        writeFileSync(join(SHOTS, `${name}.jpg`), Buffer.from((await page.screenshot()).data, "base64"));
        writeFileSync(join(SHOTS, `${name}.layout.txt`), `${describeLayout(report)}\nTOTALS ${JSON.stringify(report.totals)}\nISSUES ${JSON.stringify(report.issues)}\n`);
    }

    return report;
}

/** Computed style properties of the first element `selector` finds. */
const look = (selector: string, ...properties: string[]) =>
    inPage<Record<string, string>>(`const s = getComputedStyle(document.querySelector(${JSON.stringify(selector)})); return JSON.stringify(Object.fromEntries(${JSON.stringify(properties)}.map((k) => [k, s.getPropertyValue(k)])));`);

const accent = () => inPage<string>(`const probe = document.createElement("i"); probe.style.color = "var(--accent)"; document.body.append(probe); const c = getComputedStyle(probe).color; probe.remove(); return JSON.stringify(c);`);

before(async () => {
    if (real.skip !== false) {
        return;
    }

    mkdirSync(repo, { recursive: true });
    git("init", "-q", "-b", "master");
    git("config", "user.email", "t@t");
    git("config", "user.name", "t");
    writeFileSync(join(repo, "upload.ts"), "export async function upload(file) {\n  for (;;) {\n    const response = await send(file);\n    if (response.ok) return;\n  }\n}\n");
    git("add", ".");
    git("commit", "-q", "-m", "first");
    writeFileSync(join(repo, "upload.ts"), "export async function upload(file) {\n  let tries = 0;\n  for (;;) {\n    const response = await send(file);\n    if (response.ok) return;\n    await waitBackoff(tries++);\n  }\n}\n");
    app = await openApp(scriptedModel(route), join(root, "side-stripes-ui-data"));
    server = createServer(createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    browsers = new Browsers({ dataDir: mkdtempSync(join(root, "side-stripes-ui-browser-")), load: async () => undefined, save: () => {} });
    page = await browsers.open(1);
    await page.navigate(`${base}/login?token=${encodeURIComponent(app.config.ownerToken)}`);
    await see(`return JSON.stringify((await import("/store.js")).store.state.me?.role === "owner")`, "signed in");
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

for (const [size, viewport] of [["390", VIEWPORTS.mobile], ["1280", VIEWPORTS.desktop]] as const) {
    const width = viewport.width;

    test(`at ${size} px: a key question in an interview has its border and a "Key decision" tag, no stripe`, real, async () => {
        const id = await newSession(app);

        await app.commands.submit(id, owner(app), { text: "ask", requestId: `ask-${id}` });
        await until(() => app.approvals.forConversation(id).length === 1, "the interview");
        await page.setViewport(viewport);
        await page.navigate(`${base}/s/${id}`);
        await see(`return JSON.stringify(document.querySelector('.interview-card .button.primary') !== null)`, "the card");
        await click(".interview-card .button.primary");
        await see(`return JSON.stringify(document.querySelector('.interview-question.critical') !== null)`, "the key question");

        const report = await checked(`interview-critical-${size}`, width);

        assert.equal(report.totals["side-tab"] ?? 0, 0, describeLayout(report));
        assert.equal((await look(".interview-question.critical", "box-shadow"))["box-shadow"], "none");
        assert.equal(
            await inPage<string>(`return JSON.stringify(document.querySelector('.interview-question.critical .interview-ask [data-part="state-tag"]')?.textContent ?? "")`),
            "Key decision",
        );
        assert.equal(await inPage<number>(`return JSON.stringify(document.querySelectorAll('.interview-question:not(.critical) [data-part="state-tag"]').length)`), 0, "only the key one");
    });

    test(`at ${size} px: the quoted passage above the message box has a hairline frame and the reply arrow in the accent`, real, async () => {
        const id = await newSession(app);

        await app.commands.submit(id, owner(app), { text: "status?", requestId: `q-${id}` });
        await page.setViewport(viewport);
        await page.navigate(`${base}/s/${id}`);
        await see(`return JSON.stringify([...document.querySelectorAll(".reply")].some((r) => r.textContent.includes("The build passes")))`, "the reply");
        await page.evaluate(`(await import("/store.js")).store.set({ replyQuote: "The tests that touch the composer ran twice, both green." }); return "true";`);
        await see(`return JSON.stringify(document.querySelector('[data-part="quote-strip"]') !== null)`, "the strip");
        await typeInto('[data-part="composer"] textarea', "which ones?");

        const report = await checked(`quote-strip-${size}`, width);
        const strip = await look('[data-part="quote-strip"]', "border-left-width", "border-right-width", "border-top-width");

        assert.equal(report.totals["side-tab"] ?? 0, 0, describeLayout(report));
        assert.deepEqual(strip, { "border-left-width": "1px", "border-right-width": "1px", "border-top-width": "1px" });
        assert.equal((await look('[data-part="quote-strip"] > .icon', "color")).color, await accent());
    });

    test(`at ${size} px: a review comment and a file note keep their tint, rounded, led by the chat icon`, real, async () => {
        const id = Number(await newSession(app, repo));

        await page.setViewport(viewport);
        await page.navigate(`${base}/s/${id}`);
        await see(`return JSON.stringify(document.querySelector(".composer textarea") !== null)`, "the message box");

        // /changes toggles the panel: one an earlier test left open closes, so open it again.
        for (let tries = 0; tries < 2 && !(await inPage<boolean>(`return JSON.stringify(document.querySelector('.dv-n[data-side="new"][data-n="6"]') !== null)`)); tries++) {
            await page.type({ selector: ".composer textarea" }, "/changes");
            await page.press("Enter");
            await new Promise((resolve) => setTimeout(resolve, 800));
        }

        await see(`return JSON.stringify(document.querySelector('.dv-n[data-side="new"][data-n="6"]') !== null)`, "the diff");
        await click('.dv-n[data-side="new"][data-n="6"]');
        await see(`return JSON.stringify(document.querySelector('.dv-comment-row [data-part="comment-box"]') !== null)`, "the comment box");
        await typeInto('[data-part="comment-box"] textarea', "Backoff never stops: cap the tries.");
        await click('[data-part="comment-save"]');
        await see(`return JSON.stringify(document.querySelector('.dv-comment-row [data-part="comment"]') !== null)`, "the comment");
        await click('[data-part="file-note"]');
        await see(`return JSON.stringify(document.querySelector('.dv-notes [data-part="comment-box"]') !== null)`, "the note's box");
        await typeInto('.dv-notes [data-part="comment-box"] textarea', "Add a test for the backoff.");
        await click('.dv-notes [data-part="comment-save"]');
        await see(`return JSON.stringify(document.querySelector('.dv-notes [data-part="comment"]') !== null)`, "the note");
        await page.evaluate(`document.querySelector('.dv-comment-row [data-part="comment"]').scrollIntoView({ block: "center" }); return "true";`);

        const report = await checked(`review-comment-${size}`, width);

        assert.equal(report.totals["side-tab"] ?? 0, 0, describeLayout(report));

        for (const where of [".dv-comment-row", ".dv-notes"]) {
            const comment = await look(`${where} [data-part="comment"]`, "border-left-width", "border-top-left-radius", "border-bottom-right-radius");

            assert.deepEqual(comment, { "border-left-width": "0px", "border-top-left-radius": "8px", "border-bottom-right-radius": "8px" }, where);
            assert.equal((await look(`${where} [data-part="comment"] .dv-comment-where > .icon`, "color")).color, await accent(), `${where}: the chat icon in the accent`);
        }
    });
}
