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
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { userInfo } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { root } from "./helpers.ts";
import { APP_ROOT } from "../src/server/config.ts";

const sshdPath = ["/usr/sbin/sshd", join(process.env.PREFIX ?? "/usr", "bin", "sshd")].find((path) => existsSync(path));
const skip = sshdPath === undefined ? "no sshd on this machine" : false;

let told = "";
/** Asks the scripted model answers with one tool call, set by the tests. */
const calls: Record<string, [string, Record<string, unknown>]> = {};
let preamble = "";

const route: FauxResponseStep = (request) => {
    const messages = (request as { messages: { role: string; sections?: Record<string, string | null> }[] }).messages;

    for (const message of messages) {
        if (message.role === "system" && message.sections?.environment) {
            told = message.sections.environment;
        }

        if (message.role === "system" && message.sections?.preamble) {
            preamble = message.sections.preamble;
        }
    }

    const { role, text } = lastText(request as never);

    // The last message may be a system one (a section that changed, such as the secrets'): the ask is the last non-system one.
    const asked = lastText({ messages: messages.filter((message) => message.role !== "system") } as never);

    for (const [ask, [tool, args]] of Object.entries(calls)) {
        // With guests (an earlier test adds one), a message comes as "[from: Owner] …".
        if (asked.role === "user" && asked.text.endsWith(ask)) {
            return fauxAssistantMessage([fauxToolCall(tool, args as never)], { stopReason: "toolUse" });
        }
    }

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
            // scp speaks SFTP: the server's sftp-server, where this system keeps it (Termux, Debian, Fedora).
            ...[join(process.env.PREFIX ?? "/usr", "libexec", "sftp-server"), "/usr/lib/openssh/sftp-server", "/usr/libexec/openssh/sftp-server"]
                .filter((path) => existsSync(path))
                .slice(0, 1)
                .map((path) => `Subsystem sftp ${path}`),
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
    // Where it works, and that pi-phone's features work there too: not the phone's Termux.
    assert.match(preamble, /This session works on the owner's machine "box"/);
    assert.match(preamble, /the wiki \(the phone's, one for all sessions\), secrets/);
    assert.doesNotMatch(preamble, /Termux/);
    void home;
});

test("each set-up machine's health: this one answers; one whose address answers nothing says why", { skip }, async () => {
    const health = await app.places.health(true);

    assert.equal(health[machineId]?.ok, true);
    assert.equal((await app.places.health()) === health, true, "kept a minute");

    // A machine set up at an address where nothing listens (the test machine's port + 1).
    const broken = app.machines.add({ name: "gone", address: `${userInfo().username}@127.0.0.1:1`, keyId: app.machines.get(machineId).keyId });
    const stored = app.machines.get(broken.id);

    Object.assign(stored, { remote: app.machines.get(machineId).remote });
    const again = await app.places.health(true);

    assert.equal(again[broken.id]?.ok, false);
    assert.match(again[broken.id]?.problem ?? "", /not reachable|refused|Connection/i);
    app.machines.remove(broken.id);
});

test("a folder that is not on the machine is refused by name; worktrees stay on the phone", { skip }, async () => {
    await assert.rejects(
        app.commands.createSession(owner(app), { cwd: `machine:${machineId}:/no/such/folder` }),
        /There is no folder \/no\/such\/folder on box/,
    );
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

test("Files, the viewer, images, Changes, diffs, and undo work on the machine's folder", { skip }, async () => {
    const repo = join(remoteHome, "repo");
    const git = (...args: string[]) =>
        execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: repo, encoding: "utf8" });

    mkdirSync(join(repo, "src"), { recursive: true });
    writeFileSync(join(repo, "src", "app.txt"), "one\ntwo\n");
    writeFileSync(join(repo, "README.md"), "hello\n");
    copyFileSync(join(APP_ROOT, "web", "icon-192.png"), join(repo, "icon.png"));
    git("init", "-q");
    git("add", "-A");
    git("commit", "-qm", "init");
    writeFileSync(join(repo, "src", "app.txt"), "one\nTWO\n");
    writeFileSync(join(repo, "new.txt"), "fresh\n");

    const { id } = await app.commands.createSession(owner(app), { cwd: `machine:${machineId}:${repo}` });
    const me = owner(app);

    const listing = await app.workspace.fileList(id, me);

    assert.deepEqual(listing.files, ["README.md", "icon.png", "new.txt", "src/app.txt"]);

    const viewed = await app.workspace.viewFile(id, me, "src/app.txt");

    assert.equal(viewed.kind, "text");
    assert.equal(viewed.path, join(repo, "src", "app.txt"));
    assert.equal((viewed as { text: string }).text, "one\nTWO\n");
    assert.equal((await app.workspace.viewFile(id, me, "src")).kind, "folder");
    // The Files panel names folders as places, its root the session's own: they open the same.
    const asPanel = await app.workspace.viewFile(id, me, `machine:${machineId}:${repo}`);

    assert.equal(asPanel.kind, "folder");
    assert.equal(asPanel.path, repo);
    assert.equal((await app.workspace.viewFile(id, me, `machine:${machineId}:${repo}/src/app.txt`)).path, join(repo, "src", "app.txt"));
    await assert.rejects(app.workspace.viewFile(id, me, `machine:another:${repo}`), /not on this session's machine/);
    await assert.rejects(app.workspace.viewFile(id, me, "missing.txt"), /missing.txt is not there/);

    const image = await app.workspace.remoteImage(me, id, "icon.png");

    assert.equal(image?.type, "image/png");

    const changes = await app.workspace.changes(id, me);

    assert.equal(changes.repo?.root, repo);
    assert.deepEqual(
        changes.files.map((file) => [file.path, file.kind, file.added, file.removed]).sort(),
        [
            ["new.txt", "new", 1, 0],
            ["src/app.txt", "modified", 1, 1],
        ],
    );
    assert.match(await app.workspace.changeDiff(id, me, "src/app.txt"), /-two\n\+TWO/);

    await app.workspace.revertChange(id, me, "src/app.txt");
    await app.workspace.revertChange(id, me, "new.txt");
    assert.equal(readFileSync(join(repo, "src", "app.txt"), "utf8"), "one\ntwo\n");
    assert.equal(existsSync(join(repo, "new.txt")), false);
    assert.deepEqual((await app.workspace.changes(id, me)).files, []);
});

test("an attachment to a session on a machine is copied there, and the message names its path there", { skip }, async () => {
    const { id } = await app.commands.createSession(owner(app), { cwd: `machine:${machineId}:${join(remoteHome, "project")}` });

    await app.commands.configure(id, owner(app), { model: { provider: "faux", modelId: "faux-1" }, thinkingLevel: "off" });
    const uploads = app.workspace.uploadDirectory(id);

    mkdirSync(uploads, { recursive: true });
    const local = join(uploads, "abc-notes.txt");

    writeFileSync(local, "attached words\n");
    const home = app.machines.get(machineId).remote!.home;
    const there = join(home, ".pi", "mobile", "uploads", String(id), "abc-notes.txt");

    try {
        const { submissionId } = await app.commands.submit(id, owner(app), {
            text: "look at this",
            requestId: crypto.randomUUID(),
            attachments: [{ path: local, name: "notes.txt", mime: "text/plain", size: 15 }],
        });

        await (await app.harness.submission(submissionId, context))!.wait(context);
        assert.equal(readFileSync(there, "utf8"), "attached words\n");
        const texts = await modelTexts(app, id);

        assert.ok(texts.some((each) => each.includes(there)), texts.join("\n"));
        assert.ok(!texts.some((each) => each.includes(local)), "the phone's path is not in the message");
        assert.match(told, /copied to ~\/.pi\/mobile\/uploads on that machine/);
    } finally {
        rmSync(join(home, ".pi", "mobile", "uploads", String(id)), { recursive: true, force: true });
    }
});

test("a session goes to Pi on a machine, comes back with what Pi did there, and goes again to the same file", { skip }, async () => {
    const { SessionManager } = await import("@earendil-works/pi-coding-agent");
    const project = join(remoteHome, "project");
    const place = `machine:${machineId}:${project}`;
    const { id } = await app.commands.createSession(owner(app), { cwd: place });

    await app.commands.configure(id, owner(app), { model: { provider: "faux", modelId: "faux-1" }, thinkingLevel: "off" });
    const turn = async (text: string) => {
        const { submissionId } = await app.commands.submit(id, owner(app), { text, requestId: crypto.randomUUID() });

        await (await app.harness.submission(submissionId, context))!.wait(context);
        await app.harness.waitForIdle(context);
    };

    await turn("where are you");
    const home = app.machines.get(machineId).remote!.home;
    const folder = join(home, ".pi", "agent", "sessions", `--${project.replace(/^\//, "").replace(/[/:]/g, "-")}--`);

    try {
        const gone = await app.piHandoff.continueInPi(owner(app), id, place);

        assert.equal(gone.cwd, project);
        assert.ok(gone.path.startsWith(`${folder}/`), gone.path);

        // Pi itself opens it: the conversation with its tool call and result, its name and model.
        const pi = SessionManager.open(gone.path);
        const opened = pi.buildSessionContext();

        assert.deepEqual(opened.messages.map((message) => message.role), ["user", "assistant", "toolResult", "assistant"]);
        assert.equal(pi.getSessionName(), app.sessionMeta(id)!.title);
        assert.deepEqual(opened.model, { provider: "faux", modelId: "faux-1" });
        assert.equal((await app.piHandoff.status(owner(app), id)).link!.added, 0);
        assert.equal(app.sessions(owner(app)).find((each) => each.id === Number(id))?.inPi, machineId);
        assert.equal(app.sessions(app.config.addUser("Guest", "guest").user).find((each) => each.id === Number(id))?.inPi, undefined);

        // Pi goes on there, and compacts, keeping the last answer it was given from here.
        const kept = pi.getBranch().findLast((entry) => entry.type === "message")!.id;

        pi.appendMessage({ role: "user", content: "and now in pi", timestamp: Date.now() });
        pi.appendMessage({ role: "assistant", content: [{ type: "text", text: "pi answers" }], stopReason: "stop", timestamp: Date.now() } as never);
        pi.appendCompaction("what happened so far", kept, 1000);
        pi.appendMessage({ role: "user", content: "after the compaction", timestamp: Date.now() });

        const status = (await app.piHandoff.status(owner(app), id)).link!;

        assert.equal(status.machine, "box");
        assert.equal(status.added, 4);
        assert.equal(status.sessionWentOn, false);
        assert.equal(status.branchMoved, false);

        const back = await app.piHandoff.bringBack(owner(app), id);

        assert.deepEqual(back, { id: Number(id), added: 4 });
        const texts = (await modelTexts(app, id)).join("\n");

        assert.match(texts, /what happened so far/);
        assert.match(texts, /after the compaction/);
        assert.match(texts, /saw: /, "the kept answer from here stays");
        // The model gets what Pi's own context of the file is: the summary, and everything from the kept message on.
        const piTexts = SessionManager.open(gone.path)
            .buildSessionContext()
            .messages.map((message) => JSON.stringify((message as { content: unknown }).content));

        // (Pi's summary is a message of its own kind, which becomes the user message above for the model.)
        assert.deepEqual((await modelTexts(app, id)).slice(1), piTexts.slice(1));
        assert.equal((await app.piHandoff.status(owner(app), id)).link!.added, 0);

        // A turn here, and to Pi again: the same file, which Pi continues from where it was.
        await turn("hello again");
        const again = await app.piHandoff.continueInPi(owner(app), id);

        assert.equal(again.path, gone.path);
        const reopened = SessionManager.open(gone.path).buildSessionContext();

        assert.deepEqual(reopened.messages.slice(-2).map((message) => message.role), ["user", "assistant"]);
        assert.match(JSON.stringify(reopened.messages.at(-2)), /hello again/);
        assert.match(JSON.stringify(reopened.messages), /what happened so far/);

        // Both go on: it cannot come back into this session, only as a new one.
        const pi2 = SessionManager.open(gone.path);

        pi2.appendMessage({ role: "user", content: "pi went on", timestamp: Date.now() });
        await turn("so did the phone");
        assert.equal((await app.piHandoff.status(owner(app), id)).link!.sessionWentOn, true);
        await assert.rejects(app.piHandoff.bringBack(owner(app), id), /went on here too/);
        await assert.rejects(app.piHandoff.continueInPi(owner(app), id), /Pi went on/);

        const copy = await app.piHandoff.bringBack(owner(app), id, true);

        assert.notEqual(copy.id, Number(id));
        assert.match((await modelTexts(app, copy.id as never)).join("\n"), /pi went on/);
    } finally {
        rmSync(folder, { recursive: true, force: true });
    }
});

test("a file uploaded from the Files panel lands in the session's folder on the machine, never over another", { skip }, async () => {
    const project = join(remoteHome, "project");
    const { id } = await app.commands.createSession(owner(app), { cwd: `machine:${machineId}:${project}` });
    const target = join(project, "uploaded.txt");

    try {
        const put = await app.workspace.putFile(id, owner(app), `machine:${machineId}:${project}`, "uploaded.txt", Buffer.from("from the phone\n"));

        assert.equal(put.path, target);
        assert.equal(readFileSync(target, "utf8"), "from the phone\n");
        assert.ok((await app.workspace.fileList(id, owner(app))).files.includes("uploaded.txt"));
        await assert.rejects(
            app.workspace.putFile(id, owner(app), project, "uploaded.txt", Buffer.from("again")),
            /already a uploaded.txt there/,
        );
        assert.equal(readFileSync(target, "utf8"), "from the phone\n");
        await assert.rejects(app.workspace.putFile(id, owner(app), "/etc", "x.txt", Buffer.from("x")), /session's folder/);
    } finally {
        rmSync(target, { force: true });
    }
});

test("the machine answers, as the dock's machine bar asks", { skip }, async () => {
    assert.deepEqual(await app.places.reach(machineId), { ok: true });
});

test("branches on the machine: the chip shows what is checked out there, the sheet lists them, and switching works", { skip }, async () => {
    const repo = join(remoteHome, "branchy");
    const git = (...args: string[]) =>
        execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: repo, encoding: "utf8" });

    mkdirSync(repo, { recursive: true });
    git("init", "-q", "-b", "main");
    writeFileSync(join(repo, "a.txt"), "a\n");
    git("add", "-A");
    git("commit", "-qm", "first");
    git("branch", "feature");
    const { id } = await app.commands.createSession(owner(app), { cwd: `machine:${machineId}:${repo}` });

    // Asked of git there, so the first look says nothing yet, and the next one knows.
    app.workspace.head(id);
    for (let tries = 0; tries < 100 && app.workspace.head(id) === undefined; tries++) {
        await new Promise((resolve) => setTimeout(resolve, 50));
    }

    assert.deepEqual(app.workspace.head(id), { branch: "main" });
    const branches = await app.workspace.branches(id, owner(app));

    assert.deepEqual(branches.head, { branch: "main" });
    assert.deepEqual(branches.local.map((branch) => branch.name).sort(), ["feature", "main"]);

    assert.deepEqual(await app.workspace.switchBranch(id, owner(app), { name: "feature" }), { branch: "feature" });
    assert.equal(git("branch", "--show-current").trim(), "feature");
    await assert.rejects(app.workspace.switchBranch(id, owner(app), { name: "bad name..x" }), /cannot be a branch name/);

    for (let tries = 0; tries < 100 && JSON.stringify(app.workspace.head(id)) !== '{"branch":"feature"}'; tries++) {
        await new Promise((resolve) => setTimeout(resolve, 50));
    }

    assert.deepEqual(app.workspace.head(id), { branch: "feature" });
});

test("a call Pi left running comes back unfinished, and its result comes back once when Pi finishes it", { skip }, async () => {
    const { SessionManager } = await import("@earendil-works/pi-coding-agent");
    const project = join(remoteHome, "project");
    const place = `machine:${machineId}:${project}`;
    const { id } = await app.commands.createSession(owner(app), { cwd: place });

    await app.commands.configure(id, owner(app), { model: { provider: "faux", modelId: "faux-1" }, thinkingLevel: "off" });
    const { submissionId } = await app.commands.submit(id, owner(app), { text: "hello", requestId: crypto.randomUUID() });

    await (await app.harness.submission(submissionId, context))!.wait(context);
    await app.harness.waitForIdle(context);
    const home = app.machines.get(machineId).remote!.home;
    const folder = join(home, ".pi", "agent", "sessions", `--${project.replace(/^\//, "").replace(/[/:]/g, "-")}--`);

    try {
        const gone = await app.piHandoff.continueInPi(owner(app), id, place);
        const pi = SessionManager.open(gone.path);
        const call = { type: "toolCall", id: "call-1", name: "bash", arguments: { command: "sleep 100" } };

        pi.appendMessage({ role: "user", content: "run it", timestamp: Date.now() });
        pi.appendMessage({ role: "assistant", content: [call], stopReason: "toolUse", timestamp: Date.now() } as never);
        assert.equal((await app.piHandoff.bringBack(owner(app), id)).added, 2);

        pi.appendMessage({ role: "toolResult", toolCallId: "call-1", toolName: "bash", content: [{ type: "text", text: "slept" }], isError: false, timestamp: Date.now() } as never);
        pi.appendMessage({ role: "assistant", content: [{ type: "text", text: "done sleeping" }], stopReason: "stop", timestamp: Date.now() } as never);
        assert.equal((await app.piHandoff.bringBack(owner(app), id)).added, 2);

        const view = await (await app.harness.conversation(id, context))!.context(context);
        const results = view.messages.filter((message) => message.role === "toolResult" && message.toolCallId === "call-1");

        assert.equal(results.length, 1, JSON.stringify(results));
        assert.match(JSON.stringify(results[0]), /slept/);
    } finally {
        rmSync(folder, { recursive: true, force: true });
    }
});

test("a port of the machine opens here: its dev server answers at the forward's address, until it is closed", { skip }, async () => {
    const { createServer: createHttpServer } = await import("node:http");
    const devServer = createHttpServer((_request, response) => response.end("dev server here"));

    await new Promise<void>((resolve) => devServer.listen(0, "127.0.0.1", resolve));
    const port = (devServer.address() as { port: number }).port;

    try {
        const forward = await app.forwards.open(machineId, port);

        assert.equal(forward.remotePort, port);
        assert.equal(await (await fetch(forward.url)).text(), "dev server here");
        assert.equal((await app.forwards.open(machineId, port)).id, forward.id, "the same port opens once");
        assert.deepEqual(app.forwards.list().map((each) => each.id), [forward.id]);

        app.forwards.close(forward.id);
        assert.deepEqual(app.forwards.list(), []);
        await assert.rejects(app.forwards.open(machineId, 70000), /whole number from 1 to 65535/);
    } finally {
        devServer.close();
    }
});

test("Pi reaches machines with machine_run and machine_copy, never ssh; the app's key stores are refused; ~/.ssh stays empty", { skip }, async () => {
    const { home } = await import("./helpers.ts");
    const note = join(root, "note.txt");
    const back = join(root, "back.txt");

    writeFileSync(note, "from the phone\n");
    app.secrets.set("BOX_TOKEN", { value: "box-token-123456789" });
    calls["run on box"] = ["machine_run", { machine: "box", command: 'echo ran-$((40+2)); printf "%s" "$BOX_TOKEN" | wc -c; echo "$BOX_TOKEN"' }];
    calls["copy to box"] = ["machine_copy", { from: note, to: "box:~/copied/" }];
    calls["copy back"] = ["machine_copy", { from: "box:~/copied/note.txt", to: back }];
    calls["read the keys"] = ["read", { path: join(app.dataDir, "ssh", "keys") }];
    calls["pi-ssh it"] = ["bash", { command: `pi-ssh box 'echo via-pi-ssh-$((40+2))' && rsync -a -e pi-ssh ${note} box:${join(remoteHome, "synced.txt")} && pi-ssh box 'cat ${join(remoteHome, "synced.txt")}' && scp -q -S pi-ssh box:${join(remoteHome, "synced.txt")} ${join(root, "scp-back.txt")} && cat ${join(root, "scp-back.txt")}` }];
    calls["dump the database"] = ["bash", { command: `sqlite3 ${join(app.dataDir, "pocket.sqlite")} .dump` }];

    const { id } = await app.commands.createSession(owner(app), { cwd: join(remoteHome, "..") });

    await app.commands.configure(id, owner(app), { model: { provider: "faux", modelId: "faux-1" }, thinkingLevel: "off" });
    const say = async (text: string) => {
        const { submissionId } = await app.commands.submit(id, owner(app), { text, requestId: crypto.randomUUID() });

        await (await app.harness.submission(submissionId, context))!.wait(context);
        await app.harness.waitForIdle(context);

        return (await modelTexts(app, id)).at(-1)!;
    };

    const ran = await say("run on box");

    assert.match(ran, /box:[^ ]* · exit 0/);
    assert.match(ran, /ran-42/);
    assert.ok(ran.includes("\\n19\\n"), "the secret reached the command on the machine: 19 characters");
    assert.match(ran, /\[secret BOX_TOKEN\]/);
    assert.doesNotMatch(ran, /box-token-123456789/);

    assert.match(await say("copy to box"), /Copied phone:[^ ]*note\.txt to box:[^ ]*copied\/note\.txt \(15 bytes\)/);
    assert.match(await say("copy back"), /Copied box:/);
    assert.equal(readFileSync(back, "utf8"), "from the phone\n");

    // pi-ssh: ssh with the app's machines, signing through its agent: a command, rsync, and scp.
    const piSsh = await say("pi-ssh it");

    assert.match(piSsh, /via-pi-ssh-42/);
    assert.equal((piSsh.match(/from the phone/g) ?? []).length, 2, `rsync there and scp back: ${piSsh}`);

    assert.match(await say("read the keys"), /keeps its keys .* out of Pi's tools/);
    assert.match(await say("dump the database"), /keeps its keys .* out of Pi's tools/);

    // The phone session's prompt names the machines, and the tools to use; no ssh.
    assert.match(told, /The owner's machines: box \(/);
    assert.match(told, /machine_run[^\n]*machine_copy/);
    assert.match(told, /use pi-ssh, ssh with these machines by name/);
    assert.equal(existsSync(join(home, ".ssh", "pi-phone_config")), false);
    assert.equal(existsSync(join(home, ".ssh", "keys")), false);
    app.secrets.remove("BOX_TOKEN");
});

test("a machine connected, renamed, or removed reaches every tab at once: hello is sent again with the machines", { skip }, async () => {
    const { fakeTab } = await import("./helpers.ts");
    const tab = fakeTab(undefined, owner(app));
    const machinesOf = () =>
        ((tab.events.findLast((each) => each.event === "hello")?.data.server as { machines?: { id: string; name: string }[] }) ?? {})
            .machines ?? [];

    await app.attach(tab.client);
    const name = app.machines.get(machineId).name;
    const { host, user, port, keyId } = app.machines.get(machineId);
    const address = `${user}@${host}${port === undefined ? "" : `:${port}`}`;
    const sent = tab.events.filter((each) => each.event === "hello").length;

    try {
        await app.machines.edit(machineId, { name: "box-renamed", address, keyId });

        for (let tries = 0; tries < 50 && !machinesOf().some((each) => each.name === "box-renamed"); tries++) {
            await new Promise((resolve) => setTimeout(resolve, 20));
        }

        assert.ok(tab.events.filter((each) => each.event === "hello").length > sent, "hello was sent again");
        assert.ok(machinesOf().some((each) => each.id === machineId && each.name === "box-renamed"), JSON.stringify(machinesOf()));
    } finally {
        await app.machines.edit(machineId, { name, address, keyId });
        app.detach?.(tab.client);
    }
});
