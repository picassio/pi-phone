// A team account's model answering a teammate through the gateway (PP-69, S2): the pi-phone lists the accounts its
// person's role may use, registers each as a provider whose answers come from the gateway, and gets the scripted
// model's events whole; a role without the account, or without the model, is refused with the reason; Stop ends the
// call on the gateway too; and an account taken off the role goes from the pi-phone at the next sync.
import { cleanUp, root, scriptedModel } from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, before, test } from "node:test";
import type { Api, AssistantMessage, Context, Model } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { makeAuth } from "../src/gateway/auth.ts";
import { type ControllerClient, Gateway } from "../src/gateway/server.ts";
import { GatewayStore } from "../src/gateway/store.ts";
import { TeamAccounts } from "../src/gateway/team-accounts.ts";
import { TeamAccountsClient } from "../src/server/team-accounts.ts";
import { served } from "./gateway-served.ts";

after(() => cleanUp());

const controller: ControllerClient = {
    ensure: async () => ({ host: "127.0.0.1", port: 1 }),
    list: async () => [],
    stop: async () => undefined,
    remove: async () => undefined,
    export: async () => {
        throw new Error("not here");
    },
};

let store: GatewayStore;
let internal: Server;
let address = "";
const ids: Record<string, string> = {};
/** The scripted model on the gateway: what it was last asked, and how many calls it answered. */
const asked: { calls: number; aborted: number } = { calls: 0, aborted: 0 };

before(async () => {
    const db = new DatabaseSync(":memory:");

    store = new GatewayStore(db);

    const origin = "https://team.example.test";
    const auth = await makeAuth({ db, secret: store.authSecret(), origin });

    for (const [name, role] of [["Owner", "owner"], ["Binh", "member"]] as const) {
        const made = (await auth.api.createUser({ body: { name, email: `${name.toLowerCase()}@example.test`, password: "a long enough password", role } })) as { user: { id: string } };

        ids[name] = made.user.id;
    }

    // The gateway's own runtime, with the scripted provider as the team account's base: it answers "echo: …", slowly
    // when asked to "stream a long answer".
    const faux = scriptedModel((context, options) => {
        const last = (context as Context).messages.at(-1);
        const text = typeof last?.content === "string" ? last.content : "";

        asked.calls += 1;
        options?.signal?.addEventListener("abort", () => (asked.aborted += 1));

        return fauxAssistantMessage([fauxText(`echo: ${text}`)]);
    });
    const dir = mkdtempSync(join(root, "gw-relay-"));
    const runtime = await ModelRuntime.create({ authPath: join(dir, "auth.json"), modelsPath: null });

    runtime.registerNativeProvider(faux.provider);

    const teamAccounts = new TeamAccounts(store, dir);

    await teamAccounts.open(runtime);
    teamAccounts.add("faux", "Work", ids.Owner!);
    await runtime.setRuntimeApiKey("faux~team-work", "key-on-the-gateway");
    store.saveRole({ ...store.role("member")!, teamAccounts: ["faux~team-work"] });

    const gateway = new Gateway({ auth, store, controller, ...served(store), teamAccounts, origin, log: () => undefined });

    internal = createServer((request, response) => void gateway.internal(request, response));
    await new Promise<void>((resolve) => internal.listen(0, "127.0.0.1", resolve));
    address = `http://127.0.0.1:${(internal.address() as { port: number }).port}`;
});

after(() => internal?.close());

/** Binh's pi-phone: a model runtime with the base provider, and the client with his token. */
async function binhsPiPhone() {
    const models = await ModelRuntime.create({ authPath: join(mkdtempSync(join(root, "pp-relay-")), "auth.json"), modelsPath: null });

    models.registerNativeProvider(scriptedModel().provider);

    const client = new TeamAccountsClient({ url: address, token: store.box(ids.Binh!).token }, () => undefined);

    await client.sync(models);

    return { models, client };
}

const ask = (text: string) => ({ messages: [{ role: "user" as const, content: text, timestamp: Date.now() }] });

