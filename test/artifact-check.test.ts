// The hook "Check artifacts on publish" (PP-421): the artifact tool renders what it published at the screenshot widths
// (here with the server edition's renderer on a real Chrome, as the phone's would) and Pi gets the layout check's words
// in the same result: a 28 px button is a tap target under 40 px at the phone's width. With the hook off, the result is
// the publish alone; Markdown is never rendered.
import { type App, cleanUp, context, lastText, modelTexts, newSession, openApp, owner, scriptedModel } from "./helpers.ts";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { after, before, test } from "node:test";
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { ChromeRenderer } from "../src/server/chrome-renderer.ts";
import { createHandler } from "../src/server/http.ts";
import { findBrowser } from "./support/browser/discovery.ts";

const chrome = findBrowser();
const real = { skip: chrome === undefined ? "no Chromium-based browser on this machine (CI runs it)" : false } as const;

/** A page whose one button is 28 px tall: a phone's tap target is 40. */
const SMALL = `<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><body style="margin:0;padding:16px;font:16px sans-serif;background:#fff;color:#111"><p>Order</p><button style="height:28px;padding:0 12px;font-size:14px">Buy now</button></body>`;

const route: FauxResponseStep = (request) => {
    const { role, text } = lastText(request as never);

    if (role === "user" && text.endsWith("publish small")) {
        return fauxAssistantMessage([fauxToolCall("artifact", { id: "shop", title: "Shop", content: SMALL })], { stopReason: "toolUse" });
    }

    if (role === "user" && text.endsWith("publish notes")) {
        return fauxAssistantMessage([fauxToolCall("artifact", { id: "notes", title: "Notes", type: "markdown", content: "# Notes\n\nText." })], { stopReason: "toolUse" });
    }

    return fauxAssistantMessage([fauxText(role === "toolResult" ? `told: ${text}` : "ok")]);
};
let app: App;
let server: Server;
let renderer: ChromeRenderer | undefined;

before(async () => {
    app = await openApp(scriptedModel(route));
    server = createServer(createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    app.serverPort = (server.address() as { port: number }).port;

    if (chrome !== undefined) {
        renderer = new ChromeRenderer(app.screenshots, { binary: chrome, flags: ["--no-sandbox"], base: `http://127.0.0.1:${app.serverPort}`, token: () => app.config.ownerToken, log: () => {} });
        void renderer.run();
    }
});

after(async () => {
    await renderer?.stop();
    server?.closeAllConnections();
    server?.close();
    await app?.close();
    cleanUp();
});

/** What Pi was told in the turn, newest last. */
async function turn(id: number, text: string): Promise<string[]> {
    const { submissionId } = await app.commands.submit(id as never, owner(app), { text, requestId: crypto.randomUUID() });

    await (await app.harness.submission(submissionId, context))!.wait(context);
    await app.harness.waitForIdle(context);

    return modelTexts(app, id as never);
}

const ask = async (id: number, text: string) => (await turn(id, text)).at(-1)!;

test("a published artifact comes back with the layout check at 390, 1280 and 1920 px: its 28 px button is found", real, async () => {
    const id = await newSession(app);
    const told = await ask(id, "publish small");

    assert.match(told, /Published \\"Shop\\" as artifact shop, version 1\./);
    assert.match(told, /Layout check \(the hook \\"Check artifacts on publish\\", Settings › Hooks; screenshot shows the pictures\):/);
    assert.match(told, /Layout check at 390 px \(\d+ elements\)/);
    assert.match(told, /Layout check at 1280 px \(\d+ elements\)/);
    assert.match(told, /Layout check at 1920 px \(\d+ elements\)/);
    // At the phone's width only: a desktop has no tap targets.
    assert.match(told, /Layout check at 390 px[^]*Tap targets under 40 px \(1\):\\n- button[^:]*Buy now[^:]*: [\d.]+×28 px[^]*Layout check at 1280 px/);
    assert.doesNotMatch(told.slice(told.indexOf("Layout check at 1280 px")), /Tap targets/);
});

test("with the hook off, or for a Markdown artifact, the publish answers alone", real, async () => {
    const id = await newSession(app);

    assert.doesNotMatch(await ask(id, "publish notes"), /Layout check/);
    app.setHook(owner(app), "artifactCheck", false);

    try {
        const texts = await turn(id, "publish small");
        const told = texts.findLast((each) => each.includes("told: Published"))!;

        assert.match(told, /Published \\"Shop\\" as artifact shop, version 1\. The user opens it from the artifact card\./);
        assert.doesNotMatch(told, /Layout check/);
    } finally {
        app.setHook(owner(app), "artifactCheck", true);
    }
});
