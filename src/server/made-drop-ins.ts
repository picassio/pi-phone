/**
 * Drop-ins Pi makes (PP-369, the Creator flow; the owner's decisions of 2026-11-03 on the mockup pp366-mockup, after
 * research PP-365; adapted from DeepSeek Harness's background Creator, `packages/experimental/creation-recommendations`:
 * a reserved name, a subagent that writes it in a scratch folder and ends by saying it is ready, checks that run none of
 * its code, then the install, and Keep, Undo and Restore).
 *
 * A made drop-in is named `made-<name>`; the prefix is the Creator's (`extension_install` and the upload refuse it), so
 * every version of one goes through here. Each install keeps that version's files in
 * `<data>/extensions/.versions/made-<name>/<n>/files/`, with `version.json` (its number, time, and a one-line note);
 * `made.json` beside them is the flow's state: what was asked, which build is under way and how far it got, the versions,
 * and the one installed now. The loader never reads `.versions` (it loads `.ts` files at the drop-in folder's top).
 *
 * The drop-in gets the same host and rights as any drop-in: what keeps the owner safe is their cards (Make it, Install,
 * Undo, Restore), the install landing switched off, and the owner switching it on.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type DropInPackage, packageFromPath } from "./drop-in-install.ts";
import { BUILDER_SKILL } from "./extension-builder.ts";

/** The prefix of every drop-in the Creator makes: no other way installs one. */
export const MADE_PREFIX = "made-";
/** The name after the prefix: lowercase letters, digits and single hyphens, starting with a letter, up to 40. */
export const MADE_NAME = /^[a-z](?:[a-z0-9]|-(?=[a-z0-9])){0,39}$/;
/** What a made drop-in may hold: stricter than any drop-in's 5 MB and 1000 files. */
export const MADE_MAX_BYTES = 1024 * 1024;
export const MADE_MAX_FILES = 200;
/** The versions kept of each, the newest; the one installed now is always kept. */
export const MADE_KEEP_VERSIONS = 20;
/** Where a drop-in's UI can show, as the Creator's card names it. */
export const MADE_PLACES = ["tool", "rail", "page", "sheet", "menu", "launcher", "dock", "overlay", "panelTab", "sessionMenu", "theme"] as const;

export type MadeStep = { at: number; note?: string };
export type MadeChecks = { at: number; ok: boolean; bytes: number; files: string[]; problems: string[]; notes: string[] };
export type MadeVersion = { n: number; at: number; note: string; bytes: number; files: number };
/**
 * - `writing`: the subagent is at work on build `build.n`;
 * - `failed`: it said it could not (`build.failed`), or could not be started;
 * - `refused`: the checks found problems (`build.checks`);
 * - `declined`: the owner declined the install card;
 * - `installed`: installed, switched off until the owner switches it on;
 * - `checked`: Pi looked at it in the live app (`build.checked`);
 * - `kept`: the owner kept it (the flow ended);
 * - `removed`: undone past its first version: nothing installed, its versions kept.
 */
export type MadePhase = "writing" | "failed" | "refused" | "declined" | "installed" | "checked" | "kept" | "removed";
export type MadeState = {
    /** `pomodoro`, its module `made-pomodoro.ts`. */
    name: string;
    module: string;
    title: string;
    brief: string;
    places: string[];
    /** The session that asked, where the subagent works, and the folder it writes in. */
    session: number;
    folder: string;
    subagent?: { name: string; conversationId: number };
    phase: MadePhase;
    build: { n: number; written?: MadeStep; checks?: MadeChecks; installed?: MadeStep; checked?: MadeStep; failed?: string };
    versions: MadeVersion[];
    /** The version installed now; null when none is. */
    current: number | null;
    createdAt: number;
    updatedAt: number;
};

/** A made drop-in's module name. */
export const madeModule = (name: string) => `${MADE_PREFIX}${name}`;

/** `made-pomodoro`, `made-pomodoro.ts` or `pomodoro`: the name after the prefix. */
export function madeName(given: string): string {
    return given.trim().replace(/\.ts$/, "").replace(/^made-/, "");
}

/**
 * Why a name cannot be made, or undefined. `modules` are the extension modules' files now (built-in and drop-in);
 * `made` whether the Creator made one by this name before (then this is its next version).
 */
