// pi-phone's own main screens under the layout check (PP-395's `layoutCheck`, the one `screenshot` runs), in a real
// browser at 390 and 1280 px, in a dark palette (Tokyo Night) and a light one (Catppuccin Latte): the session list, a
// session with a reply, Dictation, Machines, a project board, and a reply's More sheet. What the polish tickets fixed
// stays fixed: no emoji or symbol glyphs as icons (PP-402); hints at 3:1 and words at 4.5:1, no text under 12 px
// (PP-399); every control a 40 px tap on a phone, its own box or a layer past it (PP-400); padding, gaps, corners and
// control heights on the 4 px grid (PP-401); icons at 16, 20 or 24 px with stroke 2 (PP-403); none of the tells
// adapted from Impeccable (PP-415) but a live state's pulse. With PHONE_SHOTS, screenshots go there.
import { type App, cleanUp, cleanUpAll, newSession, openApp, owner, root, say, scriptedModel, until, work } from "./helpers.ts";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { Browsers } from "./support/browser.ts";
import { findBrowser } from "./support/browser/discovery.ts";
import { VIEWPORTS } from "./support/browser/viewport.ts";
import { createHandler } from "../src/server/http.ts";
import { type LayoutFind, type LayoutReport, layoutCheck, parseLayout } from "../src/server/layout-check.ts";

const real = { skip: findBrowser() === undefined ? "no Chromium-based browser on this machine" : false } as const;
const SHOTS = process.env.PHONE_SHOTS;

const REPLY = [
    "## What I found",
    "",
    "The layout check measures **cut text**, overlaps and tap targets, in a paragraph long enough to wrap over a few lines on a phone, with `inline code` and a [link](https://example.com).",
    "",
    "- First point",
    "- Second point",
].join("\n");

let app: App;
let server: Server;
let browsers: Browsers;
/** Each screen's report, by `<screen>-<palette>-<width>`. */
const reports = new Map<string, LayoutReport>();

after(() => cleanUpAll(() => browsers?.closeAll({ final: true }), () => server?.closeAllConnections(), () => server?.close(), () => app?.close(), () => cleanUp()));

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

