// Code in a person's message, in a real browser (PP-351, from pi-pocket #200/#201): `spans` and ``` fences show as code,
// a fence with a language colored, and nothing else in the message changes from what was typed; a quoted passage's
// reply (PP-345) shows its code too. With PHONE_SHOTS set to a folder, screenshots at 390 and 1280 px go there.
import { type App, cleanUp, cleanUpAll, newSession, openApp, root, say, scriptedModel, until } from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { Browsers } from "./support/browser.ts";
import { findBrowser } from "./support/browser/discovery.ts";
import type { BrowserPage } from "./support/browser/page.ts";
import { VIEWPORTS } from "./support/browser/viewport.ts";
import { createHandler } from "../src/server/http.ts";

const real = { skip: findBrowser() === undefined ? "no Chromium-based browser on this machine" : false } as const;
const SHOTS = process.env.PHONE_SHOTS;
let app: App;
let server: Server;
let browsers: Browsers;
let page: BrowserPage;
let base = "";

const inPage = async <T>(script: string): Promise<T> => JSON.parse(await page.evaluate(script)) as T;

async function shot(name: string): Promise<void> {
    if (SHOTS === undefined) {
        return;
    }

    mkdirSync(SHOTS, { recursive: true });
    await new Promise((resolve) => setTimeout(resolve, 400));
    writeFileSync(join(SHOTS, `${name}.jpg`), Buffer.from((await page.screenshot()).data, "base64"));
}

before(async () => {
    if (real.skip) {
        return;
    }

    app = await openApp(scriptedModel());
    const handler = createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} });

    server = createServer((request, response) => {
        void handler(request, response);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    browsers = new Browsers({ dataDir: mkdtempSync(join(root, "user-code-ui-")), load: async () => undefined, save: () => {} });
    page = await browsers.open(1);
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

/** The first message's text, once it shows. */
const TEXT = `return JSON.stringify(document.querySelector(".user-text")?.textContent ?? "")`;
/** What the first message shows: its spans, its blocks, whether a block is colored, its mention, its quote, and its text. */
const SHOWN = `
    const message = document.querySelector(".user-text");

    return JSON.stringify({
        spans: [...message.querySelectorAll(":scope > code")].map((each) => each.textContent),
        blocks: [...message.querySelectorAll("pre.user-code")].map((each) => each.textContent),
        lang: message.querySelector("pre.user-code span")?.className ?? "",
        mention: message.querySelector(".file-mention")?.textContent.trim() ?? "",
        quote: message.querySelector('[data-part="reply-quote"]')?.textContent ?? "",
        text: message.textContent,
    });
`;

test("a person's spans and fences show as code, and the rest as typed", real, async () => {
    const id = await newSession(app);
    const text = [
        "Run `npm test` and ``a ` b`` in @src/app.ts, *not* bold.",
        "```js",
        "const x = 1;",
        "```",
        "A stray ` and an open ``` stay text.",
    ].join("\n");

    await say(app, id, text);

    for (const [size, viewport] of [["390", VIEWPORTS.mobile], ["1280", VIEWPORTS.desktop]] as const) {
        await page.setViewport(viewport);
        await page.navigate(`${base}/s/${id}`);
        await until(async () => (await inPage<string>(TEXT)) !== "", "the message in the conversation", 20_000);

        const shown = await inPage<{ spans: string[]; blocks: string[]; lang: string; text: string; mention: string }>(SHOWN);

        assert.deepEqual(shown.spans, ["npm test", "a ` b"]);
        assert.deepEqual(shown.blocks, ["const x = 1;"]);
        assert.ok(shown.lang !== "", "the js fence is colored");
        assert.equal(shown.mention, "@src/app.ts");
        assert.equal(shown.text, "Run npm test and a ` b in @src/app.ts, *not* bold.const x = 1;A stray ` and an open ``` stay text.");
        await shot(`user-code-${size}`);
    }
});

test("a reply to a quoted passage shows its code too", real, async () => {
    const id = await newSession(app);

    await say(app, id, "> the build step\n\nwhy does `npm run check` fail?");
    await page.setViewport(VIEWPORTS.mobile);
    await page.navigate(`${base}/s/${id}`);
    await until(async () => (await inPage<string>(TEXT)) !== "", "the message in the conversation", 20_000);

    const shown = await inPage<{ spans: string[]; quote: string }>(SHOWN);

    assert.equal(shown.quote, "the build step");
    assert.deepEqual(shown.spans, ["npm run check"]);
});
