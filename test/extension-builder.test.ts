// Extension builder (PP-367; the owner's decision of 2026-11-03 after research PP-365): a built-in extension, on by
// default, whose extension-builder skill (adapted in part from DeepSeek Harness's cordis-plugin-development, MIT)
// teaches Pi to make a drop-in. Its skill is listed while it is on and gone while it is off; setting_change switches
// it. Its four templates are real drop-ins: each is a package extension_install takes, passes the skill's check, and
// loads in the app without being refused, with what it says it adds; their browser parts register with `pocket` as the
// app gives it. (test/extension-builder-ui.test.ts draws them in a real browser.)
import { type App, cleanUp, context, lastText, modelTexts, newSession, openApp, owner, root, scriptedModel, until } from "./helpers.ts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { pathToFileURL } from "node:url";
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { APP_ROOT } from "../src/server/config.ts";
import { packageFromPath } from "../src/server/drop-in-install.ts";
import { BUILDER_MODULE, BUILDER_SKILL, BUILDER_TEMPLATES } from "../src/server/extension-builder.ts";
import { createHandler } from "../src/server/http.ts";

/** Each template: its files, and what it adds once on. */
const TEMPLATES = {
    "zone-time": { files: ["zone-time.ts"], tools: ["zone_time"], readOnly: ["zone_time"], routes: [], client: false, browser: undefined },
    "focus-timer": { files: ["focus-timer.js", "focus-timer.ts"], tools: [], readOnly: [], routes: [], client: true, browser: "focus-timer.js" },
    snippets: { files: ["snippets.js", "snippets.ts"], tools: [], readOnly: [], routes: [], client: true, browser: "snippets.js" },
    checklist: {
        files: ["checklist/checklist.css", "checklist/index.js", "checklist.ts"],
        tools: ["checklist_list", "checklist_change"],
        readOnly: ["checklist_list"],
        routes: ["GET items", "POST items", "POST items/:id", "DELETE items/:id"],
        client: true,
        browser: "checklist/index.js",
    },
} as const;
const NAMES = Object.keys(TEMPLATES) as (keyof typeof TEMPLATES)[];
const CHECK = join(BUILDER_SKILL, "scripts", "check.mjs");

const check = (folder: string) => spawnSync(process.execPath, [CHECK, folder], { encoding: "utf8" });

// ---- The skill's files ---------------------------------------------------------------------------------------------

test("the skill is small, names only files it has, and keeps DeepSeek Harness's MIT licence with what was adapted", () => {
    const markdown = readFileSync(join(BUILDER_SKILL, "SKILL.md"), "utf8");
    const notice = join(APP_ROOT, "third_party", "deepseek-harness");

    assert.ok(Buffer.byteLength(markdown) < 8 * 1024, `SKILL.md is ${Buffer.byteLength(markdown)} bytes`);
    assert.match(markdown, /^---\nname: extension-builder\ndescription: "Make a pi-phone drop-in extension from a request[^\n]*"\n---\n/);

    for (const [, path] of markdown.matchAll(/`((?:references|scripts)\/[a-z-]+\.(?:md|mjs)|[a-z-]+\/[a-z-]+(?:\/[a-z-]+)*\.(?:ts|js|css))`/g)) {
        const where = path!.startsWith("references/") || path!.startsWith("scripts/") ? join(BUILDER_SKILL, path!) : join(BUILDER_TEMPLATES, path!);

        assert.ok(existsSync(where), `SKILL.md names ${path}, which is not there`);
    }

    assert.deepEqual(readdirSync(BUILDER_TEMPLATES).sort(), [...NAMES].sort());
    assert.match(readFileSync(join(notice, "LICENSE"), "utf8"), /^MIT License\n\nCopyright \(c\) 2026 DeepSeek\n/);
    assert.match(readFileSync(join(notice, "README.md"), "utf8"), /ce7073d51254c26cd63b22a60835b8f948deb447[^]*cordis-plugin-development[^]*references\/practices\.md/);

    for (const file of ["practices.md", "verify.md"]) {
        assert.match(readFileSync(join(BUILDER_SKILL, "references", file), "utf8"), /DeepSeek Harness[^]*MIT,\s+Copyright \(c\) 2026 DeepSeek/, file);
    }

    // The icons the reference lists are the app's.
    const icons = new Set([...readFileSync(join(APP_ROOT, "web", "ui.js"), "utf8").matchAll(/^ {4}([a-z0-9]+):/gm)].map((match) => match[1]));
    const listed = /The names: ([^.]+)\./.exec(readFileSync(join(BUILDER_SKILL, "references", "browser-part.md"), "utf8").replace(/\s+/g, " "))![1]!.split(", ");

    assert.ok(listed.length > 50);
    assert.deepEqual(listed.filter((name) => !icons.has(name)), []);
});

