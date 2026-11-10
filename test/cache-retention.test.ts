// How long the prompt cache lasts (PP-475, src/server/cache-retention.ts): short by default, so pi-ai sends Anthropic no
// ttl; long, for every session or for one, makes each request of the session, its subagents' too, ask for the 1-hour
// cache, which pi-ai sends as ttl "1h"; a session's own setting comes first; requests that set their own keep it.
import { type App, cleanUp, context, lastText, newSession, openApp, owner, scriptedModel, until } from "./helpers.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { type Api, type AssistantMessage, type CacheRetention, type Context, createAssistantMessageEventStream, type Model, type SimpleStreamOptions } from "@earendil-works/pi-ai";
import { streamSimple as anthropicStream } from "@earendil-works/pi-ai/api/anthropic-messages";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { type ConversationId, ProviderDoc } from "@earendil-works/pi-durable";
import { installCacheRetention } from "../src/server/cache-retention.ts";
import { SubagentsDoc } from "../src/server/docs.ts";
import { appSettings } from "../src/server/settings-registry.ts";

/** What each request asked for, by its provider session id. */
const seen: { sessionId: string | undefined; cacheRetention: CacheRetention | undefined }[] = [];

const faux = scriptedModel(((request: { messages: { role: string; content: unknown }[] }, options: SimpleStreamOptions | undefined) => {
    seen.push({ sessionId: options?.sessionId, cacheRetention: options?.cacheRetention });
    const messages = request.messages.filter((message) => message.role !== "system");
    const start = messages.findLastIndex((message) => message.role === "user");
    const asked = lastText({ messages: messages.slice(0, start + 1) }).text;
    const results = messages.slice(start + 1).filter((message) => message.role === "toolResult").length;

    if (asked === "start a helper" && results === 0) {
        return fauxAssistantMessage([fauxToolCall("subagent", { action: "spawn", name: "helper", message: "look around" })], { stopReason: "toolUse" });
    }

    return fauxAssistantMessage([fauxText("ok")]);
}) as never);

let app: App;

before(async () => {
    app = await openApp(faux);
});

after(async () => {
    await app.close();
    cleanUp();
});

const say = async (id: ConversationId, text: string) => {
    const { submissionId } = await app.commands.submit(id, owner(app), { text, requestId: crypto.randomUUID() });

    await (await app.harness.submission(submissionId, context))!.wait(context);
};
const sessionIdOf = async (id: ConversationId) => (await app.harness.snapshot(ProviderDoc, id, context))!.sessionId;
/** The retention each request of `id` since `from` asked for. */
const asked = async (id: ConversationId, from: number) => {
    const sessionId = await sessionIdOf(id);

    return seen.slice(from).flatMap((each) => (each.sessionId === sessionId ? [each.cacheRetention] : []));
};

/**
 * The cache breakpoint pi-ai puts on the last message for Anthropic, for a request with `cacheRetention`: read in the
 * payload, caught before anything goes out.
 */
async function anthropicBreakpoint(cacheRetention: CacheRetention | undefined): Promise<unknown> {
    const model = {
        ...{ id: "claude-opus-5-5", name: "Claude Opus 5.5", api: "anthropic-messages", provider: "anthropic", baseUrl: "http://127.0.0.1:9" },
        ...{ reasoning: false, input: ["text"], cost: { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 }, contextWindow: 200_000, maxTokens: 8_000 },
    } as Model<"anthropic-messages">;
    const abort = new AbortController();
    let payload: unknown;
    const stream = anthropicStream(
        model,
        // A transcript as Pi Durable hands one over; its brand is a type's only.
        { messages: [{ role: "user", content: "hello", timestamp: Date.now() }] } as never,
        {
            apiKey: "test-key",
            signal: abort.signal,
            ...(cacheRetention === undefined ? {} : { cacheRetention }),
            onPayload: (body) => {
                payload = body;
                abort.abort();

                return body;
            },
            fetch: () => Promise.reject(new Error("no network in tests")),
        },
    );

    await stream.result();

    const messages = (payload as { messages: { content: { cache_control?: unknown }[] }[] }).messages;

    return messages.at(-1)!.content.at(-1)!.cache_control;
}

test("off by default: a session's requests ask for the short cache, and pi-ai sends no ttl", async () => {
    assert.equal(app.config.cacheRetention, "short");
    const id = await newSession(app);
    const from = seen.length;

    await say(id, "hello");
    const retentions = await asked(id, from);

    assert.ok(retentions.length > 0);
    assert.deepEqual(new Set(retentions), new Set(["short"]));
    assert.equal(app.cacheRetentionOf(id), "short");

    assert.deepEqual(await anthropicBreakpoint(retentions[0]), { type: "ephemeral" });
});

