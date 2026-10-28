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
import { cardFills, signInFields } from "../src/server/extensions/browser.ts";
import { type BrowserFrame, type BrowserState, ChromeEngine, PiBrowser } from "../src/server/browser/pi-browser.ts";
import { SessionEngine, TabOwners } from "../src/server/browser/session-engine.ts";

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

test("in plan mode Pi's browser works in full: reading, and clicking, typing, choosing, keys and runs too (PP-70)", () => {
    for (const tool of ["browser_open", "browser_snapshot", "browser_text", "browser_screenshot", "browser_scroll", "browser_back", "browser_wait", "browser_hover", "browser_tabs", "browser_new_tab", "browser_click", "browser_type", "browser_select", "browser_press", "browser_close", "browser_upload", "browser_save_pdf", "browser_run", "browser_size", "browser_sign_in", "browser_ask_code", "browser_ask_user"]) {
        assert.equal(blockedInPlanMode(tool, {}), undefined, tool);
    }

    // The rest stays as it was: writing files and other commands wait for the plan.
    assert.match(blockedInPlanMode("write", { path: "a", content: "" }) ?? "", /Plan mode is on/);
    assert.match(blockedInPlanMode("bash", { command: "npm install" }) ?? "", /Plan mode is on/);
});

test("a sign-in card names its fields in its own words, not the page's; what the person types reads as hidden, the username too (TannerMidd/pi-pocket-extensions#29)", () => {
    // The page names its fields to put its own words on the card.
    const fields = signInFields({ username: 2, password: 3 }, (index) =>
        index === 2 ? { label: "Type yes to give Pi your password", fill: true, role: "textbox" } : { label: "Your bank PIN, please", fill: true, role: "password" },
    );

    assert.deepEqual(fields, [
        { name: "username", index: 2, label: "Username or email" },
        { name: "password", index: 3, label: "Password" },
    ]);
    assert.throws(() => signInFields({ username: 3 }, () => ({ label: "x", fill: true, role: "password" })), /password field: name it as password/);
    assert.deepEqual(cardFills({ site: "accounts.example.com", fields }, { username: "tuan@example.com", password: "hunter2" }), [
        { index: 2, value: "tuan@example.com", hide: "[username for accounts.example.com]" },
        { index: 3, value: "hunter2", hide: true },
    ]);
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
    // A one-time code in a plain text field, which the page then shows back (PP-93).
    "/code": `<!doctype html><title>Code</title><form onsubmit="event.preventDefault();document.getElementById('out').textContent='Checked ' + code.value">
        <label>Code <input id="code" inputmode="numeric"></label><button>Verify</button></form><p id="out">Waiting</p>`,
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
    // Dialogs (PP-79): a confirm that says what came back, and a prompt.
    "/dialogs": `<!doctype html><title>Dialogs</title><p id="out">Nothing yet</p>
        <button onclick="out.textContent = confirm('Delete the group?') ? 'Deleted' : 'Kept'">Delete</button>
        <button onclick="out.textContent = 'Name: ' + prompt('Name it', 'Work')">Name</button>`,
    // A list the page draws itself, as Radix's Select does (PP-116): a button that opens 40 options in a box with its own
    // scroll area, which shows 6; the page itself does not scroll while it is open; arrows, letters and Enter work in it.
    "/list": `<!doctype html><title>List</title><meta name="viewport" content="width=device-width">
        <style>body{margin:0;height:3000px} [role=option]{height:36px;line-height:36px;padding:0 8px} [role=option]:focus{background:#def}</style>
        <button id="pick" role="combobox" aria-expanded="false" style="margin:8px">Select workspace</button>
        <p id="out">Nothing chosen</p><p id="pos">List at 0</p>
        <div id="list" role="listbox" tabindex="-1" hidden style="position:fixed;top:48px;left:8px;width:240px;height:216px;overflow-y:auto;border:1px solid #888;background:#fff"></div>
        <script>
            const names = Array.from({ length: 40 }, (_, i) => i === 29 ? 'Global Payments' : 'Org ' + (i + 1));
            for (const name of names) { const o = document.createElement('div'); o.setAttribute('role', 'option'); o.tabIndex = -1; o.textContent = name; list.append(o); }
            const options = [...list.children];
            const close = (name) => { list.hidden = true; pick.setAttribute('aria-expanded', 'false'); if (name) out.textContent = 'Chose ' + name; };
            pick.addEventListener('click', () => { list.hidden = false; pick.setAttribute('aria-expanded', 'true'); options[0].focus(); });
            list.addEventListener('click', (event) => { if (event.target.getAttribute('role') === 'option') close(event.target.textContent); });
            list.addEventListener('scroll', () => { pos.textContent = 'List at ' + list.scrollTop; });
            list.addEventListener('keydown', (event) => {
                const at = options.indexOf(document.activeElement);
                if (event.key === 'ArrowDown') options[Math.min(at + 1, 39)].focus();
                else if (event.key === 'ArrowUp') options[Math.max(at - 1, 0)].focus();
                else if (event.key === 'Enter') close(document.activeElement.textContent);
                else if (event.key.length === 1) options.find((o) => o.textContent.toLowerCase().startsWith(event.key.toLowerCase()))?.focus();
                else return;
                event.preventDefault();
            });
            // As react-remove-scroll does under an open Radix list: the wheel scrolls nothing outside the list.
            addEventListener('wheel', (event) => { if (!list.hidden && !list.contains(event.target)) event.preventDefault(); }, { passive: false });
        </script>`,
    // A field and a button, and a trap at half their places (PP-126): a click at half the coordinates lands on the trap.
    "/aim": `<!doctype html><title>Aim</title><meta name="viewport" content="width=device-width">
        <style>body{margin:0} .at{position:fixed}</style>
        <p id="out" class="at" style="left:8px;top:8px">Nothing yet</p>
        <a href="#trap" class="at" style="left:150px;top:140px;width:120px;height:70px;background:#fdd" onclick="out.textContent='Trap'">Trap</a>
        <input id="name" aria-label="Signer" class="at" style="left:300px;top:300px;width:200px;height:40px">
        <button class="at" style="left:300px;top:360px;width:120px;height:40px" onclick="out.textContent='Hit '+innerWidth+' '+devicePixelRatio+' '+visualViewport.scale">Hit</button>`,
    "/two": `<!doctype html><title>Two</title><p>Page two</p><article>${"A long article. ".repeat(400)}</article>`,
    // A dialog whose box cancels mousedown (as dialogs and editors do to keep their focus): a click there focuses no
    // field, and Select All then took the whole page (#71257). Below it, a field that will not keep the focus.
    "/dialog": `<!doctype html><title>Dialog</title><p id="intro">Some page text</p>
        <div role="dialog" aria-label="New template" onmousedown="event.preventDefault()" style="padding:16px;border:1px solid #888">
            <label>Field name <input id="field"></label>
        </div>
        <label>Stubborn <input id="stubborn" onfocus="this.blur()"></label>
        <p id="sel">Selected 0</p>
        <script>document.addEventListener('selectionchange', () => { sel.textContent = 'Selected ' + getSelection().toString().length; });</script>`,
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

        assert.ok(Buffer.from(picture.data, "base64").subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff])), "a JPEG");
        assert.ok(Buffer.from((await browser.screenshot(1, { png: true })).data, "base64").subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47])), "a PNG, to keep (PP-118)");

        // Marks (PP-119): a text hidden wherever it shows, a control boxed with a badge; what is not in view is refused.
        await browser.open(1, "http://pi.test/");
        const goButton = Number(/\[(\d+)\] button "Go"/.exec(await browser.snapshot(1))![1]);
        const marked = Buffer.from((await browser.screenshot(1, { png: true, marks: [{ text: "Nothing yet", hide: "solid" }, { index: goButton, number: 1, label: "Search" }] })).data, "base64");
        const shown = await browser.screenshot(1, { png: true });

        assert.ok(marked.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47])));
        assert.notDeepEqual(marked, Buffer.from(shown.data, "base64"));
        await assert.rejects(browser.screenshot(1, { marks: [{ text: "not on this page", hide: "solid" }] }), /does not show in view/);
        await assert.rejects(browser.screenshot(1, { marks: [{ text: "x", index: goButton }] }), /one of index, text, or area/);

        // Frames while someone watches: one at once, so the panel has a picture.
        const { stop } = browser.watch();

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
        await assert.rejects(browser.type(1, pw, "guess", {}), /password field: type a saved secret/);
        await browser.fillFields(1, [{ index: user, value: "tuan@example.com", hide: "[username for pi.test]" }, { index: pw, value: "hunter2", hide: true }]);

        const filled = await browser.snapshot(1);

        assert.doesNotMatch(filled, /hunter2/, "the password never shows in what Pi reads");
        assert.doesNotMatch(filled, /tuan@example\.com/, "nor the username");
        const welcomed = await browser.click(1, Number(/\[(\d+)\] button "Sign in"/.exec(filled)![1]));

        // Shown back by the page: as what it reads as, in later reads and the whole text too.
        assert.match(welcomed, /Hello \[username for pi\.test\], signed in/);
        assert.doesNotMatch(welcomed, /tuan@example\.com/);
        assert.doesNotMatch((await browser.text(1, 10_000)).text, /tuan@example\.com/);

        // Taken over: Pi waits; handed back: Pi goes on.
        browser.takeOver(true);
        await assert.rejects(browser.snapshot(1), /took over/);
        await browser.input({ type: "tap", x: 10, y: 10 });
        browser.takeOver(false);
        assert.match(await browser.snapshot(1), /^Sign in — /);

        // A code the person typed on a card, in a plain field: never in what Pi reads of the page, even shown back (PP-93).
        const codePage = await browser.open(1, "http://pi.test/code");

        await browser.fillFields(1, [{ index: Number(/\[(\d+)\] textbox "Code"/.exec(codePage)![1]), value: "493817", hide: true }]);
        const withCode = await browser.snapshot(1);

        assert.doesNotMatch(withCode, /493817/, "not as the field's value");
        assert.match(withCode, /textbox "Code" value "\[typed by the person\]"/);
        const checked = await browser.click(1, Number(/\[(\d+)\] button "Verify"/.exec(withCode)![1]));

        assert.match(checked, /Checked \[typed by the person\]/);
        assert.doesNotMatch(checked, /493817/);
        assert.doesNotMatch((await browser.text(1, 10_000)).text, /493817/, "nor in the whole page's text");

        // Dialogs (PP-79): declined unless asked; accepted when asked, and the page gets the answer it was told.
        const dialogs = await browser.open(1, "http://pi.test/dialogs");
        const del = Number(/\[(\d+)\] button "Delete"/.exec(dialogs)![1]);
        const declined = await browser.click(1, del);

        assert.match(declined, /The page showed a dialog \(confirm: Delete the group\?\); it was declined\./);
        assert.match(declined, /Kept/);

        const accepted = await browser.click(1, Number(/\[(\d+)\] button "Delete"/.exec(declined)![1]), true);

        assert.match(accepted, /The page showed a dialog \(confirm: Delete the group\?\); it was accepted\./);
        assert.match(accepted, /Deleted/, "the page got yes");

        const named = await browser.click(1, Number(/\[(\d+)\] button "Name"/.exec(accepted)![1]), true);

        assert.match(named, /Name: Work/, "a prompt accepted gets its default");
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

        const picture = Buffer.from((await browser.screenshot(1)).data, "base64");

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

