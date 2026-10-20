// Pi's browser (src/server/browser/): addresses as typed; the page as numbered controls; and, with a Chrome on the
// machine (CI), Pi's actions on real pages: type, choose, click, a covered control refused as stale, the local network
// refused, history, all the text, a picture, and live frames while someone watches. The phone's own WebView engine is
// the same protocol over its DevTools socket.
import { cleanUp } from "./helpers.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import { after, before, test } from "node:test";
import { addressOf, describe, elementsOf, isLocalAddress, type Observed } from "../src/server/browser/page.ts";
import { blockedInPlanMode } from "../src/server/extensions/plan.ts";
import { type BrowserFrame, type BrowserState, ChromeEngine, PiBrowser } from "../src/server/browser/pi-browser.ts";

after(() => cleanUp());

test("an address as typed: a page opens as it is, a bare name gets https, words become a search, other schemes are refused", () => {
    assert.equal(addressOf("https://example.com/a?b=1"), "https://example.com/a?b=1");
    assert.equal(addressOf("example.com"), "https://example.com/");
    assert.equal(addressOf("flights zurich london"), "https://duckduckgo.com/?q=flights%20zurich%20london");
    assert.throws(() => addressOf("file:///etc/passwd"), /http and https pages only/);
    assert.throws(() => addressOf("javascript:alert(1)"), /http and https pages only/);
    assert.throws(() => addressOf("  "), /Give an address/);

    for (const local of ["http://localhost:8787/", "http://127.0.0.1:8787/s/1", "http://192.168.1.50/", "http://10.0.0.2/", "http://172.20.1.1/", "http://100.119.9.4/", "http://[::1]:8787/", "http://0.0.0.0/"]) {
        assert.equal(isLocalAddress(local), true, local);
    }

    for (const remote of ["https://example.com/", "https://172.32.0.1/", "https://100.128.0.1/", "https://8.8.8.8/"]) {
        assert.equal(isLocalAddress(remote), false, remote);
    }
});

test("in plan mode Pi may open and read pages, but not click, type, choose, or press keys", () => {
    for (const tool of ["browser_open", "browser_snapshot", "browser_text", "browser_screenshot", "browser_scroll", "browser_back", "browser_wait", "browser_hover", "browser_tabs", "browser_new_tab"]) {
        assert.equal(blockedInPlanMode(tool, {}), undefined, tool);
    }

    for (const tool of ["browser_click", "browser_type", "browser_select", "browser_press", "browser_close", "browser_upload", "browser_save_pdf"]) {
        assert.match(blockedInPlanMode(tool, {}) ?? "", /Plan mode is on/, tool);
    }
});

test("controls are numbered once each, a drop-down with its choices, and described with the visible text", () => {
    const rect = { x: 0, y: 0, w: 10, h: 10 };
    const observed: Observed = {
        url: "https://pi.test/",
        title: "Shop",
        w: 412,
        h: 860,
        text: "Welcome",
        scroll: { y: 0, height: 2000 },
        actions: [
            { node: 7, role: "searchbox", label: "Search", rect, kind: "fill", value: "" },
            { node: 7, role: "searchbox", label: "Search", rect, kind: "click", value: "" },
            { node: 9, role: "combobox", label: "Sort", rect, kind: "select", value: "new", option: "Newest", current_value: "Popular" },
            { node: 9, role: "combobox", label: "Sort", rect, kind: "select", value: "cheap", option: "Cheapest", current_value: "Popular" },
            { node: 3, role: "button", label: "Go", rect, kind: "click", value: "" },
        ],
        marker: [],
        page_key: [],
        guards: {},
        omitted: 0,
    };
    const elements = elementsOf(observed);

    assert.deepEqual(elements.map((each) => [each.index, each.node, each.label]), [[1, 7, "Search"], [2, 9, "Sort"], [3, 3, "Go"]]);
    assert.equal(elements[0]!.fill, true);
    assert.deepEqual(elements[1]!.options?.map((option) => option.label), ["Newest", "Cheapest"]);

    const text = describe(observed, elements);

    assert.match(text, /^Shop — https:\/\/pi\.test\//);
    assert.match(text, /more below/);
    assert.match(text, /\[1\] searchbox "Search" value ""/);
    assert.match(text, /\[2\] combobox "Sort" chosen "Popular", other options: "Newest", "Cheapest"/);
    assert.match(text, /Visible text:\nWelcome/);
});

// ─── With a Chrome on the machine ─────────────────────────────────────────────────────────────────────────────────

const chrome = ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"].find((name) => {
    try {
        execFileSync("which", [name], { stdio: "ignore" });

        return true;
    } catch {
        return false;
    }
});

