// Pi's browser on a machine in the app (PP-274), in a real browser, with real Chromes standing in for the machine's:
// the panel's Browse on moves a phone session's browsing to a machine ("Pi's browser on <machine>", its live picture);
// someone using the window there shows in the panel; browser_attach's card shows the machine, port, version and profile;
// the attached browser's tabs show with its label and Detach, and a sign-in card fills its page; Settings › Machines
// sets how Pi's browser runs there. With PHONE_SHOTS set to a folder, screenshots at 390 and 1280 px go there.
import { type App, cleanUp, context, lastText, newSession, openApp, owner, root, scriptedModel } from "./helpers.ts";
import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { ConversationId } from "@earendil-works/pi-durable";
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createHandler } from "../src/server/http.ts";
import { Browsers } from "./support/browser.ts";
import { findBrowser } from "./support/browser/discovery.ts";
import type { BrowserPage } from "./support/browser/page.ts";
import { VIEWPORTS } from "./support/browser/viewport.ts";

const chromium = findBrowser();
const skip = chromium === undefined ? "no Chromium-based browser on this machine" : false;
const SHOTS = process.env.PHONE_SHOTS;
const calls: Record<string, [string, Record<string, unknown>]> = {};
const route: FauxResponseStep = (request) => {
    const { role, text } = lastText(request as never);

    for (const [ask, [tool, args]] of Object.entries(calls)) {
        if (role === "user" && text.endsWith(ask)) {
            return fauxAssistantMessage([fauxToolCall(tool, args as never)], { stopReason: "toolUse" });
        }
    }

    return fauxAssistantMessage([fauxText(role === "toolResult" ? "Done." : "ok")]);
};
const PAGE = `<!doctype html><title>Team portal</title><meta name="viewport" content="width=device-width">
    <style>body{font-family:sans-serif;margin:24px} input{display:block;margin:6px 0 14px;padding:8px;width:90%}</style>
    <h1>Team portal</h1><form onsubmit="event.preventDefault()">
    <label>Email <input id="email" type="email"></label><label>Password <input id="pw" type="password"></label>
    <button>Sign in</button></form>`;

let app: App;
let server: Server;
let site: Server;
let browsers: Browsers;
let page: BrowserPage;
let base = "";
let siteUrl = "";
let session: ConversationId;
let foreign: ChildProcess | undefined;
const home = mkdtempSync(join(root, "browser-machine-ui-home-"));
const profile = join(home, "my-chrome");

const inPage = async <T>(script: string): Promise<T> => JSON.parse(await page.evaluate(script)) as T;

async function until(check: () => Promise<boolean> | boolean, what: string, timeoutMs = 30_000): Promise<void> {
    const started = Date.now();

    while (!(await check())) {
        if (Date.now() - started > timeoutMs) {
            const shown = page === undefined ? "" : await page.evaluate(`return JSON.stringify(document.body.innerText.slice(0, 2000))`).catch(() => "");

            throw new Error(`Timed out waiting for ${what}; the page shows: ${shown}`);
        }

        await new Promise((resolve) => setTimeout(resolve, 100));
    }
}

async function shot(name: string): Promise<void> {
    if (SHOTS !== undefined) {
        mkdirSync(SHOTS, { recursive: true });
        await new Promise((resolve) => setTimeout(resolve, 600));
        writeFileSync(join(SHOTS, `${name}.jpg`), Buffer.from((await page.screenshot()).data, "base64"));
    }
}

/** A script run on "the machine": this computer, with the test's own home. */
const run = (script: string): Promise<{ code: number; out: string }> =>
    new Promise((resolve) => {
        const child = spawn("sh", ["-c", script], { env: { ...process.env, HOME: home } });
        let out = "";

        child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString()));
        child.stderr.on("data", (chunk: Buffer) => (out += chunk.toString()));
        child.on("close", (code) => resolve({ code: code ?? 1, out }));
    });

