// The team server's board service (PP-39) behind the gateway's internal port, with better-auth on an in-memory
// database and real roles: only a pi-phone's own token is let in, and it acts only as its person or their Pi; their
// role's permissions decide making, sharing and deleting boards; what is personal (folder, places, main session,
// running Pi's tasks by itself) is never kept centrally; Pi's sessions are kept as `<pi-phone>:<number>`; the store's
// internal lookups only show what the person may see; projects.view_all looks are logged; and an account that is gone
// hands its boards to the team.
import { cleanUp, root } from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, before, test } from "node:test";
import { makeAuth } from "../src/gateway/auth.ts";
import { BoardService } from "../src/gateway/boards.ts";
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
    boards = new BoardService(store, mkdtempSync(join(root, "gw-boards-")));

    const gateway = new Gateway({ auth, store, controller, boards, origin, log: () => undefined });

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