export function nameProblem(name: string, modules: readonly string[], made: boolean): string | undefined {
    if (!MADE_NAME.test(name)) {
        return `${name} is not a name for a drop-in Pi makes: lowercase letters, digits and single hyphens, starting with a letter, up to 40 (it becomes ${MADE_PREFIX}<name>).`;
    }

    if (!made && modules.includes(`${madeModule(name)}.ts`)) {
        return `${madeModule(name)} is taken by an extension Pi did not make here: choose another name.`;
    }

    return undefined;
}

/**
 * What the subagent's last answer says, from its last line: `READY made-<name>: <note>` or `NOT READY made-<name>: <why>`
 * (markdown marks around it are let go). Undefined when it says neither, or names another drop-in.
 */
export function parseReady(answer: string, module: string): { ready: boolean; note: string } | undefined {
    const last = answer
        .split("\n")
        .map((line) => line.trim().replace(/^[`*>_\s]+|[`*_\s]+$/g, ""))
        .filter((line) => line !== "")
        .at(-1);
    const found = /^(READY|NOT READY)\s+(made-[a-z0-9-]+)\s*:\s*(.+)$/.exec(last ?? "");

    if (found === null || found[2] !== module) {
        return undefined;
    }

    return { ready: found[1] === "READY", note: found[3]!.slice(0, 200) };
}

