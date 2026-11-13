// /better in a real browser (PP-506): in the "/" list with its description; while the helper works, the rows above the
// message box show its step, its tools and Stop; its rewrite lands in the box above what was typed meanwhile, with the
// notice, and nothing is sent; Esc on a desktop stops it. With BETTER_SHOTS, screenshots at 390, 1280 and 1920 px and
// the rows' markup (for the layout check) go there.
import { type App, cleanUp, cleanUpAll, context, lastText, newSession, openApp, root, say, scriptedModel, until } from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { ConversationId } from "@earendil-works/pi-durable";
import { createHandler } from "../src/server/http.ts";
import { BetterDoc } from "../src/server/better.ts";
import { Browsers } from "./support/browser.ts";
import { findBrowser } from "./support/browser/discovery.ts";
import type { BrowserPage } from "./support/browser/page.ts";
import { type Viewport, VIEWPORTS } from "./support/browser/viewport.ts";

const real = { skip: findBrowser() === undefined ? "no Chromium-based browser on this machine" : false } as const;
const SHOTS = process.env.BETTER_SHOTS;
const BOX = ".composer textarea";
const WIDE: Viewport = { width: 1920, height: 1080, scale: 1, mobile: false };

/** How long the slow helper's commands run, in seconds: long enough to look at the rows. */
let slowFor = 6;

const route: FauxResponseStep = (request) => {
    const all = JSON.stringify((request as { messages: unknown[] }).messages);
    const { text } = lastText(request as never);
    const prompt = /## Prompt to deepen\\n\\n(.*?)\\n\\n## Return/.exec(all)?.[1];

    if (prompt === undefined) {
        return fauxAssistantMessage([fauxText(`echo: ${text}`)]);
    }

    const done = all.split('"role":"toolResult"').length - 1;

    // The slow one reads three files, one failing, then answers (1) and (2), then sleeps, then writes.
    if (prompt.startsWith("slow") && done < 3) {
        const commands = ["cat docs/missing.md", "ls -la", `sleep ${slowFor}`];

        return fauxAssistantMessage(
            [...(done === 2 ? [fauxText("(1) A pro would read the logs.\n(2) The raw logs.")] : []), fauxToolCall("bash", { command: commands[done]! })],
            { stopReason: "toolUse" },
        );
    }

    return fauxAssistantMessage([fauxText(`(1) a\n(2) b\n(3) c\n(4) d\n<improved-prompt>\nBetter ${prompt}\n</improved-prompt>`)]);
};

let app: App;
let server: Server;
let browsers: Browsers;
let page: BrowserPage;
let base = "";
let session: ConversationId;

async function inPage<T>(script: string): Promise<T> {
    return JSON.parse(await page.evaluate(script)) as T;
}

const see = (script: string, what: string, timeoutMs = 30_000) =>
    until(async () => (await inPage<boolean>(script)) === true, what, timeoutMs).catch(async (error: Error) => {
        throw new Error(`${error.message}; the page: ${await page.evaluate(`return JSON.stringify(document.body.innerText.slice(-1500))`)}`);
    });

async function shot(name: string): Promise<void> {
    if (SHOTS !== undefined) {
        mkdirSync(SHOTS, { recursive: true });
        await new Promise((resolve) => setTimeout(resolve, 500));
        writeFileSync(join(SHOTS, name), Buffer.from((await page.screenshot()).data, "base64"));
    }
}

async function open(viewport: Viewport): Promise<void> {
    await page.setViewport(viewport);
    await page.navigate(`${base}/s/${Number(session)}`);
    await see(`return JSON.stringify(document.querySelector(${JSON.stringify(BOX)}) !== null)`, "the message box");
}

const boxValue = () => inPage<string>(`return JSON.stringify(document.querySelector(${JSON.stringify(BOX)}).value)`);
const lastId = async () => (await app.harness.snapshot(BetterDoc, session, context))?.last?.id;
const messages = async () => (await (await app.harness.conversation(session, context))!.entries({}, 200, undefined, context)).items.filter((entry) => entry.kind === "pi.user").length;

