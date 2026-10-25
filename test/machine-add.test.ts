// Pi adds a machine (`machine_add`, PP-139), against a real sshd on loopback (as test/machines.test.ts): one card shows
// the address, the key and the host key as scanned (checked against the one Pi read, when given); a host key that is
// not the one given is refused before any card; Deny saves nothing; Approve adds it, trusts the key, deploys pi-env and
// connects; a machine that refuses the key saves nothing but the new key, whose
// public half comes back for Pi to install.
import { type App, cleanUp, context, lastText, modelTexts, newSession, openApp, owner, scriptedModel, until } from "./helpers.ts";
import assert from "node:assert/strict";
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";

const sshdPath = ["/usr/sbin/sshd", join(process.env.PREFIX ?? "/usr", "bin", "sshd")].find((path) => existsSync(path));
const skip = sshdPath === undefined ? "no sshd on this machine" : false;
const root = mkdtempSync(join(tmpdir(), "pi-phone-machine-add-"));
const etc = join(root, "etc");
const authorized = join(root, "remote-home", ".ssh", "authorized_keys");
let sshd: ChildProcess | undefined;
let port = 0;
let hostFingerprint = "";
/** What Pi calls machine_add with, by the message's end. */
let calls: Record<string, Record<string, unknown>> = {};

const route: FauxResponseStep = (request) => {
    const { role, text } = lastText(request as never);

    for (const [ask, args] of Object.entries(calls)) {
        if (role === "user" && text.endsWith(ask)) {
            return fauxAssistantMessage([fauxToolCall("machine_add", args as never)], { stopReason: "toolUse" });
        }
    }

    return fauxAssistantMessage([fauxText(role === "toolResult" ? `told: ${text}` : "ok")]);
};
let app: App;

function freePort(): Promise<number> {
    return new Promise((resolve, reject) => {
        const server = createServer();

        server.listen(0, "127.0.0.1", () => {
            const { port: free } = server.address() as { port: number };

            server.close(() => resolve(free));
        });
        server.on("error", reject);
    });
}

before(async () => {
    app = await openApp(scriptedModel(route), join(root, "data"));

    if (sshdPath === undefined) {
        return;
    }

    port = await freePort();
    mkdirSync(etc);
    mkdirSync(join(root, "remote-home", ".ssh"), { recursive: true, mode: 0o700 });
    execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", join(etc, "host_key")]);
    chmodSync(join(etc, "host_key"), 0o600);
    // As Pi reads it on the machine itself.
    hostFingerprint = execFileSync("ssh-keygen", ["-lf", join(etc, "host_key.pub")], { encoding: "utf8" }).split(/\s+/)[1]!;
    writeFileSync(authorized, "", { mode: 0o600 });
    writeFileSync(
        join(etc, "sshd_config"),
        `${[
            `Port ${port}`,
            "ListenAddress 127.0.0.1",
            `HostKey ${join(etc, "host_key")}`,
            `AuthorizedKeysFile ${authorized}`,
            "PasswordAuthentication no",
            "KbdInteractiveAuthentication no",
            "PubkeyAuthentication yes",
            "StrictModes no",
            "UsePAM no",
            `PidFile ${join(etc, "sshd.pid")}`,
            "LogLevel ERROR",
        ].join("\n")}\n`,
    );
    sshd = spawn(sshdPath, ["-D", "-e", "-f", join(etc, "sshd_config")], { stdio: ["ignore", "ignore", "pipe"] });
    await until(() => existsSync(join(etc, "sshd.pid")), "sshd listens");
});

after(async () => {
    sshd?.kill();
    await app?.close();
    cleanUp();
});

/** One turn; with `answer`, the card it waits on is answered so and returned. */
async function turn(id: number, text: string, answer?: boolean) {
    const { submissionId } = await app.commands.submit(id as never, owner(app), { text, requestId: crypto.randomUUID() });
    let card: ReturnType<typeof app.approvals.all>[number] | undefined;

    if (answer !== undefined) {
        await until(() => app.approvals.forConversation(id as never).length > 0, "the card");
        card = app.approvals.forConversation(id as never)[0]!;
        await app.answerApproval(card.id, answer, owner(app));
    }

    await (await app.harness.submission(submissionId, context))!.wait(context);
    await app.harness.waitForIdle(context);

    return { said: (await modelTexts(app, id as never)).at(-1)!, card };
}

