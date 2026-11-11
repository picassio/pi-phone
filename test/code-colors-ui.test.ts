// Code's syntax colours in the app with dark palettes whose own colours read under 4.5:1 on code's ground (PP-406):
// a reply's code block, measured by the layout check, has no syntax colour under WCAG AA; Tokyo Night's, which read
// already, are the palette's own. Comments are quiet on purpose, in --faint, held to a hint's 3:1.
import { type App, cleanUp, cleanUpAll, newSession, openApp, root, say, scriptedModel, until, work } from "./helpers.ts";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai/providers/faux";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { Browsers } from "./support/browser.ts";
import { findBrowser } from "./support/browser/discovery.ts";
import { VIEWPORTS } from "./support/browser/viewport.ts";
import { createHandler } from "../src/server/http.ts";
import { layoutCheck, parseLayout } from "../src/server/layout-check.ts";

const real = { skip: findBrowser() === undefined ? "no Chromium-based browser on this machine" : false } as const;
const REPLY = [
    "Here it is:",
    "",
    "```js",
    "// a comment",
    'const name = "pi";',
    "function count(n) {",
    "    return n + 42;",
    "}",
    "```",
    "",
    "```html",
    '<div class="row">Hello</div>',
    "```",
].join("\n");

let app: App;
let server: Server;
let browsers: Browsers;
/** Per palette: the syntax colours' contrast findings, and the colour each token's span is drawn in. */
const seen = new Map<string, { low: string[]; colors: Record<string, string> }>();

after(() => cleanUpAll(() => browsers?.closeAll({ final: true }), () => server?.closeAllConnections(), () => server?.close(), () => app?.close(), () => cleanUp()));

before(async () => {
    if (real.skip !== false) {
        return;
    }

    mkdirSync(work, { recursive: true });
    app = await openApp(scriptedModel(() => fauxAssistantMessage([fauxText(REPLY)])), join(root, "code-colors-ui"));
    server = createServer(createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const id = await newSession(app);

    await say(app, id, "Show me some code");
    browsers = new Browsers({ dataDir: mkdtempSync(join(root, "code-colors-")), load: async () => undefined, save: () => {} });
    const page = await browsers.open(1);

    await page.setViewport(VIEWPORTS.desktop);
    await page.navigate(`${base}/login?token=${encodeURIComponent(app.config.ownerToken)}`);
    await until(async () => (await page.evaluate(`return JSON.stringify(document.querySelector(".session-row") !== null)`)) === "true", "the session list", 20_000);

    for (const theme of ["miasma", "solitude", "matte-black", "tokyo-night"]) {
        await page.evaluate(
            `localStorage.setItem("pocket.appearance", JSON.stringify({ ...JSON.parse(localStorage.getItem("pocket.appearance") || "{}"), theme: ${JSON.stringify(theme)} })); localStorage.removeItem("pocket.themeCache"); return "1";`,
        );
        await page.navigate(`${base}/s/${id}`);
        await until(async () => (await page.evaluate(`return JSON.stringify(document.documentElement.dataset.colors === ${JSON.stringify(theme)} && document.querySelectorAll("pre [class^=hl-]").length > 0)`)) === "true", `code in ${theme}`, 20_000);
        // The reply fades in: measured once it has.
        await new Promise((resolve) => setTimeout(resolve, 1500));
        const report = parseLayout(JSON.parse(await page.evaluate(`return JSON.stringify(${layoutCheck(1280)})`)), 1280);

        assert.ok(report, `${theme}: the layout check gave a report`);
        const colors = JSON.parse(
            await page.evaluate(`return JSON.stringify(Object.fromEntries([...document.querySelectorAll("pre [class^=hl-]")].map((each) => [each.className, getComputedStyle(each).color])))`),
        ) as Record<string, string>;

        seen.set(theme, { low: report.found.filter((find) => find.kind === "contrast" && /^span\.hl-/.test(find.what) && (find.ratio < 3 || !/^span\.hl-com\b/.test(find.what))).map((find) => JSON.stringify(find)), colors });
    }
});

test("a dark palette's code colours read at 4.5:1 in a reply's code block, those too dark lifted (PP-406)", real, () => {
    assert.equal(seen.size, 4);

    for (const [theme, { low, colors }] of seen) {
        assert.ok(Object.keys(colors).length >= 4, `${theme}: ${JSON.stringify(colors)}`);
        assert.deepEqual(low, [], theme);
    }
});

test("a palette whose code colours read keeps them: Tokyo Night's keywords and strings are its magenta and green (PP-406)", real, () => {
    const colors = seen.get("tokyo-night")?.colors ?? {};

    assert.equal(colors["hl-kw"], "rgb(173, 142, 230)");
    assert.equal(colors["hl-str"], "rgb(158, 206, 106)");
});