before(async () => {
    if (real.skip !== false) {
        return;
    }

    app = await openApp(scriptedModel(route), join(root, "better-ui-data"));
    session = await newSession(app);
    await say(app, session, "hello");
    server = createServer(createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    browsers = new Browsers({ dataDir: mkdtempSync(join(root, "better-ui-browser-")), load: async () => undefined, save: () => {} });
    page = await browsers.open(1);
    await page.setViewport(VIEWPORTS.mobile);
    await page.navigate(`${base}/login?token=${encodeURIComponent(app.config.ownerToken)}&next=${encodeURIComponent(`/s/${Number(session)}`)}`);
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

test("/better: in the list; the rows while it works; the rewrite above the draft, nothing sent", real, async () => {
    await open(VIEWPORTS.mobile);
    await page.type({ selector: BOX }, "/bet");
    await see(`return JSON.stringify([...document.querySelectorAll(".commands .command")].some((row) => row.querySelector(".command-name").textContent === "/better"))`, "/better in the list");
    assert.equal(
        await inPage<string>(`return JSON.stringify([...document.querySelectorAll(".commands .command")].find((row) => row.querySelector(".command-name").textContent === "/better").querySelector(".command-description").textContent)`),
        "Deepen a prompt, or the task in progress: a read-only helper puts the rewrite in your message box",
    );

    // Typed in the box, it starts the helper: the box empties, and the rows show.
    const sentBefore = await messages();

    await page.type({ selector: BOX }, "/better slow make the errors clearer");
    await page.press("Enter");
    await see(`return JSON.stringify(document.querySelector('[data-part="better-bar"]') !== null)`, "the rows");
    assert.equal(await boxValue(), "");
    // Meanwhile the person types: it stays, below the rewrite.
    await page.type({ selector: BOX }, "my own draft");
    await see(`return JSON.stringify(document.querySelectorAll(".better-tool").length === 3 && document.querySelector(".better-step").innerText.includes("(2 of 4)"))`, "three tools and the second answer", 20_000);

    const rows = await inPage<{ step: string; long: string; cells: string[]; tools: string[]; count: string; stop: boolean; time: string }>(`
        const bar = document.querySelector('[data-part="better-bar"]');

        return JSON.stringify({
            step: bar.querySelector(".better-step").innerText.trim(),
            long: bar.querySelector(".better-long").textContent.trim(),
            cells: [...bar.querySelectorAll(".better-cell")].map((cell) => cell.className.replace("better-cell", "").trim()),
            tools: [...bar.querySelectorAll(".better-tool")].reverse().map((tool) => tool.className.replace("better-tool is-", "").trim() + " " + tool.textContent.trim()),
            count: bar.querySelector(".better-count").textContent.trim(),
            stop: bar.querySelector(".better-stop") !== null,
            time: bar.querySelector(".better-time").textContent.trim(),
        });
    `);

    // A phone's row has the short form.
    assert.match(rows.step, /^Thinking\s*\(2 of 4\)$/);
    assert.equal(rows.long, "Finding the rawest material");
    assert.deepEqual(rows.cells, ["done", "done", "now", "", "", ""]);
    assert.deepEqual(rows.tools, ["failed cat docs/missing.md", "ok ls -la", `running sleep ${slowFor}`]);
    assert.equal(rows.count, "3 tools · 1 failed");
    assert.equal(rows.stop, true);
    assert.match(rows.time, /^\d+s$/);

    for (const [viewport, width] of [[VIEWPORTS.mobile, 390], [VIEWPORTS.desktop, 1280], [WIDE, 1920]] as const) {
        await page.setViewport(viewport);
        await shot(`better-rows-${width}.png`);

        // The rows alone, with the app's styles, for the layout check at each width.
        if (SHOTS !== undefined && width === 390) {
            const markup = await inPage<string>(`return JSON.stringify(document.querySelector('[data-part="better-bar"]').outerHTML)`);
            const attrs = await inPage<string>(`return JSON.stringify([...document.documentElement.attributes].map((a) => a.name + '="' + a.value + '"').join(" "))`);

            writeFileSync(join(SHOTS, "better-rows.html"), `<!doctype html><html ${attrs}><head><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="style.css"></head><body><footer class="composer-wrap" style="padding:8px"><div class="dock">${markup}</div></footer></body></html>`);
        }
    }

    await page.setViewport(VIEWPORTS.mobile);
    const before = await lastId();

    await until(async () => (await lastId()) !== before, "the rewrite", 30_000);
    await see(`return JSON.stringify(document.querySelector(${JSON.stringify(BOX)}).value.startsWith("Better slow"))`, "the rewrite in the box");
    assert.equal(await boxValue(), "Better slow make the errors clearer\n\nmy own draft");
    await see(`return JSON.stringify(document.body.innerText.includes("The improved prompt is in your message box, above what you typed. Edit it, then send."))`, "the notice");
    await see(`return JSON.stringify(document.querySelector('[data-part="better-bar"]') === null)`, "the rows gone");
    assert.equal(await messages(), sentBefore, "nothing was sent");
    await shot("better-result-390.png");

    // Opened again, the same result does not come into the box twice.
    await page.type({ selector: BOX }, "");
    await open(VIEWPORTS.mobile);
    await new Promise((resolve) => setTimeout(resolve, 800));
    assert.equal(await boxValue(), "");
});

test("Esc on a desktop stops the helper; the notice says nothing was sent", real, async () => {
    slowFor = 20;
    await open(VIEWPORTS.desktop);
    await page.type({ selector: BOX }, "/better slow again");
    await page.press("Enter");
    await see(`return JSON.stringify(document.querySelector('[data-part="better-bar"]') !== null)`, "the rows");
    await page.press("Escape");
    await see(`return JSON.stringify(document.body.innerText.includes("/better stopped; nothing was sent."))`, "the stopped notice");
    await see(`return JSON.stringify(document.querySelector('[data-part="better-bar"]') === null)`, "the rows gone");
    const last = (await app.harness.snapshot(BetterDoc, session, context))?.last;

    assert.equal(last?.ok === false && last.error, "cancelled");
});
