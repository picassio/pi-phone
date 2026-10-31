// Images in a real browser (PP-275): a picture image_generate made shows in the chat from its saved file, under the
// tool's line with what it cost; Menu › Images lists the image models of the providers signed in, Automatic first and
// OpenRouter's with their price, and a tap picks one.
import { type App, cleanUp, context, home, lastText, owner, pastWelcome, root, scriptedModel, until, work } from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { Browsers } from "./support/browser.ts";
import { findBrowser } from "./support/browser/discovery.ts";
import type { BrowserPage } from "./support/browser/page.ts";
import { VIEWPORTS } from "./support/browser/viewport.ts";
import { createHandler } from "../src/server/http.ts";

const { PocketApp } = await import("../src/server/app.ts");

const chromium = findBrowser();
const real = { skip: chromium === undefined ? "no Chromium-based browser on this machine" : false } as const;
const NANO = "google/gemini-2.5-flash-image";

/** A 64×40 PNG of one colour. */
const PNG = (() => {
    const photon = createRequire(import.meta.url)("@silvia-odwyer/photon-node") as {
        PhotonImage: new (raw: Uint8Array, width: number, height: number) => { get_bytes(): Uint8Array; free(): void };
    };
    const image = new photon.PhotonImage(new Uint8Array(64 * 40 * 4).fill(180), 64, 40);

    try {
        return Buffer.from(image.get_bytes());
    } finally {
        image.free();
    }
})();

/** OpenRouter's model list and chat completions, as far as image_generate uses them. */
const stub = createServer((request, response) => {
    request.resume();
    request.on("end", () => {
        if (request.url === "/api/v1/models") {
            response.end(JSON.stringify({ data: [{ id: NANO, name: "Google: Nano Banana", architecture: { output_modalities: ["image", "text"] }, pricing: { prompt: "0.0000003", image_output: "0.00003" } }] }));

            return;
        }

        response.end(
            JSON.stringify({
                choices: [{ message: { content: "", images: [{ image_url: { url: `data:image/png;base64,${PNG.toString("base64")}` } }] } }],
                usage: { prompt_tokens: 10, completion_tokens: 1290, cost: 0.0387 },
            }),
        );
    });
});
const route: FauxResponseStep = (request) => {
    const { role, text } = lastText(request as never);

    if (role === "user" && text.endsWith("draw a kite")) {
        return fauxAssistantMessage([fauxToolCall("image_generate", { prompt: "A small blue kite in the sky" })], { stopReason: "toolUse" });
    }

    return fauxAssistantMessage([fauxText("ok")]);
};

let app: App;
let server: Server;
let browsers: Browsers;
let page: BrowserPage;
let base = "";

async function inPage<T>(script: string): Promise<T> {
    return JSON.parse(await page.evaluate(script)) as T;
}

const see = (script: string, what: string) => until(async () => (await inPage<boolean>(script)) === true, what);

/** Signed in as the owner, at `size`, in session `id` (none: home). */
async function open(id: number | undefined, size: keyof typeof VIEWPORTS = "mobile"): Promise<void> {
    await page.setViewport(VIEWPORTS[size]);
    await page.navigate(`${base}/login?token=${encodeURIComponent(app.config.ownerToken)}`);
    await see(`return JSON.stringify((await import("/store.js")).store.state.me?.role === "owner")`, "signed in");

    if (id !== undefined) {
        await page.evaluate(`(await import("/store.js")).navigate(${id}); return "true";`);
        await see(`return JSON.stringify((await import("/store.js")).store.state.view.agent?.cwd !== undefined)`, "the session");
    }
}

before(async () => {
    if (chromium === undefined) {
        return;
    }

    await new Promise<void>((resolve) => stub.listen(0, "127.0.0.1", resolve));
    const faux = scriptedModel(route);

    app = await PocketApp.open({
        dataDir: join(root, "images-ui-data"),
        defaultCwd: work,
        supervised: false,
        log: () => {},
        home,
        configureModels: (models) => models.registerNativeProvider(faux.provider),
        officecli: { runs: false },
        images: { endpoints: { openRouter: `http://127.0.0.1:${(stub.address() as AddressInfo).port}/api/v1` }, codexAuth: async () => undefined },
    });
    pastWelcome(app);
    await app.models.setRuntimeApiKey("openrouter", "or-test-key");
    server = createServer(createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    browsers = new Browsers({ dataDir: mkdtempSync(join(root, "images-ui-browser-")), load: async () => undefined, save: () => {} });
    page = await browsers.open(1);
});

after(async () => {
    await browsers?.closeAll({ final: true });
    server?.closeAllConnections();
    server?.close();
    stub.close();
    await app?.close();
    cleanUp();
});

test("a made image shows under image_generate's line from its file, with its count and cost", real, async () => {
    app.config.lastModel ??= { provider: "faux", modelId: "faux-1", thinkingLevel: "off" };
    const { id } = await app.commands.createSession(owner(app), { cwd: work });
    const { submissionId } = await app.commands.submit(id, owner(app), { text: "draw a kite", requestId: crypto.randomUUID() });

    await (await app.harness.submission(submissionId, context))!.wait(context);
    await open(Number(id));
    await see(`return JSON.stringify(document.querySelector('[data-part="made-images"] img')?.naturalWidth === 64)`, "the picture, loaded from its file");

    const shown = await inPage<{ src: string; meta: string; subject: string }>(`
        const step = document.querySelector('[data-part="made-images"]').closest('[data-part="tool-call"]');

        return JSON.stringify({
            src: step.querySelector('[data-part="made-images"] img').getAttribute("src"),
            meta: step.querySelector(".step-meta").textContent.trim(),
            subject: step.querySelector(".step-subject").textContent.trim(),
        });
    `);

    // Named from the prompt's first six words.
    assert.match(shown.src, /^api\/c\/\d+\/file\?path=.*%2Fimages%2F\d{4}-\d\d-\d\d-\d{6}-a-small-blue-kite-in-the\.png$/);
    assert.equal(shown.meta, "1 image · $0.04");
    assert.equal(shown.subject, "A small blue kite in the sky");
});

test("Menu › Images lists Automatic and the signed-in image models with their price; a tap picks one", real, async () => {
    await open(undefined, "desktop");
    await page.evaluate(`(await import("/store.js")).openSheet({ type: "images" }); return "true";`);
    await see(`return JSON.stringify(document.querySelectorAll('[data-part="image-model"]').length === 2)`, "Automatic and Nano Banana");

    const rows = await inPage<{ model: string; text: string; on: boolean }[]>(`
        return JSON.stringify([...document.querySelectorAll('[data-part="image-model"]')].map((row) => ({
            model: row.dataset.model,
            text: [...row.querySelectorAll(".ds-text > span")].map((line) => line.textContent.replace(/\\s+/g, " ").trim()).join(" | "),
            on: row.getAttribute("aria-pressed") === "true",
        })));
    `);

    assert.deepEqual(rows, [
        { model: "auto", text: `Automatic | Now openrouter/${NANO}`, on: true },
        { model: `openrouter/${NANO}`, text: `Google: Nano Banana | ${NANO} · $30/M image tokens out`, on: false },
    ]);

    await page.evaluate(`document.querySelector('[data-model="openrouter/${NANO}"]').click(); return "true";`);
    await until(() => app.config.imageModel === `openrouter/${NANO}`, "the choice kept");
    await see(`return JSON.stringify(document.querySelector('[data-model="openrouter/${NANO}"]').getAttribute("aria-pressed") === "true")`, "the row marked");
});
