// brand-extract (PP-240): its measurement script is one expression browser_eval takes, and in Chrome, in browser_eval's
// read-only world, it reads a brand's page as the skill says: the page's background and text, the main buttons' fill,
// headings, colours by use, the type scale, spacing on its base unit, radii, shadows, the content's width and the
// :root custom properties.
import { cleanUp } from "./helpers.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { ChromeEngine, PiBrowser } from "../src/server/browser/pi-browser.ts";
import { APP_ROOT } from "../src/server/config.ts";

after(() => cleanUp());

const SKILL = join(APP_ROOT, "src", "design", "skills", "brand-extract");
const measure = readFileSync(join(SKILL, "measure.js"), "utf8");

test("brand-extract's skill names its measurement script, and the script is one expression (PP-240)", () => {
    const skill = readFileSync(join(SKILL, "SKILL.md"), "utf8");

    assert.match(skill, /^---\nname: brand-extract\ndescription: "/);
    assert.match(skill, /`measure\.js`/);
    assert.match(skill, /browser_eval/);
    assert.match(skill, /systems\.ts> check <id>/);
    // As browser_eval runs it: an expression, whose value is the measurement (a function wrapping it parses).
    assert.doesNotThrow(() => new Function(`return ${measure.trim()};`));
});

const chrome = ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"].find((name) => {
    try {
        execFileSync("which", [name], { stdio: "ignore" });

        return true;
    } catch {
        return false;
    }
});
const real = { skip: chrome === undefined ? "no Chrome on this machine (CI runs it)" : false } as const;

// A brand's page: a warm paper background, ink text, a coral brand colour on its buttons, an 8 px spacing unit, a
// 1080 px container, cards with a radius and a shadow.
const BRAND = `<!doctype html><title>Coral</title><meta name="viewport" content="width=device-width">
<style>
:root { --brand-coral: #e4572e; --brand-ink: #1d1b16; --space-unit: 8px; --unrelated-z: 3; }
body { margin: 0; background: #fbf7f0; color: #1d1b16; font: 16px/1.5 "Helvetica Neue", Arial, sans-serif; }
.wrap { max-width: 1080px; margin: 0 auto; padding: 32px 24px; }
h1 { font: 600 48px/1.1 Georgia, serif; letter-spacing: -0.96px; margin: 0 0 16px; }
h2 { font: 600 32px/1.2 Georgia, serif; margin: 48px 0 16px; }
p { margin: 0 0 16px; color: #5c574d; }
a { color: #b8391a; }
.button { display: inline-block; background: #e4572e; color: #ffffff; padding: 12px 24px; border-radius: 8px; text-decoration: none; font-weight: 500; }
.card { background: #ffffff; border: 1px solid #e8e1d4; border-radius: 16px; padding: 24px; margin: 0 0 24px; box-shadow: 0 8px 24px rgba(29, 27, 22, 0.08); }
code { font: 14px "JetBrains Mono", monospace; }
</style>
<div class="wrap">
  <h1>Warm tools for careful people</h1>
  <p>Coral makes things that last. Read <a href="/story">our story</a> or start today with a plan that fits.</p>
  <a class="button" href="/start">Start free</a> <a class="button" href="/demo">Book a demo</a>
  <h2>What you get</h2>
  ${[1, 2, 3].map((n) => `<div class="card"><p>Card ${n} explains one thing in a sentence that is long enough to count as body text on this page.</p><code>coral --plan ${n}</code></div>`).join("")}
</div>`;

let server: Server;
let port = 0;

before(async () => {
    server = createServer((_request, response) => {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end(BRAND);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as { port: number }).port;
});

after(() => server?.close());

type Share = { value: string; share: number };
type Measured = {
    page: { background: string; text: string; fontFamily: string; fontSize: string };
    headings: Record<string, { fontFamily: string; fontSize: string; fontWeight: string; lineHeight: string; letterSpacing: string; color: string }>;
    paragraph: { color: string };
    link: { color: string };
    buttons: { background: string; color: string; radius: string; padding: string }[];
    buttonFills: Share[];
    code: { fontFamily: string };
    colors: { text: Share[]; background: Share[]; border: Share[] };
    type: { families: Share[]; sizes: Share[] };
    spacing: Share[];
    radii: Share[];
    shadows: Share[];
    container: string | null;
    customProperties: Record<string, string>;
};

test("with Chrome: measure.js reads a brand's page in browser_eval's world (PP-240)", real, async () => {
    const browser = new PiBrowser({
        engine: new ChromeEngine(chrome!, [`--host-resolver-rules=MAP brand.test 127.0.0.1:${port}`, "--no-sandbox"]),
        changed: () => {},
        frame: () => {},
        log: () => {},
    });

    try {
        await browser.open(1, "http://brand.test/");
        await browser.resize(1, "desktop");

        const answer = await browser.evaluate(1, measure, false);

        if ("withheld" in answer) {
            assert.fail(`withheld: ${answer.withheld}`);
        }

        const m = JSON.parse(answer.json) as Measured;

        assert.equal(m.page.background, "#fbf7f0");
        assert.equal(m.page.text, "#1d1b16");
        assert.equal(m.page.fontSize, "16px");
        assert.match(m.page.fontFamily, /^"Helvetica Neue", Arial/);
        assert.deepEqual(
            { family: m.headings.h1!.fontFamily, size: m.headings.h1!.fontSize, weight: m.headings.h1!.fontWeight, tracking: m.headings.h1!.letterSpacing },
            { family: "Georgia, serif", size: "48px", weight: "600", tracking: "-0.96px" },
        );
        assert.equal(m.headings.h2!.fontSize, "32px");
        assert.equal(m.paragraph.color, "#5c574d");
        assert.equal(m.link.color, "#b8391a");
        // The brand colour: the main buttons' fill, with their label, radius and padding.
        assert.equal(m.buttonFills[0]!.value, "#e4572e");
        assert.deepEqual({ ...m.buttons[0]!, text: undefined }, { ...m.buttons[0]!, text: undefined, background: "#e4572e", color: "#ffffff", radius: "8px", padding: "12px 24px" });
        assert.match(m.code.fontFamily, /JetBrains Mono/);
        // Colours by use: the paper is the largest background, the card border the border, the body grey the most text.
        assert.equal(m.colors.background[0]!.value, "#fbf7f0");
        assert.ok(m.colors.background.some((each) => each.value === "#ffffff"));
        assert.equal(m.colors.border[0]!.value, "#e8e1d4");
        assert.equal(m.colors.text[0]!.value, "#5c574d");
        // Type, spacing (all on the 8 px unit, but the button's 12), radii, shadows, the container.
        assert.deepEqual(new Set(m.type.sizes.map((each) => each.value)), new Set(["16px", "48px", "32px", "14px"]));
        assert.ok(m.spacing.every((each) => parseInt(each.value, 10) % 8 === 0 || each.value === "12px"), JSON.stringify(m.spacing));
        assert.deepEqual(m.radii.map((each) => each.value).sort(), ["16px", "8px"]);
        assert.match(m.shadows[0]!.value, /rgba\(29, 27, 22, 0\.08\) 0px 8px 24px 0px/);
        assert.equal(m.container, "1080px");
        // The brand's own names for its values; a property that names none of them is left out.
        assert.deepEqual(m.customProperties, { "--brand-coral": "#e4572e", "--brand-ink": "#1d1b16", "--space-unit": "8px" });
    } finally {
        await browser.close();
    }
});
