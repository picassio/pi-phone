// Pi's tools for the team's machines (PP-82, S4: extensions/team.ts) against a real gateway on its internal port: Pi
// lists, adds, gives roles and removes team machines as the pi-phone's person, each change only after a yes on a card,
// logged as Pi's; the private key never comes back; someone without machines.manage is refused by the gateway; a guest
// Pi works for is refused before any card.
import { cleanUp, root } from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer as createHttp, type Server } from "node:http";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, before, test } from "node:test";
import { makeAuth } from "../src/gateway/auth.ts";
import { type ControllerClient, Gateway } from "../src/gateway/server.ts";
import { GatewayStore } from "../src/gateway/store.ts";
import { TeamMachines } from "../src/gateway/team-machines.ts";
import createTeam from "../src/server/extensions/team.ts";
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

let store: GatewayStore;
let machines: TeamMachines;
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

    store.saveRole({ id: "lead", name: "Lead", permissions: ["pi.use", "machines.use", "machines.manage", "roles.manage"], memoryMb: 1024, cpus: 1, models: [], spendLimit: null, builtin: false });
    store.setRoleOf(ids.Ana!, "lead");
    machines = new TeamMachines(store, mkdtempSync(join(root, "gw-tools-")));

    const gateway = new Gateway({ auth, store, controller, ...served(store), teamMachines: machines, origin, log: () => undefined });

    internal = createHttp((request, response) => void gateway.internal(request, response));
    await new Promise<void>((resolve) => internal.listen(0, "127.0.0.1", resolve));
    address = `http://127.0.0.1:${(internal.address() as { port: number }).port}`;
});

after(async () => {
    internal?.closeAllConnections();
    await new Promise((resolve) => internal?.close(resolve));
    cleanUp();
});

type Card = { tool: string; subject: string; reason?: string };

/** The team tools of `name`'s pi-phone, Pi working for its person (or a guest); cards answered `allow`. */
function toolsOf(name: string, options: { allow?: boolean; guest?: boolean } = {}) {
    const cards: Card[] = [];
    let synced = 0;
    const host = {
        teamServer: { url: address, token: store.box(ids[name]!).token },
        requesterOf: () => "person",
        person: () => ({ role: options.guest === true ? "guest" : "owner" }),
        approvals: {
            request: async (card: Card) => {
                cards.push(card);

                return { allow: options.allow ?? true, by: name };
            },
        },
        machines: () => [],
        syncTeamMachines: async () => {
            synced++;
        },
    };
    const tools = new Map(createTeam(host as never).tools!.map((tool) => [tool.name, tool]));
    let call = 0;
    const run = async (tool: string, args: Record<string, unknown>) => {
        const result = (await tools.get(tool)!.execute(args as never, { conversationId: 1, taskId: "t", callId: `c${++call}` } as never, {} as never)) as {
            output: { text: string }[];
            isError?: boolean;
        };

        return { text: result.output.map((part) => part.text).join(""), error: result.isError === true };
    };

    return { run, cards, synced: () => synced };
}

test("Pi adds a team machine only after a yes, gets the public half back, never the key, and the log says it was Pi", async () => {
    const ana = toolsOf("Ana");

    assert.match((await ana.run("team_machines", {})).text, /No team machines yet: team_machine_add/);

    const no = toolsOf("Ana", { allow: false });
    const refused = await no.run("team_machine_add", { name: "build-box", address: "dev@10.0.0.5:2222", reason: "For the team's builds" });

    assert.ok(refused.error);
    assert.match(refused.text, /said no: nothing was done/);
    assert.equal(machines.list().length, 0, "nothing added on a no");

    const added = await ana.run("team_machine_add", { name: "build-box", address: "dev@10.0.0.5:2222", reason: "For the team's builds" });
    const [machine] = machines.list();

    assert.ok(!added.error, added.text);
    assert.deepEqual(ana.cards.at(-1), { ...ana.cards.at(-1), tool: "team_machine_add", subject: "Add a team machine called build-box at dev@10.0.0.5:2222", reason: "For the team's builds" });
    assert.ok(added.text.includes(machines.publicKey(machine!.id)), "the public half, for authorized_keys");
    assert.match(added.text, /~dev\/\.ssh\/authorized_keys/);
    assert.doesNotMatch(added.text, /PRIVATE KEY/);
    assert.equal(ana.synced(), 1, "the person's machines follow");
    assert.equal(store.auditLog().find((entry) => entry.action === "team machine added")?.actor, `pi:${ids.Ana}`);

    const listed = (await ana.run("team_machines", {})).text;

    assert.match(listed, new RegExp(`- build-box \\(${machine!.id}\\): dev@10\\.0\\.0\\.5:2222; its host key isn't accepted yet`));
    assert.match(listed, /no role uses it \(and the owner's\); your folder there: ~\/team\/ana/);
    assert.match(listed, /You manage them/);
});

test("Pi says which roles may use a team machine, on a card; their people see it, and may not manage it", async () => {
    const ana = toolsOf("Ana");
    const binh = toolsOf("Binh");

    assert.match((await binh.run("team_machines", {})).text, /No team machines you may use/);

    const given = await ana.run("team_machine_access", { machine: "build-box", roles: ["member"], reason: "Members build there" });

    assert.ok(!given.error, given.text);
    assert.equal(ana.cards.at(-1)!.subject, "Let Member use the team machine build-box");
    assert.deepEqual(store.roles().find((role) => role.id === "member")!.teamMachines, [machines.list()[0]!.id]);
    assert.match((await binh.run("team_machines", {})).text, /- build-box .*you may use it; your folder there: ~\/team\/binh/);
    assert.match((await ana.run("team_machine_access", { machine: "build-box", roles: ["member"], reason: "again" })).text, /Nothing to change/);

    const notTheirs = await binh.run("team_machine_add", { name: "other", address: "me@10.0.0.6", reason: "mine" });

    assert.ok(notTheirs.error);
    assert.match(notTheirs.text, /Member does not include managing the team's machines/);
    assert.match((await ana.run("team_machine_access", { machine: "nope", roles: [], reason: "x" })).text, /No team machine is called nope/);
    assert.match((await ana.run("team_machine_access", { machine: "build-box", roles: ["ghost"], reason: "x" })).text, /No role ghost/);
});

test("Pi removes a team machine on a card: the key goes, the log says Pi, and the person is told to take the line out", async () => {
    const ana = toolsOf("Ana");
    const id = machines.list()[0]!.id;
    const removed = await ana.run("team_machine_remove", { machine: id, reason: "The box is gone" });

    assert.ok(!removed.error, removed.text);
    assert.match(ana.cards.at(-1)!.subject, /^Remove the team machine build-box \(dev@10\.0\.0\.5:2222\) for the whole team: .*; Member can no longer use it$/);
    assert.equal(machines.list().length, 0);
    assert.match(removed.text, /it is still there: take the line ending "pi-phone team build-box" out\./);
    assert.equal(store.auditLog().find((entry) => entry.action === "team machine removed")?.actor, `pi:${ids.Ana}`);
    assert.equal(ana.synced(), 1);
});

test("for a guest Pi works for, the team machine tools refuse before any card", async () => {
    const guest = toolsOf("Ana", { guest: true });
    const answer = await guest.run("team_machine_add", { name: "x", address: "a@b", reason: "x" });

    assert.ok(answer.error);
    assert.match(answer.text, /not a guest's/);
    assert.equal(guest.cards.length, 0);
    assert.equal(machines.list().length, 0);
});