const address = () => `${userInfo().username}@127.0.0.1:${port}`;

test("a host key that is not the one Pi read is refused before any card, and nothing is saved", { skip }, async () => {
    const key = await app.sshKeys.generate("wrong-check");

    calls = { "add it wrong": { name: "box-wrong", address: address(), key: key.name, expectedFingerprint: "SHA256:AAAAnotThisKeyAtAll0000000000000000000000000", reason: "A new VM" } };
    const id = await newSession(app);
    const { said } = await turn(id, "add it wrong");

    assert.match(said, /not SHA256:AAAAnotThisKeyAtAll.*refused, nothing saved/);
    assert.equal(app.approvals.all().length, 0, "no card");
    assert.equal(app.machines.list().some((each) => each.name === "box-wrong"), false);
});

test("Deny saves nothing; the card shows the address, the key and the host key that matched", { skip }, async () => {
    const key = await app.sshKeys.generate("deny-key");

    calls = { "add it": { name: "box-deny", address: address(), key: key.name, expectedFingerprint: hostFingerprint, reason: "A new VM" } };
    const id = await newSession(app);
    const { said, card } = await turn(id, "add it", false);

    assert.deepEqual(card?.form, {
        type: "machine",
        name: "box-deny",
        address: address(),
        key: { name: "deny-key", fingerprint: key.fingerprint, new: false },
        hostKeys: [`${hostFingerprint} (ED25519)`],
        expected: hostFingerprint,
        matches: true,
    });
    assert.equal(card?.reason, "A new VM");
    assert.match(said, /said no: nothing was saved/);
    assert.equal(app.machines.list().some((each) => each.name === "box-deny"), false);
    assert.ok(!existsSync(app.machines.knownHostsFile) || readFileSync(app.machines.knownHostsFile, "utf8").trim() === "", "no host key trusted");
});

test("Approve adds it, trusts the host key, deploys pi-env and connects, ready for Pi and the folder picker", { skip }, async () => {
    const key = await app.sshKeys.generate("approve-key");

    writeFileSync(authorized, `${key.publicKey}\n`, { mode: 0o600 });
    calls = { "add it now": { name: "box-yes", address: address(), key: key.name, expectedFingerprint: hostFingerprint, reason: "A new VM" } };
    const id = await newSession(app);
    const { said } = await turn(id, "add it now", true);

    assert.match(said, /Added box-yes .* and connected: (linux|android) (x64|arm64)/);
    const added = app.machines.list().find((each) => each.name === "box-yes");

    assert.ok(added?.remote, "connected");
    assert.equal(added?.hostKey, `${hostFingerprint} (ED25519)`);
    assert.match(readFileSync(app.machines.knownHostsFile, "utf8"), new RegExp(`pi-phone-${added!.id}`));
    // In the list Pi and the folder picker read (`hello`'s machines come from the same list).
    assert.ok(app.machines.sshHosts().some(({ machine }) => machine.id === added!.id));
});

test('With key "new", a machine that refuses it saves nothing but the key, whose public half comes back', { skip }, async () => {
    writeFileSync(authorized, "", { mode: 0o600 });
    calls = { "add with a new key": { name: "box-new", address: address(), key: "new", reason: "A new VM" } };
    const id = await newSession(app);
    const { said, card } = await turn(id, "add with a new key", true);

    assert.deepEqual(card?.form && { key: (card.form as { key: unknown }).key, matches: (card.form as { matches?: boolean }).matches }, { key: { name: "box-new", fingerprint: "", new: true }, matches: undefined });
    const made = (await app.sshKeys.list()).find((each) => each.name === "box-new");

    assert.ok(made, "the new key is kept");
    assert.match(said, /refused the key/);
    assert.ok(said.includes(made!.publicKey), "its public half came back");
    assert.equal(app.machines.list().some((each) => each.name === "box-new"), false, "no machine saved");
});
