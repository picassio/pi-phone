// A picture Pi reads (often one the person just sent) shows once, inside its read call once opened, not under the call's
// line too (PP-341, from pi-pocket #191). A picture another call brings (here fetch_content's image; pi-phone's
// screenshot tools the same way) is new, and shows under its line. With PHONE_SHOTS set to a folder, screenshots at 390
// and 1280 px go there.
import { type App, cleanUp, cleanUpAll, lastText, newSession, openApp, owner, root, scriptedModel, until, work } from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { crc32, deflateSync } from "node:zlib";
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { Browsers } from "./support/browser.ts";
import { findBrowser } from "./support/browser/discovery.ts";
import type { BrowserPage } from "./support/browser/page.ts";
import { type Viewport, VIEWPORTS } from "./support/browser/viewport.ts";
import { createHandler } from "../src/server/http.ts";

const chromium = findBrowser();
const real = { skip: chromium === undefined ? "no Chromium-based browser on this machine" : false } as const;
const SHOTS = process.env.PHONE_SHOTS;

/** A square PNG of one colour, `size` px a side: big enough to see in the screenshots. */
function square(size: number): Buffer {
    const chunk = (type: string, data: Buffer) => {
        const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
        const length = Buffer.alloc(4);
        const sum = Buffer.alloc(4);

        length.writeUInt32BE(data.length);
        sum.writeUInt32BE(crc32(body));

        return Buffer.concat([length, body, sum]);
    };
    const header = Buffer.alloc(13);

    header.writeUInt32BE(size, 0);
    header.writeUInt32BE(size, 4);
    header[8] = 8;
    header[9] = 2;

    const row = Buffer.concat([Buffer.from([0]), ...Array.from({ length: size }, () => Buffer.from([122, 162, 247]))]);

    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk("IHDR", header),
        chunk("IDAT", deflateSync(Buffer.concat(Array.from({ length: size }, () => row)))),
        chunk("IEND", Buffer.alloc(0)),
    ]);
}

const PNG = square(48);
const picture = join(work, "dot.png");
let imageServer: Server;
let imageUrl = "";

/** "read the picture" reads it; "fetch the picture" fetches it from a web address; after either, Pi answers "seen". */
const route: FauxResponseStep = (request) => {
    const { text } = lastText(request as never);

    if (text === "read the picture") {
        return fauxAssistantMessage([fauxToolCall("read", { path: picture })], { stopReason: "toolUse" });
    }

    if (text === "fetch the picture") {
        return fauxAssistantMessage([fauxToolCall("fetch_content", { url: imageUrl })], { stopReason: "toolUse" });
    }

    return fauxAssistantMessage([fauxText("seen")]);
};

let app: App;
let server: Server;
let browsers: Browsers;
let page: BrowserPage;
let base = "";

async function inPage<T>(script: string): Promise<T> {
    return JSON.parse(await page.evaluate(script)) as T;
}

const see = (script: string, what: string, timeoutMs = 10_000) =>
    until(async () => (await inPage<boolean>(script)) === true, what, timeoutMs);

async function shot(name: string): Promise<void> {
    if (SHOTS === undefined) {
        return;
    }

    mkdirSync(SHOTS, { recursive: true });
    await new Promise((resolve) => setTimeout(resolve, 400));
    writeFileSync(join(SHOTS, `${name}.jpg`), Buffer.from((await page.screenshot()).data, "base64"));
}

const step = "[data-part=tool-call][data-status=done]";

/** A session where Pi did what `ask` says, open at `viewport`, its steps' group open. */
async function asked(ask: string, viewport: Viewport): Promise<void> {
    const id = await newSession(app);

    await page.setViewport(viewport);
    await page.navigate(`${base}/s/${id}`);
    await see(`return JSON.stringify(document.querySelector(".composer textarea") !== null)`, "the session", 20_000);
    await app.commands.submit(id, owner(app), { text: ask, requestId: `ask-${id}` });
    await see(`return JSON.stringify([...document.querySelectorAll(".reply")].some((each) => each.textContent.includes("seen")))`, "Pi's answer", 20_000);
    // The group of steps folds once the turn ends: open it to see the call's line.
    await inPage(`document.querySelector('[data-part="activity"]:not(.open) .activity-head')?.click(); return "null";`);
    await see(`return JSON.stringify(document.querySelector('${step}') !== null)`, "the call's line");
}

const pictures = () => inPage<number>(`return JSON.stringify(document.querySelectorAll("${step} .thumbs img").length)`);

before(async () => {
    if (chromium === undefined) {
        return;
    }

    mkdirSync(work, { recursive: true });
    writeFileSync(picture, PNG);
    imageServer = createServer((_request, response) => {
        response.writeHead(200, { "content-type": "image/png", "content-length": PNG.length });
        response.end(PNG);
    });
    await new Promise<void>((resolve) => imageServer.listen(0, "127.0.0.1", resolve));
    imageUrl = `http://127.0.0.1:${(imageServer.address() as { port: number }).port}/dot.png`;
    app = await openApp(scriptedModel(route));
    const handler = createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} });

    server = createServer((request, response) => {
        void handler(request, response);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    browsers = new Browsers({ dataDir: mkdtempSync(join(root, "read-image-ui-")), load: async () => undefined, save: () => {} });
    page = await browsers.open(1);
    await page.navigate(`${base}/login?token=${encodeURIComponent(app.config.ownerToken)}`);
    await see(`return JSON.stringify((await import("/store.js")).store.state.me?.role === "owner")`, "signed in", 20_000);
});

after(() =>
    cleanUpAll(
        () => browsers?.closeAll({ final: true }),
        () => server?.closeAllConnections(),
        () => server?.close(),
        () => imageServer?.close(),
        () => app?.close(),
        () => cleanUp(),
    ),
);

for (const [size, viewport] of [["390", VIEWPORTS.mobile], ["1280", VIEWPORTS.desktop]] as const) {
    test(`at ${size} px, a picture a read returned shows once, inside the read once it is opened`, real, async () => {
        await asked("read the picture", viewport);
        assert.equal(await pictures(), 0, "no picture under the closed read");
        await shot(`read-closed-${size}`);

        await inPage(`document.querySelector('${step} .step-head').click(); return "null";`);
        await see(`return JSON.stringify(document.querySelector('${step} .step-body .thumbs img') !== null)`, "the picture in the opened read");
        assert.equal(await pictures(), 1, "the picture once, not twice");
        await shot(`read-open-${size}`);
    });
}

test("a picture another call brings is new: it shows under its line, closed", real, async () => {
    await asked("fetch the picture", VIEWPORTS.mobile);
    await see(`return JSON.stringify(document.querySelector('${step} .step-extras .thumbs img') !== null)`, "the picture under the line");
    assert.equal(await pictures(), 1);
    await shot("fetch-390");
});
