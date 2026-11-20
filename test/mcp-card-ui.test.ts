// mcp_server_set's card (PP-527) in a real browser at 390, 1280 and 1920 px: a new server's card shows the whole entry,
// where it runs, its folders and secrets, and warns of a package without a pinned version; a change's card shows the
// diff and the whole entry a tap away; Approve (named for what it does) answers it. Nothing in it runs past the screen,
// its text keeps its contrast and size, and its controls take a 40 px tap on a phone. With PHONE_SHOTS, screenshots and
// the layout check's report go there, the session without a card first (before).
import { type App, cleanUp, cleanUpAll, context, newSession, openApp, owner, root, scriptedModel } from "./helpers.ts";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai/providers/faux";
import type { ConversationId } from "@earendil-works/pi-durable";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { generateUnifiedPatch } from "@earendil-works/pi-coding-agent";
import type { ApprovalAnswer } from "../src/server/host.ts";
import { createHandler } from "../src/server/http.ts";
import { describeLayout, layoutCheck, parseLayout } from "../src/server/layout-check.ts";
import type { McpServerForm } from "../src/server/mcp/admin.ts";
import { Browsers } from "./support/browser.ts";
import { findBrowser } from "./support/browser/discovery.ts";
import type { BrowserPage } from "./support/browser/page.ts";
import { VIEWPORTS } from "./support/browser/viewport.ts";

const real = { skip: findBrowser() === undefined ? "no Chromium-based browser on this machine" : false } as const;
const SHOTS = process.env.PHONE_SHOTS;
const LARGE = { width: 1920, height: 1080, scale: 1, mobile: false };
const OLD = JSON.stringify({ gopeak: { command: "npx", args: ["-y", "gopeak"], env: { GODOT_PATH: "~/.local/bin/godot" }, folders: ["machine:034d952b-1c3a-4f0e-9d2a-7a1b2c3d4e5f:/home/ubuntu/games/dao-sao-godot"] } }, null, 4);
const NEW = JSON.stringify(
    {
        gopeak: {
            command: "xvfb-run",
            args: ["-a", "-s", "-screen 0 1280x800x24", "npx", "-y", "gopeak@2.3.8"],
            env: { GODOT_PATH: "~/.local/bin/godot", GOPEAK_TOOL_PROFILE: "compact", GOPEAK_TOKEN: "${GOPEAK_TOKEN}" },
            folders: ["machine:034d952b-1c3a-4f0e-9d2a-7a1b2c3d4e5f:/home/ubuntu/games/dao-sao-godot"],
            description: "Godot 4 editor: scenes, nodes, scripts, run and screenshot",
        },
    },
    null,
    4,
);
const FORMS: Record<string, McpServerForm> = {
    new: {
        type: "mcp-server",
        action: "save",
        name: "gopeak",
        entry: OLD,
        runs: "where the session works",
        folders: ["machine:034d952b-1c3a-4f0e-9d2a-7a1b2c3d4e5f:/home/ubuntu/games/dao-sao-godot"],
        secrets: [],
        unpinned: "gopeak",
    },
    edit: {
        type: "mcp-server",
        action: "save",
        name: "gopeak",
        entry: NEW,
        diff: generateUnifiedPatch("gopeak.json", OLD, NEW, 3),
        runs: "where the session works",
        folders: ["machine:034d952b-1c3a-4f0e-9d2a-7a1b2c3d4e5f:/home/ubuntu/games/dao-sao-godot"],
        secrets: ["GOPEAK_TOKEN"],
    },
};

let app: App;
let server: Server;
let browsers: Browsers;
let page: BrowserPage;
let base = "";
let session: ConversationId;
let cards = 0;

