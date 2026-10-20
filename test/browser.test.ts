// Pi's browser (src/server/browser/): addresses as typed; the page as numbered controls; and, with a Chrome on the
// machine (CI), Pi's actions on real pages: type, choose, click, a covered control refused as stale, the local network
// refused, history, all the text, a picture, and live frames while someone watches. The phone's own WebView engine is
// the same protocol over its DevTools socket.
import { cleanUp } from "./helpers.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import { after, before, test } from "node:test";
import { addressOf, describe, elementsOf, type Observed } from "../src/server/browser/page.ts";
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
});

test("in plan mode Pi may open and read pages, but not click, type, choose, or press keys", () => {
    for (const tool of ["browser_open", "browser_snapshot", "browser_text", "browser_screenshot", "browser_scroll", "browser_back", "browser_wait"]) {
        assert.equal(blockedInPlanMode(tool, {}), undefined, tool);
    }

    for (const tool of ["browser_click", "browser_type", "browser_select", "browser_press", "browser_close"]) {
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
        engine: new ChromeEngine(chrome!, [`--host-resolver-rules=MAP pi.test 127.0.0.1:${port}`]),
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

        // Taken over: Pi waits; handed back: Pi goes on.
        browser.takeOver(true);
        await assert.rejects(browser.snapshot(1), /took over/);
        await browser.input({ type: "tap", x: 10, y: 10 });
        browser.takeOver(false);
        assert.match(await browser.snapshot(1), /^Shop — /);
    } finally {
        await browser.close();
    }
});
