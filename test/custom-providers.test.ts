// OpenAI-compatible providers the owner adds in Providers (PP-248, picassio/pi-phone#4): written into Pi's models.json
// beside what else it has, the key kept in Secrets and named only (`$NAME`), given to Pi as the provider's runtime key so
// its models appear and requests carry it; a bad address or a file Pi would not load is refused and nothing changes;
// Find models asks the server's /models; remove takes it out; only the owner (and on the team server, a role with
// providers.custom) may.
import { type App, cleanUp, openApp, owner, root, scriptedModel, until } from "./helpers.ts";
import assert from "node:assert/strict";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { createHandler } from "../src/server/http.ts";
import { appSettings } from "../src/server/settings-registry.ts";

const KEY = "sk-stub-key-0123456789abcdef";
const OTHER_KEY = "sk-stub-key-second-9876543210";
const file = join(root, "agent", "models.json");
/** What the person had in the file before: a provider of their own (with a comment-free key), and a schema line. */
const BEFORE = {
    $schema: "https://pi.dev/schemas/models.schema.json",
    providers: {
        mine: { baseUrl: "http://127.0.0.1:9/v1", api: "anthropic-messages", apiKey: "literal-key-of-mine", models: [{ id: "my-model", name: "Mine" }] },
        openrouter: { baseUrl: "https://proxy.example.com/v1" },
    },
};

let app: App;
let stub: Server;
let base = "";
/** The Authorization header of each request the stub got, by path. */
const seen: { path: string; authorization: string | undefined; title: string | undefined }[] = [];

function answer(request: IncomingMessage) {
    seen.push({ path: request.url ?? "", authorization: request.headers.authorization, title: request.headers["x-title"] as string | undefined });
}

