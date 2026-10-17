// A session on a machine: its tools run there through pi-env's daemon, over the test sshd of machines.test.ts's kind;
// the prompt says so; the Files panel says it is not available there yet.
import {
    type App,
    cleanUp,
    context,
    lastText,
    modelTexts,
    openApp,
    owner,
    scriptedModel,
    work,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { userInfo } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { root } from "./helpers.ts";

const sshdPath = ["/usr/sbin/sshd", join(process.env.PREFIX ?? "/usr", "bin", "sshd")].find((path) => existsSync(path));
const skip = sshdPath === undefined ? "no sshd on this machine" : false;

let told = "";

const route: FauxResponseStep = (request) => {
    const messages = (request as { messages: { role: string; sections?: Record<string, string | null> }[] }).messages;

    for (const message of messages) {
        if (message.role === "system" && message.sections?.environment) {
            told = message.sections.environment;
        }
    }

    const { role, text } = lastText(request as never);

    if (role === "user" && text === "where are you") {
        return fauxAssistantMessage([fauxToolCall("bash", { command: "pwd; echo marker-$HOME" })], { stopReason: "toolUse" });
    }

    return fauxAssistantMessage([fauxText(role === "toolResult" ? `saw: ${text.trim()}` : "ok")]);
};

let app: App;
let sshd: ChildProcess | undefined;
let machineId: string;
const remoteHome = join(root, "remote-home");

before(async () => {
    app = await openApp(scriptedModel(route));

    if (skip) {
        return;
    }

    const port = await new Promise<number>((resolve) => {
        const server = createServer();

        server.listen(0, "127.0.0.1", () => {
            const { port } = server.address() as { port: number };

            server.close(() => resolve(port));
        });
    });
    const etc = join(root, "sshd");

    mkdirSync(etc, { recursive: true });
    mkdirSync(join(remoteHome, ".ssh"), { recursive: true, mode: 0o700 });
    mkdirSync(join(remoteHome, "project"), { recursive: true });
    execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", join(etc, "host_key")]);
    chmodSync(join(etc, "host_key"), 0o600);
    const key = await app.sshKeys.generate("test");

    writeFileSync(join(remoteHome, ".ssh", "authorized_keys"), `${key.publicKey}\n`, { mode: 0o600 });
    writeFileSync(
        join(etc, "sshd_config"),
        [
            `Port ${port}`,
            "ListenAddress 127.0.0.1",
            `HostKey ${join(etc, "host_key")}`,
            `AuthorizedKeysFile ${join(remoteHome, ".ssh", "authorized_keys")}`,
            "PasswordAuthentication no",
            "KbdInteractiveAuthentication no",
            "StrictModes no",
            "UsePAM no",
            `PidFile ${join(etc, "sshd.pid")}`,
            "LogLevel ERROR",
        ].join("\n") + "\n",
    );
    sshd = spawn(sshdPath!, ["-D", "-e", "-f", join(etc, "sshd_config")], { stdio: ["ignore", "ignore", "pipe"] });

    for (let tries = 0; tries < 50 && !existsSync(join(etc, "sshd.pid")); tries++) {
        await new Promise((resolve) => setTimeout(resolve, 100));
    }

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

test("a session on a machine runs its tools there, and the prompt says where", { skip }, async () => {
    const home = app.machines.get(machineId).remote!.home;
    // The machine's "project": a folder the sshd user can reach; on this test machine the same disk, but reached
    // through the daemon all the same.
    const { id } = await app.commands.createSession(owner(app), { cwd: `machine:${machineId}:${join(remoteHome, "project")}` });

    assert.equal(app.cwdOf(id), `machine:${machineId}:${join(remoteHome, "project")}`);
    await app.commands.configure(id, owner(app), { model: { provider: "faux", modelId: "faux-1" }, thinkingLevel: "off" });

    const { submissionId } = await app.commands.submit(id, owner(app), { text: "where are you", requestId: crypto.randomUUID() });

    await (await app.harness.submission(submissionId, context))!.wait(context);
    const texts = await modelTexts(app, id);

    assert.ok(texts.some((each) => each.includes(join(remoteHome, "project")) && each.includes("marker-")), texts.join("\n"));
    assert.match(told, /run on the machine "box"/);
    assert.match(told, new RegExp(`Working directory there: ${join(remoteHome, "project")}`));
    assert.doesNotMatch(told, /Platform: /);
    void home;
});

test("a folder that is not on the machine is refused by name; the Files panel says it is not there yet", { skip }, async () => {
    await assert.rejects(
        app.commands.createSession(owner(app), { cwd: `machine:${machineId}:/no/such/folder` }),
        /There is no folder \/no\/such\/folder on box/,
    );
    const { id } = await app.commands.createSession(owner(app), { cwd: `machine:${machineId}:${join(remoteHome, "project")}` });

    await assert.rejects(app.workspace.fileList(id, owner(app)), /not available yet for a session on a machine \(box\)/);
    await assert.rejects(
        app.commands.createSession(owner(app), { cwd: `machine:${machineId}:${remoteHome}`, worktree: true }),
        /worktree of its own is for folders on this phone/,
    );
});

test("a session on the phone still works as before", async () => {
    const { id } = await app.commands.createSession(owner(app), { cwd: work });

    assert.equal(app.cwdOf(id), work);
});

test("Pi's sessions on a machine are listed from their headers, and one copied here continues in its folder there", { skip }, async () => {
    const { SessionManager } = await import("@earendil-works/pi-coding-agent");
    const project = join(remoteHome, "project");
    const manager = SessionManager.inMemory(project);

    manager.appendSessionInfo("Make the tests pass");
    manager.appendMessage({ role: "user", content: "Please make the tests pass.", timestamp: 1 });
    manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "On it." }], stopReason: "stop", timestamp: 2 } as never);
    const folder = join(remoteHome, ".pi", "agent", "sessions", "--project--");

    mkdirSync(folder, { recursive: true });
    writeFileSync(
        join(folder, "one.jsonl"),
        [manager.getHeader(), ...manager.getEntries()].map((entry) => JSON.stringify(entry)).join("\n") + "\n",
    );
    // The machine's home, as pi-env detected it, is where its sessions are looked for: on this test machine that is
    // this user's real home, so the file goes there too, under a folder of its own.
    const home = app.machines.get(machineId).remote!.home;
    const real = join(home, ".pi", "agent", "sessions", `--pi-phone-test-${process.pid}--`);

    mkdirSync(real, { recursive: true });
    writeFileSync(join(real, "one.jsonl"), readFileSync(join(folder, "one.jsonl")));

    try {
        const { sessions } = await app.piSessions.listOnMachine(owner(app), machineId);
        const found = sessions.find((each) => each.path === join(real, "one.jsonl"));

        assert.ok(found, JSON.stringify(sessions.slice(0, 3)));
        assert.equal(found.title, "Please make the tests pass.");
        assert.equal(found.cwd, project);

        const imported = await app.piSessions.importFromMachine(owner(app), machineId, found.path);
        const preview = await app.piSessions.preview(owner(app), imported.path);

        assert.equal(preview.cwd, `machine:${machineId}:${project}`);
        assert.equal(preview.cwdExists, true);
        assert.deepEqual(preview.machine, { id: machineId, name: "box" });

        const { id } = await app.commands.continuePiSession(owner(app), imported.path, preview.cwd);

        assert.equal(app.cwdOf(id), `machine:${machineId}:${project}`);
    } finally {
        rmSync(real, { recursive: true, force: true });
    }
});
