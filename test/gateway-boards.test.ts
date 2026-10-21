// The team server's board service (PP-39) behind the gateway's internal port, with better-auth on an in-memory
// database and real roles: only a pi-phone's own token is let in, and it acts only as its person or their Pi; their
// role's permissions decide making, sharing and deleting boards; what is personal (folder, places, main session,
// running Pi's tasks by itself) is never kept centrally; Pi's sessions are kept as `<pi-phone>:<number>`; the store's
// internal lookups only show what the person may see; projects.view_all looks are logged; and an account that is gone
// hands its boards to the team. And Pi's team tools (PP-45) reach the gateway's own routes as the person, marked as Pi's.
import { cleanUp, root } from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, before, test } from "node:test";
import { makeAuth } from "../src/gateway/auth.ts";
import { BoardService } from "../src/gateway/boards.ts";
import { DocService } from "../src/gateway/docs.ts";
import { type ControllerClient, Gateway } from "../src/gateway/server.ts";
import { GatewayStore } from "../src/gateway/store.ts";

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
let boards: BoardService;
let docs: DocService;
let internal: Server;
let address = "";
const ids: Record<string, string> = {};

before(async () => {
    const db = new DatabaseSync(":memory:");

    store = new GatewayStore(db);

    const origin = "https://team.example.test";
    const auth = await makeAuth({ db, secret: store.authSecret(), origin });

    for (const [name, role] of [["Owner", "owner"], ["Binh", "member"], ["Chi", "member"], ["Dao", "member"]] as const) {
        const made = (await auth.api.createUser({ body: { name, email: `${name.toLowerCase()}@example.test`, password: "a long enough password", role } })) as { user: { id: string } };

        ids[name] = made.user.id;
    }

    // Dao's role can't make boards.
    store.saveRole({ id: "reader", name: "Reader", permissions: ["pi.use"], memoryMb: 1024, cpus: 1, models: [], spendLimit: null, builtin: false });
    store.setRoleOf(ids.Dao!, "reader");
    const dir = mkdtempSync(join(root, "gw-boards-"));

    boards = new BoardService(store, dir);
    docs = new DocService(store, boards, dir);

    const gateway = new Gateway({ auth, store, controller, boards, docs, origin, log: () => undefined });

    internal = createServer((request, response) => void gateway.internal(request, response));
    await new Promise<void>((resolve) => internal.listen(0, "127.0.0.1", resolve));
    address = `http://127.0.0.1:${(internal.address() as { port: number }).port}`;
});

after(() => {
    internal?.close();
    boards?.close();
});

/** A call from someone's pi-phone, with its token (or another). */
async function call(name: string, method: string, args: unknown[], pi?: { conversationId: string; closer: string }, token = store.box(ids[name]!).token) {
    const response = await fetch(`${address}/internal/boards`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ method, args, ...(pi === undefined ? {} : { pi }) }) });
    const body = (await response.json()) as { value?: unknown; error?: string };

    return { status: response.status, value: body.value as Record<string, unknown> & Record<string, never>, error: body.error ?? "" };
}