before(async () => {
    stub = createServer((request, response) => {
        answer(request);

        if (request.method === "GET" && request.url === "/v1/models") {
            response.writeHead(200, { "content-type": "application/json" });
            response.end(
                JSON.stringify({
                    data: [
                        { id: "qwen3-coder", context_length: 262144, top_provider: { max_completion_tokens: 65536 }, supported_parameters: ["tools", "reasoning"] },
                        { id: "vision-1", architecture: { input_modalities: ["text", "image"] } },
                        { id: "plain" },
                        { id: "has space" },
                    ],
                }),
            );

            return;
        }

        if (request.method === "GET" && request.url === "/denied/models") {
            response.writeHead(401).end("{}");

            return;
        }

        if (request.method === "POST" && request.url === "/v1/chat/completions") {
            request.resume();
            response.writeHead(200, { "content-type": "text/event-stream" });
            response.end('data: {"id":"1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"hi"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');

            return;
        }

        response.writeHead(404).end();
    });
    await new Promise<void>((resolve) => stub.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(stub.address() as { port: number }).port}/v1`;
    writeFileSync(file, JSON.stringify(BEFORE, null, 2));
    app = await openApp(scriptedModel(), join(root, "custom-providers-data"));
});

after(async () => {
    await app?.close();
    stub?.close();
    rmSync(file, { force: true });
    cleanUp();
});

const read = () => JSON.parse(readFileSync(file, "utf8")) as { $schema?: string; providers: Record<string, Record<string, unknown>> };
const usable = (provider: string, model: string) => app.models.getAvailableSnapshot().some((each) => each.provider === provider && each.id === model);

/** One request to a model through Pi, as a session's would go: what the stub saw of it. */
async function ask(provider: string, model: string) {
    const found = app.models.getModel(provider, model);

    assert.ok(found, `${provider}/${model} is a model`);
    seen.length = 0;

    for await (const event of app.models.streamSimple(found, { messages: [{ role: "user", content: "hello", timestamp: Date.now() }] } as never)) {
        if (event.type === "error") {
            throw new Error(JSON.stringify(event).slice(0, 300));
        }
    }

    return seen.find((each) => each.path === "/v1/chat/completions");
}

test("a provider is written into models.json beside the person's own entries, its key only named, and its models are usable", async () => {
    const saved = await app.customProviders.save(
        "lm-studio",
        {
            name: "LM Studio",
            baseUrl: `${base}/`,
            key: { kind: "new", value: KEY },
            headers: [{ name: "X-Title", value: "pi $phone" }],
            models: [{ id: "qwen3-coder", contextWindow: 262144, maxTokens: 65536, reasoning: true }, { id: "vision-1", images: true }],
        },
        true,
    );
    const text = readFileSync(file, "utf8");
    const written = read();

    // The key is in Secrets, and the file names it only.
    assert.doesNotMatch(text, new RegExp(KEY));
    assert.equal(app.secrets.value("LM_STUDIO_API_KEY"), KEY);
    assert.deepEqual(written.providers["lm-studio"], {
        name: "LM Studio",
        baseUrl: base,
        api: "openai-completions",
        apiKey: "$LM_STUDIO_API_KEY",
        headers: { "X-Title": "pi $$phone" },
        models: [
            { id: "qwen3-coder", contextWindow: 262144, maxTokens: 65536, reasoning: true },
            { id: "vision-1", input: ["text", "image"] },
        ],
    });
    // Everything else stays as it was.
    assert.equal(written.$schema, BEFORE.$schema);
    assert.deepEqual(written.providers.mine, BEFORE.providers.mine);
    assert.deepEqual(written.providers.openrouter, BEFORE.providers.openrouter);
    assert.equal(saved.configured, true);
    assert.deepEqual(saved.key, { kind: "secret", name: "LM_STUDIO_API_KEY", missing: false });
    // Reloaded: its models are in the pickers, and a request carries the key and the header as typed.
    assert.ok(usable("lm-studio", "qwen3-coder"));
    assert.ok((await app.modelList()).some((model) => model.provider === "lm-studio" && model.id === "vision-1" && model.images));
    assert.equal(app.providers.list().find((each) => each.id === "lm-studio")?.custom, true);

    const request = await ask("lm-studio", "qwen3-coder");

    assert.equal(request?.authorization, `Bearer ${KEY}`);
    assert.equal(request?.title, "pi $phone");
});

test("a change to the key's secret reaches Pi's requests, and a removed secret takes the models away", async () => {
    app.secrets.set("LM_STUDIO_API_KEY", { value: OTHER_KEY });
    await until(async () => (await ask("lm-studio", "qwen3-coder"))?.authorization === `Bearer ${OTHER_KEY}`, "the new key in requests");

    app.secrets.remove("LM_STUDIO_API_KEY");
    await until(() => !usable("lm-studio", "qwen3-coder"), "the models to go with the secret");
    assert.deepEqual(app.customProviders.get("lm-studio").key, { kind: "secret", name: "LM_STUDIO_API_KEY", missing: true });

    app.secrets.set("LM_STUDIO_API_KEY", { value: KEY });
    await until(() => usable("lm-studio", "qwen3-coder"), "the models back with the secret");
});

test("a bad address, bad models, or a file Pi would not load is refused, and the file stays as it was", async () => {
    const was = readFileSync(file, "utf8");
    const attempt = (baseUrl: string, models: unknown = ["m"]) => app.customProviders.save("bad-one", { name: "Bad", baseUrl, key: { kind: "none" }, models }, true);

    await assert.rejects(attempt("ftp://example.com/v1"), /starts with http:\/\/ or https:\/\//);
    await assert.rejects(attempt("not a url"), /not a web address/);
    await assert.rejects(attempt("http://user:pass@example.com/v1"), /no user name or password/);
    await assert.rejects(attempt(base, []), /at least one model/);
    await assert.rejects(attempt(base, [{ id: "m", contextWindow: -5 }]), /whole number of tokens/);
    await assert.rejects(app.customProviders.save("openai", { name: "openai", baseUrl: base, key: { kind: "none" }, models: ["m"] }, true), /already/);
    assert.equal(readFileSync(file, "utf8"), was);
    assert.ok(usable("lm-studio", "qwen3-coder"));

    // A file Pi would not load (a hand edit gone wrong elsewhere in it): not rewritten, and the models stay published.
    const broken = { ...read() };

    broken.providers = { ...broken.providers, typo: { baseUrl: "http://x", api: "openai-completions", models: "not a list" } };
    writeFileSync(file, JSON.stringify(broken));
    await assert.rejects(attempt(base), /Pi would not accept this provider/);
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), broken);
    assert.ok(usable("lm-studio", "qwen3-coder"));
    // Comments are Pi's to read, not the app's to drop.
    writeFileSync(file, `// mine\n${was}`);
    await assert.rejects(attempt(base), /comments or is not valid JSON/);
    writeFileSync(file, was);
});

test("Find models asks the server's /models with the key, and reads what it says of each model", async () => {
    const found = await app.customProviders.findModels({ baseUrl: base, key: { kind: "keep" }, id: "lm-studio" });

    assert.deepEqual(found, [
        { id: "plain", images: false, reasoning: false },
        { id: "qwen3-coder", contextWindow: 262144, maxTokens: 65536, images: false, reasoning: true },
        { id: "vision-1", images: true, reasoning: false },
    ]);
    assert.equal(seen.at(-1)?.path, "/v1/models");
    assert.equal(seen.at(-1)?.authorization, `Bearer ${KEY}`);

    // Without a key (a local server): no Authorization at all.
    await app.customProviders.findModels({ baseUrl: base, key: { kind: "none" } });
    assert.equal(seen.at(-1)?.authorization, undefined);

    const denied = base.replace(/\/v1$/, "/denied");

    await assert.rejects(app.customProviders.findModels({ baseUrl: denied, key: { kind: "new", value: KEY } }), (error: Error) => /answered 401: check the API key/.test(error.message) && !error.message.includes(KEY));
    await assert.rejects(app.customProviders.findModels({ baseUrl: "http://127.0.0.1:1/v1", key: { kind: "none" } }), /Could not reach/);
});

