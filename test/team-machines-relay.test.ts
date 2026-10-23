// Team machines' relays (PP-82, S2), end to end over a real sshd: a team machine added on the gateway (its key made and
// kept there), set up from the pi-phone of someone who manages machines (scan, accept, install) through the gateway's
// connection relay and its signing, then used by a member's pi-phone, whose ssh reaches it only through the gateway.
// The gateway signs nothing but a sign-in; a removed machine's open connection closes; a role without the machine is
// refused with the reason; and no private key is ever in a pi-phone's folder.
import { cleanUp, context, root } from "./helpers.ts";
import assert from "node:assert/strict";
import { type ChildProcess, execFile, execFileSync, spawn } from "node:child_process";
import { promisify } from "node:util";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer as createHttp, type Server } from "node:http";
import { createServer as createNet } from "node:net";
import { userInfo } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, before, test } from "node:test";
import { makeAuth } from "../src/gateway/auth.ts";
import { type ControllerClient, Gateway } from "../src/gateway/server.ts";
import { GatewayStore } from "../src/gateway/store.ts";
import { TeamMachines } from "../src/gateway/team-machines.ts";
import { Machines } from "../src/server/machines.ts";
import { Places } from "../src/server/places.ts";
import { SshAgent } from "../src/server/ssh-agent.ts";
import { SshKeys } from "../src/server/ssh-keys.ts";
import { TeamMachinesClient } from "../src/server/team-machines.ts";
import { served } from "./gateway-served.ts";

const sshdPath = ["/usr/sbin/sshd", join(process.env.PREFIX ?? "/usr", "bin", "sshd")].find((path) => existsSync(path));
const skip = sshdPath === undefined ? "no sshd on this machine" : false;

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
let sshd: ChildProcess | undefined;
let sshPort = 0;
let teamId = "";
const ids: Record<string, string> = {};
const remoteHome = join(root, "team-remote-home");
const phones: PiPhone[] = [];

type PiPhone = { dir: string; agent: SshAgent; keys: SshKeys; machines: Machines; places: Places; client: TeamMachinesClient };

/** A person's pi-phone, as far as machines go: its own ssh folder, Machines, Places, and the team machines' client. */
async function piPhone(name: string): Promise<PiPhone> {
    const dir = mkdtempSync(join(root, `pp-${name}-`));
    const sshDir = join(dir, "ssh");
    const agent = new SshAgent(sshDir);
    const keys = new SshKeys(dir, agent, sshDir, dir);
    let places: Places | undefined;
    const own = new Machines(dir, keys, sshDir, agent, dir, (id) => {
        if (id !== undefined) {
            places?.forget(id);
        }
    });

    places = new Places(own, () => process.env.PATH ?? "");

    const client = new TeamMachinesClient({ url: address, token: store.box(ids[name]!).token }, sshDir, () => undefined, (entries, manage) => own.setTeam(entries, manage));

    await client.start();

    const phone = { dir, agent, keys, machines: own, places, client };

    phones.push(phone);

    return phone;
}

