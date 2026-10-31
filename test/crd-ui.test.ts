// Chrome Remote Desktop's Connect (PP-263) in a real browser, with a stand-in Windows machine (`support/fake-crd.ts`):
// Pi's card and the machine's row in Settings › Machines show Google's steps with the headless page as a real link
// (opens outside the app) and Copy link, a hidden field for the command and the PIN twice; nothing is wider than a phone;
// what is typed goes to the machine, and the card goes once it is connected. With CRD_SHOTS set to a folder, screenshots
// go there.
import { type App, cleanUp, context, newSession, openApp, owner, root, scriptedModel, until as waitFor } from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createHandler } from "../src/server/http.ts";
import { Browsers } from "./support/browser.ts";
import { findBrowser } from "./support/browser/discovery.ts";
import type { BrowserPage } from "./support/browser/page.ts";
import { VIEWPORTS } from "./support/browser/viewport.ts";
import { CONNECTED, fakeCrd } from "./support/fake-crd.ts";

const skip = findBrowser() === undefined ? "no Chromium-based browser on this machine" : false;
const SHOTS = process.env.CRD_SHOTS;
const CODE = `4/0AVG7fiQ${"z".repeat(60)}Ab1`;
const REDIRECT = "https://remotedesktop.google.com/_/oauthredirect";
const PIN = "27182818";
const COMMAND = `& "\${Env:PROGRAMFILES(X86)}\\Google\\Chrome Remote Desktop\\CurrentVersion\\remoting_start_host.exe" --code="${CODE}" --redirect-url="${REDIRECT}" --name=$Env:COMPUTERNAME`;
const HEADLESS = "https://remotedesktop.google.com/headless";
const route: FauxResponseStep = (request) => {
    const last = request.messages.at(-1) as { role: string; content: unknown };
    const text = typeof last.content === "string" ? last.content : JSON.stringify(last.content);

    if (last.role === "user" && text.includes("connect the laptop")) {
        return fauxAssistantMessage([fauxToolCall("computer_control", { action: "setup", machine: "tualh-laptop", crd: "connect", reason: "So you can unlock it from your phone" } as never)], { stopReason: "toolUse" });
    }

    return fauxAssistantMessage([fauxText("ok")]);
};
const crd = fakeCrd({ ...CONNECTED, service: "Stopped", config: false });
let app: App;
let server: Server;
let base: string;
let browsers: Browsers;
let page: BrowserPage;
let laptop: string;

async function until(check: () => Promise<boolean> | boolean, what: string, timeoutMs = 20_000): Promise<void> {
    const started = Date.now();

    while (!(await check())) {
        if (Date.now() - started > timeoutMs) {
            const shown = page === undefined ? "" : await page.evaluate(`return JSON.stringify(document.body.innerText.slice(0, 3000))`).catch(() => "");

            throw new Error(`Timed out waiting for ${what}; the page shows: ${shown}`);
        }

        await new Promise((resolve) => setTimeout(resolve, 50));
    }
}

