// The UI polish leftovers after Build #441 (PP-406), measured in a real browser with the app's own style.css: on a
// phone (touch), the top bar's branch tag and usage meter, the subagents bar and a watched CI run each take a 40 px
// tap (they took 39, 25.6 and 36), the usage meter is a 24 px pill on the grid (25.6), and the subagents bar's status
// dots and a CI run's are 8 px (7). At a desktop's width the same controls stay on the grid. Image thumbnails (web/ui.js
// Thumb): a row's are 140 px tall (142: the hairline was a border around the picture), and a lone one is as tall as its
// picture, which the layout check leaves off the grid.
import { cleanUp, cleanUpAll, root, until } from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { Browsers } from "./support/browser.ts";
import { findBrowser } from "./support/browser/discovery.ts";
import { VIEWPORTS } from "./support/browser/viewport.ts";
import { type LayoutFind, layoutCheck, type LayoutReport, parseLayout } from "../src/server/layout-check.ts";

const real = { skip: findBrowser() === undefined ? "no Chromium-based browser on this machine" : false } as const;
const css = readFileSync(new URL("../web/style.css", import.meta.url), "utf8");
const icon = `<svg class="icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="8"/></svg>`;
// A picture 300 × 97: a lone thumb shows it whole, 97 px tall.
const picture = `data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='300' height='97'%3E%3Crect width='300' height='97' fill='%23888888'/%3E%3C/svg%3E`;
const thumb = `<button class="thumb" type="button"><img src="${picture}" alt="Screenshot"></button>`;
// The app's markup for each (web/app.js, web/usage.js, web/subagents.js, web/composer.js, web/ui.js).
const PAGE = `<!doctype html><html data-mode="dark"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/style.css">
<body style="padding:24px">
  <div class="title"><span class="title-sub" data-part="topbar-sub"><button class="title-branch" aria-label="Branch master: switch or make a branch">${icon}<span class="title-branch-name">master</span></button></span></div>
  <div style="height:24px"></div>
  <div class="usage-meter-wrap"><button class="usage-meter low" aria-expanded="false">wk 32%</button></div>
  <div style="height:24px"></div>
  <div class="agents-bar busy" data-part="subagents-bar"><div class="agents-top"><button class="agents-summary" aria-label="2 working" aria-expanded="false"><span class="agents-dots" aria-hidden="true"><span class="agents-dot working"></span><span class="agents-dot"></span></span><span class="agents-count">2 working</span></button></div></div>
  <div class="ci-bar" data-part="ci-watch-bar"><div class="ci-row"><a class="ci-run" href="#run"><span class="ci-dot" aria-hidden="true"></span><span class="ci-name">Build APK</span><span class="ci-meta">#486</span></a></div></div>
  <div class="thumbs" id="row">${thumb}${thumb}${thumb}</div>
  <div class="thumbs" id="lone">${thumb}</div>
</body></html>`;

let server: Server;
let browsers: Browsers;
let base = "";
const reports = new Map<number, LayoutReport>();
const sizes = new Map<number, Record<string, number[]>>();

after(() => cleanUpAll(() => browsers?.closeAll({ final: true }), () => server?.closeAllConnections(), () => server?.close(), () => cleanUp()));

before(async () => {
    if (real.skip !== false) {
        return;
    }

    server = createServer((request, response) => {
        const style = request.url === "/style.css";

        response.writeHead(200, { "content-type": style ? "text/css" : "text/html; charset=utf-8" });
        response.end(style ? css : PAGE);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    browsers = new Browsers({ dataDir: mkdtempSync(join(root, "polish-leftovers-")), load: async () => undefined, save: () => {} });
    const page = await browsers.open(1);

    for (const viewport of [VIEWPORTS.mobile, VIEWPORTS.desktop]) {
        await page.setViewport(viewport);
        await page.navigate(`${base}/`);
        // The thumbnails' pictures loaded: a page is complete after its images.
        await until(async () => (await page.evaluate(`return JSON.stringify(document.readyState === "complete")`)) === "true", "the page, loaded");
        const report = parseLayout(JSON.parse(await page.evaluate(`return JSON.stringify(${layoutCheck(viewport.width)})`)), viewport.width);

        assert.ok(report, `${viewport.width}: the layout check gave a report`);
        reports.set(viewport.width, report);
        sizes.set(
            viewport.width,
            JSON.parse(
                await page.evaluate(
                    `return JSON.stringify(Object.fromEntries(["button.title-branch", "button.usage-meter", "button.agents-summary", "a.ci-run", "span.agents-dot", "span.ci-dot", "#row .thumb", "#lone .thumb", "#lone img"].map((q) => { const r = document.querySelector(q).getBoundingClientRect(); return [q, [Math.round(r.width * 100) / 100, Math.round(r.height * 100) / 100]]; })))`,
                ),
            ) as Record<string, number[]>,
        );
    }
});

const finds = (width: number, kind: LayoutFind["kind"]) => (reports.get(width)?.found ?? []).filter((find) => find.kind === kind).map((find) => JSON.stringify(find));

test("on a phone the branch tag, the usage meter, the subagents bar and a CI run take a 40 px tap (PP-406)", real, () => {
    assert.deepEqual(finds(390, "small-target"), []);
});

test("the usage meter is a 24 px pill and the bars' rows 40 px, on the grid at both widths (PP-406)", real, () => {
    for (const width of [390, 1280]) {
        assert.deepEqual(finds(width, "off-grid"), [], `${width}`);
        assert.equal(sizes.get(width)?.["button.usage-meter"]?.[1], 24, `${width}`);
        assert.equal(sizes.get(width)?.["button.agents-summary"]?.[1], 40, `${width}`);
        assert.equal(sizes.get(width)?.["a.ci-run"]?.[1], 40, `${width}`);
    }
});

test("image thumbnails are as tall as their pictures: 140 px in a row, a lone one its picture's 97 px, which the layout check leaves off the grid (PP-406)", real, () => {
    for (const width of [390, 1280]) {
        assert.equal(sizes.get(width)?.["#row .thumb"]?.[1], 140, `${width}`);
        assert.equal(sizes.get(width)?.["#lone img"]?.[1], 97, `${width}`);
        assert.equal(sizes.get(width)?.["#lone .thumb"]?.[1], 97, `${width}`);
    }
});

test("the subagents bar's and a CI run's status dots are 8 px (PP-406)", real, () => {
    assert.deepEqual(sizes.get(390)?.["span.agents-dot"], [8, 8]);
    assert.deepEqual(sizes.get(390)?.["span.ci-dot"], [8, 8]);
});
