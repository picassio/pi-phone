// Settings › MCP servers in a real browser at 390, 1280 and 1920 px (PP-528): the list (a server running with its tools'
// count and secrets, one changed since it was approved, one off), Test connection's tools' count, the Add form, and
// the Import form. Nothing in the sheet runs past the screen, its text keeps its contrast and size, and its controls
// take a 40 px tap on a phone. With PHONE_SHOTS, screenshots and the layout check's report go there, the app without
// the sheet first (before).
import { type App, cleanUp, cleanUpAll, openApp, root, scriptedModel, work } from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { createHandler } from "../src/server/http.ts";
import { describeLayout, layoutCheck, parseLayout } from "../src/server/layout-check.ts";
import { Browsers } from "./support/browser.ts";
import { findBrowser } from "./support/browser/discovery.ts";
import type { BrowserPage } from "./support/browser/page.ts";
import { VIEWPORTS } from "./support/browser/viewport.ts";

const real = { skip: findBrowser() === undefined ? "no Chromium-based browser on this machine" : false } as const;
const SHOTS = process.env.PHONE_SHOTS;
const LARGE = { width: 1920, height: 1080, scale: 1, mobile: false };
const STUB = join(import.meta.dirname, "support", "mcp-stub.ts");

let app: App;
let server: Server;
let browsers: Browsers;
let page: BrowserPage;
let base = "";

async function until(check: () => Promise<boolean> | boolean, what: string, timeoutMs = 20_000): Promise<void> {
    const started = Date.now();

    while (!(await check())) {
        if (Date.now() - started > timeoutMs) {
            throw new Error(`Timed out waiting for ${what}`);
        }

        await new Promise((resolve) => setTimeout(resolve, 50));
    }
}

const inPage = async <T>(script: string): Promise<T> => JSON.parse(await page.evaluate(script)) as T;
const present = (selector: string, what: string) => until(() => inPage<boolean>(`return JSON.stringify(document.querySelector(${JSON.stringify(selector)}) !== null)`), what);
const clickText = (selector: string, label: string) =>
    page.evaluate(`[...document.querySelectorAll(${JSON.stringify(selector)})].find((each) => each.innerText.trim() === ${JSON.stringify(label)}).click(); return "true";`);
const sheetText = () => inPage<string>(`return JSON.stringify(document.querySelector(".sheet").innerText.trim().replace(/\\s+/g, " "))`);

before(async () => {
    if (real.skip) {
        return;
    }

    app = await openApp(scriptedModel(), join(root, "mcp-sheet-data"));
    app.secrets.set("GOPEAK_TOKEN", { value: "gopeak-token-0123456789" });
    app.mcpServers.save("gopeak", {
        command: process.execPath,
        args: [STUB],
        env: { GODOT_PATH: "~/.local/bin/godot", STUB_TOKEN: "${GOPEAK_TOKEN}" },
        folders: [work],
        description: "Godot 4 editor: scenes, nodes, scripts, run and screenshot",
    });
    app.mcpServers.save("docs", { url: "https://example.com/mcp", headers: { Authorization: "Bearer ${GOPEAK_TOKEN}" }, enabled: false });
    app.mcpServers.save("filesystem", { command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "/data/work/notes/and/a/long/folder/name/that/must/wrap"] });
    // filesystem changed outside the app: it reads, but does not run.
    const file = join(app.dataDir, "mcp", "servers.json");
    const stored = JSON.parse(readFileSync(file, "utf8")) as { mcpServers: Record<string, { args: string[] }> };

    stored.mcpServers.filesystem!.args.push("/tmp");
    writeFileSync(file, JSON.stringify(stored));
    await app.close();
    app = await openApp(scriptedModel(), join(root, "mcp-sheet-data"));
    await app.mcp.tools("gopeak", work);
    server = createServer(createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    browsers = new Browsers({ dataDir: mkdtempSync(join(root, "mcp-sheet-ui-")), load: async () => undefined, save: () => {} });
    page = await browsers.open(1);
    await page.setViewport(VIEWPORTS.mobile);
    await page.navigate(`${base}/login?token=${encodeURIComponent(app.config.ownerToken)}`);
});

after(() =>
    cleanUpAll(
        () => browsers?.closeAll({ final: true }),
        () => server?.closeAllConnections(),
        () => server?.close(),
        () => app?.close(),
        () => cleanUp(),
    ),
);

