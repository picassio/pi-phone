// The team's provider accounts (PP-69) behind the gateway's internal port, with better-auth on an in-memory database
// and real roles: someone with providers.manage adds one, signs it in with an API key through the relayed steps, renames
// and removes it, each in the Audit log; someone without it sees only the ones their role may use, and is refused the
// rest; a pi-phone's sign-in steps are its person's only; and the key never comes back out.
import { cleanUp, root } from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, before, test } from "node:test";
import { makeAuth } from "../src/gateway/auth.ts";
import { type ControllerClient, Gateway } from "../src/gateway/server.ts";
import { GatewayStore } from "../src/gateway/store.ts";
import { TeamAccounts } from "../src/gateway/team-accounts.ts";
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

const KEY = "sk-or-v1-team-test-key-0123456789";
let store: GatewayStore;
let teamDir = "";
let internal: Server;
let address = "";
const ids: Record<string, string> = {};

before(async () => {
    const db = new DatabaseSync(":memory:");

    store = new GatewayStore(db);

    const origin = "https://team.example.test";
    const auth = await makeAuth({ db, secret: store.authSecret(), origin });

    for (const [name, role] of [["Owner", "owner"], ["Ana", "member"], ["Binh", "member"]] as const) {
        const made = (await auth.api.createUser({ body: { name, email: `${name.toLowerCase()}@example.test`, password: "a long enough password", role } })) as { user: { id: string } };

        ids[name] = made.user.id;
    }

    // Ana manages the team's accounts; Binh is a member who may use some.
    store.saveRole({ id: "lead", name: "Lead", permissions: ["pi.use", "providers.manage"], memoryMb: 1024, cpus: 1, models: [], spendLimit: null, teamAccounts: [], builtin: false });
    store.setRoleOf(ids.Ana!, "lead");
    teamDir = mkdtempSync(join(root, "gw-team-"));

    const teamAccounts = new TeamAccounts(store, teamDir);

    await teamAccounts.open();

    const gateway = new Gateway({ auth, store, controller, ...served(store), teamAccounts, origin, log: () => undefined });

    internal = createServer((request, response) => void gateway.internal(request, response));
    await new Promise<void>((resolve) => internal.listen(0, "127.0.0.1", resolve));
    address = `http://127.0.0.1:${(internal.address() as { port: number }).port}`;
});

after(() => internal?.close());

type Step = { step: string; promptId?: string; prompt?: { type: string }; ok?: boolean };
type Row = { id: string; configured: boolean; models: number; roles: string[] };
/** What the route answers, by action. */
type Answer = { account: { id: string; name: string }; flowId: string; steps: Step[]; manage: boolean; accounts: Row[] };

/** The Audit log's team-account lines, oldest first: action · target. */
const auditLines = () =>
    store
        .auditLog()
        .filter((entry) => entry.action.startsWith("team account"))
        .reverse()
        .map((entry) => `${entry.action} · ${entry.target}`);