before(async () => {
    if (skip) {
        return;
    }

    app = await openApp(scriptedModel(route), join(root, "crd-ui-data"), undefined, { crdRun: crd.run });
    const key = await app.sshKeys.generate("crd-ui");

    laptop = app.machines.add({ name: "tualh-laptop", address: "Picassio@laptop", keyId: key.id }).id;
    Object.assign(app.machines.get(laptop), {
        hostKey: "SHA256:test (ED25519)",
        remote: { platform: "windows", arch: "x64", home: "C:/Users/Picassio" },
        daemon: "1.0.0",
        connectedAt: Date.now(),
        tools: { crd: "154.0.8037.40" },
    });
    server = createServer(createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    browsers = new Browsers({ dataDir: mkdtempSync(join(root, "crd-ui-")), load: async () => undefined, save: () => {} });
    page = await browsers.open(1);
    await page.navigate(`${base}/login?token=${encodeURIComponent(app.config.ownerToken)}`);
});

after(async () => {
    await browsers?.closeAll({ final: true });
    server?.closeAllConnections();
    server?.close();
    await app?.close();
    cleanUp();
});

const inPage = async <T>(script: string): Promise<T> => JSON.parse(await page.evaluate(script)) as T;
const text = (selector: string) => inPage<string>(`return JSON.stringify(document.querySelector(${JSON.stringify(selector)})?.innerText ?? "")`);

async function shot(name: string): Promise<void> {
    if (SHOTS === undefined) {
        return;
    }

    mkdirSync(SHOTS, { recursive: true });
    await new Promise((resolve) => setTimeout(resolve, 400));
    writeFileSync(join(SHOTS, `${name}.jpg`), Buffer.from((await page.screenshot()).data, "base64"));
}

/** The link and Copy link in the form under `scope`, and whatever in it runs past its box or the screen. */
async function look(scope: string): Promise<{ links: string[]; copy: boolean; spills: string[]; page: number; screen: number }> {
    return inPage(`
        const box = document.querySelector(${JSON.stringify(scope)});
        const edge = box.getBoundingClientRect().right;
        const spills = [...box.querySelectorAll("*")]
            .filter((each) => each.getClientRects().length > 0 && each.getBoundingClientRect().right > Math.min(edge, innerWidth) + 1)
            .map((each) => each.tagName + "." + each.className + " " + Math.round(each.getBoundingClientRect().right));

        return JSON.stringify({
            links: [...box.querySelectorAll(".crd-link a")].map((link) => [link.getAttribute("href"), link.target, link.rel].join(" ")),
            copy: [...box.querySelectorAll(".crd-link button")].some((button) => button.innerText.trim() === "Copy link"),
            spills,
            page: document.documentElement.scrollWidth,
            screen: innerWidth,
        });
    `);
}

/** Fill the form under `scope` as a person types, then send it. */
async function fill(scope: string, command: string, pin: string, confirm: string): Promise<void> {
    await page.type({ selector: `${scope} .crd-command` }, command);
    await page.type({ selector: `${scope} .crd-pins input:nth-child(1)` }, pin);
    await page.type({ selector: `${scope} .crd-pins input:nth-child(2)` }, confirm);
    await until(async () => inPage<boolean>(`return JSON.stringify(document.querySelector(${JSON.stringify(`${scope} .crd-connect .button.primary`)})?.disabled === false)`), "Connect enabled");
    await page.click({ selector: `${scope} .crd-connect .button.primary` });
}

test("Pi's card: Google's page as a real link with Copy link, the hidden fields, nothing wider than a phone; Connect sends them to the machine and the card goes", { skip }, async () => {
    const id = await newSession(app);
    const { submissionId } = await app.commands.submit(id as never, owner(app), { text: "connect the laptop", requestId: crypto.randomUUID() });

    await waitFor(() => app.approvals.forConversation(id as never).length > 0, "the card");
    await page.setViewport(VIEWPORTS.mobile);
    await page.navigate(`${base}/s/${id}`);
    await until(async () => (await text(".crd-connect-card")) !== "", "the card on a phone");
    const card = await text(".crd-connect-card");

    assert.match(card, /Connect Chrome Remote Desktop on tualh-laptop to your Google account/);
    assert.match(card, /Tap Begin, then Next, then Authorize\./);
    assert.match(card, /Copy the command under Windows \(PowerShell\) and paste it below/);
    assert.match(card, /Pi never sees them/);
    assert.equal(await inPage<string>(`return JSON.stringify(document.querySelector(".crd-connect-card .crd-command").type)`), "password");

    const phone = await look(".crd-connect-card");

    assert.deepEqual(phone.links, [`${HEADLESS} _blank noopener noreferrer`]);
    assert.equal(phone.copy, true);
    assert.deepEqual(phone.spills, [], "nothing runs past the card");
    assert.ok(phone.page <= phone.screen, JSON.stringify(phone));
    await shot("crd-card-390");

    await page.setViewport(VIEWPORTS.desktop);
    await page.navigate(`${base}/s/${id}`);
    await until(async () => (await text(".crd-connect-card")) !== "", "the card on a desktop");
    assert.deepEqual((await look(".crd-connect-card")).spills, []);
    await shot("crd-card-1280");

    // A PIN that differs keeps Connect off; then the right one goes to the machine, and the card goes.
    await page.type({ selector: ".crd-connect-card .crd-pins input:nth-child(1)" }, PIN);
    await page.type({ selector: ".crd-connect-card .crd-pins input:nth-child(2)" }, "11111111");
    await until(async () => (await text(".crd-connect-card")).includes("The two PINs differ."), "the PINs differ");
    await fill(".crd-connect-card", COMMAND, PIN, PIN);
    await until(async () => (await text(".crd-connect-card")) === "", "the card gone");
    await (await app.harness.submission(submissionId, context))!.wait(context);
    assert.deepEqual(crd.given, { code: CODE, redirect: REDIRECT, pin: PIN });
    assert.ok(!(await inPage<string>(`return JSON.stringify(document.body.innerText)`)).includes(CODE));
});

test("the machine's row: installed, not connected, then Connect to your Google account opens the same form, fitting a phone; connected after", { skip }, async () => {
    crd.state = { ...CONNECTED, service: "Stopped", config: false };
    await page.setViewport(VIEWPORTS.mobile);
    await page.navigate(`${base}/`);
    await page.evaluate(`(await import("/store.js")).openSheet({ type: "machines" })`);
    await until(async () => (await text(".machine-crd")).includes("installed, not connected"), "the row's state");
    assert.match(await text(".machine-crd"), /Chrome Remote Desktop · installed, not connected · 154\.0\.8037\.40/);
    await shot("crd-row-390");
    await page.evaluate(`[...document.querySelectorAll(".machine-crd .button")].find((each) => each.innerText === "Connect to your Google account").click()`);
    await until(async () => (await text(".machine-crd .crd-connect")) !== "", "the form on the row");

    const phone = await look(".machine-crd");

    assert.deepEqual(phone.links, [`${HEADLESS} _blank noopener noreferrer`]);
    assert.equal(phone.copy, true);
    assert.deepEqual(phone.spills, [], "nothing runs past the row");
    assert.ok(phone.page <= phone.screen, JSON.stringify(phone));
    await shot("crd-row-connect-390");

    await page.setViewport(VIEWPORTS.desktop);
    await until(async () => (await text(".machine-crd .crd-connect")) !== "", "the form on a desktop");
    assert.deepEqual((await look(".machine-crd")).spills, []);
    await shot("crd-row-connect-1280");

    await fill(".machine-crd", COMMAND, PIN, PIN);
    await until(async () => /Chrome Remote Desktop · connected/.test(await text(".machine-crd")), "connected");
    assert.match(await text(".machine-crd"), /Remove Chrome Remote Desktop/);
    await shot("crd-row-connected-390");
});