before(async () => {
    if (real.skip !== false) {
        return;
    }

    mkdirSync(work, { recursive: true });
    writeFileSync(join(work, "README.md"), "# Hello\n\nA file to read.\n");
    app = await openApp(
        scriptedModel((context) =>
            (context as { messages: { role: string }[] }).messages.at(-1)?.role === "toolResult"
                ? fauxAssistantMessage([fauxText(REPLY)])
                : fauxAssistantMessage([fauxToolCall("read", { path: "README.md" })], { stopReason: "toolUse" }),
        ),
        join(root, "layout-polish-ui"),
    );
    server = createServer(createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    await app.setExtensionEnabled(owner(app), "projects.ts", true);
    await until(() => app.loader.extensionNames().includes("pocket-projects"), "the projects extension", 20_000);
    const projects = async (path: string, body: unknown) => {
        const answer = await fetch(`${base}/api/x/projects/${path}`, {
            method: "POST",
            headers: { authorization: `Bearer ${app.config.ownerToken}`, "x-pocket": "1", "content-type": "application/json" },
            body: JSON.stringify(body),
        });
        assert.ok(answer.ok, `${path}: ${answer.status} ${await answer.text()}`);
    };
    await projects("projects", { key: "PP", name: "pi-phone" });

    for (const [title, state] of [["Line icons instead of symbols", "in_progress"], ["Contrast and small text", "review"], ["Tap targets", "inbox"]] as const) {
        await projects("projects/PP/tasks", { title, state });
    }

    const id = await newSession(app);
    await say(app, id, "Check the layout of the main screens please");
    browsers = new Browsers({ dataDir: mkdtempSync(join(root, "layout-polish-")), load: async () => undefined, save: () => {} });
    const page = await browsers.open(1);
    await page.setViewport(VIEWPORTS.mobile);
    await page.navigate(`${base}/login?token=${encodeURIComponent(app.config.ownerToken)}`);
    await until(async () => (await page.evaluate(`return JSON.stringify(document.querySelector(".session-row") !== null)`)) === "true", "the session list", 20_000);
    const screens = [
        ["home", "/"],
        ["session", `/s/${id}`],
        ["dictation", "/?sheet=dictation"],
        ["machines", "/?sheet=machines"],
        ["board", "/?page=projects:projects"],
        ["more", `/s/${id}`],
    ] as const;

    for (const [palette, theme] of [["dark", "tokyo-night"], ["light", "catppuccin-latte"]] as const) {
        await page.evaluate(
            `localStorage.setItem("pocket.appearance", JSON.stringify({ ...JSON.parse(localStorage.getItem("pocket.appearance") || "{}"), theme: ${JSON.stringify(theme)} })); localStorage.removeItem("pocket.themeCache"); return "1";`,
        );

        for (const [screen, path] of screens) {
            for (const viewport of [VIEWPORTS.mobile, VIEWPORTS.desktop]) {
                await page.setViewport(viewport);
                await page.navigate(`${base}${path}`);
                await until(async () => (await page.evaluate(`return JSON.stringify(document.documentElement.dataset.mode === ${JSON.stringify(palette)} && document.readyState === "complete")`)) === "true", `${screen} in ${palette}`, 20_000);

                if (screen === "more") {
                    await until(async () => (await page.evaluate(`const more = [...document.querySelectorAll('[data-part="reply-actions"] button')].find((each) => each.textContent.trim() === "More"); more?.click(); return JSON.stringify(more !== undefined);`)) === "true", "the reply's More", 20_000);
                }

                // What loads late (the board's columns, fonts, a sheet's rise) settles before the check.
                await sleep(1500);
                const name = `${screen}-${palette}-${viewport.width}`;
                const report = parseLayout(JSON.parse(await page.evaluate(`return JSON.stringify(${layoutCheck(viewport.width)})`)), viewport.width);
                assert.ok(report, `${name}: the layout check gave a report`);
                reports.set(name, report);

                if (SHOTS !== undefined) {
                    mkdirSync(SHOTS, { recursive: true });
                    writeFileSync(join(SHOTS, `${name}.jpg`), Buffer.from((await page.screenshot()).data, "base64"));
                }
            }
        }
    }
});

/** What the check found of one kind, on every screen: `<screen>: <find>` lines. */
function found(kind: LayoutFind["kind"], keep: (find: LayoutFind) => boolean = () => true): string[] {
    return [...reports].flatMap(([name, report]) => report.found.filter((find) => find.kind === kind && keep(find)).map((find) => `${name}: ${JSON.stringify(find)}`));
}

test("the main screens were checked in both palettes at both widths", real, () => {
    assert.equal(reports.size, 24);
});

test("no emoji or symbol glyphs as icons on the main screens (PP-402)", real, () => {
    assert.deepEqual(found("emoji"), []);
});

/**
 * Hints, which the owner holds to 3:1 rather than 4.5:1 (PP-399): counts, times, keys, a task's ref, the quiet "Add a
 * task". Everything else is words, at 4.5:1.
 */
const HINTS = /^(?:span\.(?:sessions-count|session-time|search-keys|prompt-time|activity-time|pj-id|pj-count|pj-wip|pj-age)|kbd|button\.pj-add-row)\b/;

test("text reads on the main screens: hints at 3:1, words at 4.5:1, in both palettes (PP-399)", real, () => {
    assert.deepEqual(found("contrast", (find) => find.kind === "contrast" && (find.ratio < 3 || !HINTS.test(find.what))), []);
});

test("no text under 12 px on the main screens (PP-399)", real, () => {
    assert.deepEqual(found("small-text"), []);
});

test("every control on the main screens takes a 40 px tap at a phone's width (PP-400)", real, () => {
    assert.deepEqual(found("small-target"), []);
});

/** Blocks as tall as their words, which grow by their text's line height: a message, the message box, a task's card. */
const CONTENT = /^(?:div\.prompt|textarea|button\.pj-card)\b/;

test("padding, gaps, corners and control heights on the 4 px grid in whole pixels (PP-401)", real, () => {
    assert.deepEqual(
        found("off-grid", (find) => find.kind === "off-grid" && find.property !== "icon width" && !(find.property === "control height" && CONTENT.test(find.what))),
        [],
    );
});

test("icons on one scale with one stroke: 16 and 20 px on the main screens, stroke 2 (PP-403)", real, () => {
    const sizes = new Set([...reports.values()].flatMap((report) => report.summary?.icons ?? []));
    const strokes = new Set([...reports.values()].flatMap((report) => report.summary?.strokes ?? []));

    assert.deepEqual([...sizes].filter((size) => !["16x16", "20x20", "24x24"].includes(size)), []);
    assert.deepEqual([...strokes], ["2px"]);
    assert.deepEqual(found("off-grid", (find) => find.kind === "off-grid" && find.property === "icon width"), []);
});

test("no broken image, skipped heading level or card inside a card on the main screens (PP-415)", real, () => {
    assert.deepEqual([...found("broken-image"), ...found("skipped-heading"), ...found("nested-cards")], []);
});

/** A pulse is pi-phone's sign of a live or working state (unslop's pass, PP-328): the other tells are held to none. */
test("no side-tab stripe, glow, narrow justified text, tight leading or repeated words on the main screens (PP-415)", real, () => {
    assert.deepEqual([...found("side-tab"), ...found("glow"), ...found("justified"), ...found("tight-leading"), ...found("repeated-text")], []);
});

test("a tool call's icon is a line icon from ICONS, never a symbol (PP-402)", () => {
    const ui = readFileSync(new URL("../web/ui.js", import.meta.url), "utf8");
    const block = /const ICONS = \{([\s\S]*?)\n\};/.exec(ui)?.[1] ?? "";
    const names = new Set([...block.matchAll(/^\s{4}"?([\w-]+)"?:/gm)].map((match) => match[1]));
    const calls = readFileSync(new URL("../web/calls.js", import.meta.url), "utf8");
    const icons = [...calls.matchAll(/icon: "([^"]*)"/g)].map((match) => match[1]!);

    assert.ok(icons.length > 50, "calls.js names its calls' icons");
    assert.deepEqual(icons.filter((icon) => !names.has(icon)), [], "every icon is a name in ICONS");
});
