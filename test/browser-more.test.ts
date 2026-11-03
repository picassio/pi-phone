// Pi's browser, PP-376, with a Chrome on the machine (CI): controls inside frames (another site's, in a process of its
// own, and the page's own) and open shadow roots are read and acted on, and what the person types on a card stays
// hidden there too.
import { cleanUpAll } from "./helpers.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import { after, before, test } from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chordOf } from "../src/server/browser/page.ts";
import { ChromeEngine, PiBrowser, type PiBrowserOptions } from "../src/server/browser/pi-browser.ts";

const chrome = ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"].find((name) => {
    try {
        execFileSync("which", [name], { stdio: "ignore" });

        return true;
    } catch {
        return false;
    }
});
const skip = chrome === undefined ? "no Chrome on this machine (CI runs it)" : false;

/** The pages, by path; `PORT` is the server's port (a frame's address names it). */
const PAGES: Record<string, string> = {
    // A shop's checkout: the card fields in a frame of the payment site (another process), a note field in a frame of the
    // page's own, and a web component whose controls are in its open shadow root.
    "/checkout": `<!doctype html><title>Checkout</title><meta name="viewport" content="width=device-width">
        <style>body{margin:8px} iframe{display:block;width:380px;border:1px solid #888;margin:4px 0}</style>
        <p id="out">Your cart</p>
        <iframe id="pay" src="http://pay.test:PORT/card" style="height:170px"></iframe>
        <iframe id="note" style="height:70px" srcdoc="<label>Gift note <input id=gift></label> <button onclick=&quot;parent.document.getElementById('out').textContent='Note: '+gift.value&quot;>Save note</button>"></iframe>
        <coupon-box></coupon-box>
        <script>
            customElements.define('coupon-box', class extends HTMLElement {
                connectedCallback() {
                    const root = this.attachShadow({ mode: 'open' });
                    root.innerHTML = '<label for=c>Coupon code</label> <input id=c> <button id=apply>Apply coupon</button> <p>Coupons inside</p>';
                    root.getElementById('apply').addEventListener('click', () => { document.getElementById('out').textContent = 'Coupon ' + root.getElementById('c').value; });
                }
            });
        </script>`,
    // Drag and drop: a kanban card (HTML5 drag and drop, with its data), a slider, and a map panned by the pointer.
    "/board": `<!doctype html><title>Board</title><meta name="viewport" content="width=device-width">
        <style>body{margin:8px} .col{width:150px;height:90px;border:1px solid #888;display:inline-block;vertical-align:top;margin:4px}</style>
        <div class="col" id="todo" aria-label="To do"><div id="card" draggable="true" style="background:#ffd;padding:6px">Write the report</div></div>
        <div class="col" id="done" aria-label="Done" tabindex="0">Done</div>
        <p><label>Volume <input id="vol" type="range" min="0" max="100" value="10" style="width:200px" oninput="out.textContent='Volume '+this.value"></label></p>
        <div id="map" aria-label="Map" style="width:300px;height:120px;background:#cde;cursor:grab">Map</div>
        <p id="out">Nothing yet</p><p id="log"></p>
        <script>
            card.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/plain', 'card-7'); log.textContent += 'dragstart '; });
            done.addEventListener('dragover', (e) => e.preventDefault());
            done.addEventListener('drop', (e) => { e.preventDefault(); done.append(card); out.textContent = 'Dropped ' + e.dataTransfer.getData('text/plain') + ' in Done'; });
            let from = null;
            map.addEventListener('pointerdown', (e) => { from = [e.clientX, e.clientY]; map.setPointerCapture(e.pointerId); });
            map.addEventListener('pointermove', (e) => { if (from) log.textContent += 'm'; });
            map.addEventListener('pointerup', (e) => { out.textContent = 'Panned ' + Math.round(e.clientX - from[0]) + ',' + Math.round(e.clientY - from[1]); from = null; });
        </script>`,
    // Downloads: a link to a file, a file the page's script makes, and one too big to keep (archive.bin, 30 MB).
    "/files": `<!doctype html><title>Files</title><meta name="viewport" content="width=device-width">
        <p><a href="/prices.csv" download>Price list</a></p>
        <p><button onclick="const a = document.createElement('a'); a.href = window.URL.createObjectURL(new Blob(['hello notes'])); a.download = 'notes.txt'; a.click()">Export notes</button></p>
        <p><a href="/archive.bin">Whole archive</a></p>`,
    // Keys: each chord the page hears (not plain characters), where the focus is, and what is selected after it.
    "/keys": `<!doctype html><title>Keys</title><meta name="viewport" content="width=device-width">
        <label>Notes <textarea id="notes"></textarea></label><br><label>Name <input id="name"></label><br>
        <label>Password <input id="pw" type="password"></label>
        <p id="out">No keys</p><p id="after">Nothing</p>
        <script>
            addEventListener('keydown', (e) => {
                if (['Control', 'Shift', 'Meta', 'Alt'].includes(e.key) || (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey)) return;
                out.textContent = 'Heard ' + (e.ctrlKey ? 'Ctrl+' : '') + (e.metaKey ? 'Meta+' : '') + (e.altKey ? 'Alt+' : '') + (e.shiftKey ? 'Shift+' : '') + e.key + ' in ' + document.activeElement.id;
                if (e.key === 'Enter' && e.ctrlKey) e.preventDefault();
            }, true);
            addEventListener('keyup', () => { const f = document.activeElement; after.textContent = 'Focus ' + f.id + ', selected ' + ((f.selectionEnd ?? 0) - (f.selectionStart ?? 0)) + ', notes ' + JSON.stringify(notes.value); });
        </script>`,
    // A photo that opens on a double click, has its own context menu, and a long press (a finger's, or the mouse's).
    "/clicks": `<!doctype html><title>Clicks</title><meta name="viewport" content="width=device-width">
        <button id="photo" style="width:160px;height:90px">Photo</button><p id="out">Nothing yet</p>
        <script>
            photo.addEventListener('dblclick', () => { out.textContent = 'Opened full size'; });
            photo.addEventListener('contextmenu', (e) => { e.preventDefault(); out.textContent = 'Menu: Save, Share'; });
            let since = 0, touched = false;
            photo.addEventListener('touchstart', () => { since = performance.now(); touched = true; });
            photo.addEventListener('touchend', () => { out.textContent = 'Held ' + (performance.now() - since >= 1000 ? 'long' : 'short') + ' by touch'; });
            photo.addEventListener('mousedown', (e) => { if (!touched && e.button === 0) since = performance.now(); });
            photo.addEventListener('mouseup', (e) => { if (!touched && e.button === 0 && e.detail === 1) out.textContent = 'Held ' + (performance.now() - since >= 1000 ? 'long' : 'short') + ' by mouse'; });
        </script>`,
    // Text to select: on the page (across elements too), in fields, in an editor; what is selected shows on the page.
    "/select": `<!doctype html><title>Select</title><meta name="viewport" content="width=device-width">
        <p>The quick brown fox jumps over the lazy dog.</p><p>Second <b>bold words</b> here.</p>
        <label>Title <input id="title" value="Quarterly report draft"></label><br><label>Body <textarea id="body">alpha beta gamma</textarea></label>
        <div contenteditable="true" aria-label="Editor" role="textbox">Edit me please</div><label>PIN <input id="pin" type="password" value="9876"></label>
        <p id="sel">Nothing selected</p>
        <script>document.addEventListener('selectionchange', () => { const a = document.activeElement; sel.textContent = 'Selection: ' + ((a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA')) ? a.value.slice(a.selectionStart, a.selectionEnd) : getSelection().toString()); });</script>`,
    // A page three views tall, with a field far below the fold, and words at its end.
    "/long": `<!doctype html><title>Long</title><meta name="viewport" content="width=device-width">
        <style>body{margin:0;background:#fff}</style><h1 style="margin:8px">Top of the page</h1><div style="height:1800px"></div>
        <label>Member number <input id="member" style="width:300px;height:40px;background:#fff;border:0"></label><div style="height:1000px"></div><p>Bottom words</p>`,
    "/card": `<!doctype html><title>Card</title><meta name="viewport" content="width=device-width">
        <label>Card number <input id="card"></label><br><label>PIN <input id="pin" type="password"></label><br>
        <button onclick="out.textContent = 'Paid with ' + card.value + (pin.value === '4321' ? ' and the PIN' : ' without the PIN')">Pay</button>
        <p id="out">Not paid</p>`,
};

