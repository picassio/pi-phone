// Design systems (PP-241, design-systems.ts): OpenDesign's bundled ones, with only their three files and an index; the
// person's own in <data>/design-systems first, broken folders named; the design-system skill's command lists, searches,
// shows, resolves tokens and checks; the design.default setting (Menu › Design system, POST /api/settings) names one
// for Pi's prompt, refuses one that is not there, and none clears it.
import { type App, cleanUp, lastText, newSession, openApp, owner, root, say, scriptedModel } from "./helpers.ts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { after, test } from "node:test";
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { APP_ROOT } from "../src/server/config.ts";
import {
    BUNDLED_DESIGN_SYSTEMS,
    listDesignSystems,
    missingTokens,
    ownDesignSystems,
    readTokens,
    REQUIRED_TOKENS,
    searchDesignSystems,
} from "../src/server/design-systems.ts";
import { createHandler } from "../src/server/http.ts";
import { appSettings } from "../src/server/settings-registry.ts";

const data = join(root, "design-data");
const COMMAND = join(APP_ROOT, "src", "skills", "design-system", "systems.ts");
const TOKENS = `:root {\n  /* the brand's */\n  --brand: #112233;\n${REQUIRED_TOKENS.map((name) => `  ${name}: ${name === "--accent" ? "var(--brand)" : "1px"};`).join("\n")}\n}\n`;

/** A system of the person's, `files` written of the three. */
function mine(id: string, files: Record<string, string>): void {
    mkdirSync(join(ownDesignSystems(data), id), { recursive: true });

    for (const [file, text] of Object.entries(files)) {
        writeFileSync(join(ownDesignSystems(data), id, file), text);
    }
}

const manifest = (id: string, name: string) => JSON.stringify({ schemaVersion: "od-design-system-project/v1", id, name, category: "Yours", description: `${name}: ink navy, one coral accent.` });

mine("acme", { "DESIGN.md": "# Acme\n", "tokens.css": TOKENS, "manifest.json": manifest("acme", "Acme") });
mine("stripe", { "DESIGN.md": "# Our Stripe\n", "tokens.css": TOKENS, "manifest.json": manifest("stripe", "Our Stripe") });
mine("half", { "DESIGN.md": "# Half\n", "manifest.json": manifest("half", "Half") });

let prompt = "";
const route: FauxResponseStep = (context) => {
    prompt = JSON.stringify((context.messages as { role: string; sections?: Record<string, string> }[]).filter((message) => message.role === "system").map((message) => message.sections ?? {}));

    return fauxAssistantMessage([fauxText(`echo: ${lastText(context as never).text}`)]);
};
let app: App | undefined;

after(async () => {
    await app?.close();
    cleanUp();
});

test("OpenDesign's systems ship only DESIGN.md, tokens.css and manifest.json, each in the index and with every required token", () => {
    const folders = readdirSync(BUNDLED_DESIGN_SYSTEMS).filter((name) => name !== "index.json").sort();
    const index = JSON.parse(readFileSync(join(BUNDLED_DESIGN_SYSTEMS, "index.json"), "utf8")) as { id: string; summary: string }[];

    assert.equal(folders.length, 152);
    assert.deepEqual(index.map((entry) => entry.id), folders);

    for (const id of folders) {
        assert.deepEqual(readdirSync(join(BUNDLED_DESIGN_SYSTEMS, id)).sort(), ["DESIGN.md", "manifest.json", "tokens.css"], id);
    }

    const bundled = listDesignSystems(join(root, "no-data")).systems;

    assert.equal(bundled.length, 152);
    assert.deepEqual(bundled.filter((system) => missingTokens(system).length > 0).map((system) => system.id), []);
    assert.equal(searchDesignSystems(bundled, "coral travel")[0]?.id, "airbnb");
    assert.equal(searchDesignSystems(bundled, "fintech").length, 7);
});

