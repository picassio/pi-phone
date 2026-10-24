/**
 * One pi-phone process per data directory (pi-pocket 0.21.0's lock, PP-131). The lock file holds only the holder's
 * process id, as before, so a lock left by an older release reads the same. Who the holder is, is in a sidecar
 * (`<lock>.identity`) bound to that lock file: the process's start time and the boot it ran in, from `/proc` (which
 * Android has too). A process id reused after a crash, by any program (Node included: Pi's own commands run Node on
 * the phone), is then told apart from the holder, and its lock taken over.
 */
import { execFileSync } from "node:child_process";
import { closeSync, fstatSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { uptime } from "node:os";

const INCOMPLETE_LOCK_GRACE_MS = 10_000;
const PROCESS_START_MARGIN_MS = 5_000;
const UPTIME_RESOLUTION_MS = 1_000;
let clockTicksPerSecond: number | undefined;

type Lock = {
    pid: number;
    fileId: string;
    mtimeMs: number;
};

type Identity = {
    version: 1;
    pid: number;
    fileId: string;
    startTime?: string;
    bootId?: string;
};

/** Read one file handle so a replaced path cannot combine one lock's pid with another lock's inode. */
function readLock(lockFile: string): Lock | undefined {
    let fd: number;

    try {
        fd = openSync(lockFile, "r");
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            return undefined;
        }

        throw error;
    }

    try {
        const stat = fstatSync(fd, { bigint: true });
        const pid = Number(readFileSync(fd, "utf8").trim());

        return {
            pid,
            fileId: `${stat.dev}:${stat.ino}:${stat.ctimeNs}`,
            mtimeMs: Number(stat.mtimeMs),
        };
    } finally {
        closeSync(fd);
    }
}

/** Linux stat's comm field can contain spaces and parentheses. Fields after its final ')' start at field 3. */
function processIdentity(pid: number): Pick<Identity, "startTime" | "bootId"> {
    const identity: Pick<Identity, "startTime" | "bootId"> = {};

    try {
        const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
        const end = stat.lastIndexOf(")");
        const startTime =
            end === -1
                ? undefined
                : stat
                      .slice(end + 2)
                      .trim()
                      .split(/\s+/)[19];

        if (startTime !== undefined && /^\d+$/.test(startTime)) {
            identity.startTime = startTime;
        }
    } catch {
        // Without readable process evidence, a live pid must remain occupied.
    }

    try {
        identity.bootId = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    } catch {
        // Systems without /proc keep the live-pid rule.
    }

    return identity;
}

/** getconf supplies USER_HZ, which need not equal the kernel timer rate. The usual 100 only where it cannot. */
function ticksPerSecond(): number {
    if (clockTicksPerSecond === undefined) {
        clockTicksPerSecond = 100;

        try {
            const value = Number(
                execFileSync("getconf", ["CLK_TCK"], {
                    encoding: "utf8",
                    timeout: 1000,
                    stdio: ["ignore", "pipe", "ignore"],
                }).trim(),
            );

            if (Number.isSafeInteger(value) && value > 0) {
                clockTicksPerSecond = value;
            }
        } catch {
            // getconf is not installed everywhere.
        }
    }

    return clockTicksPerSecond;
}

/**
 * A Linux process's wall-clock start. The boot's time comes from the system's uptime (`os.uptime`, the kernel's boot
 * clock): Android refuses apps `/proc/stat` and `/proc/uptime`, where pi-pocket reads it. Unreadable or inconsistent
 * evidence cannot permit a takeover.
 */
function processStartMs(startTime: string | undefined): number | undefined {
    if (startTime === undefined) {
        return undefined;
    }

    const ticks = Number(startTime);
    const up = uptime();

    if (!Number.isSafeInteger(ticks) || !Number.isFinite(up) || up <= 0) {
        return undefined;
    }

    const now = Date.now();
    const started = now - up * 1000 + (ticks / ticksPerSecond()) * 1000;

    // The uptime is in whole seconds on Android, so a process started just now may seem up to a second ahead; further
    // in the future means a clock change or a wrong tick rate.
    return Number.isFinite(started) && started <= now + UPTIME_RESOLUTION_MS ? Math.min(started, now) : undefined;
}

