// The server edition's screenshots (src/server/chrome-renderer.ts), on a real Chrome (CI has one): it takes the render
// requests the phone's service would, signs in only to the app's own address (a page's request to another site gets no
// token), pictures a tall page in parts of at most 2000 pixels, runs the layout check, and says why a page did not load.
import { cleanUp } from "./helpers.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import { after, before, test } from "node:test";
import { ChromeRenderer } from "../src/server/chrome-renderer.ts";
import { withPageShim } from "../src/server/file-pages.ts";
import { imageSize } from "../src/server/image-guard.ts";
import { describeLayout } from "../src/server/layout-check.ts";
import { Screenshots } from "../src/server/screenshots.ts";

after(() => cleanUp());

const chrome = ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"].find((name) => {
    try {
        execFileSync("which", [name], { stdio: "ignore" });

        return true;
    } catch {
        return false;
    }
});

/** What each server was asked, by path: the app's own, and another site a page loads from. */
const seen: { app: Record<string, IncomingHttpHeaders>; other: Record<string, IncomingHttpHeaders> } = { app: {}, other: {} };
let app: Server;
let other: Server;
let appPort = 0;
let otherPort = 0;

const listen = async (server: Server) => {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

    return (server.address() as { port: number }).port;
};

before(async () => {
    other = createServer((request, response) => {
        seen.other[request.url ?? "/"] = request.headers;
        response.writeHead(200, { "content-type": "image/svg+xml" });
        response.end(`<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>`);
    });
    otherPort = await listen(other);
    app = createServer((request, response) => {
        seen.app[request.url ?? "/"] = request.headers;

        if (request.headers.authorization !== "Bearer owner-token") {
            response.writeHead(401, { "content-type": "text/plain" });
            response.end("sign in");

            return;
        }

        const shell = SHELLS[request.url ?? ""];

        if (shell !== undefined) {
            response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
            response.end(shell);

            return;
        }

        if (request.url === "/sandboxed" || request.url === "/sandboxed-bare") {
            // As the app serves a file page (http/artifacts.ts): in the sandbox, with or without the shim (PP-440).
            response.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-security-policy": "sandbox allow-scripts" });
            response.end(request.url === "/sandboxed" ? withPageShim(STORAGE_PAGE) : STORAGE_PAGE);

            return;
        }

        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end(
            request.url === "/menu"
                ? MENU_PAGE
                : request.url === "/tall"
                ? `<!doctype html><meta name="viewport" content="width=device-width"><body style="margin:0"><div style="height:3500px;background:linear-gradient(#fff,#36c)">Tall</div>`
                : `<!doctype html><meta name="viewport" content="width=device-width"><title>Signed in</title><p>Signed in as the owner</p><img src="http://127.0.0.1:${otherPort}/logo.svg">`,
        );
    });
    appPort = await listen(app);
});

after(() => {
    app?.close();
    other?.close();
});

/**
 * A page whose menu shows only after a tap (PP-423): its one item is a 28 px button, a tap target under 40 at a phone's
 * width; a field shows what was typed into it, and Escape closes the menu.
 */
const MENU_PAGE = `<!doctype html><meta name="viewport" content="width=device-width"><body style="margin:0;padding:16px;font:16px sans-serif">
<button id="open" style="height:44px">Menu</button><button id="gone" style="display:none">Gone</button>
<input id="q" style="height:44px"><p id="said"></p>
<div id="menu" hidden><button id="item" style="height:28px">Rename</button></div>
<script>
document.getElementById("open").addEventListener("click", () => setTimeout(() => { document.getElementById("menu").hidden = false; }, 200));
document.getElementById("q").addEventListener("input", (event) => { document.getElementById("said").textContent = "typed " + event.target.value; });
document.addEventListener("keydown", (event) => { if (event.key === "Escape") document.getElementById("menu").hidden = true; });
</script>`;

/**
 * App shells (PP-440): the page does not scroll, its main area does, 30 rows of 96 px under a 48 px header. `/shell`'s main
 * area follows the view's height; `/fixed-shell`'s is 600 px whatever the view.
 */