test("a teammate's pi-phone lists the team account's models and gets its answers through the gateway", async () => {
    const { models } = await binhsPiPhone();
    const listed = models.getModels("faux~team-work");

    assert.deepEqual(listed.map((model) => model.id), ["faux-1", "faux-2", "faux-vision"]);
    assert.equal(models.getProvider("faux~team-work")?.name.endsWith("· Team Work"), true);
    assert.ok((await models.getAvailable()).some((model) => model.provider === "faux~team-work"), "available to pick");

    const before = asked.calls;
    const answer: AssistantMessage = await models.completeSimple(listed[0] as Model<Api>, ask("hello team"));

    assert.equal(answer.stopReason, "stop", answer.errorMessage ?? "");
    assert.deepEqual(answer.content, [{ type: "text", text: "echo: hello team" }]);
    assert.equal(asked.calls, before + 1, "answered on the gateway");
});

test("a role without the account, or without the model, is refused with the reason", async () => {
    const { models } = await binhsPiPhone();
    const model = models.getModels("faux~team-work")[0] as Model<Api>;

    // Only faux-2 for Members now: faux-1 is refused.
    store.saveRole({ ...store.role("member")!, models: ["faux~team-work/faux-2"] });
    const refused = await models.completeSimple(model, ask("x"));

    assert.equal(refused.stopReason, "error");
    assert.match(refused.errorMessage ?? "", /Member may not use the model faux-1/);

    // The account taken off the role: refused at once, and gone from the pi-phone at the next sync.
    store.saveRole({ ...store.role("member")!, models: [], teamAccounts: [] });
    const gone = await models.completeSimple(model, ask("x"));

    assert.match(gone.errorMessage ?? "", /Member may not use this team account/);

    const { models: later } = await binhsPiPhone();

    assert.deepEqual(later.getModels("faux~team-work"), []);
    store.saveRole({ ...store.role("member")!, teamAccounts: ["faux~team-work"] });
});

test("Stop ends the call on the gateway too", async () => {
    const { models } = await binhsPiPhone();
    const model = models.getModels("faux~team-work")[0] as Model<Api>;
    const stop = new AbortController();
    const before = asked.aborted;
    const events = models.streamSimple(model, ask("a long answer ".repeat(200)), { signal: stop.signal });
    const seen: string[] = [];

    for await (const event of events) {
        seen.push(event.type);

        if (event.type === "text_delta" && seen.filter((type) => type === "text_delta").length === 2) {
            stop.abort();
        }
    }

    const result = await events.result();

    assert.equal(result.stopReason, "aborted");

    for (let waited = 0; asked.aborted === before && waited < 40; waited++) {
        await new Promise((resolve) => setTimeout(resolve, 50));
    }

    assert.equal(asked.aborted, before + 1, "the gateway's call was stopped");
});

test("each answer's cost is counted to the person and the account, and the role's team spend limit refuses past it", async () => {
    const { models } = await binhsPiPhone();
    const model = models.getModels("faux~team-work")[0] as Model<Api>;
    const month = new Date().toISOString().slice(0, 7);
    const before = store.teamSpendOf(month, ids.Binh!);
    const answer = await models.completeSimple(model, ask("count me"));
    const row = store.teamSpend(month).find((each) => each.userId === ids.Binh && each.account === "faux~team-work");

    assert.equal(answer.stopReason, "stop", answer.errorMessage ?? "");
    assert.ok(row !== undefined && row.tokens > 0, "counted by person and account");
    assert.ok(store.teamSpendOf(month, ids.Binh!) >= before, "the month's sum");

    // Past the role's limit (here $0, so any spend reaches it): refused with the reason, before the model is asked.
    store.addTeamSpend(month, ids.Binh!, "faux~team-work", 0.5, 0);
    store.saveRole({ ...store.role("member")!, teamSpendLimit: 0.25 });
    const calls = asked.calls;
    const refused = await models.completeSimple(model, ask("more"));

    assert.equal(refused.stopReason, "error");
    assert.match(refused.errorMessage ?? "", /You've used this month's team spend \(Member: \$0\.25 a month\)/);
    assert.equal(asked.calls, calls, "not asked");

    // Empty again (no limit): answers again.
    store.saveRole({ ...store.role("member")!, teamSpendLimit: null });
    assert.equal((await models.completeSimple(model, ask("again"))).stopReason, "stop");
});
