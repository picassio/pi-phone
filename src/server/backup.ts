/**
 * Backup and restore (DESIGN.md section 4): everything that makes this phone's pi-phone its own, as one `.tar.gz`, for
 * a new phone or a reinstall. It holds sign-ins and private keys, so it is the owner's and they are told so.
 *
 * In it, from the home folder: the data folder (`.pi-pocket`: sessions, settings, machines, themes, uploads), with the
 * database as a consistent copy (SQLite's backup, taken while it runs); SSH keys and known hosts (`.ssh`); Pi's
 * folder (`.pi/agent`: model sign-ins, settings, imported sessions); GitHub's sign-in (`.config/gh`, `.gitconfig`).
 *
 * Restore checks the archive (only those paths, nothing outside them), unpacks it beside them (`.pi-phone-restore`),
 * and restarts the server; the next start (`applyRestore`, before the database opens) moves what is there now to
 * `.pi-phone-before-restore/<time>/` and the restored files in. Nothing is deleted.
 */
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { backup, DatabaseSync } from "node:sqlite";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import { HttpError } from "./errors.ts";

const run = promisify(execFile);

/** What a backup holds, under the home folder. */
export const BACKED_UP = [".pi-pocket", ".ssh", ".pi/agent", ".config/gh", ".gitconfig"];
const DATABASE = "pocket.sqlite";
const STAGING = ".pi-phone-restore";
const BEFORE = ".pi-phone-before-restore";
/** The largest archive a restore takes. */
export const MAX_RESTORE = 1024 * 1024 * 1024;

/** The backup as a file in `tmp` (the caller sends and removes it), and its name. */
export async function makeBackup(home: string, dataDir: string, tmp: string): Promise<{ file: string; name: string }> {
    const work = mkdtempSync(join(tmp, "pi-phone-backup-"));

    try {
        // The database as it is now, whole: a copy of its file could be cut between two writes.
        const database = new DatabaseSync(join(dataDir, DATABASE), { readOnly: true });

        try {
            mkdirSync(join(work, ".pi-pocket"));
            await backup(database, join(work, ".pi-pocket", DATABASE));
        } finally {
            database.close();
        }

        const name = `pi-phone-backup-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.tar.gz`;
        const archive = join(work, "backup.tar");
        const data = basename(dataDir);
        const present = BACKED_UP.filter((path) => path !== ".pi-pocket" && existsSync(join(home, path)));

        // The data folder as `.pi-pocket`, wherever it is; the live database stays out, the copy above is it.
        await run("tar", [
            "-cf",
            archive,
            `--exclude=${data}/${DATABASE}`,
            `--exclude=${data}/${DATABASE}-wal`,
            `--exclude=${data}/${DATABASE}-shm`,
            `--exclude=${data}/harness.lock`,
            `--exclude=${data}/harness.lock.identity`,
            // The copy from before Pi 1.4's upgrade (`storage-upgrade.ts`): the database above is newer and whole.
            `--exclude=${data}/${DATABASE}.before-pi-1.4`,
            `--exclude=${data}/${DATABASE}.before-pi-1.4.partial`,
            `--transform=s,^${data.replace(/\./g, "\\.")}\\(/\\|$\\),.pi-pocket\\1,`,
            "-C",
            dirname(dataDir),
            data,
            ...(present.length === 0 ? [] : ["-C", home, ...present]),
        ]);
        await run("tar", ["-rf", archive, "-C", work, `.pi-pocket/${DATABASE}`]);
        await run("gzip", ["-6", archive]);
        const file = join(tmp, name);

        renameSync(`${archive}.gz`, file);

        return { file, name };
    } finally {
        rmSync(work, { recursive: true, force: true });
    }
}

/** Whether an archive member is one a backup has: under a backed-up path, relative, no `..`. */
function allowed(member: string): boolean {
    const path = member.replace(/^\.\//, "").replace(/\/$/, "");

    if (path === "" || path.startsWith("/") || path.split("/").includes("..")) {
        return false;
    }

    return BACKED_UP.some((root) => path === root || path.startsWith(`${root}/`) || root.startsWith(`${path}/`));
}

/** Check and unpack an archive beside the files it replaces; the next start swaps them in (`applyRestore`). */
export async function stageRestore(home: string, archive: Buffer, tmp: string): Promise<void> {
    const file = join(tmp, `pi-phone-restore-${Date.now()}.tar.gz`);

    writeFileSync(file, archive, { mode: 0o600 });

    try {
        let listed: string;

        try {
            listed = (await run("tar", ["-tzf", file], { maxBuffer: 64 * 1024 * 1024 })).stdout;
        } catch {
            throw new HttpError(400, "This is not a pi-phone backup: it is not a .tar.gz archive.");
        }

        const members = listed.split("\n").filter((line) => line !== "");
        const outside = members.find((member) => !allowed(member));

        if (outside !== undefined) {
            throw new HttpError(400, `This is not a pi-phone backup: it has ${outside}.`);
        }

        if (!members.some((member) => member.replace(/^\.\//, "") === ".pi-pocket/config.json")) {
            throw new HttpError(400, "This is not a pi-phone backup: it has no .pi-pocket/config.json.");
        }

        const staging = join(home, STAGING);

        rmSync(staging, { recursive: true, force: true });
        mkdirSync(staging, { mode: 0o700 });
        await run("tar", ["-xzf", file, "-C", staging, "--no-same-owner"]);
    } finally {
        rmSync(file, { force: true });
    }
}

/**
 * Before the server opens anything: a staged restore goes in. What is there now moves to
 * `.pi-phone-before-restore/<time>/`, each backed-up path the restore has. Answers what it moved in, for the log.
 */
export function applyRestore(home: string, dataDir: string): string[] {
    const staging = join(home, STAGING);

    if (!existsSync(staging)) {
        return [];
    }

    const aside = join(home, BEFORE, new Date().toISOString().replace(/[:.]/g, "-"));
    const moved: string[] = [];

    for (const path of BACKED_UP) {
        const restored = join(staging, path);

        if (!existsSync(restored)) {
            continue;
        }

        const current = path === ".pi-pocket" ? dataDir : join(home, path);

        if (existsSync(current)) {
            mkdirSync(dirname(join(aside, path)), { recursive: true });
            renameSync(current, join(aside, path));
        }

        mkdirSync(dirname(current), { recursive: true });
        renameSync(restored, current);
        moved.push(path);
    }

    rmSync(staging, { recursive: true, force: true });

    return moved;
}