before(async () => {
    if (real.skip) {
        return;
    }

    app = await openApp(scriptedModel(() => fauxAssistantMessage([fauxText("ok")])));
    server = createServer(createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    browsers = new Browsers({ dataDir: mkdtempSync(join(root, "mcp-card-ui-")), load: async () => undefined, save: () => {} });
    page = await browsers.open(1);
    await page.setViewport(VIEWPORTS.mobile);
    await page.navigate(`${base}/login?token=${encodeURIComponent(app.config.ownerToken)}`);
    session = await newSession(app);
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

function ask(which: keyof typeof FORMS): Promise<ApprovalAnswer> {
    cards += 1;

    return app.approvals.request(
        {
            id: `mcp-ui-${cards}`,
            conversationId: session,
            taskId: cards as never,
            callId: `call-${cards}`,
            tool: "mcp_server_set",
            subject: FORMS[which]!.entry,
            reason: `${which} the MCP server gopeak`,
            form: FORMS[which]!,
            createdAt: Date.now(),
        },
        context,
    );
}

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

/** The kinds the ui-verify skill must bring to zero, of what is in the card. */
async function mustFix(report: Awaited<ReturnType<typeof measure>>) {
    const kinds = report.found.filter((each) => ["cut", "covered", "contrast", "small-text", "emoji", "small-target", "nested-cards"].includes(each.kind));
    const inCard = await inPage<boolean[]>(
        `return JSON.stringify(${JSON.stringify(kinds.map((each) => each.what.split(" ")[0]))}.map((selector) => { try { return document.querySelector("[data-mcp]").querySelector(selector) !== null; } catch { return true; } }))`,
    );

    return kinds.filter((_, index) => inCard[index]);
}

const text = () => inPage<string>(`return JSON.stringify(document.querySelector("[data-mcp]").innerText.trim().replace(/\\s+/g, " "))`);
const click = (label: string) => page.evaluate(`[...document.querySelectorAll("[data-mcp] button")].find((each) => each.innerText.trim() === ${JSON.stringify(label)}).click(); return "true";`);
const gone = () => until(async () => !(await inPage<boolean>(`return JSON.stringify(document.querySelector("[data-mcp]") !== null)`)), "the card to go");

for (const [viewport, label] of [[VIEWPORTS.mobile, "390"], [VIEWPORTS.desktop, "1280"], [LARGE, "1920"]] as const) {
    test(`at ${label} px: a new server's card shows the whole entry and warns of an unpinned package; a change's shows the diff, the whole entry a tap away; Add answers it`, real, async () => {
        await page.setViewport(viewport);
        await page.navigate(`${base}/s/${Number(session)}`);
        await measure(`mcp-card-before-${label}`, viewport.width);

        const fresh = ask("new");

        await page.navigate(`${base}/s/${Number(session)}`);
        await present("[data-mcp]", "the card");
        assert.match(await text(), /^Add the MCP server gopeak\? It runs this command as you, where it says, for sessions in these folders\. Nothing runs until you approve\. Runs where the session works Folders machine:[^ ]+dao-sao-godot Secrets None gopeak names no version[^]*"gopeak": \{[^]*Deny Add$/);
        assert.deepEqual(await mustFix(await measure(`mcp-card-new-${label}`, viewport.width)), []);
        await click("Add");
        assert.deepEqual(await fresh, { allow: true, by: owner(app).name });
        await gone();

        const edit = ask("edit");

        await page.navigate(`${base}/s/${Number(session)}`);
        await present("[data-mcp] .dv-block", "the change's diff");
        assert.match(await text(), /^Change the MCP server gopeak\?[^]*Secrets GOPEAK_TOKEN [^]*Whole entry after the change Deny Change$/);

        const report = await measure(`mcp-card-edit-${label}`, viewport.width);

        assert.deepEqual(await mustFix(report), [], describeLayout(report));
        await page.evaluate(`document.querySelector("[data-mcp] .library-whole-toggle").click(); return "true";`);
        await present("[data-mcp] .library-whole pre", "the whole entry");
        assert.deepEqual(await mustFix(await measure(`mcp-card-edit-open-${label}`, viewport.width)), []);
        await click("Deny");
        assert.equal((await edit).allow, false);
        await gone();
    });
}
