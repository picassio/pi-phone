// PP-545: the rules the layout check took from huashu-design's design_lint (third_party/huashu-design/README.md), run in
// a real Chrome (CI has one). Template decoration (parts joined by " · ", trailing arrows, one accent word in a headline,
// 01/02/03 numbering, small monospace labels), a UI face as display type, a picture by a relative address in a file
// page, what a file page logs as errors, and the look: its ground, faces and families, and the skeleton that tells a
// reskin from a new layout. huashu's slop page finds each; its clean page, PP-542's real page and the controls find none.
import { cleanUp } from "./helpers.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import { readFileSync } from "node:fs";
import { after, before, test } from "node:test";
import { ChromeEngine } from "../src/server/browser/pi-browser.ts";
import { BrowserPage } from "../src/server/browser/page.ts";
import { withPageShim } from "../src/server/file-pages.ts";
import { describeLayout, type LayoutFind, layoutCheck, type LayoutReport, LookMemory, parseLayout, RESKIN, skeletonMatch } from "../src/server/layout-check.ts";

after(() => cleanUp());

const chrome = ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"].find((name) => {
    try {
        execFileSync("which", [name], { stdio: "ignore" });

        return true;
    } catch {
        return false;
    }
});
const skip = chrome === undefined ? "no Chrome on this machine (CI runs it)" : false;

const fixture = (name: string) => readFileSync(new URL(`fixtures/layout/${name}`, import.meta.url), "utf8");
const head = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><body style="margin:24px;font:16px/1.5 Georgia, serif;color:#222;background:#fff">`;
const PIXEL = `<svg xmlns="http://www.w3.org/2000/svg" width="120" height="80"><rect width="120" height="80" fill="#888"/></svg>`;
const PAGES: Record<string, string> = {
    "/slop": fixture("huashu-slop.html"),
    "/slop?reskin": fixture("huashu-slop.html"),
    "/clean": fixture("huashu-clean.html"),
    "/clean?file": fixture("huashu-clean.html"),
    "/file/clean?file": withPageShim(fixture("huashu-clean.html")),
    "/real": fixture("real-page.html"),
    // A UI face as display type, and its controls: a serif display, and Inter under 40 px.
    "/display": `${head}<h1 style="font:700 64px/1.1 Inter, system-ui, sans-serif">Ship faster</h1><p>Words under the headline, long enough to be a paragraph.</p>`,
    "/display?serif": `${head}<h1 style="font:700 64px/1.1 Georgia, serif">Ship faster</h1><p>Words under the headline, long enough to be a paragraph.</p>`,
    "/display?small": `${head}<h1 style="font:700 32px/1.25 Inter, system-ui, sans-serif">Settings</h1><p>Words under the title, long enough to be a paragraph.</p>`,
    // What decoration is not: one " · " in a line of facts, one arrow, numbers in an ordered list, a date in a <time>, a
    // monospace face in code and in a table, a heading's bold word in its own colour.
    "/controls":
        `${head}<p>2 h ago · 3 tools</p><a href="#">All posts →</a><ol><li>01 Unpack</li><li>02 Wash</li><li>03 Dry</li></ol>` +
        `<p><time datetime="1979-03">03.1979</time> <time datetime="1998">01.1998</time> <time datetime="2019">02.2019</time></p>` +
        `<pre><code style="font:13px monospace">const a = 1;\nconst b = 2;\nconst c = 3;\nconst d = 4;</code></pre>` +
        `<table><tbody>${["12:01", "12:02", "12:03", "12:04"].map((t) => `<tr><td style="font:13px monospace">${t}</td></tr>`).join("")}</tbody></table>` +
        `<h2>The <strong>whole</strong> story</h2>`,
};
const BINARY: Record<string, [string, string]> = { "/file/pixel.svg": ["image/svg+xml", PIXEL], "/pixel.svg": ["image/svg+xml", PIXEL] };
let server: Server;
let port = 0;

before(async () => {
    server = createServer((request, response) => {
        const url = request.url ?? "/";
        const binary = BINARY[url];

        if (binary !== undefined) {
            response.writeHead(200, { "content-type": binary[0] });
            response.end(binary[1]);

            return;
        }

        const page = PAGES[url];

        response.writeHead(page === undefined ? 404 : 200, { "content-type": "text/html; charset=utf-8" });
        response.end(page ?? "");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as { port: number }).port;
});

after(() => server?.close());

async function measured(page: BrowserPage, path: string, width: number): Promise<LayoutReport> {
    await page.navigate(`http://pi.test${path}`);
    // A script inserted by the page fails to load after it was parsed: give it a moment.
    await new Promise((resolve) => setTimeout(resolve, 150));

    const report = parseLayout(await page.evaluate<string>(layoutCheck(width)), width);

    assert.ok(report !== undefined, `${path} gave a report`);

    return report;
}