const shellPage = (main: string) => `<!doctype html><meta name="viewport" content="width=device-width"><style>
html,body{margin:0;height:100%;overflow:hidden;font:16px/24px sans-serif}.shell{display:flex;flex-direction:column;height:100vh}
header{height:48px;flex:none}main{${main};overflow-y:auto}.row{height:96px}</style>
<div class="shell"><header>App</header><main id="m">${Array.from({ length: 30 }, (_, i) => `<div class="row">Row ${i + 1}</div>`).join("")}</main></div>`;
const SHELLS: Record<string, string> = { "/shell": shellPage("flex:1"), "/fixed-shell": shellPage("height:600px;flex:none") };

/** A module that awaits, then reads localStorage outside a try, as a single-file React build does; then an error later. */
const STORAGE_PAGE = `<!doctype html><html><head><meta name="viewport" content="width=device-width"></head><body><h1 id="a">before</h1>
<script type="module">const said = await Promise.resolve("ran"); const a = document.getElementById("a"); a.textContent = said; a.textContent += ", stored " + localStorage.getItem("theme"); localStorage.setItem("theme", "dark"); a.textContent += " then " + localStorage.getItem("theme"); setTimeout(() => { throw new TypeError("boom"); }, 0);</script></body></html>`;

/** What the menu page shows, as a check script answers it. */
const MENU_STATE = `JSON.stringify({ open: !document.getElementById("menu").hidden, said: document.getElementById("said").textContent })`;

test("the server's renderer signs in only to the app, pictures tall pages in parts, and measures them", { skip: chrome === undefined ? "no Chrome on this machine (CI runs it)" : false }, async () => {
    const screenshots = new Screenshots();
    const renderer = new ChromeRenderer(screenshots, { binary: chrome!, flags: ["--no-sandbox"], base: `http://127.0.0.1:${appPort}`, token: () => "owner-token", log: () => {} });

    void renderer.run();
    await new Promise((resolve) => setTimeout(resolve, 200));

    try {
        assert.ok(screenshots.present(), "the renderer polls, as the phone's service does");

        const [phone, desktop] = await screenshots.render(`http://127.0.0.1:${appPort}/`, { widths: [390, 1280], settleMs: 300 });

        assert.equal(phone!.width, 390);
        assert.equal(phone!.height, 844);
        assert.deepEqual(imageSize(phone!.parts[0]!), { width: 390, height: 844 });
        assert.equal(desktop!.height, 800);
        assert.deepEqual(phone!.layout?.issues, []);
        assert.equal(seen.app["/"]?.authorization, "Bearer owner-token", "the app's page was asked signed in");
        assert.ok(seen.other["/logo.svg"] !== undefined, "the page loaded its picture from the other site");
        assert.equal(seen.other["/logo.svg"]?.authorization, undefined, "the other site got no token");

        const [tall] = await screenshots.render(`http://127.0.0.1:${appPort}/tall`, { widths: [390], settleMs: 200 });

        assert.equal(tall!.height, 3500);
        assert.deepEqual(tall!.parts.map((part) => imageSize(part)?.height), [2000, 1500]);

        await assert.rejects(screenshots.render(`http://127.0.0.1:1/`, { widths: [390], settleMs: 0 }), /did not load/);

        // Steps before the shot (PP-423): a menu that shows only after a tap is measured open, at each width.
        const menu = `http://127.0.0.1:${appPort}/menu`;
        const [closed] = await screenshots.render(menu, { widths: [390], settleMs: 100 });

        assert.deepEqual(closed!.layout?.found.filter((each) => each.kind === "small-target"), [], "closed: no small target");

        const opened = await screenshots.render(menu, { widths: [390, 1920], settleMs: 100, steps: [{ click: "#open" }, { wait: "#item" }] });

        const small = opened[0]!.layout?.found.filter((each) => each.kind === "small-target") ?? [];

        assert.equal(small.length, 1, "open at 390: its 28 px item");
        assert.match(small[0]!.what, /Rename/);
        assert.equal(opened[1]!.width, 1920);

        const typed = await screenshots.render(menu, { widths: [390], settleMs: 100, check: MENU_STATE, steps: [{ click: "#open" }, { wait: 300 }, { type: "#q", text: "hello" }, { press: "Escape" }] });

        assert.deepEqual(JSON.parse(typed[0]!.check!), { open: false, said: "typed hello" }, "typed into, then closed with Escape");

        // A step that cannot be done fails the render, naming the step and why.
        await assert.rejects(screenshots.render(menu, { widths: [390], settleMs: 0, steps: [{ click: "#open" }, { click: "#nope" }] }), /a step failed: step 2 \(click "#nope"\): nothing matches "#nope"/);
        await assert.rejects(screenshots.render(menu, { widths: [390], settleMs: 0, steps: [{ click: "#gone" }] }), /step 1 \(click "#gone"\): "#gone" matches an element that is not visible/);
        await assert.rejects(screenshots.render(menu, { widths: [390], settleMs: 0, steps: [{ wait: ".never" }] }), /step 1 \(wait for "\.never"\): nothing visible matched within 5 s/);
    } finally {
        await renderer.stop();
    }
});

