// extension_inspect (PP-368, the Extension builder extension): a read-only tool, allowed in plan mode, that tells Pi
// the drop-in API's names as the app's own files have them (the kinds a browser part adds, pocket's members, the icons,
// the theme's CSS variables) and the names a drop-in may not take; and, for one module, how it stands: refused and why,
// failed to load and why, what it added, and what tabs reported of its browser part (POST /api/extensions/
// browser-reports: what it added once it loaded, its newest failure, kept only about the version served now). Never a
// file's contents. (test/extension-builder-ui.test.ts has a real tab report.)
import { type App, cleanUp, context, lastText, modelTexts, newSession, openApp, owner, root, scriptedModel } from "./helpers.ts";
import assert from "node:assert/strict";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { APP_ROOT } from "../src/server/config.ts";
import { DEFERRED_TOOLS } from "../src/server/deferred-tools.ts";
import { BUILDER_TEMPLATES } from "../src/server/extension-builder.ts";
import { dropInApi } from "../src/server/extension-inspect.ts";
import { blockedInPlanMode } from "../src/server/extensions/plan.ts";
import { createHandler } from "../src/server/http.ts";
import { BUILT_IN_TOOLS } from "../src/server/reload.ts";

const dataDir = join(root, "inspect-data");
const dropIns = join(dataDir, "extensions");

test("extension_inspect only reads: plan mode lets it run, and it is a built-in tool name that loads with tool_search", () => {
    assert.equal(blockedInPlanMode("extension_inspect", {}), undefined);
    assert.equal(blockedInPlanMode("extension_inspect", { name: "checklist" }), undefined);
    assert.match(blockedInPlanMode("extension_install", { path: "x" }) ?? "", /Plan mode is on/);
    assert.ok(BUILT_IN_TOOLS.has("extension_inspect"));
    assert.ok(DEFERRED_TOOLS.includes("extension_inspect"));
});

test("the drop-in API's names come from the app's own files", () => {
    const { kinds, members, icons, variables, themeTokens } = dropInApi();

    // The five places of PP-371 among them.
    assert.deepEqual(kinds, ["rail", "menu", "launcher", "page", "sheet", "dock", "overlay", "panelTab", "sessionMenu"]);
    // Every member pocketFor gives, in its order, MultiChoice (PP-367) and the places' (PP-371) among them.
    assert.deepEqual(members, [
        "version", "module", "title", "h", "html", "Fragment", "useState", "useEffect", "useLayoutEffect", "useRef", "useMemo", "useCallback", "useReducer",
        "Icon", "Spinner", "Loader", "Markdown", "Switch", "Choice", "MultiChoice", "StateTag", "t", "tn", "tx", "language", "me", "conversationId",
        "api", "on", "notify", "compose", "rail", "menu", "launcher", "page", "sheet", "dock", "overlay", "panelTab", "sessionMenu", "theme",
        "pickFolder", "toolCall", "openPage", "openPageOf", "closePage", "openSheet", "closeSheet", "style", "onDispose",
    ]);
    // pocket.theme's tokens are colours of the app's :root, the palette's among them; sizes and fonts are not.
    assert.ok(themeTokens.length > 50 && themeTokens.includes("--o-bg") && themeTokens.includes("--accent"), themeTokens.join(", "));
    assert.deepEqual(themeTokens.filter((name) => !variables.includes(name)), []);
    assert.ok(!["--r-card", "--sans", "--mono", "--space-y", "--shadow"].some((name) => themeTokens.includes(name)));
    assert.ok(icons.length > 50 && icons.includes("check") && icons.includes("clock") && icons.includes("wheel"), icons.join(", "));

    const style = readFileSync(join(APP_ROOT, "web", "style.css"), "utf8");

    assert.ok(variables.length > 80);

    for (const name of ["--o-bg", "--text", "--muted", "--accent", "--ok", "--err", "--r-card", "--sans", "--mono", "--ligatures"]) {
        assert.ok(variables.includes(name), name);
    }

    for (const name of variables) {
        assert.match(style, new RegExp(`\\n {4}${name}:`), name);
    }
});

// ---- In the app ---------------------------------------------------------------------------------------------------

const asks: Record<string, Record<string, unknown>> = {
    "inspect all": {},
    "inspect clash": { name: "clash" },
    "inspect broken": { name: "broken.ts" },
    "inspect checklist": { name: "checklist" },
    "inspect nothing": { name: "nothing-here" },
};
const route: FauxResponseStep = (request) => {
    const { role, text } = lastText(request as never);

    for (const [ask, args] of Object.entries(asks)) {
        if (role === "user" && text.endsWith(ask)) {
            return fauxAssistantMessage([fauxToolCall("extension_inspect", args as never)], { stopReason: "toolUse" });
        }
    }

    return fauxAssistantMessage([fauxText(role === "toolResult" ? `told: ${text}` : "ok")]);
};
let app: App;
let server: Server;
let base = "";