/** The tool names a module's source gives `defineTool`. */
function toolNames(source: string): string[] {
    return [...source.matchAll(/defineTool\(\s*\{[^]*?\bname:\s*["'`]([^"'`]+)["'`]/g)].map((match) => match[1]!);
}

/**
 * Check a made drop-in's folder before it is installed, running none of its code: it is one module `made-<name>.ts` with
 * only its `.js` and its folder beside it (nothing left out), no symbolic link and no path out of it, at most
 * `MADE_MAX_BYTES` and `MADE_MAX_FILES`, no tool with a built-in tool's name, and the skill's `scripts/check.mjs` says ok
 * (erasable TypeScript, modules that parse, the owner's UI rules). The package is what installing would copy.
 */
export function checkMade(folder: string, name: string, builtInTools: ReadonlySet<string>): { checks: MadeChecks; pkg?: DropInPackage } {
    const module = madeModule(name);
    const problems: string[] = [];
    const notes: string[] = [];
    const done = (pkg?: DropInPackage) => ({
        checks: { at: Date.now(), ok: problems.length === 0, bytes: pkg?.bytes ?? 0, files: (pkg?.files ?? []).map((file) => file.path), problems, notes },
        ...(problems.length === 0 && pkg !== undefined ? { pkg } : {}),
    });

    if (!existsSync(folder)) {
        problems.push(`there is nothing at ${folder}`);

        return done();
    }

    let pkg: DropInPackage;

    try {
        pkg = packageFromPath(folder);
    } catch (error) {
        problems.push(error instanceof Error ? error.message : String(error));

        return done();
    }

    if (pkg.module !== `${module}.ts`) {
        problems.push(`its module is ${pkg.module}: it must be ${module}.ts`);
    }

    if (pkg.leftOut.length > 0) {
        problems.push(`it holds more than the module, its .js and its folder: ${pkg.leftOut.join(", ")}`);
    }

    if (pkg.bytes > MADE_MAX_BYTES) {
        problems.push(`it is ${Math.ceil(pkg.bytes / 1024)} KB: a drop-in Pi makes holds 1 MB at most`);
    }

    if (pkg.files.length > MADE_MAX_FILES) {
        problems.push(`it has ${pkg.files.length} files: a drop-in Pi makes holds ${MADE_MAX_FILES} at most`);
    }

    const source = pkg.files.find((file) => file.path === pkg.module)?.data.toString("utf8") ?? "";
    const clashing = toolNames(source).filter((tool) => builtInTools.has(tool));

    if (clashing.length > 0) {
        problems.push(`its tools ${clashing.join(", ")} have built-in tools' names`);
    }

    const run = spawnSync(process.execPath, [join(BUILDER_SKILL, "scripts", "check.mjs"), folder], { encoding: "utf8", timeout: 60_000 });

    for (const line of `${run.stdout ?? ""}`.split("\n")) {
        if (line.startsWith("problem: ")) {
            problems.push(line.slice("problem: ".length));
        } else if (line.startsWith("note: ")) {
            notes.push(line.slice("note: ".length));
        }
    }

    if (run.status !== 0 && !problems.some((problem) => problem !== "")) {
        problems.push(`the skill's check did not finish: ${(run.stderr || run.error?.message || `exit ${run.status}`).trim().slice(0, 300)}`);
    }

    return done(pkg);
}

/** What installing and removing a drop-in is, as the app does it (`PocketApp.installDropIn`, `removeDropIn`). */
export type MadeHands = {
    install(pkg: DropInPackage): Promise<void>;
    remove(module: string): Promise<void>;
};

/** The made drop-ins' states and versions, under `<drop-in folder>/.versions/`. */
export class MadeDropIns {
    readonly #root: string;

    constructor(dropInFolder: string) {
        this.#root = join(dropInFolder, ".versions");
    }

    #dir(name: string): string {
        return join(this.#root, madeModule(name));
    }

    get(name: string): MadeState | undefined {
        try {
            return JSON.parse(readFileSync(join(this.#dir(name), "made.json"), "utf8")) as MadeState;
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") {
                return undefined;
            }

            throw error;
        }
    }

    list(): MadeState[] {
        let names: string[];

        try {
            names = readdirSync(this.#root);
        } catch {
            return [];
        }

        return names
            .filter((entry) => entry.startsWith(MADE_PREFIX))
            .map((entry) => this.get(entry.slice(MADE_PREFIX.length)))
            .filter((state): state is MadeState => state !== undefined)
            .sort((a, b) => b.updatedAt - a.updatedAt);
    }

    save(state: MadeState): MadeState {
        const file = join(this.#dir(state.name), "made.json");

        state.updatedAt = Date.now();
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(`${file}.tmp`, JSON.stringify(state, null, 2));
        renameSync(`${file}.tmp`, file);

        return state;
    }

    /** Keep a version's files, as installing it copies them: its number is one past the newest. */
    keep(state: MadeState, pkg: DropInPackage, note: string): MadeVersion {
        const n = Math.max(0, ...state.versions.map((version) => version.n)) + 1;
        const dir = join(this.#dir(state.name), String(n));
        const version: MadeVersion = { n, at: Date.now(), note: note.slice(0, 200), bytes: pkg.bytes, files: pkg.files.length };

        for (const file of pkg.files) {
            const target = join(dir, "files", file.path);

            mkdirSync(dirname(target), { recursive: true });
            writeFileSync(target, file.data);
        }

        writeFileSync(join(dir, "version.json"), JSON.stringify(version, null, 2));
        state.versions.push(version);

        // The oldest go past the bound, never the one installed now or this one.
        while (state.versions.length > MADE_KEEP_VERSIONS) {
            const oldest = state.versions.find((each) => each.n !== state.current && each.n !== n);

            if (oldest === undefined) {
                break;
            }

            rmSync(join(this.#dir(state.name), String(oldest.n)), { recursive: true, force: true });
            state.versions = state.versions.filter((each) => each !== oldest);
        }

        return version;
    }

    /** A kept version's files, as a package to install again. */
    version(state: MadeState, n: number): DropInPackage {
        if (!state.versions.some((version) => version.n === n)) {
            throw new Error(`${state.module} has no version ${n}: it has ${state.versions.map((version) => version.n).join(", ") || "none"}.`);
        }

        return packageFromPath(join(this.#dir(state.name), String(n), "files"));
    }

    /** The version Undo goes back to: the newest before the one installed now; undefined when that is the first. */
    previous(state: MadeState): number | undefined {
        const before = state.versions.filter((version) => state.current !== null && version.n < state.current);

        return before.at(-1)?.n;
    }

    /** Back to the previous version, or, from the first, nothing installed (its versions stay, to restore). */
    async undo(state: MadeState, hands: MadeHands): Promise<MadeState> {
        if (state.current === null) {
            throw new Error(`${state.module} is not installed now: restore one of its versions instead.`);
        }

        const previous = this.previous(state);

        if (previous === undefined) {
            await hands.remove(`${state.module}.ts`);
            state.current = null;
            state.phase = "removed";
        } else {
            await hands.install(this.version(state, previous));
            this.#installedNow(state, previous);
        }

        return this.save(state);
    }

    /** Version `n` is installed now, switched off: the progress shows that version, as it was built and checked. */
    #installedNow(state: MadeState, n: number): void {
        const version = state.versions.find((each) => each.n === n)!;

        state.current = n;
        state.phase = "installed";
        state.build = {
            n,
            written: { at: version.at, note: version.note },
            checks: { at: version.at, ok: true, bytes: version.bytes, files: [], problems: [], notes: [] },
            installed: { at: Date.now() },
        };
    }

    /** Install a kept version again. It lands switched off, as every install does. */
    async restore(state: MadeState, n: number, hands: MadeHands): Promise<MadeState> {
        await hands.install(this.version(state, n));
        this.#installedNow(state, n);

        return this.save(state);
    }
}
