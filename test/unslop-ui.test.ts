// pi-phone's own screens after the unslop pass (PP-328, the owner's OK of 2026-11-02 on the mockups pp328-unslop), in a
// real browser at a phone's width: states are a word and a small dot, never a ✓ or ⚠ dingbat (PP-330). With
// PHONE_SHOTS, screenshots go there.
import { type App, cleanUp, cleanUpAll, home, newSession, pastWelcome, root, scriptedModel, until, work } from "./helpers.ts";
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
let slow = false;

/**
 * Load `path` in the page. A load the page before cancels (a history step it still had to take: back.js takes a closed
 * layer's entry off a moment later) fails here, rather than as a row that never shows (PP-507).
 */
async function go(path: string): Promise<void> {
    const loaded = await page.navigate(`${base}${path}`);

    assert.equal(loaded.error, undefined, `${path} loaded`);
}

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
    const handler = createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} });

    // With `slow` on, the page comes a moment late and the plan limits and the OpenAI-compatible providers a second
    // late, as on a phone.
    server = createServer((request, response) => {
        const url = request.url ?? "";
        const late = !slow ? 0 : /\/api\/(usage-limits|custom-providers)/.test(url) ? 1200 : /^\/(\?|$)/.test(url) ? 300 : 0;

        if (late === 0) {
            handler(request, response);
        } else {
            setTimeout(() => handler(request, response), late);
        }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    browsers = new Browsers({ dataDir: mkdtempSync(join(root, "unslop-ui-browser-")), load: async () => undefined, save: () => {} });
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

test("states are a word and a dot, never ✓ or ⚠: Machines, Providers, Wiki (PP-330)", real, async () => {
    await go("/?sheet=machines");
    await see(`return JSON.stringify(document.querySelector(".sheet")?.innerText.includes("han-devbox") === true)`, "the machine");

    const machines = await sheet();

    assert.deepEqual(machines.tags, ["Connected/ok"]);
    assert.doesNotMatch(machines.text, /[✓⚠]/);
    await shot("unslop-machines-390.jpg");

    await go("/?sheet=providers");
    await see(`return JSON.stringify(document.querySelector('.sheet [data-part="state-tag"]') !== null)`, "a provider's state");

    const providers = await sheet();

    assert.ok(providers.tags.includes("Ready/ok"), providers.tags.join(", "));
    assert.doesNotMatch(providers.text, /[✓⚠]/);
    await shot("unslop-providers-390.jpg");

    await go("/?sheet=para:settings");
    await see(`return JSON.stringify(document.querySelector('[data-part="wiki-rerank"] [data-part="state-tag"]') !== null)`, "Rank with Jev's state");

    const wiki = await sheet();

    assert.doesNotMatch(wiki.text, /[✓⚠]/);
    await page.evaluate(`document.querySelector('[data-part="wiki-rerank"]').scrollIntoView({ block: "center" }); return "true";`);
    await shot("unslop-wiki-390.jpg");
});

test("Machines: three main buttons, the rest quiet, Forget host key and Remove last in red on a line of their own (PP-331)", real, async () => {
    await go("/?sheet=machines");
    await see(`return JSON.stringify(document.querySelector('[data-part="machine-danger"]') !== null)`, "the machine's actions");

    const groups = await inPage<{ kind: string; buttons: string[] }[]>(
        `return JSON.stringify([...document.querySelectorAll(".machine .provider-actions .action-group")].map((group) => ({ kind: [...group.querySelectorAll("button")].map((button) => button.classList.contains("danger") ? "danger" : button.classList.contains("quiet") ? "quiet" : "button").join(","), buttons: [...group.querySelectorAll("button")].map((button) => button.textContent.trim()) })))`,
    );

    assert.deepEqual(groups, [
        { kind: "button,button,button", buttons: ["Terminal", "Test", "Install tools"] },
        { kind: "quiet,quiet,quiet,quiet", buttons: ["Ports", "Edit", "Update helper", "Copy public key"] },
        { kind: "danger,danger", buttons: ["Forget host key", "Remove"] },
    ]);

    const colors = await inPage<{ remove: string; err: string; ports: string; terminal: string }>(
        `const style = (text) => getComputedStyle([...document.querySelectorAll(".machine .provider-actions button")].find((button) => button.textContent.trim() === text));
        const probe = document.createElement("span");
        probe.style.color = "var(--err)";
        document.body.append(probe);
        const err = getComputedStyle(probe).color;
        probe.remove();
        return JSON.stringify({ remove: style("Remove").color, err, ports: style("Ports").backgroundColor, terminal: style("Terminal").backgroundColor });`,
    );

    assert.equal(colors.remove, colors.err, "Remove is in the theme's red");
    assert.equal(colors.ports, "rgba(0, 0, 0, 0)", "Ports is quiet text, without a button's fill");
    assert.notEqual(colors.terminal, "rgba(0, 0, 0, 0)", "Terminal is a button");
    await page.evaluate(`document.querySelector('[data-part="machine-danger"]').scrollIntoView({ block: "center" }); return "true";`);
    await shot("unslop-machines-actions-390.jpg");
});

test("Spend: one number format, the device's grouping and short large counts, its second line whole (PP-332)", real, async () => {
    app.spend.wikiUsed({ model: "openai/text-embedding-3-small", tokens: 21_256_201, cost: 7624.48 });
    for (let i = 1; i < 3746; i++) {
        app.spend.wikiUsed({ model: "openai/text-embedding-3-small", tokens: 0, cost: 0 });
    }

    await go("/?sheet=spend");
    await see(`return JSON.stringify(document.querySelector(".spend-sub") !== null)`, "the wiki's spend");

    const shown = await inPage<{ total: string; sub: string; cut: boolean }>(
        `const sub = document.querySelector(".spend-sub");
        return JSON.stringify({ total: document.querySelector(".spend-total strong").textContent, sub: sub.textContent.trim(), cut: sub.scrollWidth > sub.clientWidth + 1 });`,
    );

    assert.equal(shown.total, "$7,624.48");
    assert.match(shown.sub, /^3,746 requests · 21\.3M tokens · since [A-Z][a-z]{2} \d{1,2}$/);
    assert.equal(shown.cut, false, "the second line is not cut off");
    await shot("unslop-spend-390.jpg");
});

test("flat marks: no hue gradients; an idle session already read shows no mark (PP-334)", real, async () => {
    await newSession(app);
    await go("/");
    await see(`return JSON.stringify(document.querySelectorAll(".session-status").length >= 1)`, "the session");

    const marks = await inPage<{ seen: number; seenSvgs: number; gradients: string[] }>(
        `const gradients = [...document.styleSheets].flatMap((sheet) => { try { return [...sheet.cssRules]; } catch { return []; } })
            .filter((rule) => rule.style && /(linear|radial)-gradient\\([^)]*var\\(--(spark|brand|accent)\\)/.test(rule.style.background + rule.style.backgroundImage))
            .map((rule) => rule.selectorText);
        return JSON.stringify({
            seen: document.querySelectorAll(".status-idle.seen").length,
            seenSvgs: document.querySelectorAll(".status-idle.seen svg").length,
            gradients,
        });`,
    );

    assert.ok(marks.seen >= 1, "an idle session already read");
    assert.equal(marks.seenSvgs, 0, "shows no cloud");
    assert.deepEqual(marks.gradients, [], "no hue gradient in the app's styles");
    await shot("unslop-sessions-390.jpg");
});

test("Wiki settings: Capture model is the app's model picker, Embedding model and Open questions the app's dropdowns, no system select (PP-335, PP-409)", real, async () => {
    await go("/?sheet=para:settings");
    await see(`return JSON.stringify(document.querySelector('[data-part="wiki-capture-model"] .choice') !== null)`, "the capture model's field");

    const shown = await inPage<{ selects: number; capture: string }>(
        `return JSON.stringify({ selects: document.querySelectorAll(".wiki-settings select").length, capture: document.querySelector('[data-part="wiki-capture-model"] .choice-text').textContent.trim() })`,
    );

    assert.equal(shown.selects, 0);
    assert.match(shown.capture, /The default model for new sessions/);
    await page.evaluate(`document.querySelector('[data-part="wiki-capture-model"] .choice').click(); return "true";`);
    await see(`return JSON.stringify(document.querySelectorAll('.model-menu .pop-menu-row').length >= 2)`, "the models");
    await shot("unslop-wiki-capture-390.jpg");
    await page.evaluate(`document.querySelectorAll('.model-menu .pop-menu-row')[1].click(); return "true";`);
    await until(async () => (await app.para.settings()).captureModel !== "auto", "the pick kept");
    // Wiki settings comes back with it, and the menu's history entry is off again: back.js takes it off a moment after
    // the menu closes, and that step would cancel a load the next test had started by then (PP-507).
    await see(`return JSON.stringify(document.querySelector(".model-menu") === null && !document.querySelector('[data-part="wiki-capture-model"] .choice-text')?.textContent.includes("The default model"))`, "Wiki settings back with the pick");
    await see(`return JSON.stringify(history.state?.pocket?.layers === 1)`, "the menu's history entry taken off");
});

test("Providers: the list stays where it first shows while the plan limits and the OpenAI-compatible providers come in (PP-336)", real, async () => {
    slow = true;

    try {
        await go("/?sheet=providers");

        // Where the first provider row is the moment it can be tapped, and a while later.
        const firstRow = `const row = [...document.querySelectorAll(".sheet .sheet-list .provider")].find((each) => !each.closest(".custom-providers") && each.getClientRects().length > 0);
            return JSON.stringify(row === undefined ? null : Math.round(row.getBoundingClientRect().top));`;

        await until(async () => (await inPage<number | null>(firstRow)) !== null, "a provider row", 30_000);

        const shown = await inPage<number>(firstRow);

        await new Promise((resolve) => setTimeout(resolve, 2500));
        assert.equal(await inPage<number>(firstRow), shown, "the row did not move");
    } finally {
        slow = false;
    }
});
