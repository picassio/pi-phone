// Redlines (src/server/redline.ts, PP-398): a page measured from its DOM, its numbers drawn on its picture. A spec from
// a plain list or a design system's tokens.css; the plan's shapes, legend and what is off the spec, with numbers; in a
// real Chrome (CI has one), a page with known padding, gaps, radii, a small button and two type styles, measured as the
// screenshot tool's renderer measures it and as Pi's browser does, drawn with a legend under it; and a picture file,
// which has no DOM, sent to image_compare.
import { type App, cleanUp, context, lastText, modelTexts, newSession, openApp, owner, scriptedModel, work } from "./helpers.ts";
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { ChromeRenderer } from "../src/server/chrome-renderer.ts";
import { ChromeEngine, PiBrowser } from "../src/server/browser/pi-browser.ts";
import { decodePicture } from "../src/server/markup.ts";
import { describeRedline, NO_DOM, parseRedline, parseSpec, planRedline, REDLINE_COLORS, type RedlineMeasure, redlinePictures, redlineScript, specFrom } from "../src/server/redline.ts";
import { Screenshots } from "../src/server/screenshots.ts";

const chrome = ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"].find((name) => {
    try {
        execFileSync("which", [name], { stdio: "ignore" });

        return true;
    } catch {
        return false;
    }
});
const skip = chrome === undefined ? "no Chrome on this machine (CI runs it)" : false;

const PAGE = `<!doctype html><meta name="viewport" content="width=device-width"><style>
body{margin:0;font:15px/20px sans-serif;background:#fff;color:#111}
.wrap{padding:20px}
.card{background:#eef;padding:16px;border-radius:23px;margin:0 0 23px}
.card h2{font-size:22px;line-height:28px;font-weight:600;margin:0}
.card p{font-size:13px;line-height:18px;margin:8px 0 0}
button{width:32px;height:32px;padding:0;border:0;background:#ccd;border-radius:8px;font:13px/16px sans-serif}
</style><div class="wrap"><div class="card" id="one"><h2>First card</h2><p>Words in it</p></div><div class="card" id="two"><h2>Second card</h2><p>More words</p></div><button id="go">Go</button></div>`;
const SPEC = "padding 16, gap 24, radius 24/12/20, font 22/13/12";
/** A list of rows under a sheet open over it, with its backdrop, as pi-phone's ?sheet=dictation. */
const SHEET = `<!doctype html><meta name="viewport" content="width=device-width"><style>
body{margin:0;font:15px/20px sans-serif;background:#fff;color:#111}
.row{background:#eee;padding:6px;margin:0 0 6px;border-radius:9px}
.scrim{position:fixed;inset:0;background:rgba(0,0,0,.5)}
#sheet{position:absolute;left:0;right:0;bottom:0;background:#fff;padding:20px;border-radius:24px 24px 0 0}
#sheet h2{font-size:20px;line-height:28px;margin:0 0 12px}
#sheet button{width:120px;height:44px;padding:0;border:0;border-radius:12px;background:#ccd;font:14px/20px sans-serif}
</style><div class="list"><div class="row">Row one</div><div class="row">Row two</div><button class="row">Row three</button></div>
<div class="scrim"><section id="sheet" role="dialog" aria-modal="true"><h2>Dictation</h2><button>Turn on</button></section></div>`;

let server: Server;
let port = 0;
let app: App;

const route: FauxResponseStep = (request) => {
    const { role, text } = lastText(request as never);

    if (role === "user" && text.endsWith("redline the picture")) {
        return fauxAssistantMessage([fauxToolCall("redline", { path: join(work, "shot.png") })], { stopReason: "toolUse" });
    }

    return fauxAssistantMessage([fauxText("done")]);
};