before(async () => {
    mkdirSync(dropIns, { recursive: true });
    cpSync(join(BUILDER_TEMPLATES, "checklist"), dropIns, { recursive: true });
    // A tool with a built-in tool's name: refused whole.
    writeFileSync(
        join(dropIns, "clash.ts"),
        `/** Clash: a tool named like a built-in one. */
import { obj } from "@earendil-works/pi-schema";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";

export default () => defineExtension({ name: "clash", tools: [defineTool({ name: "bash", description: "No.", parameters: obj({}), execute: async () => ({ output: [] }) })] });
`,
    );
    // One that throws while it loads, with a secret-looking line in its file that must never be shown.
    writeFileSync(join(dropIns, "broken.ts"), `/** Broken: it throws while it loads. */\nconst KEEP_OUT = "file-contents-stay-here";\nexport default () => {\n    throw new Error("broken on purpose " + KEEP_OUT.length);\n};\n`);

    app = await openApp(scriptedModel(route), dataDir);
    server = createServer(createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    await assert.rejects(app.setExtensionEnabled(owner(app), "clash.ts", true), /refused/);
    await assert.rejects(app.setExtensionEnabled(owner(app), "broken.ts", true), /broken on purpose/);
    await app.setExtensionEnabled(owner(app), "checklist.ts", true);
});

after(async () => {
    server?.closeAllConnections();
    server?.close();
    await app?.close();
    cleanUp();
});

async function told(id: number, text: string): Promise<string> {
    const { submissionId } = await app.commands.submit(id as never, owner(app), { text, requestId: crypto.randomUUID() });

    await (await app.harness.submission(submissionId, context))!.wait(context);
    await app.harness.waitForIdle(context);

    // The answer's text parts, as the model gave them.
    return (JSON.parse((await modelTexts(app, id as never)).at(-1)!) as { text: string }[]).map((part) => part.text).join("");
}

const report = (body: unknown) =>
    fetch(`${base}/api/extensions/browser-reports`, {
        method: "POST",
        headers: { authorization: `Bearer ${app.config.ownerToken}`, "x-pocket": "1", "content-type": "application/json" },
        body: JSON.stringify(body),
    }).then(async (response) => ({ status: response.status, body: (await response.json()) as { kept?: boolean; error?: string } }));

test("without a name: the API's names, the names a drop-in may not take, and each drop-in's state", async () => {
    const text = await told(await newSession(app), "please inspect all");

    assert.match(text, /- A browser part adds, each with pocket\.<kind>\(spec\): rail, menu, launcher, page, sheet, dock, overlay, panelTab, sessionMenu\./);
    assert.match(text, /- pocket's members: version, module, title, h, html, [^\n]*MultiChoice, StateTag[^\n]*onDispose\./);
    assert.match(text, /- Icons \(pocket\.Icon's name, a spec's icon\): menu, pip, [^\n]*check/);
    assert.match(text, /- The theme's CSS variables [^\n]*--text[^\n]*--accent/);
    assert.match(text, /- Tools \(built-in; a drop-in with one is refused whole\): [^\n]*\bbash\b[^\n]*\bextension_inspect\b/);
    assert.match(text, /- Module files \(a drop-in named like one is never loaded\): [^\n]*extension-builder\.ts/);
    assert.match(text, /- Tools other drop-ins have now: checklist_list \(checklist\.ts\), checklist_change \(checklist\.ts\)\./);
    assert.match(text, /- broken\.ts: on, failed to load\n/);
    assert.match(text, /- checklist\.ts: on, loaded\n/);
    assert.match(text, /- clash\.ts: on, refused\n/);
});

test("a refused drop-in: why, from the loader", async () => {
    const text = await told(await newSession(app), "please inspect clash");

    assert.match(text, /clash\.ts: a drop-in at .*clash\.ts\n/);
    assert.match(text, /State: on, refused: its tools bash have built-in tools' names, and the built-in ones win: rename them in the module/);
    assert.match(text, /Files \(names only\): clash\.ts \(\d+ B\)/);
    assert.match(text, /Added: nothing \(not loaded\)/);
});

test("a drop-in that fails to load: its error, and its files by name only", async () => {
    const text = await told(await newSession(app), "please inspect broken");

    assert.match(text, /State: on, failed to load: broken on purpose 23/);
    assert.match(text, /Files \(names only\): broken\.ts \(\d+ B\)/);
    assert.doesNotMatch(text, /file-contents-stay-here/);
});

test("a module there is not: the drop-ins there are", async () => {
    assert.match(await told(await newSession(app), "please inspect nothing"), /told: There is no extension module nothing-here\.ts\. Drop-ins: broken\.ts, checklist\.ts, clash\.ts\./);
});

test("what tabs report of a browser part: what it added once loaded, and its newest error, about the version served now", async () => {
    const id = await newSession(app);
    const url = app.webs.clients(owner(app)).find((each) => each.module === "checklist")!.url;
    let text = await told(id, "please inspect checklist");

    assert.match(text, /State: on, loaded/);
    assert.match(text, /Files \(names only\): checklist\.ts \([\d.]+ KB\), checklist\/checklist\.css \(\d+ B\), checklist\/index\.js \([\d.]+ KB\)/);
    assert.match(text, /- extension checklist: tools checklist_list \(read-only\), checklist_change\n/);
    assert.match(text, /- routes \(under \/api\/x\/checklist\/\): GET items, POST items, POST items\/:id, DELETE items\/:id/);
    assert.match(text, /- a browser part, for the owner/);
    assert.match(text, /- no tab has loaded this version yet/);
    assert.match(text, /- no failure reported/);

    // A tab says it loaded, and what it added; another, that its page failed to draw.
    assert.deepEqual(await report({ module: "checklist", url, state: "ready", adds: { rail: ["checklist"], page: ["checklist"], sheet: [], bogus: ["x"], menu: ["../no", 3] } }), { status: 200, body: { kept: true } });
    assert.deepEqual(await report({ module: "checklist", url, state: "failed", how: "failed to draw", error: "Checklist: boom" }), { status: 200, body: { kept: true } });
    // About another version (a tab not reloaded yet): dropped.
    assert.deepEqual(await report({ module: "checklist", url: "/x/checklist/old/index.js", state: "failed", how: "failed to load", error: "old" }), { status: 200, body: { kept: false } });
    // Not a report, or no such browser part.
    assert.equal((await report({ module: "checklist", url, state: "failed", how: "exploded", error: "x" })).status, 400);
    assert.equal((await report({ module: "clash", url, state: "ready", adds: {} })).status, 404);

    text = await told(id, "please inspect checklist");
    assert.match(text, /- loaded in [^\n]+'s tab at 20\d\d-[^\n]+Z: added rail checklist; page checklist\n/);
    assert.match(text, /- failed to draw in [^\n]+'s tab at [^\n]+Z: Checklist: boom\n/);
    assert.match(text, /- to look at: http:\/\/127\.0\.0\.1:8787\/\?page=checklist:checklist/);
    assert.doesNotMatch(text, /\/old\/|bogus|\.\.\/no/);

    // A new version of its browser part: what tabs said of the old one no longer counts.
    writeFileSync(join(dropIns, "checklist", "index.js"), `${readFileSync(join(dropIns, "checklist", "index.js"), "utf8")}\n// edited\n`);
    await app.reloadExtension("checklist.ts");
    assert.notEqual(app.webs.clients(owner(app)).find((each) => each.module === "checklist")!.url, url);
    assert.match(await told(id, "please inspect checklist"), /- no tab has loaded this version yet[^]*- no failure reported/);
});

test("what a tab says of the shared places (PP-371): whose dock waits, whose colours show; only browser parts served now", async () => {
    const id = await newSession(app);

    assert.deepEqual(
        await report({ state: "places", docks: ["nobody"], hiddenDocks: ["checklist", "clash"], theme: { "--accent": ["checklist"], "--bg": ["clash"], "bad token": ["checklist"] } }),
        { status: 200, body: { kept: true } },
    );
    assert.deepEqual({ ...app.webs.places(), at: 0 }, { docks: [], hiddenDocks: ["checklist"], theme: { "--accent": ["checklist"] }, by: owner(app).name, at: 0 });

    const all = await told(id, "please inspect all");

    assert.match(all, /- docks above the message box \(at most two show, the newest loaded\): none; checklist wait/);
    assert.match(all, /- colours \(pocket\.theme; the newest loaded wins\): --accent checklist/);
    assert.match(all, /- The colour tokens pocket\.theme may set \(while the module is on; the newest loaded wins\): --o-bg, [^\n]*--accent/);

    const one = await told(id, "please inspect checklist");

    assert.match(one, /In the shared places \([^\n]+'s tab at [^\n]+Z\):\n- its dock waits: only two modules' docks show at once, the newest loaded \(\)\n- its colours show: --accent/);
});

test("in plan mode, it still runs", async () => {
    const id = await newSession(app);

    await app.commands.setPlan(id, owner(app), true);
    assert.match(await told(id, "please inspect all"), /told: The drop-in API/);
});
