// A machine's host key changes (PP-509: a VM moved to another Proxmox host, cloud-init made new keys), against a real
// sshd on loopback whose key the test changes, as a reboot does: what machine_run and the health check say, Pi's
// machine_rekey (a key that is not the one read on the machine is refused before any card; the card shows the old key
// and the new; Deny keeps the old), and replacing the key: pi-env is not uploaded again when it is there with its hash,
// the machine stays connected, its held connection is renewed, and no cached error outlives the change.
import { type App, cleanUp, context, lastText, modelTexts, newSession, openApp, owner, scriptedModel, until } from "./helpers.ts";
import assert from "node:assert/strict";
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { formatPlace } from "../src/server/places.ts";

const sshdPath = ["/usr/sbin/sshd", join(process.env.PREFIX ?? "/usr", "bin", "sshd")].find((path) => existsSync(path));
const skip = sshdPath === undefined ? "no sshd on this machine" : false;
const root = mkdtempSync(join(tmpdir(), "pi-phone-machine-rekey-"));
const etc = join(root, "etc");
// The machine's home is the test's: what pi-phone puts there never reaches the real one.
const remoteHome = join(root, "remote-home");
const tools = join(remoteHome, ".pi", "mobile", "tools");
let sshd: ChildProcess | undefined;
let machineId = "";
/** What Pi calls, by the message's end. */
let calls: Record<string, [string, Record<string, unknown>]> = {};

const route: FauxResponseStep = (request) => {
    const { role, text } = lastText(request as never);

    for (const [ask, [tool, args]] of Object.entries(calls)) {
        if (role === "user" && text.endsWith(ask)) {
            return fauxAssistantMessage([fauxToolCall(tool, args as never)], { stopReason: "toolUse" });
        }
    }

    return fauxAssistantMessage([fauxText(role === "toolResult" ? `told: ${text}` : "ok")]);
};
let app: App;

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

async function startSshd(): Promise<void> {
    rmSync(join(etc, "sshd.pid"), { force: true });
    sshd = spawn(sshdPath!, ["-D", "-e", "-f", join(etc, "sshd_config")], { stdio: ["ignore", "ignore", "pipe"] });
    await until(() => existsSync(join(etc, "sshd.pid")), "sshd listens");
}

/** A new host key, as `ssh-keygen -lf` reads it on the machine: SHA256:… */
function newHostKey(): string {
    rmSync(join(etc, "host_key"), { force: true });
    rmSync(join(etc, "host_key.pub"), { force: true });
    execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", join(etc, "host_key")]);
    chmodSync(join(etc, "host_key"), 0o600);

    return execFileSync("ssh-keygen", ["-lf", join(etc, "host_key.pub")], { encoding: "utf8" }).split(/\s+/)[1]!;
}

/** The machine reboots with a new host key: its sessions and the daemon end, and the same address presents another key. */
async function changeHostKey(): Promise<string> {
    // Only this test's daemon and this sshd's own sessions ("[p]": the pattern does not match this shell's own command line).
    execFileSync("sh", ["-c", `pkill -f '${tools}/[p]i-env' ; pkill -P ${sshd!.pid} ; true`]);
    sshd!.kill();
    await until(() => sshd!.exitCode !== null || sshd!.signalCode !== null, "sshd stops");
    const fingerprint = newHostKey();

    await startSshd();

    return fingerprint;
}

before(async () => {
    app = await openApp(scriptedModel(route), join(root, "data"));

    if (sshdPath === undefined) {
        return;
    }

    const port = await freePort();

    mkdirSync(etc);
    mkdirSync(join(remoteHome, ".ssh"), { recursive: true, mode: 0o700 });
    newHostKey();
    const key = await app.sshKeys.generate("rekey");

    writeFileSync(join(remoteHome, ".ssh", "authorized_keys"), `${key.publicKey}\n`, { mode: 0o600 });
    writeFileSync(
        join(etc, "sshd_config"),
        `${[
            `Port ${port}`,
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
        ].join("\n")}\n`,
    );
    await startSshd();
    const machine = app.machines.add({ name: "box", address: `${userInfo().username}@127.0.0.1:${port}`, keyId: key.id });
    const scanned = await app.machines.scan(machine.id);

    await app.machines.accept(machine.id, scanned.lines, scanned.fingerprints[0]);
    await app.machines.connect(machine.id);
    machineId = machine.id;
});

after(async () => {
    sshd?.kill();
    await app?.close();
    cleanUp();
});

/** One turn; with `answer`, the card it waits on is answered so and returned. */
async function turn(text: string, answer?: boolean) {
    const id = await newSession(app);
    const { submissionId } = await app.commands.submit(id, owner(app), { text, requestId: crypto.randomUUID() });
    let card: ReturnType<typeof app.approvals.all>[number] | undefined;

    if (answer !== undefined) {
        await until(() => app.approvals.forConversation(id).length > 0, "the card");
        card = app.approvals.forConversation(id)[0]!;
        await app.answerApproval(card.id, answer, owner(app), false);
    }

    await (await app.harness.submission(submissionId, context))!.wait(context);
    await app.harness.waitForIdle(context);

    return { said: (await modelTexts(app, id)).at(-1)!, card };
}

const cwd = () => formatPlace({ machineId, path: remoteHome });
const daemon = () => readdirSync(tools).filter((name) => name.startsWith("pi-env-")).map((name) => `${name}@${statSync(join(tools, name)).mtimeMs}`);
let newKey = "";

