// /review in a real browser at a phone's width (PP-357, the owner's mockup of 2026-11-02): the command alone opens the
// sheet (what to review, the open pull requests from gh, a focus); Review sends `/review pr 7`, which shows as typed;
// the reviewer's report is a card with the verdict, the findings by priority, what a person should check, and Fix
// these, which puts the fix message in the message box without sending it. With PHONE_SHOTS, screenshots go there.
import { type App, cleanUp, cleanUpAll, newSession, openApp, root, scriptedModel, until } from "./helpers.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createHandler } from "../src/server/http.ts";
import { Browsers } from "./support/browser.ts";
import { findBrowser } from "./support/browser/discovery.ts";
import type { BrowserPage } from "./support/browser/page.ts";
import { VIEWPORTS } from "./support/browser/viewport.ts";

const real = { skip: findBrowser() === undefined ? "no Chromium-based browser on this machine" : false } as const;
const SHOTS = process.env.PHONE_SHOTS;
const repo = join(root, "review-ui-repo");
const bin = join(root, "review-ui-bin");
const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
const RESULT = {
    verdict: "needs attention",
    findings: [
        { priority: "P2", title: "Backoff duplicates waitBackoff()", file: "a.ts", line: 2, body: "The new delay helper repeats waitBackoff in net.ts; use that one." },
        { priority: "P1", title: "Retry loop never gives up on 4xx", file: "a.ts", line: 3, body: "A 401 or 413 is retried forever: the loop only stops on success.", suggestion: "if (response.status < 500) throw new UploadError(response.status);" },
    ],
    callouts: [{ label: "This change introduces a new dependency", text: "p-retry 6.2.1" }],
};

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
        throw new Error(`${error.message}; the page: ${await page.evaluate(`return JSON.stringify(document.body.innerText.slice(-1500))`)}`);
    });

async function shot(name: string): Promise<void> {
    if (SHOTS !== undefined) {
        mkdirSync(SHOTS, { recursive: true });
        await new Promise((resolve) => setTimeout(resolve, 500));
        writeFileSync(join(SHOTS, name), Buffer.from((await page.screenshot()).data, "base64"));
    }
}

const route: FauxResponseStep = (request) => {
    const messages = (request as { messages: { role: string; content: unknown }[] }).messages;
    const last = messages.at(-1)!;
    const text = typeof last.content === "string" ? last.content : JSON.stringify(last.content);

    if (/You are the subagent \\"review-pr-7\\"/.test(JSON.stringify(messages))) {
        return fauxAssistantMessage([fauxText(`One P1 and one P2.\n\n\`\`\`review-result\n${JSON.stringify(RESULT)}\n\`\`\``)]);
    }

    if (last.role === "user" && text.includes("<review-request>")) {
        const args = JSON.parse(/exactly these arguments: (\{.*?\})\. Then/.exec(text)![1]!) as Record<string, unknown>;

        return fauxAssistantMessage([fauxToolCall("review", args as never)], { stopReason: "toolUse" });
    }

    return fauxAssistantMessage([fauxText("Reviewing PR #7 in a subagent.")]);
};