before(async () => {
    if (skip) {
        return;
    }

    site = createServer((_request, response) => {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end(PAGE);
    });
    await new Promise<void>((resolve) => site.listen(0, "127.0.0.1", resolve));
    siteUrl = `http://127.0.0.1:${(site.address() as { port: number }).port}/`;

    // The owner's own Chrome on the machine, started with remote debugging.
    mkdirSync(profile);
    foreign = spawn(chromium!, ["--headless=new", "--no-sandbox", "--remote-debugging-port=0", `--user-data-dir=${profile}`, siteUrl], { stdio: "ignore" });
    await until(() => existsSync(join(profile, "DevToolsActivePort")) && readFileSync(join(profile, "DevToolsActivePort"), "utf8").includes("\n"), "the owner's Chrome");

    app = await openApp(scriptedModel(route), join(root, "browser-machine-ui"), undefined, {
        browserMachines: {
            list: () => [{ id: "m1", name: "tuanlh-sandbox-01", connected: true, platform: "linux" }],
            access: () => ({ name: "tuanlh-sandbox-01", home, run, writeFile: async () => {}, forward: async (remote) => ({ port: remote, close: () => {} }) }),
        },
    });
    session = await newSession(app);
    server = createServer(createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    browsers = new Browsers({ dataDir: mkdtempSync(join(root, "browser-machine-ui-")), load: async () => undefined, save: () => {} });
    page = await browsers.open(1);
    await page.navigate(`${base}/login?token=${encodeURIComponent(app.config.ownerToken)}`);
});

after(async () => {
    await app?.browserFor(app.cwdOf(session), session).close().catch(() => {});
    await browsers?.closeAll({ final: true });
    server?.closeAllConnections();
    server?.close();
    site?.close();
    foreign?.kill();
    await run(`pkill -f -- "user-data-dir=${home}/.pi/mobile/browser/profile"; true`);
    await app?.close();
    cleanUp();
});

async function open(viewport: typeof VIEWPORTS.mobile, panel: boolean): Promise<void> {
    await page.setViewport(viewport);
    await page.navigate(`${base}/s/${Number(session)}`);
    await until(async () => await inPage<boolean>(`return JSON.stringify(document.querySelector(".composer textarea") !== null)`), "the session");
    await page.evaluate(`(await import("/browser-panel.js")).setBrowserOpen(${panel})`);

    if (panel) {
        await until(async () => await inPage<boolean>(`return JSON.stringify(document.querySelector("[data-part=browser-panel]") !== null)`), "the panel");
    }
}

/** Pick an option of the app's dropdown (`Choice`) inside `within`, by its name. */
async function choose(within: string, name: string): Promise<void> {
    await page.evaluate(`document.querySelector(${JSON.stringify(`${within} .choice`)}).click()`);
    await until(async () => await inPage<boolean>(`return JSON.stringify(document.querySelector(".choice-menu .pop-menu-row") !== null)`), "the dropdown's list");
    await page.evaluate(`[...document.querySelectorAll(".choice-menu .pop-menu-row")].find((each) => each.innerText.trim() === ${JSON.stringify(name)}).click()`);
}

const panelText = () => inPage<string>(`return JSON.stringify(document.querySelector("[data-part=browser-panel]")?.innerText ?? "")`);
const pictured = () => inPage<boolean>(`return JSON.stringify(!!document.querySelector(".pb-frame canvas") && !document.querySelector(".pb-wait") && document.querySelector(".pb-frame canvas").width > 10)`);

async function turn(text: string, card?: (request: ReturnType<App["approvals"]["all"]>[number]) => Promise<void>): Promise<void> {
    const { submissionId } = await app.commands.submit(session, owner(app), { text, requestId: crypto.randomUUID() });

    if (card !== undefined) {
        await until(() => app.approvals.forConversation(session).length > 0, "the card");
        await card(app.approvals.forConversation(session)[0]!);
    }

    await (await app.harness.submission(submissionId, context))!.wait(context);
}

test("the panel's Browse on moves a phone session's browsing to a machine; someone at its window shows; the attach card; an attached browser with Detach and a sign-in card; Settings › Machines' mode", { skip }, async () => {
    // Browse on: this phone, or the machine.
    await open(VIEWPORTS.mobile, true);
    await until(async () => (await panelText()).includes("Browse on"), "Browse on");
    await shot("mbrowser-panel-browse-on-390");
    await choose(".pb-on", "tuanlh-sandbox-01");
    await until(() => app.browserPlaces()[String(session)] === "machine:m1", "the session browsing on the machine");

    await app.browserFor(app.cwdOf(session), session).open(Number(session), siteUrl);
    await until(async () => (await panelText()).includes("Pi's browser on tuanlh-sandbox-01") && (await panelText()).includes("Team portal"), "the machine's page in the panel");
    await until(pictured, "its live picture");
    await shot("mbrowser-panel-machine-390");

    // Someone uses the window on the machine (window mode): the panel says so.
    await page.evaluate(`
        const { piBrowserState, setPiBrowser } = await import("/store.js");
        setPiBrowser({ ...piBrowserState(), windowInUse: true });
    `);
    await until(async () => (await panelText()).includes("Someone is using this browser's window on tuanlh-sandbox-01."), "the window in use");
    await shot("mbrowser-panel-in-use-390");

    await open(VIEWPORTS.desktop, true);
    await until(pictured, "its live picture at 1280");
    await shot("mbrowser-panel-machine-1280");

    // Attaching to the owner's own Chrome: the card first.
    calls["attach my chrome"] = ["browser_attach", { machine: "tuanlh-sandbox-01", devtools_active_port: "~/my-chrome/DevToolsActivePort", label: "My Chrome" }];
    const attached = turn("attach my chrome", async (card) => {
        assert.equal(card.tool, "browser_attach");
        assert.match(card.subject, new RegExp(`Profile: ${profile.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
        await open(VIEWPORTS.mobile, false);
        await until(async () => (await inPage<string>(`return JSON.stringify(document.body.innerText)`)).includes("Attach Pi's browser to a browser on tuanlh-sandbox-01"), "the attach card");
        await shot("mbrowser-card-attach-390");
        await open(VIEWPORTS.desktop, false);
        await until(async () => (await inPage<string>(`return JSON.stringify(document.body.innerText)`)).includes("carries its profile's sign-ins"), "the attach card at 1280");
        await shot("mbrowser-card-attach-1280");
        await app.answerApproval(card.id, true, owner(app));
    });

    await attached;
    assert.match(app.browserPlaces()[String(session)] ?? "", /^attach:m1:\d+$/);

    // Pi's own tab there (the owner's tab stays theirs).
    const tab = await app.browserFor(app.cwdOf(session), session).open(Number(session), siteUrl);

    assert.match(tab, /Team portal/);
    await open(VIEWPORTS.desktop, true);
    await until(async () => (await panelText()).includes("Attached: My Chrome") && (await panelText()).includes("Detach"), "the attached browser in the panel");
    await until(pictured, "the attached page's picture");
    await shot("mbrowser-panel-attached-1280");
    await open(VIEWPORTS.mobile, true);
    await until(pictured, "the attached page's picture at 390");
    // The machine's name and the label: the title keeps to one line, so the bar holds three.
    const bar = await inPage<{ title: number; line: number; header: number; inner: number }>(`
        const title = document.querySelector(".pb-title b");
        const header = document.querySelector(".pb-bar");
        return JSON.stringify({ title: title.getBoundingClientRect().height, line: parseFloat(getComputedStyle(title).lineHeight) || 18, header: header.clientHeight, inner: header.scrollHeight });
    `);

    assert.ok(bar.title < bar.line * 1.6, `the title is one line: ${JSON.stringify(bar)}`);
    assert.ok(bar.inner <= bar.header, `nothing spills out of the bar: ${JSON.stringify(bar)}`);
    await shot("mbrowser-panel-attached-390");

    // A sign-in card on the attached tab: what the owner types goes into its page.
    const user = Number(/\[(\d+)\] textbox "Email"/.exec(tab)?.[1]);
    const pw = Number(/\[(\d+)\] password "Password"/.exec(tab)?.[1]);

    calls["sign in there"] = ["browser_sign_in", { username: user, password: pw }];
    await turn("sign in there", async (card) => {
        assert.equal((card.form as { place?: string }).place, app.browserPlaces()[String(session)]);
        await open(VIEWPORTS.mobile, false);
        await until(async () => (await inPage<string>(`return JSON.stringify(document.body.innerText)`)).includes("Sign in to 127.0.0.1"), "the sign-in card");
        await shot("mbrowser-card-signin-390");
        await open(VIEWPORTS.desktop, false);
        await until(async () => (await inPage<string>(`return JSON.stringify(document.body.innerText)`)).includes("Sign in to 127.0.0.1"), "the sign-in card at 1280");
        await shot("mbrowser-card-signin-1280");
        await app.answerBrowserAsk(card.id, { values: { username: "tuan@example.com", password: "hunter2-secret" } }, owner(app));
    });

    const filled = await app.browserFor(app.cwdOf(session), session).snapshot(Number(session));

    assert.doesNotMatch(filled, /hunter2-secret|tuan@example\.com/);
    assert.match(filled, /\[username for 127\.0\.0\.1\]/);

    // Detach in the panel: the owner's Chrome runs on.
    await open(VIEWPORTS.mobile, true);
    await until(async () => (await panelText()).includes("Detach"), "Detach");
    await page.evaluate(`[...document.querySelectorAll(".pb-on button")].find((each) => each.innerText === "Detach").click()`);
    await until(() => !(app.browserPlaces()[String(session)] ?? "").startsWith("attach:"), "detached");
    const port = Number(readFileSync(join(profile, "DevToolsActivePort"), "utf8").split("\n")[0]);

    assert.match(await (await fetch(`http://127.0.0.1:${port}/json/version`)).text(), /Browser/);

    // Settings › Machines: how Pi's browser runs on a machine.
    const machine = { id: "m1", name: "tuanlh-sandbox-01", host: "100.123.85.103", user: "ubuntu", keyId: "k1", createdAt: 1, hostKey: "SHA256:x", connectedAt: Date.now(), remote: { platform: "linux", arch: "x64", home: "/home/ubuntu" }, tools: {}, browserMode: "window" };

    for (const viewport of [VIEWPORTS.mobile, VIEWPORTS.desktop]) {
        await page.setViewport(viewport);
        await page.navigate(`${base}/`);
        await until(async () => await inPage<boolean>(`return JSON.stringify(document.querySelector(".composer textarea, .home") !== null)`), "the app");
        await page.evaluate(`
            const fetched = window.fetch;
            window.posted = [];
            window.fetch = async (input, init) => {
                const url = String(input);
                if (url === "api/machines") return Response.json({ machines: [${JSON.stringify(machine)}], team: { available: false, manage: false } });
                if (url.startsWith("api/machines/health")) return Response.json({ health: {} });
                if (url === "api/machines/m1" && init?.method === "POST") { window.posted.push(JSON.parse(init.body)); return Response.json({ ...${JSON.stringify(machine)}, ...JSON.parse(init.body) }); }
                return fetched(input, init);
            };
            (await import("/store.js")).openSheet({ type: "machines" });
        `);
        await until(async () => (await inPage<string>(`return JSON.stringify(document.body.innerText)`)).includes("Pi's browser here"), "the mode in Settings › Machines");
        await page.evaluate(`document.querySelector(".machine-browser-mode")?.scrollIntoView({ block: "center" })`);
        await shot(`mbrowser-machines-mode-${viewport.width}`);
    }

    assert.equal(await inPage<string>(`return JSON.stringify(document.querySelector(".machine-browser-mode .choice-text").innerText.trim())`), "A window on its screen");
    await choose(".machine-browser-mode", "Headless (no window)");
    await until(async () => (await inPage<unknown[]>(`return JSON.stringify(window.posted)`)).length > 0, "the change sent");
    assert.deepEqual(await inPage<unknown[]>(`return JSON.stringify(window.posted)`), [{ browserMode: "headless" }]);
});
