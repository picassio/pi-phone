// Notifications for the web UI in a real Chrome (PP-127): Menu › Notifications turns them on for this browser (its
// subscription kept by the server, named for the browser), a run's end then reaches the push service encrypted for it,
// the service worker shows what is pushed (one per session, with its session to open), Send a test and Turn off work.
// Headless Chrome cannot subscribe with a real push service: the page's `pushManager.subscribe` answers with a
// subscription of real keys at a push service of this test's own, and DevTools hands pushes to the service worker.
import { type App, cleanUp, openApp, scriptedModel, until } from "./helpers.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import { after, before, test } from "node:test";
import type { Cdp } from "../src/server/browser/cdp.ts";
import { ChromeEngine } from "../src/server/browser/pi-browser.ts";
import { createHandler } from "../src/server/http.ts";

const chrome = ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"].find((name) => {
    try {
        execFileSync("which", [name], { stdio: "ignore" });

        return true;
    } catch {
        return false;
    }
});
const real = { skip: chrome === undefined ? "no Chrome on this machine" : false } as const;

let app: App;
let server: Server;
let service: Server;
let base = "";
let pushBase = "";
let engine: ChromeEngine;
let cdp: Cdp;
const pushed: string[] = [];

/** Run in the page and answer its JSON. */
async function inPage<T>(expression: string): Promise<T> {
    const answer = await cdp.send<{ result: { value?: unknown }; exceptionDetails?: { exception?: { description?: string } } }>("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });

    if (answer.exceptionDetails !== undefined) {
        throw new Error(answer.exceptionDetails.exception?.description ?? "the page threw");
    }

    return answer.result.value as T;
}

const sheetText = () => inPage<string>(`document.querySelector(".sheet")?.innerText ?? ""`);
/** Click the sheet's button `label` once it is there and enabled (the sheet's buttons wait while a step of it runs). */
const click = async (label: string) => {
    await until(
        () => inPage<boolean>(`(() => { const b = [...document.querySelectorAll(".sheet button")].find((e) => e.textContent.trim() === ${JSON.stringify(label)}); if (!b || b.disabled) return false; b.click(); return true; })()`),
        `the ${label} button`,
    );

    return true;
};

before(async () => {
    if (chrome === undefined) {
        return;
    }

    service = createServer((request, response) => {
        request.resume();
        request.on("end", () => {
            pushed.push(request.url ?? "");
            response.writeHead(201);
            response.end();
        });
    });
    await new Promise<void>((resolve) => service.listen(0, "127.0.0.1", resolve));
    pushBase = `http://127.0.0.1:${(service.address() as { port: number }).port}`;
    app = await openApp(scriptedModel());
    server = createServer(createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    engine = new ChromeEngine(chrome, ["--no-sandbox"]);
    cdp = await engine.connect(await engine.newTab());
    await cdp.send("Page.enable");
    await cdp.send("Browser.grantPermissions", { origin: base, permissions: ["notifications"] });
    // A subscription as a push service would give one: real P-256 keys, at this test's push service.
    await cdp.send("Page.addScriptToEvaluateOnNewDocument", {
        source: `
            PushManager.prototype.getSubscription = async function () { return window.__subscription ?? null; };
            PushManager.prototype.subscribe = async function (options) {
                if (!options.userVisibleOnly || !(options.applicationServerKey instanceof Uint8Array) || options.applicationServerKey.length !== 65) throw new Error("bad options");
                const pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
                const raw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
                const b64 = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\\+/g, "-").replace(/\\//g, "_").replace(/=+$/, "");
                const json = { endpoint: ${JSON.stringify(pushBase)} + "/push/test-browser", keys: { p256dh: b64(raw), auth: b64(crypto.getRandomValues(new Uint8Array(16))) } };
                window.__subscription = { toJSON: () => json, unsubscribe: async () => { window.__subscription = null; return true; } };
                return window.__subscription;
            };
        `,
    });
    await cdp.send("Page.navigate", { url: `${base}/login?token=${encodeURIComponent(app.config.ownerToken)}` });
    await until(async () => (await inPage<string>("location.pathname").catch(() => "")) === "/" && (await inPage<boolean>(`document.querySelector(".composer, .home-list, .sidebar") !== null`).catch(() => false)), "the app", 20_000);
});

after(async () => {
    cdp?.close();
    await engine?.close();
    server?.closeAllConnections();
    server?.close();
    service?.close();
    await app?.close();
    cleanUp();
});

test("Menu › Notifications turns them on here; a run's end is pushed; the service worker shows it; test and off work", real, async () => {
    await inPage(`(async () => { const { openSheet } = await import("/store.js"); openSheet({ type: "notifications" }); })()`);
    await until(async () => (await sheetText()).includes("Off. Get a notification"), "the sheet, off");
    await until(async () => /Other devices\s+None yet\./.test(await sheetText()), "no other devices");

    assert.ok(await click("Turn on"));
    await until(async () => (await sheetText()).includes("On: Chrome on"), "the sheet, on");
    assert.equal(app.webPush.list().length, 1);
    assert.equal(app.webPush.list()[0]!.origin, base);

    // A run ended, with this browser's tab visible: no push (the page shows it). Hidden, it comes.
    await until(() => [...app.webPush.list()].length === 1 && pushed.length === 0, "nothing pushed yet");
    app.phoneEvents.add({ kind: "done", session: 3, title: "HSE PVPower", text: "All tests pass." });
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.equal(pushed.length, 0, "no push while a tab of this browser is visible");
    // The tab says it is hidden, as its visibilitychange does (headless Chrome's tab never is).
    await inPage(`(async () => { const { api, PUSH_KEY } = await import("/store.js"); await api("visibility", { tab: sessionStorage.getItem("pocket.tab"), visible: false, push: localStorage.getItem(PUSH_KEY) }); })()`);
    app.phoneEvents.add({ kind: "done", session: 3, title: "HSE PVPower", text: "All tests pass, again." });
    await until(() => pushed.length === 1, "the push once the tab is hidden");
    assert.equal(pushed[0], "/push/test-browser");

    // What the service worker does with a push: one notification, tagged for its session, its tap's address kept.
    assert.equal(await inPage<string>(`navigator.serviceWorker.ready.then((r) => r.scope)`), `${base}/`);

    const registrations: string[] = [];

    cdp.on("ServiceWorker.workerRegistrationUpdated", (params) => {
        for (const each of (params.registrations as { registrationId: string; scopeURL: string }[]) ?? []) {
            if (each.scopeURL === `${base}/`) {
                registrations.push(each.registrationId);
            }
        }
    });
    await cdp.send("ServiceWorker.enable");
    await until(() => registrations.length > 0, "the worker's registration");
    await cdp.send("ServiceWorker.deliverPushMessage", { origin: base, registrationId: registrations[0], data: JSON.stringify({ title: "Done: HSE PVPower", body: "All tests pass.", url: "/s/3", tag: "pi-phone-s3" }) });
    await until(async () => (await inPage<number>(`navigator.serviceWorker.ready.then((r) => r.getNotifications()).then((n) => n.length)`)) === 1, "the notification");
    assert.deepEqual(await inPage(`navigator.serviceWorker.ready.then((r) => r.getNotifications()).then((n) => n.map((e) => ({ title: e.title, body: e.body, tag: e.tag, url: e.data.url })))`), [
        { title: "Done: HSE PVPower", body: "All tests pass.", tag: "pi-phone-s3", url: "/s/3" },
    ]);

    // Send a test: to this browser's subscription.
    assert.ok(await click("Send a test"));
    await until(() => pushed.length === 2, "the test push");

    // Turn off: the server forgets it, the browser its subscription.
    assert.ok(await click("Turn off"));
    await until(async () => (await sheetText()).includes("Off. Get a notification"), "the sheet, off again");
    assert.equal(app.webPush.list().length, 0);
    assert.equal(await inPage<string | null>(`localStorage.getItem("pocket.pushId")`), null);
});