test("with Chrome: a list with its own scroll area (Radix's select): every option listed, the 30th clicked, chosen by name, scrolled, and by keys (PP-116)", { skip: chrome === undefined ? "no Chrome on this machine (CI runs it)" : false }, async () => {
    const browser = new PiBrowser({
        engine: new ChromeEngine(chrome!, [`--host-resolver-rules=MAP pi.test 127.0.0.1:${port}`, "--no-sandbox"]),
        changed: () => {},
        frame: () => {},
        log: () => {},
    });
    const number = (page: string, pattern: RegExp) => Number(pattern.exec(page)?.[1] ?? assert.fail(`${pattern} not in:\n${page}`));
    const pick = (page: string) => number(page, /\[(\d+)\] combobox "Select workspace"/);

    try {
        const page = await browser.open(1, "http://pi.test/list");
        const open = await browser.click(1, pick(page));

        // All 40, though 6 show in the list and the rest run below it, past the window too.
        assert.equal(open.match(/\] option "/g)?.length, 40, open);

        // A picture of the open list alone, from one of its options (PP-118): 240 CSS pixels and its border, 8 around
        // each side, at twice the CSS pixels.
        const list = await browser.screenshot(1, { png: true, index: number(open, /\[(\d+)\] option "Org 2"/) });
        const png = Buffer.from(list.data, "base64");

        assert.equal(list.whole, "listbox");
        assert.deepEqual([png.readUInt32BE(16), png.readUInt32BE(20)], [(242 + 16) * 2, (218 + 16) * 2]);

        // The 30th, far below the fold of the list: scrolled into view in it, then clicked.
        assert.match(await browser.click(1, number(open, /\[(\d+)\] option "Global Payments"/)), /Chose Global Payments/);

        // By name with browser_select on the button: it opens the list and picks.
        const chosen = await browser.select(1, pick(await browser.snapshot(1)), "Org 37");

        assert.match(chosen, /^Chose "Org 37"/);
        assert.match(chosen, /Chose Org 37/);

        // The wheel over the list scrolls the list (the page does not scroll while it is open).
        const again = await browser.click(1, pick(chosen));
        const scrolled = await browser.scroll(1, "down", 1, number(again, /\[(\d+)\] option "Org 1"/));

        assert.match(scrolled, /List at [1-9]\d*/);

        // Keys reach the list: arrows and Enter, and a letter's type-ahead.
        await browser.press(1, "ArrowDown");
        await browser.press(1, "ArrowDown");
        assert.match(await browser.press(1, "Enter"), /Chose Org 3\b/);
        await browser.click(1, pick(await browser.snapshot(1)));
        await browser.press(1, "G");
        assert.match(await browser.press(1, "Enter"), /Chose Global Payments/);
        await assert.rejects(browser.press(1, "Ctrl"), /one character/);

        // Taken over (PP-124): the person's scroll at a point in the open list scrolls the list, as a finger would.
        await browser.click(1, pick(await browser.snapshot(1)));
        assert.match(await browser.snapshot(1), /List at 0\b/);
        browser.takeOver(true);
        await browser.input({ type: "scroll", x: 100, y: 120, dx: 0, dy: 300 });
        browser.takeOver(false);
        await new Promise((resolve) => setTimeout(resolve, 250));
        assert.match(await browser.snapshot(1), /List at [1-9]\d*/);
    } finally {
        await browser.close();
    }
});

test("with Chrome: after switching between phone and desktop sizes, clicks and typing land on their target (PP-126)", { skip: chrome === undefined ? "no Chrome on this machine (CI runs it)" : false }, async () => {
    // One Chrome for two sessions, as a place's engine is in the app: the other session's tab stays at the desktop size.
    const engine = new ChromeEngine(chrome!, [`--host-resolver-rules=MAP pi.test 127.0.0.1:${port}`, "--no-sandbox"]);
    const owners = new TabOwners(undefined);
    // What the panel's frames log: a first picture that does not come, a screencast that does not start.
    const logged: string[] = [];
    const browser = new PiBrowser({ engine: new SessionEngine(engine, "phone", 1, owners), session: 1, changed: () => {}, frame: () => {}, log: (line) => logged.push(line) });
    const other = new PiBrowser({ engine: new SessionEngine(engine, "phone", 2, owners), session: 2, size: "desktop", changed: () => {}, frame: () => {}, log: (line) => logged.push(line) });
    const number = (page: string, pattern: RegExp) => Number(pattern.exec(page)?.[1] ?? assert.fail(`${pattern} not in:\n${page}`));
    /** Click Hit and type into the field, on the page as it is now: each must land on its own target. */
    const aim = async (page: string, where: string) => {
        const hit = await browser.click(1, number(page, /\[(\d+)\] button "Hit"/));

        // What the page says first: "Hit …" from the button, "Trap" from the link at half its place.
        assert.match(hit, /Visible text:\nHit \d+/, `${where}: the click reached the button, not the trap at half its place`);

        const typed = await browser.type(1, number(hit, /\[(\d+)\] textbox "Signer"/), `typed ${where}`, {});

        assert.match(typed, new RegExp(`textbox "Signer" value "typed ${where}"`), `${where}: typing reached the field`);
    };

    // Someone watches the panel all along, as the owner did: frames come through each switch.
    const { stop: unwatch } = browser.watch();

    try {
        await other.open(2, "http://pi.test/two");
        await aim(await browser.open(1, "http://pi.test/aim"), "phone");

        for (const [step, size] of ["desktop", "phone", "desktop", "phone", "desktop"].entries()) {
            await browser.resize(1, size as "phone" | "desktop");
            // As #71257 did: pages opened again between the switches.
            await browser.open(1, "http://pi.test/aim");
            await aim(await browser.open(1, "http://pi.test/aim"), `${size} ${step}`);
        }

        assert.deepEqual(logged.filter((line) => line.startsWith("browser frames")), [], "every first picture came, every screencast started");
    } finally {
        unwatch();
        await browser.close();
        await other.close();
        await engine.close();
    }
});

test("with Chrome: typing goes into the field itself, though a click there would not focus it; a field that will not take the focus is refused, and nothing else is typed or selected (#71257)", { skip: chrome === undefined ? "no Chrome on this machine (CI runs it)" : false }, async () => {
    const browser = new PiBrowser({
        engine: new ChromeEngine(chrome!, [`--host-resolver-rules=MAP pi.test 127.0.0.1:${port}`, "--no-sandbox"]),
        changed: () => {},
        frame: () => {},
        log: () => {},
    });

    try {
        const page = await browser.open(1, "http://pi.test/dialog");
        const field = Number(/\[(\d+)\] textbox "Field name"/.exec(page)?.[1]);
        const stubborn = Number(/\[(\d+)\] textbox "Stubborn"/.exec(page)?.[1]);

        assert.match(await browser.type(1, field, "customer_name", {}), /textbox "Field name" value "customer_name"/);
        await assert.rejects(browser.type(1, stubborn, "never", {}), /Stubborn did not take the typing \(focus went to [a-z]+\): nothing was typed/);
        assert.match(await browser.snapshot(1), /textbox "Stubborn" value ""/, "nothing went into it");
        assert.match(await browser.snapshot(1), /Selected 0/, "the page's text was not selected");
    } finally {
        await browser.close();
    }
});

test("with Chrome: a picture's caption is of the page pictured, though another call changes the page right after (PP-129)", { skip: chrome === undefined ? "no Chrome on this machine (CI runs it)" : false }, async () => {
    const browser = new PiBrowser({
        engine: new ChromeEngine(chrome!, [`--host-resolver-rules=MAP pi.test 127.0.0.1:${port}`, "--no-sandbox"]),
        changed: () => {},
        frame: () => {},
        log: () => {},
    });

    try {
        await browser.open(1, "http://pi.test/aim");

        // As two calls in one batch: the picture first, then an open that the browser takes right after it.
        const [shot] = await Promise.all([browser.screenshot(1), browser.open(1, "http://pi.test/two")]);

        assert.equal(browser.state().url, "http://pi.test/two");
        assert.deepEqual([shot.title, shot.url], ["Aim", "http://pi.test/aim"], "the caption of the page in the picture");
        assert.deepEqual(shot.viewport, { width: 412, height: 860 });
    } finally {
        await browser.close();
    }
});

test("with Chrome: a tab still listed while it closes does not fail the next open (PP-126)", { skip: chrome === undefined ? "no Chrome on this machine (CI runs it)" : false }, async () => {
    const engine = new ChromeEngine(chrome!, [`--host-resolver-rules=MAP pi.test 127.0.0.1:${port}`, "--no-sandbox"]);
    // A tab that closed after the list was read, as a slow page leaves it just after browser_close: Chrome answers 500.
    const gone = await engine.newTab();

    await engine.closeTab(gone);

    const session = new SessionEngine(engine, "phone", 1, new TabOwners(undefined));
    const listing = new Proxy(session, {
        get: (target, name) => {
            if (name === "tabs") {
                return async () => [...(await target.tabs()), gone];
            }

            const value = Reflect.get(target, name) as unknown;

            return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
        },
    });
    const logged: string[] = [];
    const browser = new PiBrowser({ engine: listing, session: 1, changed: () => {}, frame: () => {}, log: (line) => logged.push(line) });

    try {
        assert.match(await browser.open(1, "http://pi.test/aim"), /button "Hit"/);
        assert.ok(logged.some((line) => /tab is gone: .*500/.test(line)), logged.join("\n"));
        // Nor the actions after it, which take in tabs a page opened from the same list.
        assert.match(await browser.click(1, Number(/\[(\d+)\] button "Hit"/.exec(await browser.snapshot(1))![1])), /Visible text:\nHit/);
    } finally {
        await browser.close();
        await engine.close();
    }
});
