/**
 * prompt-eval's capture (PP-452): the real first request of a new session, as this tree's app builds it, in a
 * temporary home with a scripted model that answers "ok". Five variants: a session on the phone, one on a machine
 * (a test sshd on 127.0.0.1, as test/remote-session.test.ts runs it), one on the phone with a skill of the owner's
 * library pinned to it (`PINNED_SKILL`, PP-468), and two in a Godot project the MCP server `gopeak` serves (PP-526;
 * test/support/mcp-stub.ts with GoPeak's tool names): `mcp`, a new session there, and `mcp-loaded`, one whose first
 * turn loaded the server's scene tools with tool_search. A tree from before MCP servers captures those two without a
 * server. Writes `{ phone, machine, pinned, mcp, "mcp-loaded", files }`: each variant's request with the message
 * `message`, and the skill files the prompts list (a model may read one first).
 *
 *   node scripts/prompt-eval-capture.ts <out.json>
 *
 * scripts/prompt-eval.ts runs it as a child, here and, for `--compare <ref>`, copied into a checkout of that ref: it
 * needs only that tree's test/helpers.ts and app.
 */
import { cleanUp, newSession, openApp, root, say, scriptedModel } from "../test/helpers.ts";
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { userInfo } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";

/** The message each variant's request carries, replaced by each scenario's (the output names it). */
const MESSAGE = "__PROMPT_EVAL_MESSAGE__";
/** The `mcp-loaded` variant's first turn: the scripted model loads GoPeak's scene tools for it. */
const LOAD_MCP = "Load GoPeak's scene tools.";

type Request = { messages: { role: string; content: unknown; sections?: Record<string, string | null> }[] };

const out = process.argv[2];

if (out === undefined) {
    throw new Error("Usage: node scripts/prompt-eval-capture.ts <out.json>");
}

const sshdPath = "/usr/sbin/sshd";

if (!existsSync(sshdPath)) {
    throw new Error(`The machine variant needs an sshd at ${sshdPath}: run prompt-eval on the devbox.`);
}

let seen: Request | undefined;
// The session's own request: the one with the message (a title request has its own prompt).
const app = await openApp(
    scriptedModel((request) => {
        const messages = (request as Request).messages;

        if (seen === undefined && messages.some((message) => message.role === "user" && message.content === MESSAGE)) {
            seen = request as Request;
        }

        const last = messages.filter((message) => message.role !== "system").at(-1);

        if (last?.role === "user" && last.content === LOAD_MCP) {
            return fauxAssistantMessage([fauxToolCall("tool_search", { query: "scene node add save list tree", limit: 8 })], { stopReason: "toolUse" });
        }

        return fauxAssistantMessage([fauxText("ok")]);
    }),
    undefined,
    undefined,
    {},
    { tools: "load" },
);

/**
 * The library skill the pinned variant has (PP-468): a review procedure for one project, as an owner would keep, so a
 * scenario can ask whether Pi reads it when a request fits, and leaves it when one only shares its words.
 */
const PINNED_SKILL = `---
name: ssp-review
description: "Review a change to SSP, the billing service in ~/work/ssp, before it merges. Use when the owner asks to review an SSP pull request, branch or diff, or whether a billing or invoice change is safe to merge."
---

# SSP review

1. In ~/work/ssp, read the diff against main: \`git diff main...HEAD\`.
2. Run \`npm test\` and \`npm run migrate:check\`; a failing one stops the review.
3. Every money amount stays in integer cents; flag any float.
4. Report: what changed, the test results, and each risk with its file and line.
`;

async function capture(cwd?: string, pin = false, first?: string): Promise<Request> {
    seen = undefined;
    const id = await newSession(app, cwd);

    if (first !== undefined) {
        await say(app, id, first);
    }

    if (pin) {
        app.library.save("skill", "ssp-review", { "SKILL.md": PINNED_SKILL });
        app.library.setPin("skill", "ssp-review", { scope: "session", target: String(id) }, true);
    }

    await say(app, id, MESSAGE);

    if (seen === undefined) {
        throw new Error(`No request carried the message (${cwd ?? "phone"})`);
    }

    return seen;
}