const PAGES: Record<string, string> = {
    "/": `<!doctype html><title>Shop</title><meta name="viewport" content="width=device-width">
        <h1>Shop</h1>
        <label>Search <input id="q"></label>
        <label>Sort <select id="sort"><option>Popular</option><option value="new">Newest</option></select></label>
        <button id="go" onclick="document.getElementById('out').textContent='Found ' + q.value + ' by ' + sort.value">Go</button>
        <p id="out">Nothing yet</p>
        <div style="position:relative;height:60px"><button id="hidden">Under</button><div style="position:absolute;inset:0;background:#eee"></div></div>
        <a href="/two">Next page</a>`,
    "/login": `<!doctype html><title>Sign in</title><form onsubmit="event.preventDefault();document.getElementById('out').textContent='Hello ' + user.value + (pw.value === 'hunter2' ? ', signed in' : ', wrong password')">
        <label>Email <input id="user" autocomplete="username"></label><label>Password <input id="pw" type="password"></label><button>Sign in</button></form><p id="out">Signed out</p>`,
    "/sheet": `<!doctype html><title>Sheet</title><p id="out">Feed</p>
        <div style="position:fixed;left:0;right:0;bottom:0;padding:16px;background:#222;color:#fff">
            <div>Open in...</div>
            <div id="app" style="cursor:pointer;padding:8px" onclick="out.textContent='Opened the app'"><span>App</span> <span>Open</span></div>
            <div id="web" style="cursor:pointer;padding:8px"><span>Browser</span> <span>Continue</span></div>
        </div>
        <script>web.addEventListener('click', () => { out.textContent = 'Continued in the browser'; web.parentElement.remove(); });</script>`,
    "/tools": `<!doctype html><title>Tools</title><p id="out">Ready</p>
        <svg style="display:none"><symbol id="icon-search"><circle r="4"/></symbol></svg>
        <a href="/two" id="icon"><svg width="24" height="24"><use href="#icon-search"></use></svg></a>
        <a href="/u/tuan" style="display:inline-block;width:24px;height:24px;background:#ccc"></a>
        <button onmouseenter="out.textContent='Menu open'">Menu</button>
        <label>Attachment <input type="file" onchange="out.textContent='Got ' + this.files[0].name + ' ' + this.files[0].size"></label>
        <button onclick="document.getElementById('pics').click()">Upload photos</button>
        <input type="file" id="pics" multiple style="display:none" onchange="out.textContent='Photos ' + [...this.files].map(f => f.name).join(',')">
        <a href="/two" target="_blank">Open in a new tab</a>`,
    "/ua": `<!doctype html><title>UA</title><meta name="viewport" content="width=device-width"><p id="out"></p><script>out.textContent = (/Android.*Mobile/.test(navigator.userAgent) ? 'phone' : 'desktop') + ' ' + innerWidth + ' touch ' + navigator.maxTouchPoints;</script>`,
    "/two": `<!doctype html><title>Two</title><p>Page two</p><article>${"A long article. ".repeat(400)}</article>`,
};

let server: Server;
let port = 0;

