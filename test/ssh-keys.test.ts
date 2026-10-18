// SSH keys: kept in the app's database and its ssh-agent, never as private key files; generated and imported keys,
// their public halves and fingerprints, keys from before moved in from ~/.ssh/keys once, renamed and removed.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { SshAgent } from "../src/server/ssh-agent.ts";
import { SshKeys } from "../src/server/ssh-keys.ts";

const root = mkdtempSync(join(tmpdir(), "pi-phone-keys-"));
const data = join(root, "data");
const home = join(root, "home");
const sshDir = join(data, "ssh");

mkdirSync(data);
mkdirSync(home);
const agent = new SshAgent(sshDir);
const keys = new SshKeys(data, agent, sshDir, home);

await keys.open();

after(() => {
    agent.stop();
    keys.close();
});

/** The private keys the database holds, by id. */
const stored = () =>
    Object.fromEntries(
        (new DatabaseSync(join(data, "pocket.sqlite")).prepare("SELECT id, private_key FROM pocket_ssh_keys").all() as { id: string; private_key: string }[]).map(
            (row) => [row.id, row.private_key],
        ),
    );
const held = async () => (await agent.keys()).map((line) => line.split(" ").slice(0, 2).join(" "));
const files = (folder: string): string[] =>
    existsSync(folder) ? readdirSync(folder, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? files(join(folder, entry.name)).map((name) => `${entry.name}/${name}`) : [entry.name])) : [];

test("a generated key is in the database and the agent, never a file; its public half is", async () => {
    const key = await keys.generate("laptop");

    assert.equal(key.type, "ed25519");
    assert.match(key.fingerprint, /^SHA256:/);
    assert.match(key.publicKey, /^ssh-ed25519 \S+ pi-phone laptop$/);
    assert.match(stored()[key.id] ?? "", /BEGIN OPENSSH PRIVATE KEY/);
    assert.ok((await held()).includes(key.publicKey.split(" ").slice(0, 2).join(" ")), "the agent holds it");
    assert.deepEqual(files(sshDir).filter((name) => !name.endsWith(".pub") && name !== "agent.sock"), [], "no private key file, no work files");
    assert.equal(statSync(sshDir).mode & 0o777, 0o700);
    assert.equal(existsSync(join(home, ".ssh")), false, "nothing in ~/.ssh");

    // The names survive a reopen.
    const again = new SshKeys(data, agent, sshDir, home);

    assert.equal((await again.get(key.id)).fingerprint, key.fingerprint);
    again.close();
});

test("an imported key is checked by deriving its public key; junk and passphrases are refused, and leave nothing", async () => {
    const elsewhere = join(root, "elsewhere");

    execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", elsewhere]);
    const imported = await keys.import("work", readFileSync(elsewhere, "utf8"));
    const expected = readFileSync(`${elsewhere}.pub`, "utf8").split(" ").slice(0, 2).join(" ");

    assert.equal(imported.source, "imported");
    assert.ok(imported.publicKey.startsWith(expected));
    assert.ok((await held()).includes(expected));

    await assert.rejects(keys.import("x", "not a key"), /whole private key/);
    await assert.rejects(keys.import("x", "-----BEGIN OPENSSH PRIVATE KEY-----\nnope\n-----END OPENSSH PRIVATE KEY-----\n"), /not a private key/);
    const locked = join(root, "locked");

    execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "secret", "-f", locked]);
    await assert.rejects(keys.import("x", readFileSync(locked, "utf8")), /passphrase/);
    assert.equal((await keys.list()).length, 2, "refused imports leave nothing behind");
    assert.deepEqual(files(sshDir).filter((name) => name.startsWith("work-")), []);
});

test("keys from before (files in ~/.ssh/keys) move in once: checked, stored, their files deleted; a mismatch stays", async () => {
    const folder = join(root, "old-data");
    const oldHome = join(root, "old-home");
    const legacy = join(oldHome, ".ssh", "keys");
    const oldSsh = join(folder, "ssh");

    mkdirSync(legacy, { recursive: true });
    mkdirSync(folder);
    execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", "pi-phone good", "-f", join(legacy, "good")]);
    execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", join(legacy, "bad")]);
    execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", join(root, "other")]);
    // "bad"'s public file is another key's: it does not derive from its private key.
    writeFileSync(join(legacy, "bad.pub"), readFileSync(join(root, "other.pub")));
    writeFileSync(join(folder, "keys.json"), JSON.stringify({ keys: [{ id: "good", name: "good", createdAt: 1, source: "generated" }, { id: "bad", name: "bad", createdAt: 1, source: "generated" }] }));

    const oldAgent = new SshAgent(oldSsh);
    const moved = new SshKeys(folder, oldAgent, oldSsh, oldHome);

    await moved.open();

    try {
        const [good, bad] = await moved.list();

        assert.equal(good!.problem, undefined);
        assert.equal(existsSync(join(legacy, "good")), false, "its files are gone");
        assert.equal(existsSync(join(legacy, "good.pub")), false);
        assert.ok((await oldAgent.keys()).some((line) => line.startsWith(good!.publicKey.split(" ").slice(0, 2).join(" "))));
        assert.match(bad!.problem ?? "", /does not match its public key; it was left where it is/);
        assert.equal(existsSync(join(legacy, "bad")), true, "a key that fails the check stays");
    } finally {
        oldAgent.stop();
        moved.close();
    }
});

test("rename and remove: a removed key leaves the agent, the database, and its public file", async () => {
    const [key] = await keys.list();

    keys.rename(key!.id, "  the laptop ");
    assert.equal((await keys.get(key!.id)).name, "the laptop");
    assert.throws(() => keys.rename(key!.id, ""), /Name the key/);

    const publicFile = keys.publicKeyPath(key!.id);

    await keys.remove(key!.id);
    assert.equal(existsSync(publicFile), false);
    assert.equal(stored()[key!.id], undefined);
    assert.ok(!(await held()).includes(key!.publicKey.split(" ").slice(0, 2).join(" ")), "the agent let it go");
    await assert.rejects(keys.remove(key!.id), /no such SSH key/);
    assert.equal((await keys.list()).length, 1);
});
