// Machines: addresses, keys, host keys, and connecting through pi-env to a real sshd on this machine (when one is
// installed, as in the app's rootfs and Termux).
import assert from "node:assert/strict";
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { Machines, parseAddress } from "../src/server/machines.ts";
import { SshKeys } from "../src/server/ssh-keys.ts";

const root = mkdtempSync(join(tmpdir(), "pi-phone-machines-"));
const home = join(root, "home");

mkdirSync(join(root, "data"));
mkdirSync(home);
const keys = new SshKeys(join(root, "data"), home);
const machines = new Machines(join(root, "data"), keys, home);

test("addresses: user@host, with a port, IPv6 in brackets; anything else is refused", () => {
    assert.deepEqual(parseAddress("me@box"), { user: "me", host: "box", port: undefined });
    assert.deepEqual(parseAddress(" me@box.example.com:2222 "), { user: "me", host: "box.example.com", port: 2222 });
    assert.deepEqual(parseAddress("me@[2001:db8::1]:22"), { user: "me", host: "2001:db8::1", port: 22 });
    assert.throws(() => parseAddress("box"), /user@host/);
    assert.throws(() => parseAddress("me@box:70000"), /1 to 65535/);
    assert.throws(() => parseAddress("me@box; rm -rf /"), /user@host/);
});

test("a machine needs a name, an address, and one of the app's keys; a key in use is known", async () => {
    const key = await keys.generate("test");

    assert.throws(() => machines.add({ name: "", address: "me@box", keyId: key.id }), /Name the machine/);
    assert.throws(() => machines.add({ name: "box", address: "me@box" }), /Choose the SSH key/);
    assert.throws(() => machines.add({ name: "box", address: "me@box", keyId: "nope" }), /no such SSH key/);

    const machine = machines.add({ name: "box", address: "me@box:2222", keyId: key.id });

    assert.equal(machine.port, 2222);
    assert.deepEqual(machines.usingKey(key.id).map((each) => each.id), [machine.id]);
    assert.throws(() => machines.ready(machine.id), /not set up: open Settings > Machines/);

    // Another address forgets the host key and the connection; the same one changes nothing.
    const edited = await machines.edit(machine.id, { address: "me@other" });

    assert.equal(edited.host, "other");
    assert.equal(edited.port, undefined);
    assert.equal(new Machines(join(root, "data"), keys, home).get(machine.id).host, "other");
    await machines.remove(machine.id);
    assert.throws(() => machines.get(machine.id), /no such machine/);
});

/** A port nothing listens on. */
function freePort(): Promise<number> {
    return new Promise((resolve, reject) => {
        const server = createServer();

        server.listen(0, "127.0.0.1", () => {
            const { port } = server.address() as { port: number };

            server.close(() => resolve(port));
        });
        server.on("error", reject);
    });
}

const sshdPath = ["/usr/sbin/sshd", join(process.env.PREFIX ?? "/usr", "bin", "sshd")].find((path) =>
    existsSync(path),
);
let sshd: ChildProcess | undefined;

after(() => sshd?.kill());

test(
    "scan, accept, and connect to a real sshd: the host key is pinned, the daemon deployed and reporting the system",
    { skip: sshdPath === undefined ? "no sshd on this machine" : false },
    async () => {
        const port = await freePort();
        const etc = join(root, "etc");
        const remoteHome = join(root, "remote-home");

        mkdirSync(etc);
        mkdirSync(join(remoteHome, ".ssh"), { recursive: true, mode: 0o700 });
        execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", join(etc, "host_key")]);
        const key = await keys.generate("local");

        writeFileSync(join(remoteHome, ".ssh", "authorized_keys"), `${key.publicKey}\n`, { mode: 0o600 });
        // sshd as this user, on loopback, with the app's key only: no passwords, no PAM, our files alone.
        const config = [
            `Port ${port}`,
            "ListenAddress 127.0.0.1",
            `HostKey ${join(etc, "host_key")}`,
            `AuthorizedKeysFile ${join(remoteHome, ".ssh", "authorized_keys")}`,
            "PasswordAuthentication no",
            "KbdInteractiveAuthentication no",
            "PubkeyAuthentication yes",
            "StrictModes no",
            "UsePAM no",
            `PidFile ${join(etc, "sshd.pid")}`,
            "LogLevel ERROR",
        ].join("\n");

        writeFileSync(join(etc, "sshd_config"), `${config}\n`);
        chmodSync(join(etc, "host_key"), 0o600);
        sshd = spawn(sshdPath!, ["-D", "-e", "-f", join(etc, "sshd_config")], {
            stdio: ["ignore", "ignore", "pipe"],
            env: { ...process.env, HOME: remoteHome },
        });
        let stderr = "";

        sshd.stderr!.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
        // Until it listens.
        for (let tries = 0; tries < 50; tries++) {
            await new Promise((resolve) => setTimeout(resolve, 100));

            if (sshd.exitCode !== null) {
                throw new Error(`sshd exited ${sshd.exitCode}: ${stderr}`);
            }

            if (existsSync(join(etc, "sshd.pid"))) {
                break;
            }
        }

        const machine = machines.add({
            name: "here",
            address: `${userInfo().username}@127.0.0.1:${port}`,
            keyId: key.id,
        });

        // Not connected yet: nothing may run there, and the host key is unknown.
        await assert.rejects(machines.connect(machine.id), /Accept the machine's host key first/);

        const scanned = await machines.scan(machine.id);

        assert.ok(scanned.fingerprints.some((each) => each.startsWith("SHA256:")), JSON.stringify(scanned));
        const accepted = await machines.accept(machine.id, scanned.lines, scanned.fingerprints[0]);

        assert.equal(accepted.hostKey, scanned.fingerprints[0]);
        assert.match(readFileSync(machines.knownHostsFile, "utf8"), new RegExp(`pi-phone-${machine.id}`));

        const connected = await machines.connect(machine.id);

        assert.ok(["android", "linux"].includes(connected.remote!.platform), JSON.stringify(connected.remote));
        assert.ok(connected.daemon, "the daemon reported its version");
        assert.equal(machines.ready(machine.id).id, machine.id);
        // The daemon is on the "remote", in the home the machine reports, named by its hash, as pi-env deploys it.
        const tools = join(connected.remote!.home, ".pi", "mobile", "tools");

        assert.ok(existsSync(tools), `the daemon was deployed to ${tools}`);
        assert.ok(readdirSync(tools).some((name) => name.startsWith("pi-env")), readdirSync(tools).join(","));
    },
);
