// Review's comments and "Since last review" in a real browser at a phone's width (PP-358, the owner's mockup of
// 2026-11-02): a tap on a line number opens the comment box under the line; a comment and a file note are kept; Send
// review puts pi-review-loop's feedback in the message box, unsent, and afterwards "Since last review" shows nothing new
// until the folder changes again, while vs HEAD marks the file reviewed. With PHONE_SHOTS, screenshots go there.
import { type App, cleanUp, cleanUpAll, newSession, openApp, root, scriptedModel, until } from "./helpers.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { createHandler } from "../src/server/http.ts";
import { Browsers } from "./support/browser.ts";
import { findBrowser } from "./support/browser/discovery.ts";
import type { BrowserPage } from "./support/browser/page.ts";
import { VIEWPORTS } from "./support/browser/viewport.ts";

const real = { skip: findBrowser() === undefined ? "no Chromium-based browser on this machine" : false } as const;
const SHOTS = process.env.PHONE_SHOTS;
const repo = join(root, "review-loop-ui-repo");
const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();

let app: App;
let server: Server;
let browsers: Browsers;
let page: BrowserPage;
let base = "";
let session = 0;

async function inPage<T>(script: string): Promise<T> {
    return JSON.parse(await page.evaluate(script)) as T;
}

const see = (script: string, what: string) =>
    until(async () => (await inPage<boolean>(script)) === true, what, 30_000).catch(async (error: Error) => {
        throw new Error(`${error.message}; the page: ${await page.evaluate(`return JSON.stringify(document.body.innerText.slice(0, 2000))`)}; errors: ${await page.evaluate(`return JSON.stringify(window.__errors ?? [])`)}`);
    });

async function shot(name: string): Promise<void> {
    if (SHOTS !== undefined) {
        mkdirSync(SHOTS, { recursive: true });
        await new Promise((resolve) => setTimeout(resolve, 500));
        writeFileSync(join(SHOTS, name), Buffer.from((await page.screenshot()).data, "base64"));
    }
}

const click = (selector: string) => page.evaluate(`document.querySelector(${JSON.stringify(selector)}).click(); return "true";`);
const typeInto = (selector: string, text: string) =>
    page.evaluate(`const field = document.querySelector(${JSON.stringify(selector)}); field.value = ${JSON.stringify(text)}; field.dispatchEvent(new Event("input", { bubbles: true })); return "true";`);

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
    app = await openApp(scriptedModel(() => fauxAssistantMessage([fauxText("ok")])), join(root, "review-loop-ui-data"));
    session = Number(await newSession(app, repo));
    server = createServer(createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    browsers = new Browsers({ dataDir: mkdtempSync(join(root, "review-loop-ui-browser-")), load: async () => undefined, save: () => {} });
    page = await browsers.open(1);
    await page.setViewport(VIEWPORTS.mobile);
    await page.navigate(`${base}/login?token=${encodeURIComponent(app.config.ownerToken)}&next=${encodeURIComponent(`/s/${session}`)}`);
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

test("a comment on a line and a file note; Send review fills the box; then nothing new since, and vs HEAD says reviewed", real, async () => {
    // What the page says went wrong, for a failure's message.
    await page.evaluate(`window.__errors = []; addEventListener("error", (event) => window.__errors.push(event.message)); const said = console.error; console.error = (...args) => { window.__errors.push(args.map(String).join(" ").slice(0, 300)); said(...args); }; return "true";`);
    await see(`return JSON.stringify(document.querySelector(".composer textarea") !== null)`, "the message box");
    await page.type({ selector: ".composer textarea" }, "/changes");
    await page.press("Enter");
    await see(`return JSON.stringify(document.querySelector('[data-part="review-loop"]') !== null && document.querySelector('.dv-n[data-side="new"][data-n="6"]') !== null)`, "Review, since HEAD, with its lines");
    assert.match(await inPage<string>(`return JSON.stringify(document.querySelector('[data-part="review-loop"]').innerText)`), /1 file changed from HEAD, not reviewed yet/);

    // A tap on new line 6 opens the box under it; a comment is kept and shows there.
    await click('.dv-n[data-side="new"][data-n="6"]');
    await see(`return JSON.stringify(document.querySelector('.dv-comment-row [data-part="comment-box"]') !== null)`, "the comment box under the line");
    await typeInto('[data-part="comment-box"] textarea', "Backoff never stops: cap the tries.");
    await shot("review-comment-box-390.jpg");
    await click('[data-part="comment-save"]');
    await see(`return JSON.stringify(/Line 6[\\s\\S]*Backoff never stops/.test(document.querySelector('.dv-comment-row [data-part="comment"]')?.innerText ?? ""))`, "the comment under line 6");

    // A note on the whole file.
    await click('[data-part="file-note"]');
    await see(`return JSON.stringify(document.querySelector('.dv-notes [data-part="comment-box"]') !== null)`, "the note's box");
    await typeInto('.dv-notes [data-part="comment-box"] textarea', "Add a test for the backoff.");
    await click('.dv-notes [data-part="comment-save"]');
    await see(`return JSON.stringify(/Send review · 2/.test(document.querySelector('[data-part="review-send"]')?.innerText ?? ""))`, "two comments to send");
    await page.evaluate(`document.querySelector('[data-part="review-loop"]').scrollIntoView({ block: "start" }); return "true";`);
    await shot("review-comments-390.jpg");

    await click('[data-part="review-send"]');
    await see(`return JSON.stringify(document.querySelector(".composer textarea").value.startsWith("Please address the following review feedback:"))`, "the feedback in the box");
    assert.equal(
        await inPage<string>(`return JSON.stringify(document.querySelector(".composer textarea").value)`),
        "Please address the following review feedback:\n\n1. upload.ts:6 (current)\n   Backoff never stops: cap the tries.\n\n2. upload.ts\n   Add a test for the backoff.",
    );
    // On a phone the tile covered the screen: it went, so the message box shows.
    await see(`return JSON.stringify(document.querySelector('[data-part="review-loop"]') === null)`, "the tile gone");

    // Nothing new since; vs HEAD shows the file, reviewed.
    await page.evaluate(`const box = document.querySelector(".composer textarea"); box.value = "/changes"; box.dispatchEvent(new Event("input", { bubbles: true })); return "true";`);
    await page.press("Enter");
    await see(`return JSON.stringify(document.querySelector('[data-part="review-nothing-new"]') !== null)`, "nothing new since the review");
    await shot("review-nothing-new-390.jpg");
    await click('[data-part="review-head"]');
    await see(`return JSON.stringify(/reviewed/.test(document.querySelector(".dr-file")?.innerText ?? ""))`, "the file marked reviewed");

    // A change after the review: only that shows since.
    writeFileSync(join(repo, "upload.ts"), "export async function upload(file) {\n  let tries = 0;\n  for (;;) {\n    const response = await send(file);\n    if (response.ok) return;\n    if (tries > 5) throw new Error(\"gave up\");\n    await waitBackoff(tries++);\n  }\n}\n");
    await click('[data-part="review-since"]');
    await click('.dr-actions button[aria-label="Refresh"]');
    await see(`return JSON.stringify(document.querySelector('.dv-n[data-side="new"][data-n="6"]') !== null && /gave up/.test(document.querySelector(".dr-file")?.innerText ?? ""))`, "the change after the review");
    assert.doesNotMatch(await inPage<string>(`return JSON.stringify([...document.querySelectorAll(".dv-row.add")].map((row) => row.innerText).join("\\n"))`), /let tries = 0/, "what was reviewed is not new");
});