const NEW = new Set<LayoutFind["kind"]>(["decoration", "ui-display", "relative-image"]);
const devices = (report: LayoutReport) => [...new Set(report.found.flatMap((find) => (find.kind === "decoration" ? [find.device] : [])))].sort();
const kinds = (report: LayoutReport) => [...new Set(report.found.map((find) => find.kind).filter((kind) => NEW.has(kind)))].sort();

test("huashu's slop page shows each template decoration, its look families and the clay; its clean page, a real page and the controls show none (PP-545)", { skip }, async () => {
    const engine = new ChromeEngine(chrome!, [`--host-resolver-rules=MAP pi.test 127.0.0.1:${port}`, "--no-sandbox"]);

    try {
        const page = new BrowserPage(await engine.connect((await engine.tabs())[0]!));

        for (const width of [390, 1280]) {
            await page.init({ width, height: width < 600 ? 844 : 800, mobile: width < 600 });

            const slop = await measured(page, "/slop", width);

            assert.deepEqual(devices(slop), ["accent-word", "dot-connector", "mono-label", "numbering", "trailing-arrow"], `at ${width}: ${JSON.stringify(slop.found.filter((find) => NEW.has(find.kind)))}`);
            assert.equal(slop.totals.decoration, 1 + 1 + 4 + 4 + 4, `at ${width}`);
            assert.deepEqual(slop.look?.families, ["warm paper + serif display + clay accent", "card kit (one radius and shadow ×4)"], `at ${width}`);
            assert.equal(slop.look?.groundClass, "warm paper");
            assert.deepEqual(slop.look?.display, { family: "Georgia", size: 76, serif: true });

            const text = describeLayout(slop);

            assert.match(text, /\nTemplate decoration \(14\):\n- [^\n]+\(×4\)\n- [^\n]+\(×4\)\n- [^\n]+\(×4\)\n- and 2 more\n/, text);
            assert.match(text, /\n- a\.cta "Learn more →": a trailing → on a link or button \("Learn more →"\) \(×4\)\n/, text);
            assert.deepEqual(
                slop.found.filter((find) => find.kind === "decoration" && find.count === 1).map((find) => find.kind === "decoration" && [find.what, find.device, find.text]),
                [
                    ['div.eyebrow "Origin · Process · Roast"', "dot-connector", "Origin · Process · Roast"],
                    ['h1 "Every cup has a history."', "accent-word", "history"],
                ],
            );
            assert.match(text, /\nLook: warm paper ground #f4f1ea; display Georgia 76 px \(serif\); body Helvetica; look families: warm paper \+ serif display \+ clay accent, card kit \(one radius and shadow ×4\) \(no fault alone/);

            for (const path of ["/clean", "/real", "/controls"]) {
                const report = await measured(page, path, width);

                assert.deepEqual(kinds(report), [], `${path} at ${width}: ${JSON.stringify(report.found.filter((find) => NEW.has(find.kind)))}`);
                assert.deepEqual(report.look?.families, [], `${path} at ${width}`);
            }
        }
    } finally {
        await engine.close();
    }
});

test("a UI face as display type: Inter at 64 px is one; a serif at 64 px and Inter at 32 px are not (PP-545)", { skip }, async () => {
    const engine = new ChromeEngine(chrome!, [`--host-resolver-rules=MAP pi.test 127.0.0.1:${port}`, "--no-sandbox"]);

    try {
        const page = new BrowserPage(await engine.connect((await engine.tabs())[0]!));

        await page.init({ width: 1280, height: 800, mobile: false });

        const inter = await measured(page, "/display", 1280);

        assert.deepEqual(
            inter.found.filter((find) => find.kind === "ui-display"),
            [{ kind: "ui-display", what: 'h1 "Ship faster"', family: "Inter", size: 64, count: 1 }],
        );
        assert.match(describeLayout(inter), /\nA UI face as display type \(1\):\n- h1 "Ship faster": Inter at 64 px, a face drawn for small interface text\n/);
        assert.deepEqual(kinds(await measured(page, "/display?serif", 1280)), []);
        assert.deepEqual(kinds(await measured(page, "/display?small", 1280)), []);
    } finally {
        await engine.close();
    }
});

test("a file page: its picture by a relative address and what it logs as errors are found; the same page from a server is not a single file (PP-545)", { skip }, async () => {
    const engine = new ChromeEngine(chrome!, [`--host-resolver-rules=MAP pi.test 127.0.0.1:${port}`, "--no-sandbox"]);

    try {
        const page = new BrowserPage(await engine.connect((await engine.tabs())[0]!));

        await page.init({ width: 390, height: 844, mobile: true });

        const file = await measured(page, "/file/clean?file", 390);

        assert.deepEqual(
            file.found.filter((find) => find.kind === "relative-image"),
            [{ kind: "relative-image", what: "img", src: "pixel.svg", count: 1 }],
        );
        assert.equal(file.logged?.length, 2, JSON.stringify(file.logged));
        assert.ok(file.logged?.includes("Chart data failed: no rows"), JSON.stringify(file.logged));
        assert.ok(file.logged?.includes("Failed to load script http://pi.test/file/missing.js"), JSON.stringify(file.logged));
        assert.match(describeLayout(file), /\nPictures by a relative address in a single-file page \(lost when the file travels alone: embed them\) \(1\):\n- img: pixel\.svg\n/);
        assert.match(describeLayout(file), /\nThe page logged errors: /);

        const served = await measured(page, "/clean?file", 390);

        assert.deepEqual(kinds(served), []);
        assert.equal(served.logged, undefined);
    } finally {
        await engine.close();
    }
});

test("the skeleton tells a reskin from a new layout: huashu's slop page and its reskin match, the clean page does not; the memory names the page reskinned (PP-545)", { skip }, async () => {
    const engine = new ChromeEngine(chrome!, [`--host-resolver-rules=MAP pi.test 127.0.0.1:${port}`, "--no-sandbox"]);

    try {
        const page = new BrowserPage(await engine.connect((await engine.tabs())[0]!));

        for (const width of [390, 1280]) {
            await page.init({ width, height: width < 600 ? 844 : 800, mobile: width < 600 });

            const slop = (await measured(page, "/slop", width)).look!.skeleton;
            const reskin = await measured(page, "/slop?reskin", width);
            const clean = (await measured(page, "/clean", width)).look!.skeleton;

            assert.ok(skeletonMatch(slop, reskin.look!.skeleton) >= RESKIN, `reskin at ${width}: ${skeletonMatch(slop, reskin.look!.skeleton)}`);
            assert.ok(skeletonMatch(slop, clean) < RESKIN - 0.2, `clean at ${width}: ${skeletonMatch(slop, clean)}`);
            assert.equal(reskin.look?.groundClass, "dark tinted");
            assert.deepEqual(reskin.look?.families, ["card kit (one radius and shadow ×4)"]);

            const memory = new LookMemory();

            assert.equal(memory.note("c1", "dir-1.html", width, slop), undefined);
            // The same page shot again is no reskin of itself.
            assert.equal(memory.note("c1", "dir-1.html", width, slop), undefined);
            assert.equal(memory.note("c1", "dir-3.html", width, clean), undefined);
            assert.match(memory.note("c1", "dir-2.html", width, reskin.look!.skeleton) ?? "", /^Same first-screen skeleton as dir-1\.html at \d+ px \(correlation 0\.\d+\): the same layout in other colours and faces/);
            // Another conversation's pages are not compared.
            assert.equal(memory.note("c2", "dir-2.html", width, reskin.look!.skeleton), undefined);
        }
    } finally {
        await engine.close();
    }
});
