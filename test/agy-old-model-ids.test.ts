// Google Antigravity models saved by their old ids (PP-555). Before PR #17 a Gemini Enterprise account listed one model
// per effort (`gemini-4-carbon-medium`); it now lists one per family. A session, its subagents' and the app's settings on
// an old id move to the family at that effort's level once the account's catalog has it, with no notice; a turn on an
// account's model looks its window up in that account's catalog, not the default account's (whose catalog is another);
// a model the catalog does not list is said once in the session, and a send on one that cannot move says what to do.
import { type App, cleanUp, home, owner, root, say, work } from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { ConversationId } from "@earendil-works/pi-durable";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { AGY_PROVIDER, type AgyCatalog, type AgySend } from "../src/server/antigravity.ts";
import { upgradedModel, upgradedSpec } from "../src/server/model-upgrade.ts";
import { ENTERPRISE_FULL_CATALOG } from "./support/enterprise-catalog.ts";

const { PocketApp } = await import("../src/server/app.ts");

const WORK = `${AGY_PROVIDER}~work`;
/** The catalog as builds before PR #17 listed it: no families, one model per effort. */
const OLD: AgyCatalog = { ...ENTERPRISE_FULL_CATALOG, groupedModels: {} };
/** The catalog now: the same answer, grouped by family. */
const NOW: AgyCatalog = ENTERPRISE_FULL_CATALOG;

let catalog: AgyCatalog = OLD;
const asked: string[] = [];
const logged: string[] = [];
let app: App;

const reply =
    `data: ${JSON.stringify({ candidates: [{ content: { role: "model", parts: [{ text: "pong" }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 30, candidatesTokenCount: 2, totalTokenCount: 32 } })}\r\n\r\n`;

/** Google for a Gemini Enterprise license: its catalog (old or new), and a turn answered "pong", whose experience is kept. */
const send: AgySend = async (url, init) => {
    const turn = url.includes(":streamGenerateContent");

    if (turn) {
        asked.push((JSON.parse(init.body!) as { aicode: { experience: string } }).aicode.experience);
    }

    const body = url.includes(":fetchAvailableModels") ? JSON.stringify(catalog) : turn ? reply : "{}";

    return {
        status: 200,
        headers: new Headers({ "content-type": turn ? "text/event-stream" : "application/json" }),
        body: (async function* () {
            yield new TextEncoder().encode(body);
        })(),
    };
};

before(async () => {
    const agent = join(root, "agent");

    mkdirSync(agent, { recursive: true });
    // A Gemini Enterprise sign-in as `antigravity.ts` keeps one (a stand-in token, a neutral project); the default
    // account is not signed in, so its catalog has none of these models.
    writeFileSync(
        join(agent, "auth.json"),
        JSON.stringify({
            [WORK]: {
                type: "oauth",
                access: "ya29.stand-in",
                refresh: "1//stand-in",
                expires: Date.now() + 30 * 86_400_000,
                projectId: "example-project-123",
                osType: "linux",
                arch: "amd64",
                authMethod: "gcp",
                location: "global",
                userTier: "gcp-ge-plus-tier",
                tierName: "Gemini Enterprise Plus",
            },
        }),
    );
    app = await PocketApp.open({
        dataDir: join(root, "agy-old-ids-data"),
        defaultCwd: work,
        supervised: false,
        log: (line) => logged.push(line),
        home,
        antigravity: { send, platform: { osType: "linux", arch: "amd64" } },
        officecli: { runs: false },
    });
    app.accounts.add(AGY_PROVIDER, "Work");
    await app.models.refresh({ providers: [WORK], allowNetwork: true, force: true });
});

after(async () => {
    await app?.close();
    cleanUp();
});

/** A new session, as one started on the account's first model. */
const session = async (): Promise<ConversationId> => {
    app.config.lastModel ??= { provider: WORK, modelId: app.models.getModels(WORK)[0]!.id, thinkingLevel: "off" };

    return (await app.commands.createSession(owner(app), { cwd: work })).id;
};

const refreshTo = async (next: AgyCatalog) => {
    catalog = next;
    await app.models.refresh({ providers: [WORK], allowNetwork: true, force: true });
    // The wrapper's pass runs after the refresh; this one is waited for.
    await app.upgradeModels();
};

test("an old id is its family at the effort's level, once the account's catalog has the family; nothing else moves", () => {
    const models = { getModel: (provider: string, id: string) => app.models.getModel(provider, id) };

    catalog = NOW;
    assert.equal(app.models.getModel(WORK, "gemini-4-carbon-medium")?.id, "gemini-4-carbon-medium", "the old catalog still lists it: it stays");
    assert.equal(upgradedModel(models, WORK, "gemini-4-carbon-medium"), undefined);
    assert.equal(upgradedModel(models, "anthropic", "claude-x-medium"), undefined, "another provider's");
    assert.deepEqual(upgradedSpec(models, "session"), { spec: "session" });
});

