// The team's machines (PP-82, S1) behind the gateway's internal port, with better-auth on an in-memory database and
// real roles: someone with machines.manage adds one (its key made and kept on the gateway), renames it, saves its host
// key and system, and removes it, each in the Audit log; someone without it sees only the machines their role may use,
// with the key's public half only, and is refused the rest; the private key never comes back out.
import { cleanUp, root } from "./helpers.ts";
import assert from "node:assert/strict";
import { createPublicKey, verify } from "node:crypto";
import { existsSync, mkdtempSync, statSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, before, test } from "node:test";
import { makeAuth } from "../src/gateway/auth.ts";
import { checkRole } from "../src/gateway/roles.ts";
import { type ControllerClient, Gateway } from "../src/gateway/server.ts";
import { GatewayStore } from "../src/gateway/store.ts";
import { TeamMachines } from "../src/gateway/team-machines.ts";
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
let machines: TeamMachines;
let dir = "";
let internal: Server;
let address = "";
const ids: Record<string, string> = {};
/** Every answer the route gave, as text: the private key must be in none. */
const answers: string[] = [];

before(async () => {
    const db = new DatabaseSync(":memory:");

    store = new GatewayStore(db);

    const origin = "https://team.example.test";
    const auth = await makeAuth({ db, secret: store.authSecret(), origin });

    for (const [name, role] of [["Owner", "owner"], ["Ana", "member"], ["Binh", "member"]] as const) {
        const made = (await auth.api.createUser({ body: { name, email: `${name.toLowerCase()}@example.test`, password: "a long enough password", role } })) as { user: { id: string } };

        ids[name] = made.user.id;
    }

    // Ana manages the team's machines; Binh is a member, who may use the ones his role lists.
    store.saveRole({ id: "lead", name: "Lead", permissions: ["pi.use", "machines.use", "machines.manage"], memoryMb: 1024, cpus: 1, models: [], spendLimit: null, builtin: false });
    store.setRoleOf(ids.Ana!, "lead");
    dir = mkdtempSync(join(root, "gw-machines-"));
    machines = new TeamMachines(store, dir);

    const gateway = new Gateway({ auth, store, controller, ...served(store), teamMachines: machines, origin, log: () => undefined });

    internal = createServer((request, response) => void gateway.internal(request, response));
    await new Promise<void>((resolve) => internal.listen(0, "127.0.0.1", resolve));
    address = `http://127.0.0.1:${(internal.address() as { port: number }).port}`;
});

after(() => internal?.close());

type Row = { id: string; name: string; publicKey: string; usable: boolean; roles: string[]; hostKey?: string; knownHosts?: string[]; remote?: { platform: string } };
type Answer = { machine: Row; publicKey: string; manage: boolean; machines: Row[] };

