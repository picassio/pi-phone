// A run that hits a provider's limit waits inside its request until the provider's own reset, and goes on by itself
// (PP-135, pi-pocket 0.21.0's wait, with pi-phone's additions). The provider is pi-ai's own Anthropic adapter talking
// to a fake Anthropic API over real HTTP, so the limit's status and headers come the way a real provider sends them.
import { type App, cleanUp, fakeTab, home, owner, root, work } from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { ConversationId } from "@earendil-works/pi-durable";
import { createHandler } from "../src/server/http.ts";
import type { LimitTuning } from "../src/server/limit-gate.ts";
import { inLanguage, type PhoneEvent } from "../src/server/phone-events.ts";
import { translator } from "../src/server/i18n.ts";
import { type FakeReply, fakeAnthropic, fiveHourLimit, localAnthropic, MODEL_ID, overloaded, plainLimit, signIns, weeklyLimit } from "./support/fake-anthropic.ts";

const { PocketApp } = await import("../src/server/app.ts");

const TUNING: Partial<LimitTuning> = { minWaitMs: 50, resetJitterMs: [0, 0], backoffMs: [300], spacingMs: [10, 20] };
const agentDir = join(root, "agent");

/** What the fake provider answers now: by the request's token (the account), and its number. */
let behave: (token: string, call: number) => FakeReply = () => ({ text: "answered" });
/** Each account's usage bars, by token, as Claude's usage endpoint answers them. */
let usage: Record<string, { five: number; fiveReset: number; week?: number }> = {};

let provider: Awaited<ReturnType<typeof fakeAnthropic>>;
const apps: App[] = [];
let server: Server | undefined;
let port = 0;

before(async () => {
    provider = await fakeAnthropic((token, call) => behave(token, call));
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(agentDir, "auth.json"), signIns({ anthropic: "tok-default", "anthropic~work": "tok-work" }));
    // Pi Durable's own short retries, quick: a refusal the gate gives fails the run in a moment.
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ retry: { baseDelayMs: 20 } }));
});

after(async () => {
    server?.closeAllConnections();
    server?.close();

    for (const app of apps) {
        await app.close();
    }

    provider?.close();
    cleanUp();
});

/** Claude's usage endpoint, as `usage-limits.ts` asks it, answering from `usage` by the account's token. */
const usageFetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    const token = String(new Headers(init?.headers).get("authorization") ?? "").replace(/^Bearer /, "");
    const bars = usage[token];

    if (bars === undefined) {
        return new Response("{}", { status: 404 });
    }

    return Response.json({
        five_hour: { utilization: bars.five, resets_at: new Date(bars.fiveReset).toISOString() },
        seven_day: { utilization: bars.week ?? 10, resets_at: new Date(Date.now() + 4 * 86_400_000).toISOString() },
    });
}) as typeof fetch;

async function open(dir = join(root, `limits-${apps.length}`), tuning: Partial<LimitTuning> = TUNING): Promise<App> {
    const app = await PocketApp.open({
        dataDir: dir,
        defaultCwd: work,
        supervised: false,
        log: () => {},
        home,
        configureModels: (models) => models.registerNativeProvider(localAnthropic(provider.url)),
        accountProviders: { anthropic: () => localAnthropic(provider.url) },
        usageFetch,
        limits: tuning,
        officecli: { runs: false },
    });

    apps.push(app);

    return app;
}

/** The app's HTTP API, as a browser calls it. */
async function http(app: App) {
    server?.closeAllConnections();
    server?.close();
    server = createServer(createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }));
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    port = (server.address() as { port: number }).port;

    return (route: string, body: unknown = {}, token = app.config.ownerToken) =>
        fetch(`http://127.0.0.1:${port}/api/${route}`, {
            method: "POST",
            headers: { authorization: `Bearer ${token}`, "x-pocket": "1", "content-type": "application/json" },
            body: JSON.stringify(body),
        });
}

async function session(app: App, account = "anthropic"): Promise<ConversationId> {
    app.config.lastModel ??= { provider: account, modelId: MODEL_ID, thinkingLevel: "off" };
    const { id } = await app.commands.createSession(owner(app), { cwd: work });

    await app.commands.configure(id, owner(app), { model: { provider: account, modelId: MODEL_ID }, thinkingLevel: "off" });

    return id;
}

const send = (app: App, id: ConversationId, text = "hello") => app.commands.submit(id, owner(app), { text, requestId: crypto.randomUUID() });

async function until(check: () => Promise<boolean> | boolean, what: string, timeoutMs = 15_000): Promise<void> {
    const started = Date.now();

    while (!(await check())) {
        if (Date.now() - started > timeoutMs) {
            throw new Error(`Timed out waiting for ${what}`);
        }

        await new Promise((resolve) => setTimeout(resolve, 25));
    }
}

type Reply = { kind: string; stopReason?: string; error?: string };
const replies = async (app: App, id: ConversationId) => ((await app.transcripts.allEntries(id, false)) as Reply[]).filter((entry) => entry.kind === "assistant");
const last = async (app: App, id: ConversationId) => (await replies(app, id)).at(-1);
const answered = async (app: App, id: ConversationId) => (await last(app, id))?.stopReason === "stop";
const callsSince = (from: number) => provider.calls.slice(from);