function readIdentity(lockFile: string, lock: Lock): Identity | undefined {
    try {
        const value = JSON.parse(readFileSync(`${lockFile}.identity`, "utf8")) as Identity;

        if (
            value?.version === 1 &&
            value.pid === lock.pid &&
            value.fileId === lock.fileId &&
            (value.startTime === undefined ||
                (typeof value.startTime === "string" && /^\d+$/.test(value.startTime))) &&
            (value.bootId === undefined ||
                (typeof value.bootId === "string" &&
                    /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value.bootId)))
        ) {
            return value;
        }
    } catch {
        // Missing, damaged, or old: it cannot show that a live holder is stale.
    }

    return undefined;
}

function lockHolder(lockFile: string, lock: Lock): boolean {
    if (!Number.isSafeInteger(lock.pid) || lock.pid <= 0) {
        // A lock being written right now is empty for a moment; an old damaged one is a crash's.
        if (Date.now() - lock.mtimeMs < INCOMPLETE_LOCK_GRACE_MS) {
            throw new Error(`pi-phone's lock is incomplete or damaged and still recent: ${lockFile}. Try again shortly.`);
        }

        return false;
    }

    if (lock.pid === process.pid) {
        return false;
    }

    try {
        process.kill(lock.pid, 0);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH") {
            return false;
        }

        // EPERM and other uncertain failures do not show that the holder has stopped.
    }

    const saved = readIdentity(lockFile, lock);
    const current = processIdentity(lock.pid);

    if (saved !== undefined) {
        if (
            (saved.startTime !== undefined &&
                current.startTime !== undefined &&
                saved.startTime !== current.startTime) ||
            (saved.bootId !== undefined && current.bootId !== undefined && saved.bootId !== current.bootId)
        ) {
            return false;
        }
    }

    if (saved?.startTime === undefined) {
        const started = processStartMs(current.startTime);

        if (started !== undefined && started > lock.mtimeMs + PROCESS_START_MARGIN_MS) {
            // A process that began clearly after this lock was written cannot be its holder.
            return false;
        }
    }

    // A live holder stays when the evidence is missing or too close in time, whatever its program's name.
    return true;
}

/** Remove the lock only while it is still this one (same pid, same file): not an atomic compare-and-unlink. */
function release(lockFile: string, owned: Lock): void {
    const current = readLock(lockFile);

    if (current === undefined || !Object.is(current.pid, owned.pid) || current.fileId !== owned.fileId) {
        return;
    }

    try {
        rmSync(`${lockFile}.identity`, { force: true });
    } finally {
        rmSync(lockFile, { force: true });
    }
}

/**
 * Take the data directory's lock, or throw when a live pi-phone holds it. A lock left by a process that died (killed,
 * or its phone stopped it) is taken over; created with `wx`, so of two processes starting at once only one gets it.
 * Answers this lock's release.
 */
export function takeLock(lockFile: string): () => void {
    const previous = readLock(lockFile);

    if (previous !== undefined) {
        if (lockHolder(lockFile, previous)) {
            throw new Error(
                `pi-phone is already running on this data directory (pid ${previous.pid}). If it is not, delete ${lockFile}.`,
            );
        }

        release(lockFile, previous);
    }

    try {
        writeFileSync(lockFile, `${process.pid}\n`, { flag: "wx", mode: 0o600 });
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
            throw error;
        }

        throw new Error("pi-phone is already running on this data directory: another one started at the same moment.");
    }

    const owned = readLock(lockFile);

    if (owned === undefined) {
        throw new Error(`pi-phone's lock disappeared as it was taken: ${lockFile}.`);
    }

    try {
        const identity: Identity = { version: 1, pid: owned.pid, fileId: owned.fileId, ...processIdentity(process.pid) };

        writeFileSync(`${lockFile}.identity`, `${JSON.stringify(identity)}\n`, { mode: 0o600 });
    } catch (error) {
        release(lockFile, owned);

        throw error;
    }

    return () => release(lockFile, owned);
}
