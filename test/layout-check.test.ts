// The measured layout check screenshots carry (src/server/layout-check.ts), run in a real Chrome (CI has one): a page
// in place reports nothing; a code block whose long lines scroll inside it is in place; a box whose content spills, a
// child that sticks out of its parent, and a page wider than the screen are reported, with their sizes.
import { cleanUp } from "./helpers.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import { after, before, test } from "node:test";
import { ChromeEngine } from "../src/server/browser/pi-browser.ts";
import { BrowserPage } from "../src/server/browser/page.ts";
import { describeLayout, layoutCheck, type LayoutReport, parseLayout } from "../src/server/layout-check.ts";

after(() => cleanUp());

const chrome = ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"].find((name) => {
    try {
        execFileSync("which", [name], { stdio: "ignore" });

        return true;
    } catch {
        return false;
    }
});

const head = `<!doctype html><meta name="viewport" content="width=device-width"><style>body{margin:0;font:14px sans-serif} .col{width:300px;margin:0 20px}</style>`;
const PAGES: Record<string, string> = {
    "/clean": `${head}<div class="col"><p>Words that wrap in their column, as a reply's do.</p><pre style="overflow-x:auto;background:#eee"><code>${"a very long line of code ".repeat(20)}</code></pre></div>`,
    "/spill": `${head}<div class="col" id="box" style="overflow:visible"><div style="width:500px;background:#ccc">Wide</div></div>`,
    "/wide": `${head}<div style="width:2000px;height:20px;background:#ccc"></div>`,
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

test("a page laid out wider than the picture is reported as wider than the screen, at the width asked for", () => {
    const report = parseLayout(JSON.stringify({ width: 520, height: 844, checked: 6, issues: [], more: 0 }), 390);

    assert.equal(report?.width, 390);
    assert.deepEqual(report?.issues, [{ kind: "page-wider", what: "the page", box: [0, 520], limit: [0, 390] }]);
    assert.match(describeLayout(report!), /- the page: is wider than the screen \(520 px in 390\)/);
    assert.equal(parseLayout("not json", 390), undefined);
    assert.equal(parseLayout(JSON.stringify({ width: 390, height: 844, checked: 6, issues: [], more: 0 }), 390)?.issues.length, 0);
});

test("the layout check reports what is out of place, with sizes, and nothing on a page in place", { skip: chrome === undefined ? "no Chrome on this machine (CI runs it)" : false }, async () => {
    const engine = new ChromeEngine(chrome!, [`--host-resolver-rules=MAP pi.test 127.0.0.1:${port}`, "--no-sandbox"]);

    try {
        const page = new BrowserPage(await engine.connect((await engine.tabs())[0]!));

        await page.init({ width: 390, height: 844, mobile: true });

        const check = async (path: string) => {
            await page.navigate(`http://pi.test${path}`);

            return JSON.parse(await page.evaluate<string>(layoutCheck(390))) as LayoutReport;
        };

        const clean = await check("/clean");

        assert.deepEqual(clean.issues, [], JSON.stringify(clean.issues));
        assert.match(describeLayout(clean), /^Layout check at 390 px \(\d+ elements\): nothing spills/);

        const spill = await check("/spill");

        assert.ok(spill.issues.some((issue) => issue.kind === "spills" && issue.what.startsWith("div#box") && issue.box[1] === 500 && issue.limit[1] === 300), JSON.stringify(spill.issues));
        assert.ok(spill.issues.some((issue) => issue.kind === "outside-parent" && issue.what.includes('"Wide"')), JSON.stringify(spill.issues));
        assert.match(describeLayout(spill), /div#box\.col "Wide": its content is wider than its box \(500 px in 300\)/);

        const wide = await check("/wide");

        assert.ok(wide.issues.some((issue) => issue.kind === "page-wider" && issue.box[1] === 2000 && issue.limit[1] === 390), JSON.stringify(wide.issues));
    } finally {
        await engine.close();
    }
});
