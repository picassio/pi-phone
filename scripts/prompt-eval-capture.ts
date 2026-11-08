/**
 * prompt-eval's capture (PP-452): the real first request of a new session, as this tree's app builds it, in a
 * temporary home with a scripted model that answers "ok". Two variants: a session on the phone, and one on a machine
 * (a test sshd on 127.0.0.1, as test/remote-session.test.ts runs it). Writes `{ phone, machine, files }`: each
 * variant's request with the message `message`, and the skill files the prompts list (a model may read one first).
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
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai/providers/faux";

/** The message each variant's request carries, replaced by each scenario's (the output names it). */
const MESSAGE = "__PROMPT_EVAL_MESSAGE__";

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

        return fauxAssistantMessage([fauxText("ok")]);
    }),
    undefined,
    undefined,
    {},
    { tools: "load" },
);

async function capture(cwd?: string): Promise<Request> {
    seen = undefined;
    await say(app, await newSession(app, cwd), MESSAGE);

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

const phone = await capture();
const remote = await machine();
const onMachine = await capture(remote.cwd);
/** Every skill file a prompt lists, read now, before the temporary home goes. */
const files: Record<string, string> = {};

for (const request of [phone, onMachine]) {
    for (const message of request.messages) {
        for (const match of String(message.sections?.skills ?? "").matchAll(/<location>([^<]+)<\/location>/g)) {
            const path = match[1]!;

            if (existsSync(path)) {
                files[path] = readFileSync(path, "utf8");
            }
        }
    }
}

writeFileSync(out, JSON.stringify({ message: MESSAGE, phone, machine: onMachine, files }));
remote.sshd.kill();
await app.close();
cleanUp();
process.exit(0);