before(async () => {
    if (real.skip !== false) {
        return;
    }

    mkdirSync(repo, { recursive: true });
    git("init", "-q", "-b", "master");
    git("config", "user.email", "t@t");
    git("config", "user.name", "t");
    writeFileSync(join(repo, "a.ts"), "export const a = 1;\n");
    git("add", ".");
    git("commit", "-q", "-m", "first");
    writeFileSync(join(repo, "a.ts"), "export const a = 1;\nwait();\nretry();\n");
    git("commit", "-qam", "Add retry");

    const origin = join(root, "review-ui-origin.git");

    execFileSync("git", ["clone", "-q", "--bare", repo, origin]);
    execFileSync("git", ["-C", origin, "update-ref", "refs/pull/7/head", git("rev-parse", "HEAD")]);
    execFileSync("git", ["-C", origin, "update-ref", "refs/heads/master", git("rev-parse", "HEAD~1")]);
    git("remote", "add", "origin", origin);
    mkdirSync(bin, { recursive: true });
    writeFileSync(
        join(bin, "gh"),
        `#!/bin/sh
case "$1 $2" in
  "pr list") echo '[{"number":7,"title":"Add retry to the uploader","headRefName":"feature/upload-retry","baseRefName":"master","changedFiles":6}]' ;;
  "pr view") echo "{\\"number\\":7,\\"title\\":\\"Add retry to the uploader\\",\\"baseRefName\\":\\"master\\",\\"headRefOid\\":\\"$(git rev-parse HEAD)\\",\\"url\\":\\"https://github.com/o/r/pull/7\\",\\"changedFiles\\":6}" ;;
  *) echo "gh: $*" >&2; exit 1 ;;
esac
`,
    );
    chmodSync(join(bin, "gh"), 0o755);
    process.env.PATH = `${bin}:${process.env.PATH}`;

    app = await openApp(scriptedModel(route), join(root, "review-ui-data"));
    session = Number(await newSession(app, repo));
    server = createServer(createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    browsers = new Browsers({ dataDir: mkdtempSync(join(root, "review-ui-browser-")), load: async () => undefined, save: () => {} });
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

test("/review alone opens the sheet; Review sends /review pr 7; the report is a card; Fix these fills the box, unsent", real, async () => {
    await see(`return JSON.stringify(document.querySelector(".composer textarea") !== null)`, "the message box");
    await page.type({ selector: ".composer textarea" }, "/review");
    await page.press("Enter");
    await see(`return JSON.stringify(document.querySelector('[data-part="review-kind"]') !== null)`, "the sheet");
    await page.evaluate(`[...document.querySelectorAll('[data-part="review-kind"] button')].find((button) => button.textContent.trim() === "Pull request").click(); return "true";`);
    await see(`return JSON.stringify(/#7 Add retry to the uploader/.test(document.querySelector('[data-part="review-pr"]')?.textContent ?? ""))`, "the open pull request");
    assert.match(await inPage<string>(`return JSON.stringify(document.querySelector('[data-part="review-pr"]').textContent)`), /feature\/upload-retry → master · 6 files/);
    await page.evaluate(`const field = document.querySelector('[data-part="review-focus"] input'); field.value = "error handling"; field.dispatchEvent(new Event("input", { bubbles: true })); return "true";`);
    await shot("review-sheet-390.jpg");
    await page.evaluate(`document.querySelector('[data-part="review-start"]').click(); return "true";`);

    await see(`return JSON.stringify(document.querySelector('[data-part="review-card"]') !== null)`, "the review card");
    assert.equal(await inPage<string>(`return JSON.stringify(document.querySelector(".composer textarea").value)`), "", "nothing left in the box");
    assert.match(await page.evaluate(`return JSON.stringify(document.body.innerText)`), /\/review pr 7 --extra \\"error handling\\"/, "the command as sent");

    const card = await inPage<{ text: string; findings: string[]; post: boolean; user: string[] }>(
        `const card = document.querySelector('[data-part="review-card"]');
        return JSON.stringify({
            text: card.innerText,
            findings: [...card.querySelectorAll('[data-part="review-finding"] .review-finding-title')].map((row) => row.innerText.replace(/\\s+/g, " ")),
            post: card.querySelector('[data-part="review-post"]') !== null,
            user: [...document.querySelectorAll(".user-entry, .entry.user")].map((each) => each.innerText),
        });`,
    );

    assert.match(card.text, /Review · PR #7 · Add retry to the uploader/);
    assert.match(card.text, /6 files/);
    assert.match(card.text, /Needs attention/);
    assert.deepEqual(card.findings, ["P1 Retry loop never gives up on 4xx", "P2 Backoff duplicates waitBackoff()"], "by priority");
    assert.match(card.text, /a\.ts:3[\s\S]*if \(response\.status < 500\)/);
    assert.match(card.text, /For a person to check[\s\S]*This change introduces a new dependency: p-retry 6\.2\.1/);
    assert.equal(card.post, true, "Post to GitHub for a pull request");
    assert.doesNotMatch(await page.evaluate(`return JSON.stringify(document.body.innerText)`), /review-request|exactly these arguments/, "the request Pi got stays out of sight");
    await page.evaluate(`document.querySelector('[data-part="review-card"]').scrollIntoView({ block: "start" }); return "true";`);
    await shot("review-card-390.jpg");

    await page.evaluate(`document.querySelector('[data-part="review-fix"]').click(); return "true";`);
    await see(`return JSON.stringify(document.querySelector(".composer textarea").value.startsWith("Fix the findings of the review of PR #7"))`, "the fix message in the box");
    assert.match(await inPage<string>(`return JSON.stringify(document.querySelector(".composer textarea").value)`), /1\. \[P1\] Retry loop never gives up on 4xx \(a\.ts:3\)/);
    await shot("review-fix-390.jpg");
});
