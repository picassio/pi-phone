// A team account's limit, through the team server (PP-135): the gateway passes the provider's refusal on to the
// person's pi-phone with its status and limit headers, and does not wait itself; the limit gate on the pi-phone reads
// them as it reads its own requests', and waits until the provider's reset. The provider is pi-ai's Anthropic adapter
// on the gateway, talking to a fake Anthropic API over real HTTP.
import { cleanUp, root } from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, before, test } from "node:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { makeAuth } from "../src/gateway/auth.ts";
import { type ControllerClient, Gateway } from "../src/gateway/server.ts";
import { GatewayStore } from "../src/gateway/store.ts";
import { TeamAccounts } from "../src/gateway/team-accounts.ts";
import { LimitGate } from "../src/server/limit-gate.ts";
import { TeamAccountsClient } from "../src/server/team-accounts.ts";
import { type FakeReply, fakeAnthropic, fiveHourLimit, localAnthropic, MODEL_ID, weeklyLimit } from "./support/fake-anthropic.ts";
import { served } from "./gateway-served.ts";

const controller: ControllerClient = {
    ensure: async () => ({ host: "127.0.0.1", port: 1 }),
    list: async () => [],
    stop: async () => undefined,
    remove: async () => undefined,
    export: async () => {
        throw new Error("not here");
    },
};

const BASE = "claude-local";
const TEAM = `${BASE}~team-work`;
let behave: (token: string, call: number) => FakeReply = () => ({ text: "answered" });
let provider: Awaited<ReturnType<typeof fakeAnthropic>>;
let store: GatewayStore;
let internal: Server;
let address = "";
const ids: Record<string, string> = {};

before(async () => {
    provider = await fakeAnthropic((token, call) => behave(token, call));

    const db = new DatabaseSync(":memory:");

    store = new GatewayStore(db);

    const origin = "https://team.example.test";
    const auth = await makeAuth({ db, secret: store.authSecret(), origin });

    for (const [name, role] of [["Owner", "owner"], ["Binh", "member"]] as const) {
        const made = (await auth.api.createUser({ body: { name, email: `${name.toLowerCase()}@example.test`, password: "a long enough password", role } })) as { user: { id: string } };

        ids[name] = made.user.id;
    }

    // The gateway's runtime: the team's Claude account, on the fake provider.
    const dir = mkdtempSync(join(root, "gw-limits-"));
    const runtime = await ModelRuntime.create({ authPath: join(dir, "auth.json"), modelsPath: null });

    // Under an id of its own: the gateway makes Claude's own team accounts from pi-ai's real provider.
    runtime.registerNativeProvider(localAnthropic(provider.url, BASE));

    const teamAccounts = new TeamAccounts(store, dir);

    await teamAccounts.open(runtime);
    teamAccounts.add(BASE, "Work", ids.Owner!);
    await runtime.setRuntimeApiKey(TEAM, "tok-team");
    store.saveRole({ ...store.role("member")!, teamAccounts: [TEAM] });

    const gateway = new Gateway({ auth, store, controller, ...served(store), teamAccounts, origin, log: () => undefined });

    internal = createServer((request, response) => void gateway.internal(request, response));
    await new Promise<void>((resolve) => internal.listen(0, "127.0.0.1", resolve));
    address = `http://127.0.0.1:${(internal.address() as { port: number }).port}`;
});

after(() => {
    internal?.close();
    provider?.close();
    cleanUp();
});

/** Binh's pi-phone: its model runtime with the team account from the gateway, and its limit gate. */
async function binhsPiPhone() {
    const models = await ModelRuntime.create({ authPath: join(mkdtempSync(join(root, "pp-limits-")), "auth.json"), modelsPath: null });

    models.registerNativeProvider(localAnthropic(provider.url, BASE));

    const client = new TeamAccountsClient({ url: address, token: store.box(ids.Binh!).token }, () => undefined, () => ({ enabled: false, version: "2.1.280" }));

    await client.sync(models);

    const gate = new LimitGate({
        hours: () => 6,
        epoch: () => 0,
        conversationOf: () => undefined,
        changed: () => {},
        log: () => {},
        tuning: { minWaitMs: 50, resetJitterMs: [0, 0] },
    });

    gate.install(models);

    return { models, gate, model: models.getModel(TEAM, MODEL_ID) as Model<Api> };
}

const ask = { messages: [{ role: "user" as const, content: "hello", timestamp: Date.now() }] };

test("a team account's 5-hour limit reaches the pi-phone with its headers: it waits there until the reset, the gateway does not", async () => {
    const { models, gate, model } = await binhsPiPhone();
    const resetAt = Date.now() + 2000;
    const from = provider.calls.length;

    assert.ok(model, "the team account's model is here");
    behave = (_token, call) => (call === from ? fiveHourLimit(resetAt) : { text: "answered on the team account" });

    const answer = models.streamSimple(model, ask).result();
    const ended = { message: undefined as Awaited<typeof answer> | undefined };

    void answer.then((message) => (ended.message = message));

    for (let i = 0; i < 500 && gate.gates().length === 0 && ended.message === undefined; i++) {
        await new Promise((resolve) => setTimeout(resolve, 10));
    }

    assert.equal(ended.message?.errorMessage, undefined, "it waits rather than failing");

    const [wait] = gate.gates();

    assert.deepEqual([wait?.key, wait?.scope, wait?.kind, wait?.window, wait?.source], [TEAM, "account", "reset", "5-hour", "header"]);
    assert.equal(wait?.resetAt, Math.ceil(resetAt / 1000) * 1000, "the provider's own reset, passed on by the gateway");
    assert.ok(Date.now() < resetAt, "the refusal came at once: the gateway did not wait");

    const message = await answer;

    assert.equal(message.stopReason, "stop", message.errorMessage ?? "");
    assert.ok(Date.now() >= resetAt);
    assert.deepEqual(
        provider.calls.slice(from).map((each) => each.token),
        ["tok-team", "tok-team"],
        "one refused request, then the one at the reset, both with the team's sign-in on the gateway",
    );
    gate.close();
});

test("a team account's weekly window fails at once on the pi-phone, with its reset", async () => {
    const { models, gate, model } = await binhsPiPhone();
    const from = provider.calls.length;

    behave = () => weeklyLimit(Date.now() + 2 * 86_400_000);

    const message = await models.streamSimple(model, ask).result();

    assert.equal(message.stopReason, "error");
    assert.match(message.errorMessage ?? "", /Not waiting: it resets in 2 d .*a limit of days/);
    assert.equal(provider.calls.length, from + 1);
    gate.close();
});