test("a session, its subagents and the settings on an old id go on with the family at that level after the catalog changes, with no notice; the turn asks the same experience", async () => {
    const id = await session();

    await app.commands.configure(id, owner(app), { model: { provider: WORK, modelId: "gemini-4-carbon-medium" } });
    app.config.defaultModel = { provider: WORK, modelId: "gemini-4-hydrogen-high", thinkingLevel: "off" };
    app.config.setSubagentDefault("model", `${WORK}/gemini-3.1-pro-low`);
    app.config.subagentModels = [`${WORK}/gemini-4-carbon-medium`, `${WORK}/gemini-4-carbon-high`, "anthropic/claude-x"];
    app.config.updateUser(owner(app).id, { favoriteModels: [`${WORK}/gemini-4-argon-low`] });

    await refreshTo(NOW);

    const agent = await app.agentState(id);

    assert.deepEqual([agent?.model, agent?.thinkingLevel], [{ provider: WORK, modelId: "gemini-4-carbon" }, "medium"]);
    assert.deepEqual(app.config.defaultModel, { provider: WORK, modelId: "gemini-4-hydrogen", thinkingLevel: "high" });
    assert.deepEqual(app.config.subagentDefaults, { model: `${WORK}/gemini-3.1-pro`, thinking: "low" });
    assert.deepEqual(app.config.subagentModels, [`${WORK}/gemini-4-carbon`, "anthropic/claude-x"], "both efforts are one family");
    assert.deepEqual(app.config.userById(owner(app).id)?.favoriteModels, [`${WORK}/gemini-4-argon`]);

    // A turn: Google is asked for the same model and effort as before; the session hears of nothing.
    logged.length = 0;
    asked.length = 0;
    await say(app, id, "Reply with exactly: pong");
    assert.deepEqual(asked, ["gemini-4-carbon-medium"]);
    assert.deepEqual(logged.filter((line) => /^\[(?:warning|error)\]|catalogue/.test(line)), [], "no notice");
});

test("a message to a session still on an old id moves it first; one whose family is gone says to pick a model, and nothing is sent", async () => {
    // Saved by a build before: the agent document names the old id as it was.
    catalog = OLD;
    await app.models.refresh({ providers: [WORK], allowNetwork: true, force: true });
    const moved = await session();
    const gone = await session();

    await app.commands.configure(moved, owner(app), { model: { provider: WORK, modelId: "gemini-4-argon-high" } });
    await app.commands.configure(gone, owner(app), { model: { provider: WORK, modelId: "gemini-3.6-flash-low" } });
    // The new catalog comes without the app's pass (a background refresh): the message moves its session itself.
    catalog = { ...NOW, agentModelSorts: [{ groups: [{ modelIds: (NOW.agentModelSorts![0]!.groups![0]!.modelIds ?? []).filter((each) => !each.startsWith("gemini-3.6-flash")) }] }] };
    const without = Object.fromEntries(Object.entries(NOW.models!).filter(([each]) => !each.startsWith("gemini-3.6-flash")));

    catalog = { ...catalog, models: without };
    await app.models.refresh({ providers: [WORK], allowNetwork: true, force: true });

    asked.length = 0;
    await say(app, moved, "Reply with exactly: pong");
    assert.deepEqual((await app.agentState(moved))?.model, { provider: WORK, modelId: "gemini-4-argon" });
    assert.deepEqual(asked, ["gemini-4-argon-high"]);

    await assert.rejects(say(app, gone, "Reply with exactly: pong"), {
        message: `This session's model, ${WORK}/gemini-3.6-flash-low, is not offered now. Pick another model for this session; nothing was sent.`,
    });
});

test("an answer whose model the catalogue does not list is said once in the session, not after every answer", async () => {
    const id = await session();

    catalog = NOW;
    await app.models.refresh({ providers: [WORK], allowNetwork: true, force: true });
    await app.commands.configure(id, owner(app), { model: { provider: WORK, modelId: "gemini-4-carbon" }, thinkingLevel: "medium" });
    const answer = {
        role: "assistant",
        content: [{ type: "text", text: "pong" }],
        api: "google-antigravity",
        provider: AGY_PROVIDER,
        model: "gemini-4-gone",
        usage: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 12, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: "stop",
        timestamp: Date.now(),
    } as AssistantMessage;
    const turn = { lastUser: "hello", compacted: false, costAfterCall: 0 };

    logged.length = 0;

    for (let each = 0; each < 3; each++) {
        await app.selfCompact.apply(id as ConversationId, await app.selfCompact.onYield(id as ConversationId, answer, turn, true));
    }

    assert.deepEqual(
        logged.filter((line) => line.startsWith("[warning]")),
        [
            "[warning] google-antigravity/gemini-4-gone answered, but it is not in the model list now, so this session's context size is not watched. Pick this session's model again in the model picker.",
        ],
    );
});
