// Pi's browser per session (PP-13), its size (PP-15), and a person's typing (PP-14), on a real Chrome (CI has one):
// two sessions share a place's engine (one profile: a cookie set in one is there in the other) but each sees and acts on
// only its own tabs, which keep their owner across a restart (TabOwners' file); closing one session's tabs leaves the
// other's; Desktop lays pages out at 1280 with a desktop user agent and no touch, Phone at 412; a tap on a password
// field says so; and a browser left alone counts as idle, but not while it is watched.
import { cleanUp, root } from "./helpers.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { ChromeEngine, PiBrowser } from "../src/server/browser/pi-browser.ts";
import { BrowserSizes, SessionEngine, TabOwners } from "../src/server/browser/session-engine.ts";

after(() => cleanUp());

const chrome = ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"].find((name) => {
    try {
        execFileSync("which", [name], { stdio: "ignore" });

        return true;
    } catch {
        return false;
    }
});

const PAGES: Record<string, string> = {
    "/a": `<!doctype html><title>Page A</title><meta name="viewport" content="width=device-width"><p>A</p><script>document.cookie = "signed=yes; path=/"</script>`,
    "/b": `<!doctype html><title>Page B</title><meta name="viewport" content="width=device-width"><p id="out"></p><script>out.textContent = 'cookie ' + document.cookie</script>`,
    "/ua": `<!doctype html><title>UA</title><meta name="viewport" content="width=device-width"><p id="out"></p><script>out.textContent = (/Android.*Mobile/.test(navigator.userAgent) ? 'phone' : /Windows/.test(navigator.userAgent) ? 'desktop' : 'other') + ' ' + innerWidth + ' touch ' + navigator.maxTouchPoints;</script>`,
    "/login": `<!doctype html><title>Login</title><meta name="viewport" content="width=device-width"><style>input{display:block;width:300px;height:40px;margin:20px}</style><input id="user" placeholder="User"><input id="pass" type="password" placeholder="Password">`,
};
let server: Server;
let port = 0;