before(async () => {
    server = createServer((_request, response) => {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end(_request.url === "/sheet" ? SHEET : PAGE);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as { port: number }).port;
    app = await openApp(scriptedModel(route));
});

after(async () => {
    server?.close();
    await app?.close();
    cleanUp();
});

test("a spec names a tokens.css file to read, or is a plain list; none is no spec", async () => {
    const read: string[] = [];
    const from = (path: string) => {
        read.push(path);

        return Promise.resolve(":root { --space-4: 16px; --radius-md: 12px; }");
    };

    assert.deepEqual(await specFrom("designs/stripe/tokens.css", from), { source: "designs/stripe/tokens.css", padding: [16], gap: [16], radius: [12] });
    assert.deepEqual(read, ["designs/stripe/tokens.css"]);
    assert.deepEqual(await specFrom("radius 24/12", from), { source: "the spec given", radius: [12, 24] });
    assert.equal(await specFrom("  ", from), undefined);
    assert.equal(await specFrom(undefined, from), undefined);
    assert.deepEqual(read, ["designs/stripe/tokens.css"]);
});

test("a spec from a plain list or a design system's tokens.css; a name it does not know fails, saying what it takes", () => {
    assert.deepEqual(parseSpec("padding 16, gap 8/16, radius 24/12/20, font 22/13/12, weight 400/500, line 20px, target 44", "list"), {
        source: "list",
        padding: [16],
        gap: [8, 16],
        radius: [12, 20, 24],
        font: [12, 13, 22],
        weight: [400, 500],
        line: [20],
        target: 44,
    });
    assert.deepEqual(parseSpec("spacing 4/8", "list"), { source: "list", padding: [4, 8], gap: [4, 8] });

    const tokens = parseSpec(":root { --space-1: 4px; --space-2: 0.5rem; --radius-sm: 6px; --radius-pill: 9999px; --text-base: 1rem; --text-sm: var(--x); --x: 13px; --leading-body: 1.5; --leading-tight: 20px; --accent: #533afd; }", "tokens.css");

    assert.deepEqual(tokens, { source: "tokens.css", padding: [4, 8], gap: [4, 8], radius: [6], font: [13, 16], line: [20] });
    assert.throws(() => parseSpec("colour red", "list"), /"colour red" is not a spec entry/);
    assert.throws(() => parseSpec("padding big", "list"), /not a number of pixels/);
    assert.throws(() => parseSpec(":root { --accent: #fff; }", "brand.css"), /brand\.css has no spacing, radius or type tokens/);
});

/** A card with 16 px padding, 23 px corners and a 23 px gap below it, a 32 px button, and two type styles. */
const MEASURE: RedlineMeasure = {
    width: 390,
    height: 844,
    mode: "auto",
    found: 2,
    blocks: [
        {
            what: 'div.card "First card"',
            kind: "surface",
            box: [20, 20, 350, 90],
            padding: [16, 16, 16, 16],
            border: [0, 0, 0, 0],
            radius: [23, 23, 23, 23],
            pill: false,
            gap: { axis: "y", value: 23, area: [20, 110, 350, 23] },
        },
        { what: 'button "Go"', kind: "control", box: [20, 133, 32, 32], padding: [0, 0, 0, 0], border: [0, 0, 0, 0], radius: [8, 8, 8, 8], pill: false },
    ],
    types: [
        { size: 22, weight: 600, line: 28, color: "#111111", what: 'h2 "First card"', box: [36, 36, 120, 28], count: 2 },
        { size: 15, weight: 400, line: 20, color: "#111111", what: 'p "Words in it"', box: [36, 72, 90, 20], count: 2 },
    ],
};

test("the plan draws padding, gaps, radii, sizes and type, lists the values used, and marks what is off the spec in red with the spec's nearest value", () => {
    const auto = planRedline(MEASURE, undefined, { width: 390, height: 844 });
    const labels = auto.shapes.filter((shape) => shape.kind === "label").map((shape) => shape.text);

    assert.deepEqual(auto.misses, []);
    assert.ok(labels.includes("16") && labels.includes("23") && labels.includes("32x32 < 40") && labels.includes("22/28 600 #111111"), JSON.stringify(labels));
    assert.deepEqual(
        auto.legend.map((line) => line.text),
        ["Spacing (gaps) 23", "Padding 16", "Radius 8, 23", "Type 22/28 600 #111111; 15/20 400 #111111", "Tap targets under 40 px: 1"],
    );

    const spec = parseSpec(SPEC, "the spec given");
    const checked = planRedline(MEASURE, spec, { width: 390, height: 844 });

    assert.deepEqual(
        checked.misses.map((miss) => `${miss.what}: ${miss.property} ${miss.value}, spec ${miss.spec}`),
        ['div.card "First card": gap 23, spec 24', 'div.card "First card": radius 23, spec 24', 'button "Go": radius 8, spec 12', 'p "Words in it": font size 15, spec 13'],
    );
    assert.ok(checked.shapes.some((shape) => shape.kind === "label" && shape.text === "gap 23, spec 24" && shape.color === REDLINE_COLORS.off && shape.first === true));
    assert.ok(checked.shapes.some((shape) => shape.kind === "fill" && shape.color === REDLINE_COLORS.off && shape.box[3] === 23), "the gap's strip is red");
    assert.match(describeRedline(MEASURE, checked, spec), /^Redlines at 390 px: 1 surfaces and 1 controls \(the main blocks\); 2 type styles\.\n- Spacing \(gaps\) 23\n/);
    assert.match(describeRedline(MEASURE, checked, spec), /\nOff the spec \(the spec given: padding 16; gap 24; radius 12\/20\/24; font 12\/13\/22\), 4:\n- div\.card "First card": gap 23, spec 24\n/);
    assert.match(describeRedline(MEASURE, planRedline(MEASURE, parseSpec("padding 16", "list"), { width: 390, height: 844 }), parseSpec("padding 16", "list")), /Everything measured matches the spec \(list: padding 16\)\./);
    // Space the layout spreads (a flex: 1 filler, an auto margin) is drawn and said, never checked or listed as spacing.
    const spread: RedlineMeasure = { ...MEASURE, blocks: [{ ...MEASURE.blocks[0]!, gap: { axis: "y", value: 218, area: [20, 110, 350, 218], auto: true } }] };
    const spreadPlan = planRedline(spread, undefined, { width: 390, height: 844 });

    assert.ok(spreadPlan.shapes.some((shape) => shape.kind === "label" && shape.text === "218 auto"));
    assert.ok(!spreadPlan.legend.some((line) => line.text.startsWith("Spacing")));
    assert.deepEqual(planRedline(spread, spec, { width: 390, height: 844 }).misses.filter((each) => each.property === "gap"), []);
    // Blocks wholly outside the picture are left out.
    assert.equal(planRedline(MEASURE, undefined, { width: 390, height: 15 }).shapes.length, 0);
});

test("a picture file has no DOM: redline says so and points to image_compare", async () => {
    const id = await newSession(app);

    mkdirSync(work, { recursive: true });
    writeFileSync(join(work, "shot.png"), "not really");

    const { submissionId } = await app.commands.submit(id, owner(app), { text: "redline the picture", requestId: crypto.randomUUID() });

    await (await app.harness.submission(submissionId, context))!.wait(context);
    await app.harness.waitForIdle(context);

    const result = (await modelTexts(app, id)).find((each) => each.includes("has no page to measure"));

    assert.ok(result !== undefined, "the redline tool answered");
    assert.ok(result.includes(JSON.stringify(NO_DOM).slice(1, -1)) && NO_DOM.includes("image_compare"));
});

test("with Chrome: the screenshot tool's renderer measures the page with the redline script, and the picture gets the numbers and a legend under it", { skip }, async () => {
    const screenshots = new Screenshots();
    const renderer = new ChromeRenderer(screenshots, { binary: chrome!, flags: ["--no-sandbox"], base: `http://127.0.0.1:${port}`, token: () => "owner-token", log: () => {} });

    void renderer.run();
    await new Promise((resolve) => setTimeout(resolve, 200));

    try {
        const [shot] = await screenshots.render(`http://127.0.0.1:${port}/`, { widths: [390], settleMs: 200, check: redlineScript({ width: 390 }) });
        const measure = parseRedline(shot!.check);

        assert.ok(measure !== undefined, String(shot!.check).slice(0, 300));
        assert.equal(shot!.layout, undefined, "no layout check ran");

        const cards = measure.blocks.filter((block) => block.kind === "surface");
        const [button] = measure.blocks.filter((block) => block.kind === "control");

        assert.deepEqual(cards.map((card) => [card.what.split(" ")[0], card.padding, card.radius[0], card.gap?.axis, card.gap?.value]), [
            ["div#one.card", [16, 16, 16, 16], 23, "y", 23],
            ["div#two.card", [16, 16, 16, 16], 23, "y", 23],
        ]);
        assert.deepEqual(button?.box.slice(2), [32, 32]);
        assert.ok(measure.types.some((type) => type.size === 22 && type.line === 28 && type.weight === 600 && type.color === "#111111"), JSON.stringify(measure.types));

        const spec = parseSpec(SPEC, "the spec given");
        const { pictures, text } = redlinePictures([{ bytes: shot!.parts[0]!, top: 0 }], measure, spec, { cssWidth: shot!.width, cssHeight: shot!.height, png: true });
        const picture = decodePicture(pictures[0]!);
        const plain = decodePicture(shot!.parts[0]!);

        assert.match(text, /Off the spec .*, 5:/);
        assert.match(text, /- div#one\.card "First cardWords in it": gap 23, spec 24/);
        assert.equal(picture.width, plain.width);
        assert.ok(picture.height > plain.height, "the legend is a band under the picture");

        // The gap between the cards is tinted red (off the spec), where the page is white.
        const gap = cards[0]!.gap!.area;
        const at = ((Math.round(gap[1] + gap[3] / 2) * picture.width) + Math.round(gap[0] + 4)) * 4;
        const [r, g, b] = [...picture.data.subarray(at, at + 3)];

        assert.ok(r! > 200 && g! < 200 && b! < 200, `the gap is red: ${r},${g},${b}`);

        if (process.env.PHONE_SHOTS !== undefined) {
            mkdirSync(process.env.PHONE_SHOTS, { recursive: true });
            writeFileSync(join(process.env.PHONE_SHOTS, "redline-spec-390.png"), pictures[0]!);
            writeFileSync(join(process.env.PHONE_SHOTS, "redline-auto-390.png"), redlinePictures([{ bytes: shot!.parts[0]!, top: 0 }], measure, undefined, { cssWidth: shot!.width, cssHeight: shot!.height, png: true }).pictures[0]!);
        }
    } finally {
        await renderer.stop();
    }
});

test("with Chrome: with a sheet open over the page, auto mode measures the sheet only, not the list under its backdrop; a selector still finds what it names", { skip }, async () => {
    const screenshots = new Screenshots();
    const renderer = new ChromeRenderer(screenshots, { binary: chrome!, flags: ["--no-sandbox"], base: `http://127.0.0.1:${port}`, token: () => "owner-token", log: () => {} });

    void renderer.run();
    await new Promise((resolve) => setTimeout(resolve, 200));

    try {
        const [auto] = await screenshots.render(`http://127.0.0.1:${port}/sheet`, { widths: [390], settleMs: 200, check: redlineScript({ width: 390 }) });
        const measure = parseRedline(auto!.check)!;

        assert.equal(measure.layer, 'section#sheet "DictationTurn on"');
        assert.deepEqual(measure.blocks.map((block) => [block.kind, block.what]), [
            ["surface", 'section#sheet "DictationTurn on"'],
            ["control", 'button "Turn on"'],
        ]);
        assert.deepEqual(measure.types.map((type) => type.what).sort(), ['button "Turn on"', 'h2 "Dictation"']);

        const { text } = redlinePictures([{ bytes: auto!.parts[0]!, top: 0 }], measure, parseSpec(SPEC, "the spec given"), { cssWidth: 390, cssHeight: auto!.height, png: false });

        assert.match(text, /^Redlines at 390 px: 1 surfaces and 1 controls \(the main blocks of the top layer, section#sheet "DictationTurn on"; the page under it is left out\)/);
        assert.doesNotMatch(text, /row/);

        const [chosen] = await screenshots.render(`http://127.0.0.1:${port}/sheet`, { widths: [390], settleMs: 200, check: redlineScript({ width: 390, selector: ".row" }) });
        const rows = parseRedline(chosen!.check)!;

        assert.equal(rows.layer, undefined);
        assert.equal(rows.blocks.length, 3);
    } finally {
        await renderer.stop();
    }
});

test("with Chrome: Pi's browser measures the page in front with the same script, a selector choosing the elements", { skip }, async () => {
    const browser = new PiBrowser({ engine: new ChromeEngine(chrome!, [`--host-resolver-rules=MAP pi.test 127.0.0.1:${port}`, "--no-sandbox"]), changed: () => {}, frame: () => {}, log: () => {} });

    try {
        await browser.open(1, "http://pi.test/");

        const shot = await browser.screenshot(1, { png: true, script: redlineScript({ selector: ".card h2" }) });

        assert.ok("data" in shot && shot.layout === undefined);

        const measure = parseRedline(shot.measured);

        assert.ok(measure !== undefined);
        assert.equal(measure.mode, "selector");
        assert.deepEqual(measure.blocks.map((block) => [block.kind, block.what, block.type?.size]), [
            ["chosen", 'h2 "First card"', 22],
            ["chosen", 'h2 "Second card"', 22],
        ]);

        const { pictures, text } = redlinePictures([{ bytes: Buffer.from(shot.data, "base64"), top: 0 }], measure, undefined, { cssWidth: shot.viewport.width, cssHeight: shot.viewport.height, png: true });

        // With a selector, the type is the chosen elements' own, not the whole page's.
        assert.match(text, /^Redlines at \d+ px: 2 of the 2 elements \.card h2 finds; 1 type styles\.\n/);
        assert.match(text, /\n- Type 22\/28 600 #111111(\n|$)/);
        assert.ok(decodePicture(pictures[0]!).height > decodePicture(Buffer.from(shot.data, "base64")).height);
    } finally {
        await browser.close();
    }
});
