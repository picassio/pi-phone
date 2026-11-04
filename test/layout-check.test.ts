// The measured layout check screenshots carry (src/server/layout-check.ts), run in a real Chrome (CI has one): a page
// in place reports nothing; a code block whose long lines scroll inside it is in place; a box whose content spills, a
// child that sticks out of its parent, and a page wider than the screen are reported, with their sizes. Since PP-395 a
// page with one fault each: text cut by its box (an ellipsis, lines cut at the bottom), an element over a button, a
// small tap target, sizes off the 4 px grid, faint text, small text, emoji as icons, gradient text, uppercase labels,
// tight tracking and long lines; a sheet over the page is no overlap. Pi's browser gives the same check.
import { cleanUp } from "./helpers.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import { after, before, test } from "node:test";
import { ChromeEngine, PiBrowser } from "../src/server/browser/pi-browser.ts";
import { BrowserPage } from "../src/server/browser/page.ts";
import { describeLayout, type LayoutFind, layoutCheck, type LayoutReport, parseLayout } from "../src/server/layout-check.ts";

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

const head = `<!doctype html><meta name="viewport" content="width=device-width"><style>body{margin:0;font:14px sans-serif} .col{width:300px;margin:0 20px}</style>`;
const words = "Words that wrap in their column, as a reply's do, line after line after line. ";
const PAGES: Record<string, string> = {
    "/clean": `${head}<div class="col"><p>Words that wrap in their column, as a reply's do.</p><pre style="overflow-x:auto;background:#eee"><code>${"a very long line of code ".repeat(20)}</code></pre></div>`,
    "/spill": `${head}<div class="col" id="box" style="overflow:visible"><div style="width:500px;background:#ccc">Wide</div></div>`,
    "/wide": `${head}<div style="width:2000px;height:20px;background:#ccc"></div>`,
    "/ellipsis": `${head}<div class="col"><div id="title" style="width:120px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">A long session title that does not fit</div></div>`,
    "/lines": `${head}<div class="col"><div id="note" style="width:200px;height:40px;overflow:hidden;line-height:20px">${words.repeat(3)}</div></div>`,
    "/covered": `${head}<div class="col" style="position:relative"><button id="send" style="width:120px;height:48px;padding:0">Send now</button><div id="toast" style="position:absolute;left:0;top:0;width:100px;height:48px;background:#eee"></div></div><div class="col" style="position:relative;margin-top:16px"><span id="name">A title the whole row opens</span><button aria-label="Open" style="position:absolute;left:0;top:0;right:0;bottom:0;background:transparent;border:0"></button></div>`,
    "/sheet": `${head}<div class="col"><p>Under the sheet</p><button style="width:120px;height:48px;padding:0">Behind</button></div><div role="dialog" style="position:fixed;left:0;top:0;right:0;bottom:0;background:#fff"><p class="col">The sheet's words</p></div>`,
    "/target": `${head}<div class="col"><button id="close" style="width:32px;height:32px;padding:0;border:0">Go</button></div>`,
    "/grid": `${head}<div class="col"><div id="row" style="padding:6px;border-radius:10px;display:flex;gap:5.5px;background:#eee"><span>One</span><span>Two</span></div></div>`,
    "/faint": `${head}<div class="col" style="background:#1a1b26;padding:8px"><span id="meta" style="color:#3b3f55">Two minutes ago</span> <span id="dim" style="color:rgba(255,255,255,0.3)">Muted</span> <span style="color:#c0caf5">Readable</span></div>`,
    "/small": `${head}<div class="col"><p id="fine" style="font-size:10px">Fine print</p></div>`,
    "/emoji": `${head}<div class="col"><p id="state">\u{1F680} Launched</p><p id="done">\u2713 Done</p><p id="react">\u263A+ © 2026</p><p id="look">\u25A3 Looks at</p></div>`,
    "/gradient": `${head}<div class="col"><p id="hype" style="background:linear-gradient(90deg,#a855f7,#3b82f6);-webkit-background-clip:text;background-clip:text;color:transparent">Supercharge</p></div>`,
    "/caps": `${head}<div class="col"><p id="label" style="text-transform:uppercase;letter-spacing:2px">Navigation</p><p id="tight" style="letter-spacing:-0.5px">Squeezed words</p></div>`,
    "/long": `${head}<div style="overflow-x:auto"><p id="essay" style="width:760px;margin:0">${words.repeat(8)}</p></div>`,
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

/** An empty report at `width`, to build reports from. */
const report = (width: number, more: Partial<LayoutReport> = {}): LayoutReport => ({
    width,
    height: 844,
    checked: 6,
    issues: [],
    more: 0,
    found: [],
    totals: {},
    summary: { fontSizes: [14], colors: ["#000000"], families: ["sans-serif"], icons: [], strokes: [] },
    ...more,
});

test("a page laid out wider than the picture is reported as wider than the screen, at the width asked for", () => {
    const parsed = parseLayout(JSON.stringify({ ...report(520) }), 390);

    assert.equal(parsed?.width, 390);
    assert.deepEqual(parsed?.issues, [{ kind: "page-wider", what: "the page", box: [0, 520], limit: [0, 390] }]);
    assert.match(describeLayout(parsed!), /- the page: is wider than the screen \(520 px in 390\)/);
    assert.equal(parseLayout("not json", 390), undefined);
    assert.equal(parseLayout(JSON.stringify(report(390)), 390)?.issues.length, 0);
    // A report without the PP-395 findings is not one.
    assert.equal(parseLayout(JSON.stringify({ width: 390, height: 844, checked: 6, issues: [], more: 0 }), 390), undefined);
});

test("the words keep the report short: three of each kind with their numbers, a count of the rest, and the summary past a designed page's few sizes and colours", () => {
    const targets: LayoutFind[] = [
        { kind: "small-target", what: 'button.icon "Close"', size: [32, 32], count: 9 },
        { kind: "small-target", what: 'a.chip "Docs"', size: [60, 24], count: 4 },
        { kind: "small-target", what: "input.check", size: [16, 16], count: 2 },
        { kind: "small-target", what: 'button.more "More"', size: [36, 36], count: 1 },
    ];
    const text = describeLayout(
        report(390, {
            found: [
                ...targets,
                { kind: "contrast", what: 'span.meta "2 min ago"', color: "#3b3f55", background: "#1a1b26", ratio: 1.62, needs: 4.5, count: 3 },
                { kind: "off-grid", what: 'div.row "One"', property: "padding", value: 6, count: 14 },
            ],
            totals: { "small-target": 16, contrast: 3, "off-grid": 14 },
            summary: { fontSizes: [11, 12, 13, 13.6, 14, 15, 16, 20], colors: ["#c0caf5", "#a9b1d6"], families: ["Inter", "JetBrains Mono", "Georgia"], icons: ["16x16", "18x18", "20x20"], strokes: ["1.5px", "2px"] },
        }),
    );

    assert.match(text, /^Layout check at 390 px \(6 elements\): 33 out of place\./);
    assert.match(text, /\nTap targets under 40 px \(16\):\n- button\.icon "Close": 32×32 px \(×9\)\n- a\.chip "Docs": 60×24 px \(×4\)\n- input\.check: 16×16 px \(×2\)\n- and 1 more\n/);
    assert.match(text, /\nText under WCAG AA contrast \(3\):\n- span\.meta "2 min ago": #3b3f55 on #1a1b26, 1\.62:1 \(needs 4\.5\) \(×3\)\n/);
    assert.match(text, /\nSizes off the 4 px grid or not whole pixels \(14\):\n- padding 6 px: 14 elements, such as div\.row "One"\n/);
    assert.match(text, /\nType and colour: 8 font sizes \(11, 12, 13, 13\.6, 14, 15, 16, 20 px\); 3 font families \(Inter, JetBrains Mono, Georgia\); icons in 3 sizes \(16x16, 18x18, 20x20 px\); icon strokes of 2 widths \(1\.5px, 2px\)\.$/);
    assert.doesNotMatch(text, /More/);
});

/** The page's report, as the renderer measures it. */
async function measured(page: BrowserPage, path: string, width = 390): Promise<LayoutReport> {
    await page.navigate(`http://pi.test${path}`);

    const report = parseLayout(await page.evaluate<string>(layoutCheck(width)), width);

    assert.ok(report !== undefined, `${path} gave a report`);

    return report;
}

const of = <K extends LayoutFind["kind"]>(report: LayoutReport, kind: K) => report.found.filter((find): find is Extract<LayoutFind, { kind: K }> => find.kind === kind);

test("the layout check reports what is out of place, with sizes, and nothing on a page in place", { skip }, async () => {
    const engine = new ChromeEngine(chrome!, [`--host-resolver-rules=MAP pi.test 127.0.0.1:${port}`, "--no-sandbox"]);

    try {
        const page = new BrowserPage(await engine.connect((await engine.tabs())[0]!));

        await page.init({ width: 390, height: 844, mobile: true });

        const clean = await measured(page, "/clean");

        assert.deepEqual(clean.issues, [], JSON.stringify(clean.issues));
        assert.deepEqual(clean.found, [], JSON.stringify(clean.found));
        assert.match(describeLayout(clean), /^Layout check at 390 px \(\d+ elements\): nothing spills/);

        const spill = await measured(page, "/spill");

        assert.ok(spill.issues.some((issue) => issue.kind === "spills" && issue.what.startsWith("div#box") && issue.box[1] === 500 && issue.limit[1] === 300), JSON.stringify(spill.issues));
        assert.ok(spill.issues.some((issue) => issue.kind === "outside-parent" && issue.what.includes('"Wide"')), JSON.stringify(spill.issues));
        assert.match(describeLayout(spill), /div#box\.col "Wide": its content is wider than its box \(500 px in 300\)/);

        const wide = await measured(page, "/wide");

        assert.ok(wide.issues.some((issue) => issue.kind === "page-wider" && issue.box[1] === 2000 && issue.limit[1] === 390), JSON.stringify(wide.issues));
    } finally {
        await engine.close();
    }
});

test("the layout check finds cut text, overlaps, small tap targets, off-grid sizes, low contrast, small text, emoji, gradient text, uppercase labels, tight tracking and long lines, each with its numbers (PP-395)", { skip }, async () => {
    const engine = new ChromeEngine(chrome!, [`--host-resolver-rules=MAP pi.test 127.0.0.1:${port}`, "--no-sandbox"]);

    try {
        const page = new BrowserPage(await engine.connect((await engine.tabs())[0]!));

        await page.init({ width: 390, height: 844, mobile: true });

        // Cut text: an ellipsis that truncates, and lines cut at the bottom of a box that hides its overflow.
        const ellipsis = await measured(page, "/ellipsis");
        const [title] = of(ellipsis, "cut");

        assert.ok(title !== undefined && title.what.startsWith("div#title") && title.axis === "x" && title.ellipsis && title.shown === 120 && title.full > 200, JSON.stringify(ellipsis.found));
        assert.match(describeLayout(ellipsis), /Cut text \(1\):\n- div#title "A long session title that does": cut at the side, ends in … \(shows 120 of \d+ px wide\)/);

        const lines = await measured(page, "/lines");
        const [note] = of(lines, "cut");

        assert.ok(note !== undefined && note.what.startsWith("div#note") && note.axis === "y" && !note.ellipsis && note.shown === 40 && note.full >= 80, JSON.stringify(lines.found));

        // An element over a button; a dialog over the whole page is a layer, not an overlap.
        const covered = await measured(page, "/covered");
        const [send, ...others] = of(covered, "covered");

        // A transparent button laid over a title (one tap target for the row) hides nothing.
        assert.deepEqual(others, []);
        assert.ok(send !== undefined && send.what.startsWith("button#send") && send.by.startsWith("div#toast"), JSON.stringify(covered.found));
        assert.match(describeLayout(covered), /Covered: an element on top of another's text or control \(\d\):\n- button#send "Send now": under div#toast/);
        assert.deepEqual(of(await measured(page, "/sheet"), "covered"), []);

        // A tap target under 40 px at a phone's width; at a desktop's it is not one.
        const target = await measured(page, "/target");

        assert.deepEqual(of(target, "small-target").map((find) => [find.what, find.size]), [['button#close "Go"', [32, 32]]]);
        assert.deepEqual(of(await measured(page, "/target", 1280), "small-target"), []);

        // Padding, radius and gap off the 4 px grid, and a gap that is not a whole pixel.
        const grid = await measured(page, "/grid");

        assert.deepEqual(
            of(grid, "off-grid").map((find) => [find.property, find.value]).sort(),
            [["gap", 5.5], ["padding", 6], ["radius", 10]],
            JSON.stringify(grid.found),
        );

        // Faint text, with the numbers: #3b3f55 on #1a1b26, and white at 30% over it.
        const faint = await measured(page, "/faint");
        const contrast = of(faint, "contrast");

        assert.equal(contrast.length, 2, JSON.stringify(faint.found));
        assert.ok(contrast.some((find) => find.what.startsWith("span#meta") && find.color === "#3b3f55" && find.background === "#1a1b26" && find.ratio < 2 && find.needs === 4.5), JSON.stringify(contrast));
        assert.ok(contrast.some((find) => find.what.startsWith("span#dim") && find.ratio < 4.5), JSON.stringify(contrast));

        assert.deepEqual(of(await measured(page, "/small"), "small-text").map((find) => [find.what, find.size]), [['p#fine "Fine print"', 10]]);
        assert.deepEqual(of(await measured(page, "/emoji"), "emoji").map((find) => find.glyphs).sort(), ["\u25A3", "\u263A", "\u2713", "\u{1F680}"]);
        assert.deepEqual(of(await measured(page, "/gradient"), "gradient-text").map((find) => find.what), ['p#hype "Supercharge"']);

        const caps = await measured(page, "/caps");

        assert.deepEqual(of(caps, "uppercase").map((find) => [find.what, find.transform, find.tracking]), [['p#label "Navigation"', "uppercase", 2]]);
        assert.deepEqual(of(caps, "tight-tracking").map((find) => [find.what, find.tracking, find.size]), [['p#tight "Squeezed words"', -0.5, 14]]);

        const [essay] = of(await measured(page, "/long"), "long-lines");

        assert.ok(essay !== undefined && essay.what.startsWith("p#essay") && essay.chars > 90, JSON.stringify(essay));
    } finally {
        await engine.close();
    }
});

test("Pi's browser gives the same check: browser_layout_check on the page in front, and with browser_screenshot's picture (PP-395)", { skip }, async () => {
    const browser = new PiBrowser({
        engine: new ChromeEngine(chrome!, [`--host-resolver-rules=MAP pi.test 127.0.0.1:${port}`, "--no-sandbox"]),
        changed: () => {},
        frame: () => {},
        log: () => {},
    });

    try {
        await browser.open(1, "http://pi.test/covered");

        const layout = await browser.layoutCheck(1);

        assert.ok(!("withheld" in layout));
        assert.ok(of(layout, "covered").some((find) => find.what.startsWith("button#send") && find.by.startsWith("div#toast")), JSON.stringify(layout.found));

        const shot = await browser.screenshot(1);

        assert.ok("data" in shot && shot.layout !== undefined && !("error" in shot.layout));
        assert.ok(of(shot.layout, "covered").length === 1, JSON.stringify(shot.layout));
        // A picture of one control comes without it.
        await browser.open(1, "http://pi.test/target");

        const one = await browser.screenshot(1, { index: 1 });

        assert.ok("data" in one && one.layout === undefined);
    } finally {
        await browser.close();
    }
});