test("the person's own come first, by a bundled one's id too, and a folder missing a file is named", () => {
    const { systems, problems } = listDesignSystems(data);

    assert.deepEqual(systems.slice(0, 2).map((system) => [system.id, system.name, system.mine]), [["acme", "Acme", true], ["stripe", "Our Stripe", true]]);
    assert.equal(systems.filter((system) => system.id === "stripe").length, 1);
    assert.equal(systems.length, 153);
    assert.deepEqual(problems, [`${join(ownDesignSystems(data), "half")}: no tokens.css`]);
    assert.equal(readTokens(TOKENS).get("--accent"), "#112233");
});

test("the skill's command lists, searches, shows, gives tokens and checks, with the person's from the app's data folder", () => {
    const run = (...args: string[]) => spawnSync(process.execPath, [COMMAND, ...args], { encoding: "utf8", env: { ...process.env, PI_POCKET_DIR: data } });

    assert.match(run("search", "coral", "travel").stdout, /^1 match "coral travel", best first:\nairbnb: Airbnb · E-Commerce & Retail · Travel marketplace/);
    assert.match(run("list").stdout, /^153 design systems \(yours in [^\n]+\)\.\n\n## Yours\nacme: Acme · yours · Acme: ink navy[^]*## Fintech & Crypto\n[^]*Not a design system: [^\n]*half: no tokens\.css/);
    assert.match(run("show", "linear-app").stdout, /tokens\.css: [^\n]*third_party\/open-design\/design-systems\/linear-app\/tokens\.css/);
    assert.match(run("tokens", "acme").stdout, /--accent: #112233/);
    assert.match(run("check", "acme").stdout, /Complete: DESIGN\.md, tokens\.css/);

    const half = run("check", "half");

    assert.equal(half.status, 1);
    assert.match(half.stderr, /"half" is not a design system yet: [^\n]*no tokens\.css/);
    assert.equal(run("show", "nope").status, 1);
});

test("design.default names one for Pi's prompt, refuses one that is not there, and none clears it; the sheet's API too", async () => {
    app = await openApp(scriptedModel(route), data);

    const setting = appSettings(app).settings.find((each) => each.id === "design.default")!;
    const id = await newSession(app);

    await say(app, id, "before");
    assert.doesNotMatch(prompt, /"design_system"/);
    await assert.rejects(Promise.resolve(setting.apply(owner(app), "nope", undefined)), /There is no design system "nope"/);
    await setting.apply(owner(app), "stripe", undefined);
    assert.equal(await setting.read(undefined), "stripe");
    await say(app, id, "with stripe");
    assert.match(prompt, /"design_system":"<design_system>\\nThe person's default design system \(Menu › Design system\): Our Stripe \(stripe, their own\)/);
    assert.ok(prompt.includes(join(ownDesignSystems(data), "stripe", "tokens.css")));
    await setting.apply(owner(app), "none", undefined);
    assert.equal(await setting.read(undefined), "none");

    const server = createServer(createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }));

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

    const port = (server.address() as { port: number }).port;
    const call = (path: string, body?: unknown) =>
        fetch(`http://127.0.0.1:${port}/api/${path}`, {
            method: body === undefined ? "GET" : "POST",
            headers: { authorization: `Bearer ${app!.config.ownerToken}`, "x-pocket": "1", "content-type": "application/json" },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });

    try {
        assert.equal((await call("settings", { designSystem: "linear-app" })).status, 200);

        const listed = (await (await call("design-systems")).json()) as { chosen: string; systems: { id: string; mine: boolean }[]; problems: string[] };

        assert.equal(listed.chosen, "linear-app");
        assert.deepEqual(listed.systems[0], { id: "acme", name: "Acme", category: "Yours", summary: "Acme: ink navy, one coral accent.", mine: true });
        assert.equal(listed.problems.length, 1);
        assert.equal((await call("settings", { designSystem: "../etc" })).status, 400);
        await say(app, id, "with linear");
        assert.match(prompt, /Linear \(linear-app, Productivity & SaaS\)/);
        assert.equal((await call("settings", { designSystem: null })).status, 200);
        assert.equal(app.config.designSystem, undefined);
    } finally {
        server.close();
    }
});