async function measure(name: string, width: number) {
    await new Promise((resolve) => setTimeout(resolve, 600));
    const report = parseLayout(JSON.parse(await page.evaluate(`return JSON.stringify(${layoutCheck(width)})`)), width);

    assert.ok(report !== undefined, "the layout check answered");

    if (SHOTS !== undefined) {
        mkdirSync(SHOTS, { recursive: true });
        writeFileSync(join(SHOTS, `${name}.jpg`), Buffer.from((await page.screenshot()).data, "base64"));
        writeFileSync(join(SHOTS, `${name}.layout.txt`), `${describeLayout(report)}\nRAW ${JSON.stringify(report.found)}\n`);
    }

    return report;
}

/** The kinds the ui-verify skill must bring to zero, of what is in the sheet. */
async function mustFix(report: Awaited<ReturnType<typeof measure>>) {
    const kinds = report.found.filter((each) => ["cut", "covered", "contrast", "small-text", "emoji", "small-target", "nested-cards", "spill"].includes(each.kind));
    const inSheet = await inPage<boolean[]>(
        `return JSON.stringify(${JSON.stringify(kinds.map((each) => each.what.split(" ")[0]))}.map((selector) => { try { return document.querySelector(".sheet").querySelector(selector) !== null; } catch { return true; } }))`,
    );

    return kinds.filter((_, index) => inSheet[index]);
}

for (const [viewport, label] of [[VIEWPORTS.mobile, "390"], [VIEWPORTS.desktop, "1280"], [LARGE, "1920"]] as const) {
    test(`at ${label} px: the servers, Test connection, the Add form and the Import form`, real, async () => {
        await page.setViewport(viewport);
        await page.navigate(`${base}/`);
        await measure(`mcp-sheet-before-${label}`, viewport.width);
        await page.navigate(`${base}/?sheet=mcp-servers`);
        await present('[data-mcp-server="gopeak"]', "the servers");

        const listed = await sheetText();

        assert.match(listed, /docs [^]*over HTTP · every folder · \$GOPEAK_TOKEN Off/);
        assert.match(listed, /filesystem [^]*Changed since you approved it: turn it on again to run it/);
        assert.match(listed, /gopeak Godot 4 editor: scenes, nodes, scripts, run and screenshot [^]*mcp-stub\.ts where the session works · [^ ]+work · 9 tools · \$GOPEAK_TOKEN/);
        assert.ok(!listed.includes("gopeak-token-0123456789"), "no secret's value");

        let report = await measure(`mcp-sheet-list-${label}`, viewport.width);

        assert.deepEqual(await mustFix(report), [], describeLayout(report));

        // Test connection: 9 tools.
        await page.evaluate(`[...document.querySelector('[data-mcp-server="gopeak"]').querySelectorAll("button")].find((each) => each.innerText.trim() === "Test").click(); return "true";`);
        await present('[data-mcp-server="gopeak"] .mcp-test input', "the folder to test in");
        await page.evaluate(`[...document.querySelector('[data-mcp-server="gopeak"] .mcp-test').querySelectorAll("button")].find((each) => each.innerText.trim() === "Test").click(); return "true";`);
        await present('[data-mcp-server="gopeak"] .mcp-tested', "the test's answer");
        assert.match(await inPage<string>(`return JSON.stringify(document.querySelector('[data-mcp-server="gopeak"] .mcp-tested').innerText)`), /^9 tools in \d+\.\d s$/);
        report = await measure(`mcp-sheet-tested-${label}`, viewport.width);
        assert.deepEqual(await mustFix(report), [], describeLayout(report));

        // The Add form, then the Import form.
        await clickText(".sheet button", "Add a server");
        await present(".sheet .mcp-form", "the form");
        report = await measure(`mcp-sheet-add-${label}`, viewport.width);
        assert.deepEqual(await mustFix(report), [], describeLayout(report));
        // A URL's form: its headers and where it is reached from (PP-529).
        await page.evaluate(`document.querySelector(".sheet .mcp-form .choice").click(); return "true";`);
        await present('.choice-menu [role="option"]', "the kinds");
        await page.evaluate(`[...document.querySelectorAll('.choice-menu [role="option"]')].find((each) => each.innerText.includes("A URL")).click(); return "true";`);
        await until(async () => (await sheetText()).includes("Reached from"), "the URL's form");
        report = await measure(`mcp-sheet-add-http-${label}`, viewport.width);
        assert.deepEqual(await mustFix(report), [], describeLayout(report));
        await clickText(".sheet .mcp-form button", "Cancel");
        await clickText(".sheet button", "Import JSON");
        await present(".sheet .mcp-import", "the import form");
        report = await measure(`mcp-sheet-import-${label}`, viewport.width);
        assert.deepEqual(await mustFix(report), [], describeLayout(report));
        await clickText(".sheet .mcp-import button", "Cancel");
    });
}