test("Pi adds, finds and removes through app_action's actions, with a key only as a secret's name", async () => {
    const { actions } = appSettings(app);
    const action = (id: string) => actions.find((each) => each.id === id)!;
    const me = owner(app);

    app.secrets.set("LOCAL_KEY", { value: "local-key-value-123" });
    assert.match(action("providers.customSave").help, /lm-studio \(LM Studio/);
    await assert.rejects(action("providers.customSave").run(me, { name: "Typed", baseUrl: base, models: "plain", key: "sk-typed-by-pi-123456" }), /There is no secret sk-typed-by-pi-123456: ask the person to type the key with secret_request/);
    assert.match(action("providers.customFind").describe({ baseUrl: base, key: "LOCAL_KEY" }), /with the key in secret LOCAL_KEY/);
    assert.match(await action("providers.customFind").run(me, { baseUrl: base, key: "LOCAL_KEY" }), /qwen3-coder, context 262144, output 65536, reasoning/);
    assert.equal(seen.at(-1)?.authorization, "Bearer local-key-value-123");

    const said = await action("providers.customSave").run(me, { name: "Local box", baseUrl: base, models: "plain, vision-1", key: "LOCAL_KEY" });

    assert.match(said, /Added local-box \(Local box/);
    assert.equal(read().providers["local-box"]?.apiKey, "$LOCAL_KEY");
    assert.doesNotMatch(readFileSync(file, "utf8"), /local-key-value-123/);
    assert.ok(usable("local-box", "vision-1"));

    // A change keeps its key when none is given.
    await action("providers.customSave").run(me, { id: "local-box", name: "Local box", baseUrl: base, models: '[{"id": "plain", "contextWindow": 8192}]' });
    assert.deepEqual(read().providers["local-box"]?.models, [{ id: "plain", contextWindow: 8192 }]);
    assert.equal(read().providers["local-box"]?.apiKey, "$LOCAL_KEY");

    await action("providers.customRemove").run(me, { id: "local-box" });
    assert.equal(read().providers["local-box"], undefined);
    assert.ok(!usable("local-box", "plain"));
});

test("remove takes the provider out, keeps the rest of the file and its secret", async () => {
    await app.customProviders.remove("lm-studio");

    const written = read();

    assert.equal(written.providers["lm-studio"], undefined);
    assert.deepEqual(written.providers.mine, BEFORE.providers.mine);
    assert.equal(app.models.getModel("lm-studio", "qwen3-coder"), undefined);
    assert.ok(!usable("lm-studio", "qwen3-coder"));
    assert.equal(app.secrets.value("LM_STUDIO_API_KEY"), KEY, "the key stays in Secrets");
    await assert.rejects(app.customProviders.remove("lm-studio"), /no OpenAI-compatible provider lm-studio/);
    await assert.rejects(app.customProviders.remove("mine"), /no OpenAI-compatible provider mine/, "the person's own other providers are not this list's");
});

test("only the owner: guests are refused the routes, and a team role without providers.custom everything", async () => {
    const server = createServer(createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }));

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/custom-providers`;
    const guest = app.config.addUser("Guest", "guest");
    const viewer = app.config.addUser("Viewer", "viewer");
    const call = (token: string, path = "", method = "GET", body?: unknown) =>
        fetch(`${url}${path}`, {
            method,
            headers: { authorization: `Bearer ${token}`, "X-Pocket": "1", "content-type": "application/json" },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
    const add = { name: "Guest's", baseUrl: base, key: { kind: "none" }, models: ["plain"] };

    try {
        for (const token of [guest.token, viewer.token]) {
            assert.equal((await call(token)).status, 403);
            assert.equal((await call(token, "", "POST", add)).status, 403);
            assert.equal((await call(token, "/discover", "POST", { baseUrl: base, key: { kind: "none" } })).status, 403);
        }

        assert.equal(read().providers["guest-s"], undefined);

        const listed = await call(app.config.ownerToken);

        assert.equal(listed.status, 200);
        assert.ok(Array.isArray(((await listed.json()) as { providers: unknown[] }).providers));

        const made = await call(app.config.ownerToken, "", "POST", { ...add, name: "Owner's box", key: { kind: "new", value: "owner-key-123456789" } });

        assert.equal(made.status, 200);
        assert.equal(read().providers["owner-s-box"]?.apiKey, "$OWNER_S_BOX_API_KEY");
        assert.equal((await call(app.config.ownerToken, "/owner-s-box", "DELETE")).status, 200);
        assert.equal((await call(app.config.ownerToken, "", "POST", { ...add, baseUrl: "file:///etc/passwd" })).status, 400);

        // On the team server, a role without providers.custom (a member's) gets none of it, its owner included.
        await app.applyPolicy(owner(app), { permissions: ["pi.use", "providers.signin", "settings.change", "secrets.use"], models: [], spendLimit: null, role: "Member" });
        assert.equal((await call(app.config.ownerToken)).status, 403);
        assert.match(app.policy.routeRefusal("custom-providers", "GET") ?? "", /Member does not include adding OpenAI-compatible providers/);
        await assert.rejects(
            appSettings(app).actions.find((each) => each.id === "providers.customSave")!.run(owner(app), { name: "x", baseUrl: base, models: "plain", key: "none" }),
            /Member does not include adding OpenAI-compatible providers/,
        );
    } finally {
        server.closeAllConnections();
        server.close();
    }
});