before(async () => {
    server = createServer((request, response) => {
        const page = PAGES[request.url ?? "/"];

        response.writeHead(page === undefined ? 404 : 200, { "content-type": "text/html; charset=utf-8" });
        response.end(page ?? "not here");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as { port: number }).port;
});

after(() => server?.close());

test("with Chrome: Pi reads a page, types, chooses, clicks; a covered control and the local network are refused; back, text, a picture, frames", { skip: chrome === undefined ? "no Chrome on this machine (CI runs it)" : false }, async () => {
    const states: BrowserState[] = [];
    const frames: BrowserFrame[] = [];
    // A name that is not a local address, mapped to the test server: 127.0.0.1 itself is refused, as it should be.
    const browser = new PiBrowser({
        engine: new ChromeEngine(chrome!, [`--host-resolver-rules=MAP pi.test 127.0.0.1:${port}`, "--no-sandbox"]),
        changed: (state) => states.push(state),
        frame: (frame) => frames.push(frame),
        log: () => {},
    });

    try {
        const first = await browser.open(1, "http://pi.test/");

        assert.match(first, /^Shop — http:\/\/pi\.test\//);

        const search = /\[(\d+)\] textbox "Search"/.exec(first)?.[1];
        const sort = /\[(\d+)\] combobox "Sort" chosen "Popular"/.exec(first)?.[1];
        const go = /\[(\d+)\] button "Go"/.exec(first)?.[1];

        assert.ok(search && sort && go, first);

        const typed = await browser.type(1, Number(search), "lamp", {});

        assert.match(typed, /textbox "Search" value "lamp"/);

        const chosen = await browser.select(1, Number(/\[(\d+)\] combobox "Sort"/.exec(typed)![1]), "newest");

        assert.match(chosen, /^Chose "Newest"/);

        const clicked = await browser.click(1, Number(/\[(\d+)\] button "Go"/.exec(chosen)![1]));

        assert.match(clicked, /Found lamp by new/);
        assert.equal(states.at(-1)?.doing, null);
        assert.ok(states.some((state) => state.doing?.startsWith("Clicking [")), "the panel heard what Pi was doing");

        // A control behind something else is refused, not clicked through; a number not on the page is refused too.
        await assert.rejects(browser.click(1, Number(/\[(\d+)\] button "Under"/.exec(clicked)![1])), /covered/);
        await assert.rejects(browser.type(1, 999, "x", {}), /There is no \[999\]/);

        // The local network: never loaded.
        await assert.rejects(browser.open(1, `http://127.0.0.1:${port}/`), /does not open|local network|ERR_BLOCKED/);

        const next = await browser.click(1, Number(/\[(\d+)\] link "Next page"/.exec(await browser.snapshot(1))![1]));

        assert.match(next, /^Two — /);

        const all = await browser.text(1, 1000);

        assert.equal(all.cut, true);
        assert.match(all.text, /^Page two/);
        assert.match(await browser.history(1, -1), /^Shop — /);

        const picture = await browser.screenshot(1);

        assert.ok(Buffer.from(picture, "base64").subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff])), "a JPEG");

        // Frames while someone watches: one at once, so the panel has a picture.
        const stop = browser.watch();

        for (let tries = 0; tries < 50 && frames.length === 0; tries++) {
            await new Promise((resolve) => setTimeout(resolve, 100));
        }

        stop();
        assert.ok(frames.length > 0, "a frame came");

        // Things clickable only by their look or script (a sheet's plain divs) are listed, and clicking one works.
        const sheet = await browser.open(1, "http://pi.test/sheet");

        assert.match(sheet, /clickable "App Open"/);
        assert.doesNotMatch(sheet, /clickable "Open in\.\.\."/, "plain text with no pointer is not a control");
        assert.match(await browser.click(1, Number(/\[(\d+)\] clickable "Browser Continue"/.exec(sheet)![1])), /Continued in the browser/);

        // A sign-in: the password field is listed but never its value; Pi may not type into it; the person's values go in.
        const login = await browser.open(1, "http://pi.test/login");
        const user = Number(/\[(\d+)\] textbox "Email"/.exec(login)![1]);
        const pw = Number(/\[(\d+)\] password "Password"/.exec(login)![1]);

        assert.doesNotMatch(login, /password "Password" value/);
        await assert.rejects(browser.type(1, pw, "guess", {}), /Pi never types a password/);
        await browser.fillFields(1, [{ index: user, value: "tuan@example.com" }, { index: pw, value: "hunter2" }]);

        const filled = await browser.snapshot(1);

        assert.doesNotMatch(filled, /hunter2/, "the password never shows in what Pi reads");
        assert.match(await browser.click(1, Number(/\[(\d+)\] button "Sign in"/.exec(filled)![1])), /Hello tuan@example\.com, signed in/);

        // Taken over: Pi waits; handed back: Pi goes on.
        browser.takeOver(true);
        await assert.rejects(browser.snapshot(1), /took over/);
        await browser.input({ type: "tap", x: 10, y: 10 });
        browser.takeOver(false);
        assert.match(await browser.snapshot(1), /^Sign in — /);
    } finally {
        await browser.close();
    }
});

