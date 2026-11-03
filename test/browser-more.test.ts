// Pi's browser, PP-376, with a Chrome on the machine (CI): controls inside frames (another site's, in a process of its
// own, and the page's own) and open shadow roots are read and acted on, and what the person types on a card stays
// hidden there too.
import { cleanUpAll } from "./helpers.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import { after, before, test } from "node:test";
import { ChromeEngine, PiBrowser } from "../src/server/browser/pi-browser.ts";

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
    "/card": `<!doctype html><title>Card</title><meta name="viewport" content="width=device-width">
        <label>Card number <input id="card"></label><br><label>PIN <input id="pin" type="password"></label><br>
        <button onclick="out.textContent = 'Paid with ' + card.value + (pin.value === '4321' ? ' and the PIN' : ' without the PIN')">Pay</button>
        <p id="out">Not paid</p>`,
};

let server: Server;
let port = 0;

before(async () => {
    server = createServer((request, response) => {
        const page = PAGES[(request.url ?? "/").split("?")[0]!];

        response.writeHead(page === undefined ? 404 : 200, { "content-type": "text/html; charset=utf-8" });
        response.end((page ?? "not here").replaceAll("PORT", String(port)));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as { port: number }).port;
});

after(() => cleanUpAll(() => server?.close()));

/** A browser on a headless Chrome, where pi.test and pay.test (another site) are the test server. */
function browserHere(): PiBrowser {
    return new PiBrowser({
        engine: new ChromeEngine(chrome!, [`--host-resolver-rules=MAP pi.test 127.0.0.1:${port},MAP pay.test 127.0.0.1:${port}`, "--no-sandbox"]),
        changed: () => {},
        frame: () => {},
        log: () => {},
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