test("a 429 with Claude's 5-hour reset waits until that time, shows the wait, tells the phone once, and answers by itself", async () => {
    const app = await open(undefined, { ...TUNING, longWaitMs: 1000 });
    const id = await session(app);
    const tab = fakeTab(id, owner(app));
    const events: Omit<PhoneEvent, "seq" | "at">[] = [];

    app.phoneEvents.subscribe((event) => events.push(event));
    await app.attach(tab.client);

    const resetAt = Date.now() + 2500;
    const from = provider.calls.length;

    behave = (_token, call) => (call === from ? fiveHourLimit(resetAt) : { text: "answered" });
    await send(app, id);
    await until(() => app.limits.waitFor(Number(id)) !== undefined, "the run to wait");

    const wait = app.limits.waitFor(Number(id))!;

    assert.deepEqual([wait.scope, wait.kind, wait.window, wait.source, wait.key], ["account", "reset", "5-hour", "header", "anthropic"]);
    assert.equal(wait.resetAt, Math.ceil(resetAt / 1000) * 1000, "the provider's own reset");
    await until(() => (tab.field("live") as { limit?: unknown } | undefined)?.limit !== undefined, "the view to show the wait");

    const shown = (tab.field("live") as { limit: Record<string, unknown> }).limit;

    assert.equal(shown.providerName, "Anthropic");
    assert.equal(shown.window, "5-hour");
    assert.equal(typeof app.sessions().find((each) => each.id === Number(id))?.limited, "number", "the session list marks it limited");

    await until(() => answered(app, id), "the answer by itself");
    assert.ok(Date.now() >= resetAt, "not before the reset");
    assert.equal(callsSince(from).length, 2, "one refused request, then the one at the reset");
    assert.ok(!(await replies(app, id)).some((reply) => reply.stopReason === "error"), "no failure on record");
    assert.equal(app.sessions().find((each) => each.id === Number(id))?.limited, undefined);

    const told = events.filter((event) => event.kind === "limit");

    assert.equal(told.length, 1, "one notice for the wait");

    const english = inLanguage({ ...told[0]!, seq: 1, at: 0 }, translator("en"));

    assert.equal(english.heading, "Waiting for a limit: hello");
    assert.match(english.text, /^Anthropic's 5-hour limit · goes on by itself at \d\d:\d\d$/);
    assert.match(inLanguage({ ...told[0]!, seq: 1, at: 0 }, translator("zh-CN")).heading, /^等待额度恢复：hello$/);
});

test("an overload with no time waits growing gaps, and the notice stays off when the owner turned it off", async () => {
    const app = await open(undefined, { ...TUNING, longWaitMs: 0 });
    const id = await session(app);
    const events: string[] = [];

    app.phoneEvents.subscribe((event) => events.push(event.kind));
    await app.setLimitNotice(owner(app), false);

    const from = provider.calls.length;

    behave = (_token, call) => (call === from ? overloaded : { text: "answered" });
    await send(app, id);
    await until(() => app.limits.waitFor(Number(id)) !== undefined, "the run to wait");
    assert.deepEqual([app.limits.waitFor(Number(id))?.kind, app.limits.waitFor(Number(id))?.scope], ["backoff", "model"]);
    await until(() => answered(app, id), "the answer after the gap");
    assert.equal(callsSince(from).length, 2);
    assert.ok(!events.includes("limit"), "no notice: it is off");
});

test("a weekly window fails at once, with its reset in the error, and sends nothing more", async () => {
    const app = await open();
    const id = await session(app);
    const from = provider.calls.length;

    behave = () => weeklyLimit(Date.now() + 3 * 86_400_000);
    await send(app, id);
    await until(async () => (await last(app, id))?.stopReason === "error" && !app.isBusy(id), "the failure", 20_000);
    assert.match((await last(app, id))!.error ?? "", /Not waiting: it resets in 3 d .*a limit of days/);
    assert.equal(callsSince(from).length, 1, "Pi Durable's own retries meet the refusal: no second request");
});

test("a 429 with no time waits for the reset the account's usage bars know", async () => {
    const app = await open();
    const id = await session(app);
    const fiveReset = Date.now() + 2000;
    const from = provider.calls.length;

    usage = { "tok-default": { five: 100, fiveReset } };
    behave = (_token, call) => (call === from ? plainLimit : { text: "answered" });
    await send(app, id);
    await until(() => app.limits.waitFor(Number(id))?.kind === "reset", "the wait until the bars' reset");

    const wait = app.limits.waitFor(Number(id))!;

    assert.deepEqual([wait.source, wait.window, wait.scope, wait.resetAt], ["usage", "5-hour", "account", fiveReset]);
    await until(() => answered(app, id), "the answer at the reset");
    assert.ok(Date.now() >= fiveReset);
    assert.equal(callsSince(from).length, 2);
    usage = {};
});

test("Stop ends a wait at once; Retry now (over HTTP, not for a viewer) sends the request at once", async () => {
    const app = await open();
    const call = await http(app);
    const stopped = await session(app);
    const retried = await session(app);
    const from = provider.calls.length;

    behave = () => fiveHourLimit(Date.now() + 3_600_000);
    await send(app, stopped);
    await until(() => app.limits.waitFor(Number(stopped)) !== undefined, "the run to wait");

    const started = Date.now();

    assert.equal((await call(`c/${stopped}/abort`)).status, 200);
    await until(() => !app.isBusy(stopped), "the stopped run to end");
    assert.ok(Date.now() - started < 3000);
    assert.equal(callsSince(from).length, 1);

    // The account's gate stays closed: the next run waits with no request of its own.
    await send(app, retried);
    await until(() => app.limits.waitFor(Number(retried)) !== undefined, "the second run to wait");
    assert.equal(callsSince(from).length, 1, "it waits at the gate the first found");

    const viewer = app.config.addUser("Vee", "viewer");

    assert.equal((await call(`c/${retried}/limit/retry`, {}, viewer.token)).status, 403);
    behave = () => ({ text: "answered" });
    assert.deepEqual(await (await call(`c/${retried}/limit/retry`)).json(), { ok: true });
    await until(() => answered(app, retried), "the answer");
    assert.equal(callsSince(from).length, 2);
    assert.deepEqual(await (await call(`c/${retried}/limit/retry`)).json(), { ok: false }, "nothing waits now");
});

test("a restart in the middle of a wait: the run waits again with no request, and answers by its own time", async () => {
    const dir = join(root, "limits-restart");
    let app = await open(dir);
    const id = await session(app);
    const resetAt = Date.now() + 4000;
    const from = provider.calls.length;

    behave = (_token, call) => (call === from ? fiveHourLimit(resetAt) : { text: "answered" });
    await send(app, id);
    await until(() => app.limits.waitFor(Number(id)) !== undefined, "the run to wait");
    await app.close();
    apps.splice(apps.indexOf(app), 1);

    app = await open(dir);
    await until(() => app.limits.waitFor(Number(id)) !== undefined || provider.calls.length > from + 1, "the run to resume", 15_000);
    assert.equal(provider.calls.length, from + 1, "the replayed request waits at the kept gate: no request");
    await until(() => answered(app, id), "the answer by its own time", 20_000);
    assert.ok(Date.now() >= resetAt);
    assert.equal(callsSince(from).length, 2);
});

test("another account with room: the card offers it; Wait keeps waiting, Move sends the request through it", async () => {
    const app = await open();
    const call = await http(app);

    app.accounts.add("anthropic", "Work");

    const waits = await session(app);
    const moves = await session(app);
    const waitTab = fakeTab(waits, owner(app));
    const moveTab = fakeTab(moves, owner(app));
    const reset = Date.now() + 3_600_000;
    const from = provider.calls.length;

    await app.attach(waitTab.client);
    await app.attach(moveTab.client);
    usage = { "tok-default": { five: 100, fiveReset: reset }, "tok-work": { five: 20, fiveReset: reset + 60_000, week: 30 } };
    behave = (token) => (token === "tok-work" ? { text: "answered at work" } : fiveHourLimit(reset));

    type Offer = { conversationId: number; to: string; toName: string; toUsed: number; toWindow: string; window: string; providerName: string };
    const offers = (tab: ReturnType<typeof fakeTab>) => (tab.field("limitOffers") ?? []) as Offer[];

    await send(app, waits);
    await until(() => offers(waitTab).length === 1, "the card");

    const [offer] = offers(waitTab);

    assert.deepEqual(
        [offer!.conversationId, offer!.to, offer!.toUsed, offer!.toWindow, offer!.window, offer!.providerName, offer!.toName],
        [Number(waits), "anthropic~work", 20, "5-hour", "5-hour", "Anthropic", "Anthropic · Work"],
    );

    // Wait: the card goes, and the run keeps waiting.
    assert.equal((await call(`c/${waits}/limit/answer`, { choice: "wait" })).status, 200);
    await until(() => offers(waitTab).length === 0, "the card to go");
    assert.ok(app.limits.waitFor(Number(waits)));

    // Move: the other session's waiting request goes through the Work account, and the session uses it from now on.
    await send(app, moves);
    await until(() => offers(moveTab).length === 1, "the second card");
    assert.equal((await call(`c/${moves}/limit/answer`, { choice: "move", to: "anthropic~other" })).status, 409, "only the account offered");
    assert.equal((await call(`c/${moves}/limit/answer`, { choice: "move", to: "anthropic~work" })).status, 200);
    await until(() => answered(app, moves), "the answer through the other account");
    assert.deepEqual(
        callsSince(from).map((each) => each.token),
        ["tok-default", "tok-work"],
        "the second run met the closed gate, and went to Work: one request",
    );
    assert.equal((await app.agentState(moves))?.model?.provider, "anthropic~work");
    assert.ok(app.limits.waitFor(Number(waits)), "the session that chose to wait still waits");
    await app.commands.abort(waits, owner(app));
    usage = {};
});