let server: Server;
let port = 0;

before(async () => {
    server = createServer((request, response) => {
        const path = (request.url ?? "/").split("?")[0]!;

        if (path === "/prices.csv") {
            response.writeHead(200, { "content-type": "text/csv" });
            response.end("lamp,12\nchair,40\n");

            return;
        }

        if (path === "/archive.bin") {
            const size = 30 * 1024 * 1024;
            const chunk = Buffer.alloc(1024 * 1024);

            response.writeHead(200, { "content-type": "application/octet-stream", "content-disposition": "attachment; filename=archive.bin", "content-length": String(size) });

            for (let sent = 0; sent < size; sent += chunk.length) {
                response.write(chunk);
            }

            response.end();

            return;
        }

        const page = PAGES[path];

        response.writeHead(page === undefined ? 404 : 200, { "content-type": "text/html; charset=utf-8" });
        response.end((page ?? "not here").replaceAll("PORT", String(port)));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as { port: number }).port;
});

after(() => cleanUpAll(() => server?.close()));

/** A browser on a headless Chrome, where pi.test and pay.test (another site) are the test server. */
function browserHere(options: Partial<PiBrowserOptions> = {}): PiBrowser {
    return new PiBrowser({
        engine: new ChromeEngine(chrome!, [`--host-resolver-rules=MAP pi.test 127.0.0.1:${port},MAP pay.test 127.0.0.1:${port}`, "--no-sandbox"]),
        changed: () => {},
        frame: () => {},
        log: () => {},
        ...options,
    });
}

/** The number of the control a pattern finds in a read. */
const number = (page: string, pattern: RegExp) => Number(pattern.exec(page)?.[1] ?? assert.fail(`${pattern} not in:\n${page}`));

test("with Chrome: controls in a frame of another site, a frame of the page's own and an open shadow root are read and acted on; a card's typing stays hidden there (PP-376)", { skip }, async () => {
    const browser = browserHere();

    try {
        const page = await browser.open(1, "http://pi.test/checkout");
        const site = `pay.test:${port}`;

        // Each frame's controls, named with the frame; the shadow root's as the page's own.
        assert.match(page, new RegExp(`\\[\\d+\\] textbox "Card number" value "" \\(in a frame: ${site}\\)`));
        assert.match(page, new RegExp(`\\[\\d+\\] password "PIN" \\(in a frame: ${site}\\)`));
        assert.match(page, /\[\d+\] textbox "Gift note" value "" \(in a frame: an inline frame\)/);
        assert.match(page, /\[\d+\] textbox "Coupon code" value ""\n/);
        assert.match(page, /\[\d+\] button "Apply coupon"\n/);
        // Their visible text, the frames' under their names.
        assert.match(page, new RegExp(`\\[In a frame: ${site}\\]\\nCard number[\\s\\S]*Not paid`));
        assert.match(page, /Coupons inside/);

        // Typing and clicking in the other site's frame; Pi's own typing never goes into its password field.
        const typed = await browser.type(1, number(page, /\[(\d+)\] textbox "Card number"/), "4242", {});

        assert.match(typed, /textbox "Card number" value "4242"/);
        await assert.rejects(browser.type(1, number(typed, /\[(\d+)\] password "PIN"/), "1111", {}), /is a password field/);

        // The person's card fills it (a password, and a username-like value in the card field), hidden from Pi there too.
        await browser.fillFields(1, [
            { index: number(typed, /\[(\d+)\] password "PIN"/), value: "4321", hide: true },
            { index: number(typed, /\[(\d+)\] textbox "Card number"/), value: "4000-1234-5678", hide: "[card for pay.test]" },
        ]);

        const paid = await browser.click(1, number(await browser.snapshot(1), /\[(\d+)\] button "Pay"/));

        assert.match(paid, /Paid with \[card for pay\.test\] and the PIN/);
        assert.doesNotMatch(paid, /4000-1234-5678/);

        const whole = await browser.text(1, 40_000);

        assert.ok(!("withheld" in whole));
        assert.match(whole.text, new RegExp(`\\[In a frame: ${site}\\]\\n[\\s\\S]*Paid with \\[card for pay\\.test\\] and the PIN`));
        assert.match(whole.text, /Coupons inside/);
        assert.doesNotMatch(whole.text, /4000-1234-5678/);

        // A picture: the card field in the frame is blacked out, a mark on a control in the frame is placed.
        const shot = await browser.screenshot(1, { marks: [{ index: number(paid, /\[(\d+)\] button "Pay"/), label: "Pay" }] });

        assert.ok("data" in shot);

        // The page's own frame, and the shadow root.
        const noted = await browser.type(1, number(paid, /\[(\d+)\] textbox "Gift note"/), "Happy birthday", {});
        const saved = await browser.click(1, number(noted, /\[(\d+)\] button "Save note"/));

        assert.match(saved, /Note: Happy birthday/);

        const coupon = await browser.type(1, number(saved, /\[(\d+)\] textbox "Coupon code"/), "SAVE10", {});
        const applied = await browser.click(1, number(coupon, /\[(\d+)\] button "Apply coupon"/));

        assert.match(applied, /Coupon SAVE10/);
    } finally {
        await browser.close();
    }
});

test("with Chrome: browser_drag drops a card on a column (the page's own drag and drop, with its data), moves a slider and pans a map by an offset (PP-376)", { skip }, async () => {
    const browser = browserHere();

    try {
        const page = await browser.open(1, "http://pi.test/board");

        // What can be dragged says so.
        assert.match(page, /\[\d+\] clickable "Write the report" draggable\n/);
        assert.match(page, /\[\d+\] slider "Volume" value "10" draggable\n/);
        assert.match(page, /\[\d+\] clickable "Map" draggable\n/);

        const dropped = await browser.drag(1, number(page, /\[(\d+)\] clickable "Write the report"/), { index: number(page, /\[(\d+)\] clickable "Done"/) });

        assert.match(dropped, /^Dragged \[\d+\] onto \[\d+\] \(the page's own drag and drop\)\.\n/);
        assert.match(dropped, /Dropped card-7 in Done/);

        const slid = await browser.drag(1, number(dropped, /\[(\d+)\] slider "Volume"/), { dx: 80, dy: 0 });
        const volume = Number(/Volume (\d+)/.exec(slid.split("Visible text:")[1] ?? "")?.[1]);

        assert.ok(volume > 50, slid);

        const panned = await browser.drag(1, number(slid, /\[(\d+)\] clickable "Map"/), { dx: -60, dy: 30 });

        assert.match(panned, /^Dragged \[\d+\] by -60, 30 px\.\n/);
        assert.match(panned, /Panned -60,30/);
        // The pointer moved there in steps, as a person's does.
        assert.match(panned, /m{5,}/);
        await assert.rejects(browser.drag(1, number(panned, /\[(\d+)\] clickable "Map"/), { dx: 5000, dy: 0 }), /would end outside the view/);
    } finally {
        await browser.close();
    }
});

test("a key or a chord: modifiers by name (Ctrl, Shift, Meta or Cmd, Alt), a letter as the key's own, and no text with a shortcut (PP-376)", () => {
    assert.deepEqual(chordOf("Ctrl+A"), { key: "a", code: "KeyA", keyCode: 65, modifiers: 2 });
    assert.deepEqual(chordOf("Shift+Tab"), { key: "Tab", code: "Tab", keyCode: 9, modifiers: 8 });
    assert.deepEqual(chordOf("cmd+k"), { key: "k", code: "KeyK", keyCode: 75, modifiers: 4 });
    assert.deepEqual(chordOf("Ctrl+Shift+P"), { key: "P", code: "KeyP", keyCode: 80, modifiers: 10 });
    assert.deepEqual(chordOf("Shift+a"), { key: "A", code: "KeyA", keyCode: 65, modifiers: 8, text: "A" });
    assert.deepEqual(chordOf("Ctrl+Enter"), { key: "Enter", code: "Enter", keyCode: 13, modifiers: 2 });
    assert.deepEqual(chordOf("Ctrl++"), { key: "+", code: "", keyCode: 0, modifiers: 2 });
    // Keys as before: a named key, a character, and "+" itself.
    assert.deepEqual(chordOf("Enter"), { key: "Enter", code: "Enter", keyCode: 13, modifiers: 0, text: "\r" });
    assert.deepEqual(chordOf("G"), { key: "G", code: "KeyG", keyCode: 71, modifiers: 0, text: "G" });
    assert.deepEqual(chordOf("+"), { key: "+", code: "", keyCode: 0, modifiers: 0, text: "+" });
    assert.equal(chordOf("Hyper+A"), undefined);
    assert.equal(chordOf("Ctrl+Bogus"), undefined);
});

test("with Chrome: browser_press presses chords the page hears (Ctrl+A selects all, Ctrl+Enter, Shift+Tab goes back, Meta+K), and no character into a password field (PP-376)", { skip }, async () => {
    const browser = browserHere();

    try {
        const page = await browser.open(1, "http://pi.test/keys");

        await browser.type(1, number(page, /\[(\d+)\] textbox "Notes"/), "one two three", {});
        assert.match(await browser.press(1, "Ctrl+A"), /Heard Ctrl\+a in notes\nFocus notes, selected 13/);
        assert.match(await browser.press(1, "Ctrl+Enter"), /Heard Ctrl\+Enter in notes\nFocus notes, selected 13, notes "one two three"/);
        assert.match(await browser.press(1, "Meta+K"), /Heard Meta\+k in notes/);

        const named = await browser.type(1, number(page, /\[(\d+)\] textbox "Name"/), "Tuan", {});

        assert.match(await browser.press(1, "Shift+Tab"), /Heard Shift\+Tab in name\nFocus notes/);

        // In the password field: a character is refused, a shortcut and Enter are not.
        await browser.click(1, number(named, /\[(\d+)\] password "Password"/));
        await assert.rejects(browser.press(1, "x"), /focus is in a password field, and x would type into it/);
        await assert.rejects(browser.press(1, "Shift+X"), /password field/);
        assert.match(await browser.press(1, "Ctrl+A"), /Heard Ctrl\+a in pw/);
        assert.match(await browser.press(1, "Enter"), /Heard Enter in pw/);
        await assert.rejects(browser.press(1, "Hyper+A"), /each with modifiers if needed/);
    } finally {
        await browser.close();
    }
});

test("with Chrome: browser_focus puts the focus on a control without a click, in a frame of another site too; the read says which control has it (PP-376)", { skip }, async () => {
    const browser = browserHere();

    try {
        const page = await browser.open(1, "http://pi.test/keys");

        assert.doesNotMatch(page, /focused/);

        const focused = await browser.focus(1, number(page, /\[(\d+)\] textbox "Name"/));

        assert.match(focused, /\[\d+\] textbox "Name" value "" focused\n/);
        assert.match(await browser.press(1, "Shift+Tab"), /\[\d+\] textbox "Notes" value "" focused\n[\s\S]*Focus notes/);

        // In the payment site's frame: the read follows the focus into it, and keys go there.
        const checkout = await browser.open(1, "http://pi.test/checkout");
        const card = await browser.focus(1, number(checkout, /\[(\d+)\] textbox "Card number"/));

        assert.match(card, new RegExp(`\\[\\d+\\] textbox "Card number" value "" focused \\(in a frame: pay\\.test:${port}\\)`));
        assert.match(await browser.press(1, "4"), /textbox "Card number" value "4" focused/);

        // Something that takes no focus says so.
        const board = await browser.open(1, "http://pi.test/board");

        await assert.rejects(browser.focus(1, number(board, /\[(\d+)\] clickable "Write the report"/)), /did not take the focus/);
    } finally {
        await browser.close();
    }
});

test("with Chrome: browser_click double-clicks, right-clicks (the page's context menu), and long-presses for as long as asked, a finger's on a phone's layout and the mouse's at desktop size (PP-376)", { skip }, async () => {
    const browser = browserHere();

    try {
        const page = await browser.open(1, "http://pi.test/clicks");
        const photo = number(page, /\[(\d+)\] button "Photo"/);

        assert.match(await browser.click(1, photo, false, { how: "double" }), /Opened full size/);
        assert.match(await browser.click(1, photo, false, { how: "right" }), /Menu: Save, Share/);
        assert.match(await browser.click(1, photo, false, { how: "long", ms: 300 }), /Held short by touch/);
        // Two touches close together are a double tap to Chrome: the next one waits.
        await new Promise((resolve) => setTimeout(resolve, 700));
        assert.match(await browser.click(1, photo, false, { how: "long", ms: 1200 }), /Held long by touch/);

        const desktop = await browser.resize(1, "desktop");

        assert.match(await browser.click(1, number(desktop, /\[(\d+)\] button "Photo"/), false, { how: "long", ms: 1200 }), /Held long by mouse/);
    } finally {
        await browser.close();
    }
});

test("with Chrome: browser_select_text selects a text on the page (across elements), in a field (its text, all, characters), in an editor; never in a password field or what the person typed (PP-376)", { skip }, async () => {
    const browser = browserHere();
    const selection = async () => /Selection: (.*)/.exec(await browser.snapshot(1))?.[1];

    try {
        const page = await browser.open(1, "http://pi.test/select");
        const fox = await browser.selectText(1, undefined, { text: "brown fox  jumps" });

        assert.match(fox, /^Selected "brown fox  jumps" \(characters 10 to 25\) of \d+ on the page\.\n/);
        assert.equal(await selection(), "brown fox jumps");
        await browser.selectText(1, undefined, { text: "Second bold words" });
        assert.equal(await selection(), "Second bold words");

        const title = number(page, /\[(\d+)\] textbox "Title"/);

        assert.match(await browser.selectText(1, title, { all: true }), /^Selected characters 0 to 22 of 22 in \[\d+\]\.\n[\s\S]*textbox "Title" value "Quarterly report draft" focused/);
        assert.equal(await selection(), "Quarterly report draft");
        await browser.selectText(1, title, { text: "report" });
        assert.equal(await selection(), "report");
        await browser.selectText(1, number(page, /\[(\d+)\] textbox "Body"/), { start: 6, end: 10 });
        assert.equal(await selection(), "beta");
        await browser.selectText(1, number(page, /\[(\d+)\] textbox "Editor"/), { text: "me" });
        assert.equal(await selection(), "me");

        await assert.rejects(browser.selectText(1, undefined, { text: "purple elephant" }), /the page does not show that text/);
        await assert.rejects(browser.selectText(1, number(page, /\[(\d+)\] password "PIN"/), { all: true }), /holds what the person typed/);

        // A value the person typed on a card is never looked for: whether it is found would tell it.
        await browser.fillFields(1, [{ index: title, value: "Secret plan 2027", hide: true }]);
        await browser.snapshot(1);
        await assert.rejects(browser.selectText(1, undefined, { text: "plan 20" }), /what the person typed on a card/);
        await assert.rejects(browser.selectText(1, number(await browser.snapshot(1), /\[(\d+)\] textbox "Title"/), { start: 0, end: 3 }), /holds what the person typed/);
    } finally {
        await browser.close();
    }
});

test("with Chrome: browser_screenshot's whole page goes past the view, with marks there and the card's typing blacked out anywhere in it; a browser that pictures its view only says so (PP-376)", { skip }, async () => {
    const browser = browserHere();
    const photon = createRequire(import.meta.url)("@silvia-odwyer/photon-node") as {
        PhotonImage: { new_from_byteslice(bytes: Uint8Array): { get_width(): number; get_height(): number; get_raw_pixels(): Uint8Array; free(): void } };
    };

    try {
        await browser.open(1, "http://pi.test/long");

        const below = await browser.scroll(1, "down", 2);

        await browser.fillFields(1, [{ index: number(below, /\[(\d+)\] textbox "Member number"/), value: "M-5551234", hide: true }]);
        await browser.scroll(1, "up", 4);

        const at = await browser.evaluate(1, "(() => { const r = document.getElementById('member').getBoundingClientRect(); return {x: r.x + 20 + scrollX, y: r.y + r.height / 2 + scrollY, height: document.documentElement.scrollHeight}; })()", false);
        const where = JSON.parse((at as { json: string }).json) as { x: number; y: number; height: number };
        // Marks below the view are placed (a text there is no error on a whole page).
        const shot = await browser.screenshot(1, { png: true, full: true, marks: [{ text: "Bottom words", label: "The end" }] });

        assert.ok("data" in shot);
        assert.deepEqual(shot.page, { height: where.height, of: where.height });

        const image = photon.PhotonImage.new_from_byteslice(Buffer.from(shot.data, "base64"));
        const width = image.get_width();
        const scale = width / 412;
        const pixels = image.get_raw_pixels();
        const pixel = (x: number, y: number) => [...pixels.subarray((Math.round(y * scale) * width + Math.round(x * scale)) * 4, (Math.round(y * scale) * width + Math.round(x * scale)) * 4 + 3)];

        assert.equal(image.get_height(), Math.round(where.height * scale));
        // The card's value is under a solid box, far below the view.
        assert.deepEqual(pixel(where.x, where.y), [24, 24, 27]);
        image.free();
        await assert.rejects(browser.screenshot(1, { full: true, index: 1 }), /leave index out/);
    } finally {
        await browser.close();
    }

    // An engine whose pictures are of its view only (the phone's) says so.
    const engine = new ChromeEngine(chrome!, [`--host-resolver-rules=MAP pi.test 127.0.0.1:${port}`, "--no-sandbox"]);
    const viewOnly = new PiBrowser({ engine: new Proxy(engine, { get: (target, name) => (name === "wholePage" ? false : (Reflect.get(target, name) as unknown) instanceof Function ? (Reflect.get(target, name) as (...args: unknown[]) => unknown).bind(target) : Reflect.get(target, name)) }), changed: () => {}, frame: () => {}, log: () => {} });

    try {
        await viewOnly.open(1, "http://pi.test/long");
        await assert.rejects(viewOnly.screenshot(1, { full: true }), /takes pictures of what is in view only/);
    } finally {
        await viewOnly.close();
    }
});

test("with Chrome: a file the page downloads is saved where the session works and named in the answer; one over 25 MB is cancelled; a browser that keeps none says so (PP-376)", { skip }, async () => {
    const folder = mkdtempSync(join(tmpdir(), "pi-downloads-"));
    const saved: string[] = [];
    const browser = browserHere({
        saveDownload: async (name, bytes) => {
            const path = join(folder, saved.includes(name) ? `${name} (2)` : name);

            writeFileSync(path, bytes);
            saved.push(name);

            return path;
        },
    });

    try {
        const page = await browser.open(1, "http://pi.test/files");
        const got = await browser.click(1, number(page, /\[(\d+)\] link "Price list"/));

        assert.match(got, new RegExp(`^The page downloaded prices\\.csv \\(1 KB\\): saved as ${join(folder, "prices.csv").replace(/[.\\/]/g, "\\$&")}\\.\\n`));
        assert.equal(readFileSync(join(folder, "prices.csv"), "utf8"), "lamp,12\nchair,40\n");

        // Made by the page's script (a blob), with the name it gives.
        const made = await browser.click(1, number(got, /\[(\d+)\] button "Export notes"/));

        assert.match(made, /^The page downloaded notes\.txt \(1 KB\): saved as /);
        assert.equal(readFileSync(join(folder, "notes.txt"), "utf8"), "hello notes");

        const big = await browser.click(1, number(made, /\[(\d+)\] link "Whole archive"/));

        assert.match(big, /^The page began downloading archive\.bin, larger than 25 MB, the most Pi's browser keeps: it was cancelled\.\n/);
        assert.deepEqual(saved, ["prices.csv", "notes.txt"]);
    } finally {
        await browser.close();
        rmSync(folder, { recursive: true, force: true });
    }

    // Without a place to keep them (as the phone's WebView, which hands them to no one), the answer says so.
    const none = browserHere();

    try {
        const page = await none.open(1, "http://pi.test/files");

        assert.match(await none.click(1, number(page, /\[(\d+)\] link "Price list"/)), /^The page began downloading prices\.csv \(http:\/\/pi\.test\/prices\.csv\), but Chrome does not keep downloads: browse on a machine/);
    } finally {
        await none.close();
    }
});