/** A call from someone's pi-phone, with its own token. */
async function call(name: string, body: Record<string, unknown>) {
    const response = await fetch(`${address}/internal/team-machines`, { method: "POST", headers: { authorization: `Bearer ${store.box(ids[name]!).token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
    const text = await response.text();
    const answer = JSON.parse(text) as { value?: unknown; error?: string };

    answers.push(text);

    return { status: response.status, value: answer.value as unknown as Answer, error: answer.error ?? "" };
}

/** The Audit log's team-machine lines, oldest first: action · target. */
const auditLines = () =>
    store
        .auditLog()
        .filter((entry) => entry.action.startsWith("team machine"))
        .reverse()
        .map((entry) => `${entry.action} · ${entry.target}`);

let id = "";

test("someone with machines.manage adds a team machine: its key is made and kept on the gateway, its public half given", async () => {
    const added = await call("Ana", { action: "add", name: "build-box", address: "ci@10.0.0.20:2222" });

    assert.equal(added.status, 200, added.error);
    id = added.value.machine.id;
    assert.match(id, /^[a-z0-9]{12}$/);
    assert.deepEqual([added.value.machine.name, (added.value.machine as unknown as { user: string; host: string; port: number }).host], ["build-box", "10.0.0.20"]);
    assert.match(added.value.publicKey, /^ssh-ed25519 AAAAC3NzaC1lZDI1NTE5\S+ pi-phone team build-box$/);

    // The key: a file of the gateway's own, mode 600.
    const file = join(dir, "team-machines", `${id}.key`);

    assert.ok(existsSync(file));
    assert.equal(statSync(file).mode & 0o777, 0o600);

    // A second machine of the same name, a bad address: refused.
    assert.equal((await call("Ana", { action: "add", name: "Build-Box", address: "ci@10.0.0.21" })).status, 409);
    assert.match((await call("Ana", { action: "add", name: "other", address: "no address" })).error, /user@host/);
});

test("a member sees only the machines their role lists, with the public half; never the private key; changes are refused", async () => {
    assert.deepEqual((await call("Binh", { action: "list" })).value.machines, []);
    assert.equal((await call("Binh", { action: "list" })).value.manage, false);

    store.saveRole({ ...store.role("member")!, teamMachines: [id] });

    const listed = (await call("Binh", { action: "list" })).value.machines;

    assert.deepEqual(listed.map((each) => [each.name, each.usable]), [["build-box", true]]);
    assert.equal(listed[0]!.publicKey, machines.publicKey(id));

    for (const action of ["add", "rename", "remove", "accept", "connected"]) {
        const refused = await call("Binh", { action, id, name: "x", address: "a@b" });

        assert.equal(refused.status, 403, action);
        assert.match(refused.error, /managing the team's machines/);
    }

    // The owner's role uses every machine; whoever manages sees which roles use each.
    assert.deepEqual((await call("Owner", { action: "list" })).value.machines.map((each) => each.usable), [true]);
    assert.deepEqual((await call("Ana", { action: "list" })).value.machines[0]!.roles, ["Member"]);
});

test("the host key and system found from a manager's pi-phone are kept for everyone; bad ones refused", async () => {
    assert.equal((await call("Ana", { action: "accept", id, lines: ["not a line"], fingerprint: "SHA256:x" })).status, 400);

    const line = "pi-phone-team-x ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOV0Zm9vYmFyYmF6cXV4cXV1eHF1dXhxdXV4cXV1eA==";
    const accepted = await call("Ana", { action: "accept", id, lines: [line], fingerprint: "SHA256:abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG" });

    assert.equal(accepted.status, 200, accepted.error);
    assert.equal((await call("Ana", { action: "connected", id, remote: { platform: "linux" } })).status, 400);
    assert.equal((await call("Ana", { action: "connected", id, remote: { platform: "linux", arch: "x64", home: "/home/ci" }, daemon: "1.3.0" })).status, 200);

    const seen = (await call("Binh", { action: "list" })).value.machines[0]!;

    assert.deepEqual([seen.hostKey, seen.knownHosts, seen.remote?.platform], ["SHA256:abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG", [line], "linux"]);
});

test("the key signs as SSH does, checkable with its public half (the relays sign with it, S2)", () => {
    const blob = machines.publicBlob(id);
    const raw = blob.subarray(blob.length - 32);
    const signature = machines.signRaw(id, Buffer.from("data to sign"));
    // SSH's signature: string "ssh-ed25519", then the 64 bytes.
    const bytes = signature.subarray(4 + 11 + 4);
    const key = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: raw.toString("base64url") }, format: "jwk" });

    assert.equal(bytes.length, 64);
    assert.ok(verify(null, Buffer.from("data to sign"), key, bytes));
});

test("renamed and removed, each in the Audit log; removed, its key file and every role's mention go too", async () => {
    assert.equal((await call("Ana", { action: "rename", id, name: "ci-box" })).status, 200);
    assert.equal((await call("Ana", { action: "remove", id })).status, 200);
    assert.ok(!existsSync(join(dir, "team-machines", `${id}.key`)));
    assert.deepEqual(store.role("member")!.teamMachines, []);
    assert.deepEqual(auditLines(), [
        "team machine added · build-box",
        "team machine host key accepted · build-box",
        "team machine installed · build-box",
        "team machine renamed · ci-box",
        "team machine removed · ci-box",
    ]);
    assert.ok(!answers.some((text) => /PRIVATE KEY|BEGIN/.test(text)), "no private key in any answer");
});

test("a role's team machines are checked as given", () => {
    const base = { name: "R", permissions: [], memoryMb: 512, cpus: 1 };

    assert.deepEqual(checkRole({ ...base, teamMachines: ["abcdef012345", "abcdef012345"] }, "r").teamMachines, ["abcdef012345"]);
    assert.throws(() => checkRole({ ...base, teamMachines: ["../etc"] }, "r"), /Team machines are given by their ids/);
});