test("a whole page that scrolls in its main area is pictured whole; a file page in the sandbox has storage and says its errors (PP-440)", { skip: chrome === undefined ? "no Chrome on this machine (CI runs it)" : false }, async () => {
    const screenshots = new Screenshots();
    const renderer = new ChromeRenderer(screenshots, { binary: chrome!, flags: ["--no-sandbox"], base: `http://127.0.0.1:${appPort}`, token: () => "owner-token", log: () => {} });

    void renderer.run();
    await new Promise((resolve) => setTimeout(resolve, 200));

    try {
        // Laid out as tall as the view plus what the main area hid: 844 + (2880 - 796), all 30 rows in the picture.
        const [shell] = await screenshots.render(`http://127.0.0.1:${appPort}/shell`, { widths: [390], settleMs: 100 });

        assert.equal(shell!.height, 2928);
        assert.deepEqual(shell!.parts.map((part) => imageSize(part)?.height), [2000, 928]);
        assert.equal(shell!.layout?.scroller, undefined, "nothing left hidden");

        const [first] = await screenshots.render(`http://127.0.0.1:${appPort}/shell`, { widths: [390], settleMs: 100, fullPage: false });

        assert.equal(first!.height, 844, "the first screen only, when asked");
        assert.deepEqual(first!.layout?.scroller, { what: 'main#m "Row 1Row 2Row 3Row 4Row 5Row 6"', shown: 796, full: 2880 });

        // A main area of a fixed height hides the rest whatever the view: said with its numbers.
        const [fixed] = await screenshots.render(`http://127.0.0.1:${appPort}/fixed-shell`, { widths: [390], settleMs: 100 });

        assert.deepEqual(fixed!.layout?.scroller, { what: 'main#m "Row 1Row 2Row 3Row 4Row 5Row 6"', shown: 600, full: 2880 });
        assert.match(describeLayout(fixed!.layout!), /The page scrolls inside main#m "Row 1[^"]*": the picture shows 600 of its 2880 px, the rest is not in it\./);

        // A document that scrolls itself keeps its own height.
        const [tall] = await screenshots.render(`http://127.0.0.1:${appPort}/tall`, { widths: [390], settleMs: 100 });

        assert.equal(tall!.height, 3500);
        assert.equal(tall!.layout?.scroller, undefined);

        // Without the shim, the sandbox's storage throws: the module stops at it, a blank page in a real app.
        const words = `document.getElementById("a").textContent`;
        const [bare] = await screenshots.render(`http://127.0.0.1:${appPort}/sandboxed-bare`, { widths: [390], settleMs: 200, check: words });

        assert.equal(bare!.check, "ran", "stopped at localStorage");

        const [shimmed] = await screenshots.render(`http://127.0.0.1:${appPort}/sandboxed`, { widths: [390], settleMs: 200, check: words });

        assert.equal(shimmed!.check, "ran, stored null then dark", "storage in memory, empty at first");

        const [checked] = await screenshots.render(`http://127.0.0.1:${appPort}/sandboxed`, { widths: [390], settleMs: 200 });

        assert.deepEqual(checked!.layout?.errors, ["TypeError: boom"]);
        assert.match(describeLayout(checked!.layout!), /The page threw: TypeError: boom/);
    } finally {
        await renderer.stop();
    }
});
