// The server edition's screenshots (src/server/chrome-renderer.ts), on a real Chrome (CI has one): it takes the render
// requests the phone's service would, signs in only to the app's own address (a page's request to another site gets no
// token), pictures a tall page in parts of at most 2000 pixels, runs the layout check, and says why a page did not load.
import { cleanUp } from "./helpers.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import { after, before, test } from "node:test";
import { ChromeRenderer } from "../src/server/chrome-renderer.ts";
import { imageSize } from "../src/server/image-guard.ts";
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

        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end(
            request.url === "/tall"
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
    } finally {
        await renderer.stop();
    }
});