before(async () => {
    server = createServer((request, response) => {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end(PAGES[request.url ?? "/"] ?? "");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as { port: number }).port;
});

after(() => server?.close());

const real = { skip: chrome === undefined ? "no Chrome on this machine (CI runs it)" : false } as const;

test("two sessions at one place: their own tabs, one profile, owners kept across a restart, closing one leaves the other", real, async () => {
    const engine = new ChromeEngine(chrome!, [`--host-resolver-rules=MAP pi.test 127.0.0.1:${port}`, "--no-sandbox"]);
    const file = join(root, "browser-tabs.json");
    const owners = new TabOwners(file);
    const browserOf = (session: number, tabs = owners) =>
        new PiBrowser({ engine: new SessionEngine(engine, "machine:test", session, tabs), place: "machine:test", session, changed: () => {}, frame: () => {}, log: () => {} });
    const one = browserOf(1);
    const two = browserOf(2);

    try {
        assert.match(await one.open(1, "http://pi.test/a"), /^Page A — /);
        // The other session's page is not this one's: it opens its own tab, and the cookie session 1's page set is there.
        assert.match(await two.open(2, "http://pi.test/b"), /cookie signed=yes/);
        assert.match(await one.snapshot(1), /^Page A — /, "session 1 still reads its own page");
        assert.equal(one.state().tabs.length, 1);
        assert.equal(two.state().tabs.length, 1);
        assert.equal(one.state().session, 1);
        assert.match(await one.tabs(1), /Page A/);
        assert.doesNotMatch(await one.tabs(1), /Page B/);

        // A restart: new browsers on the same engine and the owners' file find their own tabs again.
        const again = new TabOwners(file);
        const twoAgain = browserOf(2, again);

        assert.match(await twoAgain.snapshot(2), /^Page B — /);

        // Closing session 2's tabs leaves session 1's.
        await twoAgain.close();
        assert.match(await one.snapshot(1), /^Page A — /);
        assert.deepEqual((await engine.tabs()).length, 1);
    } finally {
        await one.close();
        await engine.close();
    }
});

test("Desktop lays pages out at 1280 as a desktop Chrome without touch, Phone at 412; a tap on a password field says so; idle counts", real, async () => {
    const engine = new ChromeEngine(chrome!, [`--host-resolver-rules=MAP pi.test 127.0.0.1:${port}`, "--no-sandbox"]);
    const picked: string[] = [];
    const browser = new PiBrowser({ engine: new SessionEngine(engine, "machine:test", 7, new TabOwners(undefined)), place: "machine:test", session: 7, sized: (size) => picked.push(size), changed: () => {}, frame: () => {}, log: () => {} });

    try {
        assert.match(await browser.open(7, "http://pi.test/ua"), /phone 412 touch 5/);

        const desktop = await browser.resize(7, "desktop");

        assert.match(desktop, /^Now laid out as a desktop \(1280×800\)\.\nUA — /);
        assert.match(desktop, /desktop 1280 touch 0/);
        assert.equal(browser.state().size, "desktop");
        assert.deepEqual(browser.state().viewport, { width: 1280, height: 800 });
        // A tab opened after keeps the size.
        assert.match(await browser.newTab(7, "http://pi.test/ua"), /desktop 1280 touch 0/);
        assert.match(await browser.resize(7, "phone"), /phone 412 touch 5/);
        assert.deepEqual(picked, ["desktop", "phone"], "each size picked is kept");

        // A person's taps say where the focus went: a text field, then a password field, then nothing.
        await browser.open(7, "http://pi.test/login");
        browser.takeOver(true);
        assert.deepEqual(await browser.input({ type: "tap", x: 100, y: 40 }), { editable: true, password: false });
        await browser.input({ type: "text", text: "tuan" });
        assert.deepEqual(await browser.input({ type: "tap", x: 100, y: 100 }), { editable: true, password: true });
        assert.deepEqual(await browser.input({ type: "tap", x: 380, y: 700 }), { editable: false, password: false });
        browser.takeOver(false);

        // Left alone it is idle; watched, it is not.
        assert.ok(browser.idleFor(Date.now() + 60_000) >= 60_000);

        const stop = browser.watch();

        assert.equal(browser.idleFor(Date.now() + 60_000), 0);
        stop();
    } finally {
        await browser.close();
        await engine.close();
    }
});

/** A Chrome that resizes as the phone's WebView does: by opening each tab again at the new size. */
class ReopeningChrome extends ChromeEngine {
    override readonly reopensToResize: boolean = true;
}

test("where a tab keeps its size (the phone's WebView), a new size opens each tab again at its address, in its place", real, async () => {
    const engine = new ReopeningChrome(chrome!, [`--host-resolver-rules=MAP pi.test 127.0.0.1:${port}`, "--no-sandbox"]);
    const browser = new PiBrowser({ engine: new SessionEngine(engine, "phone", 9, new TabOwners(undefined)), place: "phone", session: 9, changed: () => {}, frame: () => {}, log: () => {} });

    try {
        await browser.open(9, "http://pi.test/a");
        await browser.newTab(9, "http://pi.test/ua");
        await browser.switchTab(9, 1);

        const before = await engine.tabs();
        const desktop = await browser.resize(9, "desktop");

        assert.match(desktop, /^Now laid out as a desktop \(1280×800\)\.\nTab 1 of 2\. Page A — /, "the tab in front stays in front");

        const after = await engine.tabs();

        assert.equal(after.length, 2);
        assert.equal(after.filter((id) => before.includes(id)).length, 0, "both tabs were opened again");
        assert.match(await browser.tabs(9), /→ 1\. Page A — http:\/\/pi\.test\/a\n  2\. UA — http:\/\/pi\.test\/ua/);
        assert.match(await browser.switchTab(9, 2), /desktop 1280 touch 0/);
    } finally {
        await browser.close();
        await engine.close();
    }
});

test("a session's size is kept and read back after a restart, Phone is the default, and an archived session's is dropped", () => {
    const file = join(root, "browser-sizes.json");
    const sizes = new BrowserSizes(file);

    assert.equal(sizes.of("phone#5"), "phone");
    sizes.set("phone#5", "desktop");
    sizes.set("machine:m1#6", "desktop");

    const again = new BrowserSizes(file);

    assert.equal(again.of("phone#5"), "desktop");
    assert.equal(again.of("machine:m1#6"), "desktop");

    // A browser made with the kept size starts at it, and keeps a new one where it is told.
    const kept: string[] = [];
    const browser = new PiBrowser({ engine: new ChromeEngine("chrome"), session: 5, size: again.of("phone#5"), sized: (size) => kept.push(size), changed: () => {}, frame: () => {}, log: () => {} });

    assert.equal(browser.state().size, "desktop");
    assert.deepEqual(browser.state().viewport, { width: 1280, height: 800 });

    again.set("phone#5", undefined);
    again.set("machine:m1#6", "phone");
    assert.equal(new BrowserSizes(file).of("phone#5"), "phone");
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), {}, "Phone is not written down");
    assert.deepEqual(kept, []);
});

test("a saved secret is typed into a password field by name; plain text into one is refused (PP-32)", real, async () => {
    const engine = new ChromeEngine(chrome!, [`--host-resolver-rules=MAP pi.test 127.0.0.1:${port}`, "--no-sandbox"]);
    const browser = new PiBrowser({ engine: new SessionEngine(engine, "machine:test", 11, new TabOwners(undefined)), place: "machine:test", session: 11, changed: () => {}, frame: () => {}, log: () => {} });

    try {
        const page = await browser.open(11, "http://pi.test/login");
        const password = Number(/\[(\d+)\] password "Password"/.exec(page)?.[1] ?? assert.fail(page));

        await assert.rejects(browser.type(11, password, "plain text", {}), /password field: type a saved secret/);

        const after = await browser.typeSecret(11, password, "LOGIN_PASSWORD", "s3cret-value-123", {});

        assert.ok(!after.includes("s3cret-value-123"), "the page as read back does not hold the value");
        assert.equal(await (await engine.connect((await engine.tabs())[0]!)).send<{ result: { value: string } }>("Runtime.evaluate", { expression: "document.getElementById('pass').value", returnByValue: true }).then((answer) => answer.result.value), "s3cret-value-123", "the page got it");
    } finally {
        await browser.close();
        await engine.close();
    }
});