test("a changed host key: machine_run says so and the way on; the health check marks it, in the owner's words", { skip }, async () => {
    calls = { "run it": ["machine_run", { machine: "box", command: "echo hi-from-box" }] };
    // What Pi read, as JSON: its line break is \n.
    assert.match((await turn("run it")).said, /exit 0\\nhi-from-box/);
    newKey = await changeHostKey();

    const { said } = await turn("run it");

    assert.match(said, /box: The host key of 127\.0\.0\.1 changed/);
    assert.match(said, /read the new key on the machine itself .* call machine_rekey with it/);
    assert.match(said, /replaces it on its row in Settings › Machines/);
    const health = (await app.places.health(true))[machineId]!;

    assert.equal(health.ok, false);
    assert.equal(health.hostKey, "changed");
    assert.match(health.problem!, /host key changed since you accepted it: .* replace it on its row in Settings › Machines/);
});

test("machine_rekey refuses a key that is not the one read on the machine itself, before any card", { skip }, async () => {
    const known = readFileSync(app.machines.knownHostsFile, "utf8");

    calls = { "rekey it wrong": ["machine_rekey", { machine: "box", expectedFingerprint: "SHA256:AAAAnotThisKeyAtAll0000000000000000000000000", reason: "Moved to tuan-pve" }] };
    const { said } = await turn("rekey it wrong");

    assert.match(said, /presents SHA256:.*, not SHA256:AAAAnotThisKeyAtAll.*: refused, nothing changed/);
    assert.equal(app.approvals.all().length, 0, "no card");
    assert.equal(readFileSync(app.machines.knownHostsFile, "utf8"), known, "the known hosts as they were");
});

test("machine_rekey's card shows the old key and the new, the one Pi read; Deny keeps the old", { skip }, async () => {
    const old = app.machines.get(machineId).hostKey;

    calls = { "rekey it, no": ["machine_rekey", { machine: "box", expectedFingerprint: newKey, reason: "Moved to tuan-pve" }] };
    const { said, card } = await turn("rekey it, no", false);

    assert.deepEqual(card?.form, {
        type: "machine-rekey",
        machine: machineId,
        name: "box",
        address: `${userInfo().username}@${app.machines.get(machineId).host}:${app.machines.get(machineId).port}`,
        old,
        hostKeys: [`${newKey} (ED25519)`],
        expected: newKey,
    });
    assert.match(said, /said no: box keeps its old host key/);
    assert.equal(app.machines.get(machineId).hostKey, old);
});

test("Approve replaces the key and keeps the install: pi-env not uploaded again, connected at once, its connection renewed, no cached error", { skip }, async () => {
    const deployed = daemon();
    const held = app.places.env(cwd());

    // The error is what a reader of the kept answer (the folder picker) was told.
    assert.equal((await app.places.health(true))[machineId]!.ok, false);
    calls = { "rekey it": ["machine_rekey", { machine: "box", expectedFingerprint: newKey, reason: "Moved to tuan-pve" }] };
    const { said } = await turn("rekey it", true);

    assert.match(said, /Replaced box's host key with SHA256:.* and connected again: pi-env \d+\.\d+\.\d+ was there with its hash, nothing installed/);
    const machine = app.machines.get(machineId);

    assert.equal(machine.hostKey, `${newKey} (ED25519)`);
    assert.ok(machine.remote, "still set up");
    assert.deepEqual(daemon(), deployed, "pi-env as it was: the same file, not written again");
    assert.notEqual(app.places.env(cwd()), held, "a new environment: the held connection went");
    assert.equal((await app.places.env(cwd()).exec("echo ok", {}, context)).ok, true);
    assert.equal((await app.places.health())[machineId]!.ok, true, "the kept answer is checked again, not the error from before");
    calls = { "run it again": ["machine_run", { machine: "box", command: "echo hi-again" }] };
    assert.match((await turn("run it again")).said, /exit 0\\nhi-again/);
});

test("Replace key without pi-env there: the key is replaced, and the machine waits for Install and connect", { skip }, async () => {
    const key = await changeHostKey();

    rmSync(tools, { recursive: true, force: true });
    const scanned = await app.machines.scan(machineId);
    const { machine, kept } = await app.machines.replaceKey(machineId, scanned.lines, scanned.fingerprints[0]);

    assert.equal(kept, false);
    assert.equal(machine.hostKey, `${key} (ED25519)`);
    assert.equal(machine.remote, undefined, "Install and connect first");
    assert.throws(() => app.places.env(cwd()), { status: 409, message: /not set up/ });
    assert.ok((await app.machines.connect(machineId)).remote, "Install and connect works with the new key");
    assert.ok(daemon().length === 1);
});

test("Forget, scan, accept, Install and connect: the error from before does not outlive it", { skip }, async () => {
    await changeHostKey();
    assert.match((await app.places.health(true))[machineId]!.said!, /host key of 127\.0\.0\.1 changed/);
    await app.machines.forget(machineId);
    const scanned = await app.machines.scan(machineId);

    await app.machines.accept(machineId, scanned.lines, scanned.fingerprints[0]);
    await app.machines.connect(machineId);
    // As the folder picker asks: the kept answer, which was the changed key's.
    assert.deepEqual({ ...(await app.places.health())[machineId], at: 0 }, { ok: true, at: 0 });
});
