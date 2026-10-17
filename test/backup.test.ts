// Backup and restore: one archive of the data folder (its database copied while the app runs), keys, Pi's folder and
// GitHub's sign-in; a restore takes only those paths, and goes in at the next start with what was there set aside.
import { cleanUp, home, openApp, owner, root, scriptedModel, work } from "./helpers.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { applyRestore, makeBackup, stageRestore } from "../src/server/backup.ts";

after(cleanUp);

test("a backup restores on another phone: sessions, keys, and sign-ins, with what was there set aside", async () => {
    mkdirSync(join(home, ".ssh", "keys"), { recursive: true });
    writeFileSync(join(home, ".ssh", "keys", "k1"), "private key\n");
    mkdirSync(join(home, ".pi", "agent"), { recursive: true });
    writeFileSync(join(home, ".pi", "agent", "auth.json"), '{"anthropic":{}}\n');
    const app = await openApp(scriptedModel(), join(root, "backup-data"));
    const { id } = await app.commands.createSession(owner(app), { cwd: work });

    await app.commands.updateSession(id, owner(app), { title: "kept across phones" });
    const made = await makeBackup(app.home, app.dataDir, root);

    await app.close();
    const members = execFileSync("tar", ["-tzf", made.file], { encoding: "utf8" }).split("\n");

    assert.ok(members.includes(".pi-pocket/pocket.sqlite"), members.join("\n"));
    assert.ok(members.includes(".pi-pocket/config.json"));
    assert.ok(members.includes(".ssh/keys/k1"));
    assert.ok(members.includes(".pi/agent/auth.json"));
    assert.ok(!members.some((member) => member.endsWith("harness.lock") || member.endsWith("-wal")));

    // Another phone: something there already, which the restore sets aside.
    const other = join(root, "other-home");
    const otherData = join(other, ".pi-pocket");

    mkdirSync(join(other, ".ssh"), { recursive: true });
    writeFileSync(join(other, ".ssh", "old"), "old\n");
    await stageRestore(other, readFileSync(made.file), root);
    assert.deepEqual(applyRestore(other, otherData).sort(), [".pi", ".pi-pocket", ".ssh"].map((path) => (path === ".pi" ? ".pi/agent" : path)).sort());
    assert.equal(readFileSync(join(other, ".ssh", "keys", "k1"), "utf8"), "private key\n");
    assert.ok(!existsSync(join(other, ".ssh", "old")));
    const aside = readdirSync(join(other, ".pi-phone-before-restore"));

    assert.equal(readFileSync(join(other, ".pi-phone-before-restore", aside[0]!, ".ssh", "old"), "utf8"), "old\n");
    assert.deepEqual(applyRestore(other, otherData), [], "once");

    const restored = await openApp(scriptedModel(), otherData);

    try {
        assert.ok(restored.sessions(owner(restored)).some((session) => session.title === "kept across phones"));
    } finally {
        await restored.close();
    }
});

test("a restore takes only a pi-phone backup", async () => {
    const odd = join(root, "odd");

    mkdirSync(join(odd, "etc"), { recursive: true });
    writeFileSync(join(odd, "etc", "passwd"), "x\n");
    execFileSync("tar", ["-czf", join(root, "odd.tar.gz"), "-C", odd, "etc"]);
    await assert.rejects(stageRestore(join(root, "h3"), readFileSync(join(root, "odd.tar.gz")), root), /it has etc/);
    await assert.rejects(stageRestore(join(root, "h3"), Buffer.from("not an archive"), root), /not a .tar.gz/);
});