before(async () => {
    const db = new DatabaseSync(":memory:");

    store = new GatewayStore(db);

    const origin = "https://team.example.test";
    const auth = await makeAuth({ db, secret: store.authSecret(), origin });

    for (const [name, role] of [["Owner", "owner"], ["Ana", "member"], ["Binh", "member"]] as const) {
        const made = (await auth.api.createUser({ body: { name, email: `${name.toLowerCase()}@example.test`, password: "a long enough password", role } })) as { user: { id: string } };

        ids[name] = made.user.id;
    }

    store.saveRole({ id: "lead", name: "Lead", permissions: ["pi.use", "machines.use", "machines.manage"], memoryMb: 1024, cpus: 1, models: [], spendLimit: null, builtin: false });
    store.setRoleOf(ids.Ana!, "lead");
    machines = new TeamMachines(store, mkdtempSync(join(root, "gw-tm-")));

    const gateway = new Gateway({ auth, store, controller, ...served(store), teamMachines: machines, origin, log: () => undefined });

    internal = createHttp((request, response) => void gateway.internal(request, response));
    internal.on("upgrade", (request, socket, head) => void gateway.internalUpgrade(request, socket, head));
    await new Promise<void>((resolve) => internal.listen(0, "127.0.0.1", resolve));
    address = `http://127.0.0.1:${(internal.address() as { port: number }).port}`;

    if (skip) {
        return;
    }

    sshPort = await new Promise<number>((resolve) => {
        const probe = createNet();

        probe.listen(0, "127.0.0.1", () => {
            const { port } = probe.address() as { port: number };

            probe.close(() => resolve(port));
        });
    });

    // The team machine: added on the gateway, whose key's public half goes in the machine's authorized_keys.
    const added = machines.add("build-box", `${userInfo().username}@127.0.0.1:${sshPort}`, ids.Ana!);

    teamId = added.machine.id;

    const etc = join(root, "team-sshd");

    mkdirSync(etc, { recursive: true });
    mkdirSync(join(remoteHome, ".ssh"), { recursive: true, mode: 0o700 });
    mkdirSync(join(remoteHome, "work"), { recursive: true });
    execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", join(etc, "host_key")]);
    chmodSync(join(etc, "host_key"), 0o600);
    writeFileSync(join(remoteHome, ".ssh", "authorized_keys"), `${added.publicKey}\n`, { mode: 0o600 });
    writeFileSync(
        join(etc, "sshd_config"),
        [
            `Port ${sshPort}`,
            "ListenAddress 127.0.0.1",
            `HostKey ${join(etc, "host_key")}`,
            `AuthorizedKeysFile ${join(remoteHome, ".ssh", "authorized_keys")}`,
            "PasswordAuthentication no",
            "KbdInteractiveAuthentication no",
            "StrictModes no",
            "UsePAM no",
            `PidFile ${join(etc, "sshd.pid")}`,
            `SetEnv HOME=${remoteHome}`,
            "LogLevel ERROR",
        ].join("\n") + "\n",
    );
    sshd = spawn(sshdPath!, ["-D", "-e", "-f", join(etc, "sshd_config")], { stdio: ["ignore", "ignore", "pipe"] });

    for (let tries = 0; tries < 50 && !existsSync(join(etc, "sshd.pid")); tries++) {
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
});

after(async () => {
    for (const phone of phones) {
        await phone.places.close(context);
        await phone.client.close();
        phone.agent.stop();
        phone.keys.close();
    }

    sshd?.kill();
    internal?.close();
    cleanUp();
});

const run = promisify(execFile);

/** Every file under a folder, as text where it is text. */
function files(dir: string): string[] {
    return readdirSync(dir, { recursive: true, encoding: "utf8" })
        .map((each) => join(dir, each))
        .filter((path) => statSync(path).isFile());
}

test("someone who manages machines sets the team machine up through the gateway: scan, accept, install and connect", { skip }, async () => {
    const ana = await piPhone("Ana");

    await ana.client.sync();

    const machine = ana.machines.get(`team-${teamId}`);

    assert.equal(machine.team?.manage, true);
    assert.equal(machine.hostKey, undefined);

    // Its host key, scanned through the gateway's relay (its Host block), under the machine's own alias.
    const scanned = await ana.machines.scan(machine.id);

    assert.ok(scanned.lines.every((line) => line.startsWith(`pi-phone-team-${teamId} `)), scanned.lines.join("\n"));
    await ana.client.call({ action: "accept", id: teamId, lines: scanned.lines, fingerprint: scanned.fingerprints[0]!.split(" ")[0] });
    await ana.client.sync();
    assert.ok(ana.machines.get(machine.id).hostKey?.startsWith("SHA256:"));

    // Installed and connected: signed in with the key on the gateway, through the agent that asks it.
    const connected = await ana.machines.connect(machine.id);

    assert.equal(connected.remote?.home, remoteHome);
    await ana.client.call({ action: "connected", id: teamId, remote: connected.remote, daemon: connected.daemon });
    assert.deepEqual(
        store.auditLog().filter((entry) => entry.action.startsWith("team machine")).map((entry) => entry.action).reverse(),
        ["team machine connected", "team machine host key accepted", "team machine installed"],
    );
});

test("a member whose role lists the machine runs a command there through the gateway; the key is in no pi-phone", { skip }, async () => {
    store.saveRole({ ...store.role("member")!, teamMachines: [teamId] });

    const binh = await piPhone("Binh");

    await binh.client.sync();

    const machine = binh.machines.get(`team-${teamId}`);

    assert.equal(machine.team?.manage, false);
    assert.equal(machine.remote?.platform !== undefined, true, "set up for everyone");

    const env = binh.places.env(`machine:${machine.id}:${join(remoteHome, "work")}`);
    let said = "";
    const ran = await env.exec("echo team-$((40+2)); pwd", { onOutput: (text) => (said += text) }, context);

    assert.ok(ran.ok, ran.ok ? "" : ran.error.message);
    assert.equal(said, `team-42\n${join(remoteHome, "work")}\n`);

    // pi-ssh reaches it too, by its short alias: the same relay and agent.
    const config = readFileSync(binh.machines.configFile, "utf8");

    assert.match(config, new RegExp(`Host pi-phone-team-${teamId} build-box\\n`));
    // Not execFileSync: the gateway and the relay answer in this process, which must not be blocked.
    assert.equal((await run(binh.machines.piSsh, ["build-box", "echo via-pi-ssh"])).stdout.trim(), "via-pi-ssh");

    // No private key anywhere in either pi-phone's folder; only the public half.
    for (const phone of phones) {
        for (const path of files(phone.dir)) {
            if (!path.endsWith(".sock")) {
                assert.doesNotMatch(readFileSync(path, "latin1"), /PRIVATE KEY/, path);
            }
        }
    }
});

test("the gateway signs only a sign-in to the machine with its key", { skip }, async () => {
    const binh = phones[1]!;

    await assert.rejects(binh.client.call({ action: "sign", id: teamId, data: Buffer.from("anything at all").toString("base64") }), /signs only a sign-in/);
});

test("a role without the machine is refused with the reason; a removed machine's open connection closes", { skip }, async () => {
    const binh = phones[1]!;
    const env = binh.places.env(`machine:team-${teamId}:${join(remoteHome, "work")}`);

    assert.ok((await env.exec("true", undefined, context)).ok, "connected before");

    // Taken off his role: a new connection is refused, and ssh says why.
    store.saveRole({ ...store.role("member")!, teamMachines: [] });

    const refused = await run(binh.machines.piSsh, ["build-box", "true"]).then(
        () => "",
        (error: { stderr?: string }) => String(error.stderr ?? error),
    );

    assert.match(refused, /Member may not use build-box: ask your team's owner/);

    // Removed: Binh's open connection is closed by the gateway, and its next command fails.
    store.saveRole({ ...store.role("member")!, teamMachines: [teamId] });
    await phones[0]!.client.call({ action: "remove", id: teamId });

    const after = await env.exec("true", undefined, context);

    assert.equal(after.ok, false, "the connection is gone");

    // Listed again, it is gone from his pi-phone: its entry, and its public half.
    assert.ok(existsSync(join(binh.dir, "ssh", "team", `${teamId}.pub`)));
    await binh.client.sync();
    assert.ok(!binh.machines.list().some((machine) => machine.id === `team-${teamId}`));
    assert.deepEqual(readdirSync(join(binh.dir, "ssh", "team")), []);
});