/** A call from someone's pi-phone, with its own token. */
async function call(name: string, body: Record<string, unknown>) {
    const response = await fetch(`${address}/internal/team-accounts`, { method: "POST", headers: { authorization: `Bearer ${store.box(ids[name]!).token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
    const answer = (await response.json()) as { value?: unknown; error?: string };

    return { status: response.status, value: answer.value as unknown as Answer, error: answer.error ?? "" };
}

test("someone with providers.manage adds a team account and signs it in with a key, through the relayed steps", async () => {
    const added = await call("Ana", { action: "add", provider: "openrouter", name: "Work" });

    assert.equal(added.status, 200, added.error);
    assert.equal(added.value.account.id, "openrouter~team-work");

    const login = await call("Ana", { action: "login", id: "openrouter~team-work", type: "api_key" });
    const flowId = login.value.flowId;
    let steps: Step[] = [];

    // The steps wait for Ana's pi-phone; the key prompt comes first.
    for (let after = 0; !steps.some((step) => step.step === "prompt"); ) {
        const waited = await call("Ana", { action: "wait", flowId, after });

        steps = [...steps, ...waited.value.steps];
        after = steps.length;
    }

    const prompt = steps.find((step) => step.step === "prompt")!;

    assert.equal(prompt.prompt?.type, "secret");
    // Not Binh's to see or answer.
    assert.equal((await call("Binh", { action: "wait", flowId, after: 0 })).status, 404);
    assert.equal((await call("Binh", { action: "answer", flowId, promptId: prompt.promptId, value: "x" })).status, 404);

    assert.equal((await call("Ana", { action: "answer", flowId, promptId: prompt.promptId, value: KEY })).status, 200);

    let done: Step | undefined;

    for (let after = steps.length; done === undefined; ) {
        const waited = await call("Ana", { action: "wait", flowId, after });

        after += waited.value.steps.length;
        done = waited.value.steps.find((step) => step.step === "done");
    }

    assert.equal(done.ok, true);

    const listed = await call("Ana", { action: "list" });
    const work = listed.value.accounts.find((each) => each.id === "openrouter~team-work")!;

    assert.equal(listed.value.manage, true);
    assert.equal(work.configured, true);
    assert.ok(work.models > 0, "its models");
    assert.deepEqual(work.roles, []);
    // The key is in the gateway's own file, and in no answer.
    assert.ok(readFileSync(join(teamDir, "team-providers", "auth.json"), "utf8").includes(KEY));
    assert.ok(!JSON.stringify(listed.value).includes(KEY));
    assert.deepEqual(
        auditLines(),
        ["team account added · OpenRouter · Team Work", "team account sign-in · OpenRouter · Team Work"],
    );
});

test("without providers.manage: only the team accounts one's role may use, and nothing to change", async () => {
    assert.deepEqual((await call("Binh", { action: "list" })).value, { manage: false, accounts: [] });

    store.saveRole({ ...store.role("member")!, teamAccounts: ["openrouter~team-work"] });
    const listed = await call("Binh", { action: "list" });

    assert.deepEqual(listed.value.accounts.map((each) => each.id), ["openrouter~team-work"]);
    assert.deepEqual(listed.value.accounts[0]!.roles, ["Member"]);

    for (const body of [{ action: "add", provider: "openrouter", name: "Mine" }, { action: "login", id: "openrouter~team-work", type: "api_key" }, { action: "remove", id: "openrouter~team-work" }, { action: "logout", id: "openrouter~team-work" }]) {
        const refused = await call("Binh", body);

        assert.equal(refused.status, 403, body.action);
        assert.match(refused.error, /Member does not include managing the team's provider accounts/);
    }

    // The owner's role uses every one.
    assert.deepEqual((await call("Owner", { action: "list" })).value.accounts.map((each) => each.id), ["openrouter~team-work"]);
});

test("renamed, then removed: gone from the list, from its roles, and its key from the gateway's file", async () => {
    const renamed = await call("Ana", { action: "rename", id: "openrouter~team-work", name: "Research" });

    assert.equal(renamed.value.account.name, "Research");
    assert.equal(renamed.value.account.id, "openrouter~team-work", "the id stays: sessions refer to it");

    assert.equal((await call("Ana", { action: "remove", id: "openrouter~team-work" })).status, 200);
    assert.deepEqual((await call("Ana", { action: "list" })).value.accounts, []);
    assert.deepEqual(store.role("member")!.teamAccounts, []);
    assert.ok(!readFileSync(join(teamDir, "team-providers", "auth.json"), "utf8").includes(KEY));
    assert.deepEqual(auditLines().slice(-2), ["team account renamed · OpenRouter · Team Research", "team account removed · OpenRouter · Team Research"]);
});

test("a token of no pi-phone is refused", async () => {
    const response = await fetch(`${address}/internal/team-accounts`, { method: "POST", headers: { authorization: "Bearer nobody", "content-type": "application/json" }, body: JSON.stringify({ action: "list" }) });

    assert.equal(response.status, 401);
});
