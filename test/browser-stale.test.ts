// Pi's browser on pages that change under it, with a Chrome on the machine (CI): a layout that shifts between Pi's
// check of a control and its click (PP-447).
import { cleanUp, cleanUpAll } from "./helpers.ts";
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

/** Two buttons under a loading line; `moves` says when the line goes or comes, as data that comes in steps would. */
const shifting = (moves: string) => `<!doctype html><title>Shift</title><meta name="viewport" content="width=device-width">
    <style>body{margin:0;font:16px sans-serif} button{display:block;width:240px;height:48px;margin:0;border:1px solid #888}</style>
    <div id="bar" style="height:48px;background:#fd8">Loading</div>
    <button id="match" onclick="out.textContent='Clicked Match again'">Match again</button>
    <button id="handoff" onclick="out.textContent='Clicked Human handoff'">Human handoff</button>
    <p id="out">Nothing clicked</p>
    <script>${moves}</script>`;

const PAGES: Record<string, string> = {
    // The loading line goes on the first pointer move: the point Pi checked is now over the button below.
    "/shift": shifting("addEventListener('mousemove', () => bar.remove(), { once: true });"),
    // The line goes and comes on every pointer move: the button never holds still under the pointer.
    "/jumpy": shifting("addEventListener('mousemove', () => { bar.hidden = !bar.hidden; });"),
    // The first page in a frame of the page's own.
    "/framed": `<!doctype html><title>Framed</title><meta name="viewport" content="width=device-width">
        <style>body{margin:0} iframe{display:block;width:300px;height:220px;border:0}</style><iframe src="/shift"></iframe>`,
};

let server: Server;
let port = 0;

before(async () => {
    server = createServer((request, response) => {
        const page = PAGES[(request.url ?? "/").split("?")[0]!];

        response.writeHead(page === undefined ? 404 : 200, { "content-type": "text/html; charset=utf-8" });
        response.end(page ?? "not here");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as { port: number }).port;
});

after(() => cleanUpAll(() => server?.close(), () => cleanUp()));

function browserHere(): PiBrowser {
    return new PiBrowser({
        engine: new ChromeEngine(chrome!, [`--host-resolver-rules=MAP pi.test 127.0.0.1:${port}`, "--no-sandbox"]),
        changed: () => {},
        frame: () => {},
        log: () => {},
    });
}

/** The number of the control a pattern finds in a read. */
const number = (page: string, pattern: RegExp) => Number(pattern.exec(page)?.[1] ?? assert.fail(`${pattern} not in:\n${page}`));

test("with Chrome: a click whose control moves just before it lands on that control, not on what is there now; one that keeps moving clicks nothing (PP-447)", { skip }, async () => {
    const browser = browserHere();

    try {
        // The line goes as the pointer comes: the old point is over "Human handoff" now. Pi points again.
        const page = await browser.open(1, "http://pi.test/shift");

        assert.match(page, /Loading/);

        const clicked = await browser.click(1, number(page, /\[(\d+)\] button "Match again"/));

        assert.match(clicked, /Clicked Match again/);
        assert.doesNotMatch(clicked, /Clicked Human handoff/);

        // A double click and a right click are guarded too.
        const twice = await browser.open(1, "http://pi.test/shift?double");
        const doubled = await browser.click(1, number(twice, /\[(\d+)\] button "Match again"/), false, { how: "double" });

        assert.doesNotMatch(doubled, /Clicked Human handoff/);
        assert.match(doubled, /Clicked Match again/);

        // It moves on every pointer move: refused, and nothing on the page was clicked.
        const jumpy = await browser.open(1, "http://pi.test/jumpy");

        await assert.rejects(browser.click(1, number(jumpy, /\[(\d+)\] button "Match again"/)), /\[\d+\] Match again kept moving \(the click would have landed on (button "Human handoff"|div "Loading")\): nothing was clicked\./);
        assert.match(await browser.snapshot(1), /Nothing clicked/);

        // In a frame: the guard is in the frame, and the page around it.
        const framed = await browser.open(1, "http://pi.test/framed");
        const inFrame = await browser.click(1, number(framed, /\[(\d+)\] button "Match again" \(in a frame/));

        assert.match(inFrame, /Clicked Match again/);
        assert.doesNotMatch(inFrame, /Clicked Human handoff/);
    } finally {
        await browser.close();
    }
});