test("pi-phones share boards through the gateway, as their own person or their Pi, by their role", async () => {
    // Only a pi-phone's own token.
    assert.equal((await call("Binh", "list", [], undefined, "x".repeat(32))).status, 401);
    assert.equal((await fetch(`${address}/internal/boards`, { method: "POST" })).status, 401);

    // The team to share with (names only), and who each pi-phone's person is there (PP-43).
    const team = (await call("Binh", "people", [])).value as unknown as { id: string; name: string; role: string }[];

    assert.deepEqual(team.map((person) => person.name).sort(), ["Binh", "Chi", "Dao", "Owner"]);
    assert.deepEqual((await call("Binh", "me", [])).value, { id: ids.Binh, name: "Binh", managesTeam: false, seesAll: false, canCreate: true, canShare: true, canDelete: false });
    assert.equal(((await call("Owner", "me", [])).value as unknown as { managesTeam: boolean }).managesTeam, true, "the owner manages team boards");

    // Binh makes a board; its folder stays his own, never kept here.
    const made = await call("Binh", "create", [{ key: "web", name: "Website", folder: "/data/home/web" }]);

    assert.equal(made.status, 200);
    assert.deepEqual([made.value.key, made.value.folder, made.value.owner], ["WEB", null, ids.Binh]);
    assert.match((await call("Binh", "update", ["WEB", { places: [{ folder: "/x", cap: 1 }] }])).error, /each person's own/);
    assert.match((await call("Dao", "create", [{ key: "NO", name: "x" }])).error, /Making boards is not part of your role/);

    // Chi doesn't see it, even through the store's lookups, until it's shared.
    const task = (await call("Binh", "createTask", ["WEB", { title: "Header" }])).value;

    assert.deepEqual((await call("Chi", "list", [])).value, []);
    assert.equal((await call("Chi", "taskById", [task.id])).value, null);
    assert.deepEqual((await call("Chi", "allProjects", [])).value, []);
    assert.match((await call("Dao", "setMembers", ["WEB", [ids.Chi]])).error, /Sharing boards is not part of your role/);

    await call("Binh", "setMembers", ["WEB", [ids.Chi], { [ids.Chi!]: "member" }]);
    assert.equal(((await call("Chi", "allProjects", [])).value as unknown as unknown[]).length, 1);

    // Chi's Pi comments: its session is kept with Chi's pi-phone's key; another pi-phone's session 7 is a different one.
    const comment = (await call("Chi", "comment", [task.ref, "On it."], { conversationId: "7", closer: "person" })).value;

    assert.equal(comment.session, `${store.box(ids.Chi!).key}:7`);
    assert.equal(comment.authorName, "Pi");
    assert.match((await call("Chi", "comment", [task.ref, "x"], { conversationId: "7", closer: "anyone" })).error, /Who closes tasks/);

    // The owner sees it through projects.view_all, logged; a pi-phone can't name another person.
    assert.equal((await call("Owner", "board", ["WEB"])).status, 200);
    assert.ok(store.auditLog().some((entry) => entry.action === "board shared" && entry.actor === ids.Binh));
    assert.ok(store.auditLog().some((entry) => entry.action === "viewed board (view_all)" && entry.actor === ids.Owner));
    assert.match((await call("Binh", "nonsense", [])).error, /not something the board service does/);

    // Deleting needs projects.delete, which Member doesn't have.
    assert.match((await call("Binh", "remove", ["WEB"])).error, /Deleting boards is not part of your role/);

    // Binh's account goes: his board becomes the team's, and Chi keeps it.
    boards.forgetPerson(ids.Binh!);
    const kept = (await call("Chi", "project", ["WEB"])).value;

    assert.deepEqual([kept.owner, kept.team], ["team", true]);
    assert.deepEqual(boards.membersOf(String(kept.id)).sort(), [ids.Chi, ids.Owner].sort(), "those who hear of its changes");
});

/** A team call from someone's pi-phone (PP-45): the gateway's own route, as that person, for Pi's tools. */
async function team(name: string, route: string, method: string, body?: unknown) {
    const response = await fetch(`${address}/internal/team`, { method: "POST", headers: { authorization: `Bearer ${store.box(ids[name]!).token}`, "content-type": "application/json" }, body: JSON.stringify({ route, method, ...(body === undefined ? {} : { body }) }) });

    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

test("Pi's team tools reach the gateway's own routes, with the person's rights, marked as Pi's; never passwords, exports or backups", async () => {
    // The owner's Pi lists people and makes an invite; the audit log says it was Pi, for the owner.
    assert.equal((await team("Owner", "people", "GET")).status, 200);
    const invite = await team("Owner", "invites", "POST", { role: "member", minutes: 60 });

    assert.equal(invite.status, 200);
    assert.match(String(invite.body.url), /\/auth\/invite\//);
    assert.ok(store.auditLog().some((entry) => entry.action === "invite made" && entry.actor === `pi:${ids.Owner}`), "Pi for the owner");

    // A member's Pi has a member's rights.
    assert.match(String((await team("Chi", "people", "GET")).body.error), /does not see people/);
    assert.match(String((await team("Chi", "roles", "POST", { name: "Mine", permissions: [], memoryMb: 512, cpus: 1 })).body.error), /does not change roles/);

    // The owner's Pi gives Chi a role; never sets a password, downloads people's data or backs up the server.
    assert.equal((await team("Owner", `people/${ids.Chi}/role`, "POST", { role: "reader" })).status, 200);
    assert.ok(store.auditLog().some((entry) => entry.action === "role given" && entry.actor === `pi:${ids.Owner}`));

    for (const [route, method] of [[`people/${ids.Chi}/reset-password`, "POST"], [`people/${ids.Chi}/export`, "GET"], ["backup", "GET"], ["setup", "POST"]] as const) {
        const refused = await team("Owner", route, method, { password: "a new long password" });

        assert.equal(refused.status, 403, route);
        assert.match(String(refused.body.error), /only people's/);
    }

    // Server settings, by server.manage.
    assert.equal(((await team("Owner", "server", "GET")).body as { idleMinutes: number }).idleMinutes, 30);
    assert.match(String((await team("Chi", "server", "POST", { idleMinutes: 5 })).body.error), /does not manage the server/);
});

/** A documents call from someone's pi-phone (PP-46). */
async function doc(name: string, method: string, args: unknown[], pi?: { conversationId: string }) {
    const response = await fetch(`${address}/internal/docs`, { method: "POST", headers: { authorization: `Bearer ${store.box(ids[name]!).token}`, "content-type": "application/json" }, body: JSON.stringify({ method, args, ...(pi === undefined ? {} : { pi }) }) });
    const body = (await response.json()) as { value?: unknown; error?: string };

    return { status: response.status, value: body.value as Record<string, unknown> & Record<string, never>, error: body.error ?? "" };
}

test("team and project documents in the gateway, by each person's rights (PP-46)", async () => {
    // Team documents: everyone with a pi-phone reads; "Edit team documents" writes (the owner has it, a member doesn't).
    const made = await doc("Owner", "write", ["team", { title: "Onboarding", body: "Read the [[Runbook]]." }]);

    assert.equal(made.status, 200);
    assert.equal(made.value.scope, "team");
    assert.equal((await doc("Chi", "page", ["team", made.value.id])).value.title, "Onboarding", "a member reads it");
    assert.match((await doc("Chi", "write", ["team", { title: "Mine", body: "x" }])).error, /Editing team documents is not part of your role/);
    assert.deepEqual(((await doc("Chi", "scopes", [])).value as unknown as { id: string; write: boolean }[]).find((each) => each.id === "team"), { id: "team", name: "Team", write: false });

    // Project documents follow the board: Owner makes DOC and shares it with Chi as a viewer, then as a member.
    await call("Owner", "create", [{ key: "DOC", name: "Docs board" }]);
    assert.match((await doc("Chi", "tree", ["project:DOC"])).error, /no project DOC/, "not shared yet");
    await call("Owner", "setMembers", ["DOC", [ids.Chi], { [ids.Chi!]: "viewer" }]);
    assert.equal((await doc("Chi", "tree", ["project:DOC"])).status, 200);
    assert.match((await doc("Chi", "write", ["project:DOC", { title: "Plan", body: "x" }])).error, /viewer on DOC/);
    await call("Owner", "setMembers", ["DOC", [ids.Chi], { [ids.Chi!]: "member" }]);
    const plan = await doc("Chi", "write", ["project:DOC", { title: "Plan", body: "Ship the docs." }], { conversationId: "4" });

    assert.deepEqual([plan.value.scope, plan.value.updatedByName], ["project:DOC", "Pi (Chi)"]);

    // Search: only the scopes asked for that the person may read.
    const hits = (await doc("Chi", "search", [["team", "project:DOC"], "docs"])).value as unknown as { scope: string; title: string }[];

    assert.ok(hits.some((hit) => hit.scope === "project:DOC" && hit.title === "Plan"));

    // A delete is audited; the board deleted takes its documents.
    assert.equal((await doc("Chi", "remove", ["project:DOC", plan.value.id])).status, 200);
    assert.ok(store.auditLog().some((entry) => entry.action === "document deleted" && entry.actor === ids.Chi));
    boards.call(store.box(ids.Owner!), { method: "remove", args: ["DOC"] });
    assert.match((await doc("Owner", "tree", ["project:DOC"])).error, /no project DOC/);
});

test("search in documents: Pi may set the model, never the key; the key is never answered back nor audited (PP-49)", async () => {
    const before = (await team("Owner", "server", "GET")).body as { docs: { model: string | null; keySet: boolean } };

    assert.deepEqual([before.docs.model, before.docs.keySet], [null, false]);
    assert.match(String((await team("Owner", "server", "POST", { docsModel: "not a model" })).body.error), /OpenRouter model.s id/);

    const refused = await team("Owner", "server", "POST", { docsKey: "sk-or-from-pi" });

    assert.equal(refused.status, 403);
    assert.match(String(refused.body.error), /Pi does not set the server.s OpenRouter key/);
    assert.equal(store.docsSearch().key, null);

    // The owner typed the key on the Server page; Pi sets the model.
    store.setDocsSearch({ key: "sk-or-test-key" });
    const saved = (await team("Owner", "server", "POST", { docsModel: "openai/text-embedding-3-small" })).body as { docs: Record<string, unknown> };

    assert.deepEqual([saved.docs.model, saved.docs.keySet], ["openai/text-embedding-3-small", true]);
    assert.ok(!JSON.stringify(saved).includes("sk-or-test-key"), "never answered back");
    assert.ok(!JSON.stringify(store.auditLog()).includes("sk-or-test-key"), "never in the audit log");
    assert.ok(store.auditLog().some((entry) => entry.details?.docsKey === "set"));
    store.setDocsSearch({ key: null, model: null });
});