test("on for every session: each request, its subagent's too, asks for the long cache, which pi-ai sends as ttl 1h", async () => {
    await app.setCacheRetention(owner(app), "long");

    try {
        const id = await newSession(app);
        const from = seen.length;

        await say(id, "start a helper");
        await until(async () => (await app.harness.snapshot(SubagentsDoc, id, context))?.agents.helper?.answeredAt !== undefined, "the helper's answer");
        const helper = (await app.harness.snapshot(SubagentsDoc, id, context))!.agents.helper!.conversationId;

        const retentions = await asked(id, from);

        assert.deepEqual(new Set(retentions), new Set(["long"]));
        assert.deepEqual(new Set(await asked(helper, from)), new Set(["long"]), "the subagent follows its session");
        assert.deepEqual(await anthropicBreakpoint(retentions[0]), { type: "ephemeral", ttl: "1h" });
    } finally {
        await app.setCacheRetention(owner(app), "short");
    }
});

test("a session's own setting comes first, both ways; inherit goes back to the setting for every session", async () => {
    const id = await newSession(app);

    await app.setSessionCacheRetention(id, owner(app), "long");
    let from = seen.length;

    await say(id, "hello");
    assert.deepEqual(new Set(await asked(id, from)), new Set(["long"]), "long here, short for all");
    assert.equal(app.sessionMeta(id)?.cacheRetention, "long");

    await app.setCacheRetention(owner(app), "long");

    try {
        await app.setSessionCacheRetention(id, owner(app), "short");
        from = seen.length;
        await say(id, "hello");
        assert.deepEqual(new Set(await asked(id, from)), new Set(["short"]), "short here, long for all");

        await app.setSessionCacheRetention(id, owner(app), "inherit");
        assert.equal(app.sessionMeta(id)?.cacheRetention, undefined);
        from = seen.length;
        await say(id, "hello");
        assert.deepEqual(new Set(await asked(id, from)), new Set(["long"]), "inherit: long for all");
    } finally {
        await app.setCacheRetention(owner(app), "short");
    }

    await assert.rejects(app.setSessionCacheRetention(id, owner(app), "forever"), /short \(5 minutes\), long \(1 hour\), or inherit/);
    await assert.rejects(app.setCacheRetention(owner(app), "inherit"), /short \(5 minutes\) or long \(1 hour\)\./);
});

test("a request that sets its own retention keeps it (Pi Durable's summarizer, the side model: none), one without a session goes as it came, and a lookup that fails fails the request", async () => {
    const calls: (SimpleStreamOptions | undefined)[] = [];
    const models = {
        streamSimple: (_model: Model<Api>, _context: Context, options?: SimpleStreamOptions) => {
            calls.push(options);
            const out = createAssistantMessageEventStream();
            const message = { ...fauxAssistantMessage([fauxText("ok")]), api: "x", provider: "p", model: "m" } as AssistantMessage;

            queueMicrotask(() => {
                out.push({ type: "done", reason: "stop", message });
                out.end(message);
            });

            return out;
        },
    };

    installCacheRetention(models, async (sessionId) => {
        if (sessionId === "broken") {
            throw new Error("no sessions");
        }

        return sessionId === "mine" ? "long" : undefined;
    });
    const model = { id: "m", provider: "p", api: "x" } as unknown as Model<Api>;
    const request = { messages: [] };

    await models.streamSimple(model, request, { sessionId: "mine", cacheRetention: "none" }).result();
    await models.streamSimple(model, request, { sessionId: "mine" }).result();
    await models.streamSimple(model, request, { sessionId: "someone else's" }).result();
    await models.streamSimple(model, request, {}).result();
    assert.deepEqual(
        calls.map((options) => options?.cacheRetention),
        ["none", "long", undefined, undefined],
    );

    const failed = await models.streamSimple(model, request, { sessionId: "broken" }).result();

    assert.equal(failed.stopReason, "error");
    assert.match(failed.errorMessage!, /prompt cache setting could not be read: no sessions/);
    assert.equal(calls.length, 4, "nothing sent");
});

test("the settings tool's registry has the setting for every session and a session's own", async () => {
    const id = await newSession(app);
    const { settings } = appSettings(app);
    const all = settings.find((setting) => setting.id === "sessions.cacheRetention")!;
    const own = settings.find((setting) => setting.id === "sessions.sessionCacheRetention")!;

    assert.equal(await all.read(undefined), "short");
    assert.equal(await own.read(String(id)), "inherit (short)");
    await own.apply(owner(app), "long", String(id));
    assert.equal(await own.read(String(id)), "long");
    assert.equal(app.cacheRetentionOf(id), "long");
    await own.apply(owner(app), "inherit", String(id));
    assert.equal(app.cacheRetentionOf(id), "short");
});
