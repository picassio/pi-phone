// SSH keys: generated and imported keys, their public halves and fingerprints, renamed and removed.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SshKeys } from "../src/server/ssh-keys.ts";

const root = mkdtempSync(join(tmpdir(), "pi-phone-keys-"));

mkdirSync(join(root, "data"));
const keys = new SshKeys(join(root, "data"), join(root, "home"));

test("a generated key has its files, mode 600, a fingerprint, and a public key naming the app", async () => {
    const key = await keys.generate("laptop");

    assert.equal(key.type, "ed25519");
    assert.match(key.fingerprint, /^SHA256:/);
    assert.match(key.publicKey, /^ssh-ed25519 \S+ pi-phone laptop$/);
    assert.equal(statSync(keys.privateKeyPath(key.id)).mode & 0o777, 0o600);
    assert.equal(statSync(keys.dir).mode & 0o777, 0o700);
    assert.deepEqual((await keys.list()).map((each) => each.name), ["laptop"]);

    // The names survive a reopen; the files are what they were.
    const again = new SshKeys(join(root, "data"), join(root, "home"));

    assert.equal((await again.get(key.id)).fingerprint, key.fingerprint);
});

test("an imported key is checked by deriving its public key; junk and passphrases are refused", async () => {
    const elsewhere = join(root, "elsewhere");

    execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", elsewhere]);
    const imported = await keys.import("work", readFileSync(elsewhere, "utf8"));
    const expected = readFileSync(`${elsewhere}.pub`, "utf8").split(" ").slice(0, 2).join(" ");

    assert.equal(imported.source, "imported");
    assert.ok(imported.publicKey.startsWith(expected));

    await assert.rejects(keys.import("x", "not a key"), /whole private key/);
    await assert.rejects(keys.import("x", "-----BEGIN OPENSSH PRIVATE KEY-----\nnope\n-----END OPENSSH PRIVATE KEY-----\n"), /not a private key/);
    const locked = join(root, "locked");

    execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "secret", "-f", locked]);
    await assert.rejects(keys.import("x", readFileSync(locked, "utf8")), /passphrase/);
    assert.equal((await keys.list()).length, 2, "refused imports leave nothing behind");
});

test("rename and remove", async () => {
    const [key] = await keys.list();

    keys.rename(key!.id, "  the laptop ");
    assert.equal((await keys.get(key!.id)).name, "the laptop");
    assert.throws(() => keys.rename(key!.id, ""), /Name the key/);

    const path = keys.privateKeyPath(key!.id);

    keys.remove(key!.id);
    assert.equal(existsSync(path), false);
    assert.equal(existsSync(`${path}.pub`), false);
    assert.throws(() => keys.remove(key!.id), /no such SSH key/);
    assert.equal((await keys.list()).length, 1);
});