test("each template is a package extension_install takes whole, and passes the skill's check", () => {
    for (const name of NAMES) {
        const pkg = packageFromPath(join(BUILDER_TEMPLATES, name));

        assert.equal(pkg.module, `${name}.ts`);
        assert.deepEqual(pkg.leftOut, [], name);
        assert.deepEqual(pkg.files.map((file) => file.path).sort(), [...TEMPLATES[name].files].sort(), name);

        const run = check(join(BUILDER_TEMPLATES, name));

        assert.equal(run.status, 0, `${name}: ${run.stdout}${run.stderr}`);
        assert.match(run.stdout, /^ok: /m);
        assert.doesNotMatch(run.stdout, /^(problem|note):/m, name);
    }
});

test("the check refuses what pi-phone cannot run or the owner's rules forbid, each said", () => {
    const folder = join(mkdtempSync(join(root, "builder-bad-")), "bad");

    mkdirSync(folder);
    writeFileSync(
        join(folder, "bad.ts"),
        'import { defineTool } from "@earendil-works/pi-durable";\nenum Kind { A }\nconst tool = defineTool({ name: "bash", description: "" } as never);\nexport default function create(host: any) { return [tool, Kind, host]; }\n',
    );
    writeFileSync(join(folder, "bad.js"), 'export default (pocket) => pocket.html`<select><option>\u2713 ok</option></select><${pocket.Icon} name="rocket" /><b style="width:10.5px">x</b>`;\n');

    let run = check(folder);

    assert.equal(run.status, 1);
    assert.match(run.stdout, /problem: bad\.ts: TypeScript enum is not supported in strip-only mode/);
    assert.match(run.stdout, /problem: bad\.js: a system <select>/);
    assert.match(run.stdout, /problem: bad\.js: the icon rocket is not one of the app's/);
    assert.match(run.stdout, /problem: bad\.js: an emoji or dingbat/);
    assert.match(run.stdout, /problem: bad\.js: a size in part pixels/);

    // Past the enum, the rest of the module is read.
    writeFileSync(join(folder, "bad.ts"), 'import { defineTool } from "@earendil-works/pi-durable";\nconst tool = defineTool({ name: "bash", description: "" } as never);\nexport default function create(host: any) { return [tool, host]; }\n');
    run = check(folder);
    assert.match(run.stdout, /problem: bad\.ts: uses the type any/);
    assert.match(run.stdout, /problem: bad\.ts: the tool bash has a built-in tool's name/);
    assert.match(run.stdout, /note: bad\.ts: no "export const pocketApi = 2"/);
});

// ---- The browser parts, with `pocket` as the app gives it -----------------------------------------------------------

/** `pocket`'s members, as web/extension-ui.js gives them to a browser part. */
const MEMBERS = [
    "version", "module", "title", "h", "html", "Fragment", "useState", "useEffect", "useLayoutEffect", "useRef", "useMemo", "useCallback", "useReducer",
    "Icon", "Spinner", "Loader", "Markdown", "Switch", "Choice", "MultiChoice", "StateTag", "t", "tn", "tx", "language", "me", "conversationId",
    "api", "on", "notify", "compose", "rail", "menu", "launcher", "page", "sheet", "pickFolder", "toolCall", "openPage", "openPageOf", "closePage",
    "openSheet", "closeSheet", "style", "onDispose",
];

test("each template's browser part adds what it says with pocket's own members, and every button leads to its own page or sheet", async () => {
    const ui = readFileSync(join(APP_ROOT, "web", "extension-ui.js"), "utf8");

    for (const member of MEMBERS) {
        assert.match(ui, new RegExp(`\\n {8}${member}[,:(]`), `pocket.${member} is the app's`);
    }

    const icons = new Set([...readFileSync(join(APP_ROOT, "web", "ui.js"), "utf8").matchAll(/^ {4}([a-z0-9]+):/gm)].map((match) => match[1]));

    /** What a browser part adds, and the members it used, in a language. */
    async function load(name: keyof typeof TEMPLATES, entry: string, language: string) {
        const added: Record<string, Record<string, Record<string, unknown>>> = { rail: {}, menu: {}, launcher: {}, page: {}, sheet: {} };
        const used: string[] = [];
        const handle = { update: () => {}, remove: () => {} };
        const given: Record<string, unknown> = {
            version: 2,
            module: name,
            title: name,
            html: () => null,
            t: (text: string, vars?: Record<string, unknown>) => text.replace(/\{(\w+)\}/g, (_, key: string) => String(vars?.[key] ?? `{${key}}`)),
            language: () => language,
            api: () => Promise.resolve({ items: [] }),
            on: () => () => {},
            toolCall: (spec: { tool: string }) => {
                assert.ok((TEMPLATES[name].tools as readonly string[]).includes(spec.tool), `${name} describes ${spec.tool}, which is not its own`);

                return handle;
            },
            ...Object.fromEntries(
                Object.keys(added).map((kind) => [
                    kind,
                    (spec: Record<string, unknown>) => {
                        assert.match(String(spec.id), /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/);
                        added[kind]![String(spec.id)] = spec;

                        return handle;
                    },
                ]),
            ),
        };
        const pocket = new Proxy(given, {
            get(target, member) {
                assert.ok(typeof member !== "string" || MEMBERS.includes(member), `${name} uses pocket.${String(member)}, which the app does not give`);
                used.push(String(member));

                return member in target ? target[member as string] : () => handle;
            },
        });
        const loaded = (await import(pathToFileURL(join(BUILDER_TEMPLATES, name, entry)).href)) as { pocketApi: number; default: (pocket: unknown) => unknown };

        assert.equal(loaded.pocketApi, 2, name);
        await loaded.default(pocket);

        return { added, used };
    }

    for (const name of NAMES) {
        const entry = TEMPLATES[name].browser;

        if (entry === undefined) {
            continue;
        }

        const { added, used } = await load(name, entry, "en");
        const shown = [...Object.values(added.rail!), ...Object.values(added.menu!), ...Object.values(added.launcher!)];

        assert.ok(shown.length > 0 && Object.keys({ ...added.page, ...added.sheet }).length > 0, `${name} adds a way in and a page or sheet`);

        for (const spec of shown) {
            const target = spec.page === undefined ? added.sheet![String(spec.sheet)] : added.page![String(spec.page)];

            assert.ok(target !== undefined, `${name}: ${String(spec.id)} leads to a page or sheet it has`);
            assert.ok(spec.icon === undefined || icons.has(String(spec.icon)), `${name}: the icon ${String(spec.icon)}`);
        }

        for (const spec of [...Object.values(added.page!), ...Object.values(added.sheet!)]) {
            assert.equal(typeof spec.component, "function");
        }

        assert.ok(used.includes("onDispose") || name !== "focus-timer", "the timer stops when the module goes");

        // Its own words, through t(), in the app's other languages.
        for (const language of ["vi", "zh-CN"]) {
            const other = (await load(name, entry, language)).added;

            for (const kind of Object.keys(added)) {
                for (const [id, spec] of Object.entries(added[kind]!)) {
                    for (const field of ["title", "label", "hint"]) {
                        if (typeof spec[field] === "string") {
                            assert.notEqual(other[kind]![id]![field], spec[field], `${name}: ${kind} ${id}'s ${field} in ${language}`);
                        }
                    }
                }
            }
        }
    }
});

// ---- In the app ---------------------------------------------------------------------------------------------------

const dataDir = join(root, "builder-data");
const calls: Record<string, [string, Record<string, unknown>]> = {
    "builder off": ["setting_change", { id: "extensions.extension-builder.ts", value: "off", reason: "Not needed" }],
    "builder on": ["setting_change", { id: "extensions.extension-builder.ts", value: "on", reason: "Back" }],
    "time in saigon": ["zone_time", { zone: "Asia/Saigon" }],
    "add milk": ["checklist_change", { action: "add", text: "Buy milk" }],
    "read the list": ["checklist_list", {}],
};
let prompt = "";
const route: FauxResponseStep = (request) => {
    const { role, text } = lastText(request as never);

    prompt = JSON.stringify((request.messages as { role: string; sections?: Record<string, string> }[]).filter((message) => message.role === "system").map((message) => message.sections ?? {}));

    for (const [ask, [tool, args]] of Object.entries(calls)) {
        if (role === "user" && text.endsWith(ask)) {
            return fauxAssistantMessage([fauxToolCall(tool, args as never)], { stopReason: "toolUse" });
        }
    }

    return fauxAssistantMessage([fauxText(role === "toolResult" ? `told: ${text}` : "ok")]);
};
let app: App;
let server: Server;
let base = "";

before(async () => {
    // As extension_install puts them: each template's files in the drop-in folder.
    for (const name of NAMES) {
        cpSync(join(BUILDER_TEMPLATES, name), join(dataDir, "extensions"), { recursive: true });
    }

    app = await openApp(scriptedModel(route), dataDir);
    server = createServer(createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
    server?.closeAllConnections();
    server?.close();
    await app?.close();
    cleanUp();
});

async function turn(id: number, text: string, answer?: boolean): Promise<string> {
    const { submissionId } = await app.commands.submit(id as never, owner(app), { text, requestId: crypto.randomUUID() });

    if (answer !== undefined) {
        await until(() => app.approvals.forConversation(id as never).length > 0, "the card");
        await app.answerApproval(app.approvals.forConversation(id as never)[0]!.id, answer, owner(app));
    }

    await (await app.harness.submission(submissionId, context))!.wait(context);
    await app.harness.waitForIdle(context);

    return (await modelTexts(app, id as never)).at(-1)!;
}

test("Extension builder is on by default and lists its skill; setting_change turns it off, which hides it, and on again", async () => {
    const id = await newSession(app);
    const listed = () => app.skillCommands(id).some((each) => each.name === "extension-builder");

    assert.equal(app.loader.list().find((module) => module.file === BUILDER_MODULE)?.title, "Extension builder");
    assert.equal(app.loader.enabled(BUILDER_MODULE), true, "on by default");
    assert.equal(listed(), true);
    await turn(id, "hello");
    assert.match(prompt, /<name>extension-builder<\/name>[^]*src\/extension-builder\/skills\/extension-builder\/SKILL\.md/);

    assert.match(await turn(id, "builder off", true), /Changed extensions\.extension-builder\.ts: on → off/);
    assert.equal(app.loader.enabled(BUILDER_MODULE), false);
    assert.equal(listed(), false);

    const off = await newSession(app);

    await turn(off, "hello");
    assert.doesNotMatch(prompt, /<name>extension-builder<\/name>/);
    assert.match(prompt, /<name>html<\/name>/, "the other skills stay");

    assert.match(await turn(off, "builder on", true), /Changed extensions\.extension-builder\.ts: off → on/);
    assert.equal(listed(), true);
    await turn(await newSession(app), "hello");
    assert.match(prompt, /<name>extension-builder<\/name>/);
});

test("each template loads as a drop-in, switched off until turned on, then on without being refused, with what it adds", async () => {
    const module = (file: string) => app.loader.list().find((each) => each.file === file);

    for (const name of NAMES) {
        const file = `${name}.ts`;
        const expected = TEMPLATES[name];

        assert.equal(module(file)?.source, "drop-in", name);
        assert.equal(module(file)?.enabled, false, `${name} lands off`);
        await app.setExtensionEnabled(owner(app), file, true);

        const loaded = module(file)!;

        assert.equal(loaded.error, undefined, `${name}: ${loaded.error}`);
        assert.equal(loaded.refused, undefined, name);
        assert.ok(loaded.summary.length > 10, `${name} says what it does`);
        assert.deepEqual(loaded.extensions.flatMap((each) => each.tools), [...expected.tools], name);
        assert.deepEqual(loaded.extensions.flatMap((each) => each.readOnlyTools), [...expected.readOnly], name);
        assert.deepEqual(loaded.web?.routes ?? [], [...expected.routes], name);
        assert.equal(loaded.web?.client !== undefined, expected.client, name);
    }
});

test("the templates' tools work, and the checklist's page and Pi change the same list", async () => {
    const id = await newSession(app);

    assert.match(await turn(id, "what is the time in saigon"), /told: Asia\/Saigon: .*20\d\d/);
    assert.match(await turn(id, "please add milk"), /told: - \[ \] [0-9a-f]{8}: Buy milk/);

    const api = (path: string, method = "GET", body?: unknown) =>
        fetch(`${base}/api/x/checklist/${path}`, {
            method,
            headers: { authorization: `Bearer ${app.config.ownerToken}`, "x-pocket": "1", "content-type": "application/json" },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }).then(async (response) => ({ status: response.status, body: (await response.json()) as { items?: { id: string; text: string; done: boolean }[]; error?: string } }));

    const listed = await api("items");

    assert.equal(listed.status, 200);
    assert.deepEqual(listed.body.items?.map((item) => [item.text, item.done]), [["Buy milk", false]]);

    const milk = listed.body.items![0]!.id;

    assert.equal((await api(`items/${milk}`, "POST", { done: true })).status, 200);
    assert.match(await turn(id, "now read the list"), /told: - \[x\] [0-9a-f]{8}: Buy milk/);

    const wrong = await api("items/nope", "DELETE");

    assert.equal(wrong.status, 400);
    assert.match(JSON.stringify(wrong.body), /There is no item nope on the checklist/);
    assert.equal((await api(`items/${milk}`, "DELETE")).status, 200);
    assert.deepEqual(JSON.parse(readFileSync(join(dataDir, "extension-data", "checklist", "items.json"), "utf8")), []);
    assert.ok(statSync(join(dataDir, "extensions", "checklist", "index.js")).isFile(), "its data is apart from its files");
});