test("with Chrome: icons get names, hover, uploads to a field and through its button, a PDF, and tabs (new, switch, close, one a link opened)", { skip: chrome === undefined ? "no Chrome on this machine (CI runs it)" : false }, async () => {
    const states: BrowserState[] = [];
    const browser = new PiBrowser({
        engine: new ChromeEngine(chrome!, [`--host-resolver-rules=MAP pi.test 127.0.0.1:${port}`, "--no-sandbox"]),
        changed: (state) => states.push(state),
        frame: () => {},
        log: () => {},
    });
    const number = (page: string, pattern: RegExp) => Number(pattern.exec(page)?.[1] ?? assert.fail(`${pattern} not in:\n${page}`));

    try {
        const page = await browser.open(1, "http://pi.test/tools");

        // A desktop Chrome presents itself as a phone's, at the phone's width, with pictures at twice its CSS pixels.
        assert.match(await browser.open(1, "http://pi.test/ua"), /phone 412 touch 5/);

        const picture = Buffer.from(await browser.screenshot(1), "base64");

        assert.equal(picture.readUInt16BE(picture.indexOf(Buffer.from([0xff, 0xc0])) + 7), 824, "824 pixels wide");
        await browser.open(1, "http://pi.test/tools");

        // Icons with no text: named by their sprite, or where they go.
        assert.match(page, /link "search"/);
        assert.match(page, /link "to \/u\/tuan"/);
        assert.match(page, /file "Attachment"/);

        assert.match(await browser.hover(1, number(page, /\[(\d+)\] button "Menu"/)), /Menu open/);

        const one = await browser.upload(1, number(page, /\[(\d+)\] file "Attachment"/), [{ name: "notes.txt", bytes: new TextEncoder().encode("hello") }]);

        assert.match(one, /Got notes\.txt 5/);

        const photos = await browser.upload(1, number(one, /\[(\d+)\] button "Upload photos"/), [
            { name: "a.png", bytes: new Uint8Array([1]) },
            { name: "b.png", bytes: new Uint8Array([2]) },
        ]);

        assert.match(photos, /Photos a\.png,b\.png/);
        await assert.rejects(browser.upload(1, number(photos, /\[(\d+)\] button "Menu"/), [{ name: "x.txt", bytes: new Uint8Array([1]) }]), /did not ask for a file/);

        const { pdf } = await browser.pdf(1);

        assert.equal(pdf.subarray(0, 5).toString(), "%PDF-");

        // A link to a new window opens a tab, brought to the front, as a person's browser does.
        const opened = await browser.click(1, number(await browser.snapshot(1), /\[(\d+)\] link "Open in a new tab"/));

        assert.match(opened, /opened a new tab; now on tab 2 of 2/);
        assert.match(opened, /Two — /);

        const third = await browser.newTab(1, "http://pi.test/");

        assert.match(third, /^Tab 3 of 3\. Shop — /);
        assert.equal(states.at(-1)?.tabs.length, 3);
        assert.equal(states.at(-1)?.tab, 2);
        assert.match(await browser.tabs(1), /  1\. Tools — http:\/\/pi\.test\/tools\n  2\. Two — .*\n→ 3\. Shop/);
        assert.match(await browser.switchTab(1, 1), /^Tab 1 of 3\. Tools — /);
        assert.match(await browser.closeTab(1, 2), /^Closed tab 2\.\nTab 1 of 2\. Tools — /);
        await assert.rejects(browser.switchTab(1, 5), /There is no tab 5/);
        assert.match(await browser.closeTab(1, 1), /^Closed tab 1\.\nShop — /);
        assert.match(await browser.closeTab(1, 1), /last tab/);
        assert.equal(states.at(-1)?.open, false);
    } finally {
        await browser.close();
    }
});
