/** The data lock (pi-pocket 0.21.0's, PP-131): who holds it goes by the process's start time and boot, not its name. */
import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { takeLock, waitForLock } from "../src/server/lock.ts";

const procfs = process.platform === "linux" || process.platform === "android";
const lockModule = new URL("../src/server/lock.ts", import.meta.url).href;
// A child that takes the lock itself, as a running server does.
const holderScript = `
    import { takeLock } from ${JSON.stringify(lockModule)};
    takeLock(process.argv[1]);
    process.send("held");
    setInterval(() => {}, 1000);
`;

function fixture(t: TestContext) {
    const dir = mkdtempSync(join(tmpdir(), "pi-phone-lock-test-"));
    const lock = join(dir, "harness.lock");
    const children: ChildProcess[] = [];

    t.after(() => {
        for (const each of children) {
            each.kill("SIGKILL");
        }
        rmSync(dir, { recursive: true, force: true });
    });

    /** A live child: with `hold`, one that has taken the lock under a name that is not `node`; else a plain Node one. */
    async function child(hold = false): Promise<ChildProcess> {
        let each: ChildProcess;

        if (hold) {
            const executable = join(dir, "pocket-host");

            symlinkSync(process.execPath, executable);
            each = spawn(executable, ["--input-type=module", "-e", holderScript, "--", lock], {
                stdio: ["ignore", "inherit", "inherit", "ipc"],
            });
        } else {
            each = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
        }

        children.push(each);
        await (hold ? once(each, "message") : once(each, "spawn"));

        return each;
    }

    return { lock, child };
}

function identity(lock: string): { pid: number; startTime: string; fileId: string } {
    return JSON.parse(readFileSync(`${lock}.identity`, "utf8")) as { pid: number; startTime: string; fileId: string };
}

function assertOccupied(lock: string): void {
    const before = readFileSync(lock, "utf8");

    assert.throws(() => takeLock(lock), (error: Error) => /already running/i.test(error.message) && !/delete/i.test(error.message));
    assert.equal(readFileSync(lock, "utf8"), before);
}

function assertTakenOver(lock: string): void {
    const release = takeLock(lock);

    assert.equal(readFileSync(lock, "utf8").trim(), String(process.pid));
    assert.equal(identity(lock).pid, process.pid);
    release();
    assert.equal(existsSync(lock), false);
    assert.equal(existsSync(`${lock}.identity`), false);
}

test("a live holder under a name that is not node keeps the lock", async (t) => {
    const { lock, child } = fixture(t);

    await child(true);
    assertOccupied(lock);
});

test("a reused pid with another start time is taken over", { skip: !procfs }, async (t) => {
    const { lock, child } = fixture(t);
    const holder = await child(true);
    const saved = { ...identity(lock), startTime: "1" };

    writeFileSync(`${lock}.identity`, JSON.stringify(saved));
    assertTakenOver(lock);
    assert.doesNotThrow(() => process.kill(holder.pid ?? 0, 0));
});

test("an older release's lock goes by whether its live Node process started after it", { skip: !procfs }, async (t) => {
    const { lock, child } = fixture(t);
    const node = await child();
    const old = new Date(Date.now() - 60_000);

    writeFileSync(lock, `${node.pid}\n`);
    assertOccupied(lock);
    utimesSync(lock, old, old);
    assertTakenOver(lock);
});

test("an empty lock is taken over when old, and not when young", (t) => {
    const { lock } = fixture(t);
    const young = new Date(Date.now() - 1000);
    const old = new Date(Date.now() - 11_000);

    writeFileSync(lock, "");
    utimesSync(lock, young, young);
    assert.throws(() => takeLock(lock), /incomplete|damaged/i);
    utimesSync(lock, old, old);
    assertTakenOver(lock);
});

// PP-198: the phone's service started a new server while the one before it, sent SIGTERM, was still closing; the new
// one failed at once with "already running … delete <a file the person cannot reach>".
test("a holder that stops while the next one waits lets it start", async (t) => {
    const { lock, child } = fixture(t);
    const holder = await child(true);
    const lines: string[] = [];

    setTimeout(() => holder.kill("SIGKILL"), 400);

    const release = await waitForLock(lock, { waitMs: 8000, pollMs: 50, log: (line) => lines.push(line) });

    assert.equal(readFileSync(lock, "utf8").trim(), String(process.pid));
    release();
    assert.match(lines[0]!, new RegExp(`held by a live process \\(pid ${holder.pid}: .*pocket-host`));
    assert.match(lines.at(-1)!, /let go/);
});

test("a holder that does not stop fails the start with what to do, its pid and command line logged", async (t) => {
    const { lock, child } = fixture(t);
    const holder = await child(true);
    const lines: string[] = [];
    const started = Date.now();

    await assert.rejects(waitForLock(lock, { waitMs: 500, pollMs: 50, log: (line) => lines.push(line) }), (error: Error) => {
        assert.equal(error.message, `pi-phone is still stopping its earlier server (pid ${holder.pid}), so it cannot start. Restart the app.`);

        return true;
    });
    assert.ok(Date.now() - started >= 450, "it waited");
    assert.ok(lines.some((line) => line.includes(`pid ${holder.pid}: `) && line.includes("pocket-host")), lines.join(" | "));
    assert.doesNotThrow(() => process.kill(holder.pid ?? 0, 0), "the holder is left alone");
});

test("a release leaves a lock that is no longer this one", (t) => {
    const { lock } = fixture(t);
    const release = takeLock(lock);

    rmSync(lock);
    writeFileSync(lock, "123\n");
    release();
    assert.equal(readFileSync(lock, "utf8"), "123\n");
});