/** A machine on a test sshd, connected: its home is a folder of this run's. */
async function machine(): Promise<{ cwd: string; sshd: ChildProcess }> {
    const port = await new Promise<number>((resolve) => {
        const server = createServer();

        server.listen(0, "127.0.0.1", () => {
            const { port } = server.address() as { port: number };

            server.close(() => resolve(port));
        });
    });
    const etc = join(root, "sshd");
    const home = join(root, "remote-home");

    mkdirSync(etc, { recursive: true });
    mkdirSync(join(home, ".ssh"), { recursive: true, mode: 0o700 });
    mkdirSync(join(home, "project"), { recursive: true });
    execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", join(etc, "host_key")]);
    chmodSync(join(etc, "host_key"), 0o600);
    const key = await app.sshKeys.generate("prompt-eval");

    writeFileSync(join(home, ".ssh", "authorized_keys"), `${key.publicKey}\n`, { mode: 0o600 });
    writeFileSync(
        join(etc, "sshd_config"),
        [
            `Port ${port}`,
            "ListenAddress 127.0.0.1",
            `HostKey ${join(etc, "host_key")}`,
            `AuthorizedKeysFile ${join(home, ".ssh", "authorized_keys")}`,
            "PasswordAuthentication no",
            "KbdInteractiveAuthentication no",
            "StrictModes no",
            "UsePAM no",
            `PidFile ${join(etc, "sshd.pid")}`,
            `SetEnv HOME=${home}`,
            "LogLevel ERROR",
            ...["/usr/lib/openssh/sftp-server", "/usr/libexec/openssh/sftp-server"].filter((path) => existsSync(path)).slice(0, 1).map((path) => `Subsystem sftp ${path}`),
        ].join("\n") + "\n",
    );
    const sshd = spawn(sshdPath, ["-D", "-e", "-f", join(etc, "sshd_config")], { stdio: ["ignore", "ignore", "inherit"] });

    for (let tries = 0; tries < 50 && !existsSync(join(etc, "sshd.pid")); tries++) {
        await new Promise((resolve) => setTimeout(resolve, 100));
    }

    const added = app.machines.add({ name: "devbox", address: `${userInfo().username}@127.0.0.1:${port}`, keyId: key.id });
    const scanned = await app.machines.scan(added.id);

    await app.machines.accept(added.id, scanned.lines, scanned.fingerprints[0]);
    await app.machines.connect(added.id);

    return { cwd: `machine:${added.id}:${join(home, "project")}`, sshd };
}

/** A Godot project the MCP server `gopeak` serves, in a tree that has MCP servers (PP-526): its tools listed. */
async function godotProject(): Promise<string> {
    const project = join(root, "godot-game");

    mkdirSync(join(project, "scenes"), { recursive: true });
    writeFileSync(join(project, "project.godot"), '[application]\nconfig/name="Ink Game"\nrun/main_scene="res://scenes/main.tscn"\n');
    writeFileSync(join(project, "scenes", "main.tscn"), '[gd_scene format=3]\n\n[node name="Main" type="Node2D"]\n');

    if ("mcpServers" in app) {
        app.mcpServers.save("gopeak", {
            command: process.execPath,
            args: [join(import.meta.dirname, "..", "test", "support", "mcp-stub.ts")],
            env: { STUB_PROFILE: "gopeak" },
            description: "Godot 4 editor: scenes, nodes, scripts, run and screenshot",
            folders: [project],
        });
        await app.mcp.tools("gopeak", project);
    }

    return project;
}

const phone = await capture();
const pinned = await capture(undefined, true);
const project = await godotProject();
const mcp = await capture(project);
const mcpLoaded = await capture(project, false, LOAD_MCP);
const remote = await machine();
const onMachine = await capture(remote.cwd);
/** Every skill file a prompt lists, read now, before the temporary home goes. */
const files: Record<string, string> = {};

for (const request of [phone, onMachine, pinned, mcp, mcpLoaded]) {
    for (const message of request.messages) {
        for (const match of String(message.sections?.skills ?? "").matchAll(/<location>([^<]+)<\/location>/g)) {
            const path = match[1]!;

            if (existsSync(path)) {
                files[path] = readFileSync(path, "utf8");
            }
        }
    }
}

writeFileSync(out, JSON.stringify({ message: MESSAGE, phone, machine: onMachine, pinned, mcp, "mcp-loaded": mcpLoaded, files }));
remote.sshd.kill();
await app.close();
cleanUp();
process.exit(0);
