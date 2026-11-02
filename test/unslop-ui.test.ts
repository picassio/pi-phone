// pi-phone's own screens after the unslop pass (PP-328, the owner's OK of 2026-11-02 on the mockups pp328-unslop), in a
// real browser at a phone's width: states are a word and a small dot, never a ✓ or ⚠ dingbat (PP-330). With
// PHONE_SHOTS, screenshots go there.
import { type App, cleanUp, home, pastWelcome, root, scriptedModel, until, work } from "./helpers.ts";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai/providers/faux";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { Browsers } from "./support/browser.ts";
import { findBrowser } from "./support/browser/discovery.ts";
import type { BrowserPage } from "./support/browser/page.ts";
import { VIEWPORTS } from "./support/browser/viewport.ts";
import { createHandler } from "../src/server/http.ts";

const { PocketApp } = await import("../src/server/app.ts");

const real = { skip: findBrowser() === undefined ? "no Chromium-based browser on this machine" : false } as const;
const SHOTS = process.env.PHONE_SHOTS;

// OpenRouter as the wiki asks it: one Jev model.
const openRouter = (async (url: string | URL | Request) => {
    if (String(url).startsWith("https://openrouter.ai/api/v1/models")) {
        return Response.json({ data: [{ id: "typesafe/jev-1.14", name: "TypeSafe: Jev 1.14", pricing: { prompt: "0.000000042" } }] });
    }

    return Response.json({ answers: {}, usage: { cost: 0 } });
}) as typeof fetch;

let app: App;
let server: Server;
let browsers: Browsers;
let page: BrowserPage;
let base = "";

async function inPage<T>(script: string): Promise<T> {
    return JSON.parse(await page.evaluate(script)) as T;
}

const see = (script: string, what: string) =>
    until(async () => (await inPage<boolean>(script)) === true, what, 30_000).catch(async (error: Error) => {
        throw new Error(`${error.message}; the sheet: ${await page.evaluate(`return JSON.stringify(document.querySelector(".sheet")?.innerText.slice(0, 2000) ?? "(no sheet)")`)}`);
    });

async function shot(name: string): Promise<void> {
    if (SHOTS !== undefined) {
        mkdirSync(SHOTS, { recursive: true });
        await new Promise((resolve) => setTimeout(resolve, 500));
        writeFileSync(join(SHOTS, name), Buffer.from((await page.screenshot()).data, "base64"));
    }
}

/** The sheet's text, and its state tags as "label/tone". */
const sheet = () =>
    inPage<{ text: string; tags: string[] }>(
        `return JSON.stringify({ text: document.querySelector(".sheet")?.innerText ?? "", tags: [...document.querySelectorAll('.sheet [data-part="state-tag"]')].map((tag) => tag.textContent.trim() + "/" + tag.className.replace("state-tag", "").trim()) })`,
    );

before(async () => {
    if (real.skip !== false) {
        return;
    }

    const faux = scriptedModel(() => fauxAssistantMessage([fauxText("ok")]));

    app = await PocketApp.open({
        dataDir: join(root, "unslop-ui-data"),
        defaultCwd: work,
        supervised: false,
        log: () => {},
        home,
        configureModels: (models) => models.registerNativeProvider(faux.provider),
        officecli: { runs: false },
        jev: { fetch: openRouter },
    });
    pastWelcome(app);
    await app.models.setRuntimeApiKey("openrouter", "or-test-key");

    const key = await app.sshKeys.generate("unslop-ui");
    const devbox = app.machines.add({ name: "han-devbox", address: "ubuntu@192.168.1.50", keyId: key.id }).id;

    Object.assign(app.machines.get(devbox), {
        hostKey: "SHA256:test (ED25519)",
        remote: { platform: "linux", arch: "x64", home: "/home/ubuntu" },
        daemon: "1.3.0",
        connectedAt: Date.now() - 16 * 86_400_000,
    });
    // It answers (there is no real machine behind it).
    Object.assign(app.places, { health: async () => ({ [devbox]: { ok: true, at: Date.now() } }) });
    server = createServer(createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    browsers = new Browsers({ dataDir: mkdtempSync(join(root, "unslop-ui-browser-")), load: async () => undefined, save: () => {} });
    page = await browsers.open(1);
    await page.setViewport(VIEWPORTS.mobile);
    await page.navigate(`${base}/login?token=${encodeURIComponent(app.config.ownerToken)}`);
});

after(async () => {
    await browsers?.closeAll({ final: true });
    server?.closeAllConnections();
    server?.close();
    await app?.close();
    cleanUp();
});

test("states are a word and a dot, never ✓ or ⚠: Machines, Providers, Wiki (PP-330)", real, async () => {
    await page.navigate(`${base}/?sheet=machines`);
    await see(`return JSON.stringify(document.querySelector(".sheet")?.innerText.includes("han-devbox") === true)`, "the machine");

    const machines = await sheet();

    assert.deepEqual(machines.tags, ["Connected/ok"]);
    assert.doesNotMatch(machines.text, /[✓⚠]/);
    await shot("unslop-machines-390.jpg");

    await page.navigate(`${base}/?sheet=providers`);
    await see(`return JSON.stringify(document.querySelector('.sheet [data-part="state-tag"]') !== null)`, "a provider's state");

    const providers = await sheet();

    assert.ok(providers.tags.includes("Ready/ok"), providers.tags.join(", "));
    assert.doesNotMatch(providers.text, /[✓⚠]/);
    await shot("unslop-providers-390.jpg");

    await page.navigate(`${base}/?sheet=para:settings`);
    await see(`return JSON.stringify(document.querySelector('[data-part="wiki-rerank"] [data-part="state-tag"]') !== null)`, "Rank with Jev's state");

    const wiki = await sheet();

    assert.doesNotMatch(wiki.text, /[✓⚠]/);
    await page.evaluate(`document.querySelector('[data-part="wiki-rerank"]').scrollIntoView({ block: "center" }); return "true";`);
    await shot("unslop-wiki-390.jpg");
});
