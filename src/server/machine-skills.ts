/**
 * pi-phone's own skills in sessions on a machine (PP-441). Pi's tools there (read, bash) see the machine's files, not the
 * phone's, so the app copies the skills that work there to `~/.pi/mobile/skills/<key>/<skill folder>/` and lists them at
 * that place: read, and bash for a skill's scripts (unslop's, business-motion-film's), find them. The key is a hash of
 * their files: a new app version with changed skills copies them again, an unchanged one copies nothing. The copy
 * happens on a session's first request there (once per machine and key while the app runs: a `.done` mark says it is
 * complete, and is touched each time); copies not used for 30 days are removed with the next copy.
 *
 * Which skills: pi-phone's own (`src/skills/`) but getting-started (a Getting started session is on the phone),
 * Effective HTML's, and Design & video's while it is on, but design-system and brand-extract, which read and write the
 * person's design systems on the phone (`DESIGN_MACHINE_SKILLS`). OfficeCLI's and the statechart skill come with their
 * machine tools (`machine-tools.ts`); Extension builder's makes drop-ins on the phone. The owner's library skills pinned
 * to a session (`library.ts`, PP-466) go the same way, as a bundle of their own.
 */
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import { loadSkills, type Skill } from "@earendil-works/pi-coding-agent";
import type { Machine } from "./machines.ts";
import type { Places } from "./places.ts";

/** Where on a machine, below its home. */
export const MACHINE_SKILLS_DIR = ".pi/mobile/skills";
/** Skills of the app's folders that work only in a session on the phone. */
export const PHONE_ONLY_SKILLS: ReadonlySet<string> = new Set(["getting-started"]);
/** A copy whose `.done` mark is older than this many days is removed with the next copy. */
const UNUSED_DAYS = 30;

/** The skills to copy (at their place on the phone), and the key their files give. */
export type SkillBundle = { key: string; skills: Skill[] };

/** A machine pi-phone reached: its home is known. */
type Reached = Machine & { remote: NonNullable<Machine["remote"]> };

/** Every file of a folder, below it, in a stable order. */
function filesOf(folder: string, below = ""): string[] {
    return readdirSync(join(folder, below), { withFileTypes: true })
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
        .flatMap((entry) => {
            const path = below === "" ? entry.name : `${below}/${entry.name}`;

            return entry.isDirectory() ? filesOf(folder, path) : entry.isFile() ? [path] : [];
        });
}

/** The app's skills in `folders` that work on a machine, and a key from their folders' names and files. */
export function skillBundle(folders: readonly string[], agentDir: string): SkillBundle {
    const skills = loadSkills({ cwd: agentDir, agentDir, skillPaths: [...folders], includeDefaults: false }).skills.filter(
        (skill) => !PHONE_ONLY_SKILLS.has(skill.name),
    );
    const hash = createHash("sha256");
    const seen = new Set<string>();

    for (const skill of [...skills].sort((a, b) => (basename(a.baseDir) < basename(b.baseDir) ? -1 : 1))) {
        const name = basename(skill.baseDir);

        // Each skill's folder goes to the copy's top by its name: two of one name would land on each other.
        if (seen.has(name)) {
            throw new Error(`Two of the app's skills are in folders named ${name}: ${skill.baseDir} and another.`);
        }

        seen.add(name);

        for (const file of filesOf(skill.baseDir)) {
            hash.update(`${name}/${file}\0`).update(readFileSync(join(skill.baseDir, file))).update("\0");
        }
    }

    return { key: hash.digest("hex").slice(0, 16), skills };
}

/** The bundle's skills named at their place on the machine whose home is `home`. */
export function skillsThere(bundle: SkillBundle, home: string): Skill[] {
    const root = `${home}/${MACHINE_SKILLS_DIR}/${bundle.key}`;

    return bundle.skills.map((skill) => {
        const baseDir = `${root}/${basename(skill.baseDir)}`;

        return { ...skill, baseDir, filePath: `${baseDir}/${relative(skill.baseDir, skill.filePath)}` };
    });
}

/** Copies the app's skills to machines, once per machine and key while the app runs. */
export class MachineSkills {
    readonly #places: Places;
    readonly #copies = new Map<string, Promise<void>>();

    constructor(places: Places) {
        this.#places = places;
    }

    /** The bundle's skills at their place on the machine, copied there first unless they are; a failed copy throws. */
    async place(machine: Reached, bundle: SkillBundle): Promise<Skill[]> {
        const id = `${machine.id} ${bundle.key}`;
        let copy = this.#copies.get(id);

        if (copy === undefined) {
            const started = this.#copy(machine, bundle);

            copy = started;
            this.#copies.set(id, started);
            // A failed copy is tried again by the next request.
            started.catch(() => {
                if (this.#copies.get(id) === started) {
                    this.#copies.delete(id);
                }
            });
        }

        await copy;

        return skillsThere(bundle, machine.remote.home);
    }

    async #run(machine: Reached, script: string): Promise<{ code: number; out: string }> {
        const env = this.#places.env(`machine:${machine.id}:${machine.remote.home}`);
        let out = "";
        // On Windows the daemon runs a command line with Git Bash; `sh` may not be on Windows' own PATH.
        const result = await env.exec(
            machine.remote.platform === "windows" ? script : ["sh", "-c", script],
            { cwd: machine.remote.home, timeout: 120, onOutput: (chunk) => (out += chunk) },
            BACKGROUND_CONTEXT,
        );

        if (!result.ok) {
            throw new Error(`${machine.name}: ${result.error.message}`);
        }

        return { code: result.value.exitCode, out };
    }

    async #copy(machine: Reached, bundle: SkillBundle): Promise<void> {
        // The key is hex: safe in the scripts as it is.
        const there = `"$HOME/${MACHINE_SKILLS_DIR}/${bundle.key}"`;
        const have = await this.#run(machine, `if [ -f ${there}/.done ]; then touch ${there}/.done; echo have; fi`);

        if (have.code === 0 && have.out.trim() === "have") {
            return;
        }

        const work = mkdtempSync(join(tmpdir(), "machine-skills-"));

        try {
            const archive = join(work, "skills.tar.gz");

            execFileSync("tar", ["-czf", archive, ...bundle.skills.flatMap((skill) => ["-C", dirname(skill.baseDir), basename(skill.baseDir)])]);
            const env = this.#places.env(`machine:${machine.id}:${machine.remote.home}`);
            const folder = `${machine.remote.home}/${MACHINE_SKILLS_DIR}`;
            const made = await env.createDir(folder, { recursive: true }, BACKGROUND_CONTEXT);

            if (!made.ok) {
                throw new Error(`Could not make ${folder} on ${machine.name}: ${made.error.message}`);
            }

            const written = await env.writeFile(`${folder}/${bundle.key}.tar.gz`, readFileSync(archive), BACKGROUND_CONTEXT);

            if (!written.ok) {
                throw new Error(`Could not copy pi-phone's skills to ${machine.name}: ${written.error.message}`);
            }

            const { code, out } = await this.#run(
                machine,
                [
                    "set -e",
                    `S="$HOME/${MACHINE_SKILLS_DIR}"`,
                    `rm -rf ${there}`,
                    `mkdir -p ${there}`,
                    `tar -xzf "$S/${bundle.key}.tar.gz" -C ${there}`,
                    `rm -f "$S/${bundle.key}.tar.gz"`,
                    `touch ${there}/.done`,
                    `find "$S" -mindepth 2 -maxdepth 2 -name .done -mtime +${UNUSED_DAYS} | while read -r done; do rm -rf "\${done%/.done}"; done`,
                ].join("\n"),
            );

            if (code !== 0) {
                throw new Error(`Could not unpack pi-phone's skills on ${machine.name}: ${out.trim() || `exit ${code}`}`);
            }
        } finally {
            rmSync(work, { recursive: true, force: true });
        }
    }
}

/**
 * The skills section of a session on a machine: its tools' skills, the app's own and the library's pinned to it at
 * their place there; when the app's or the library's could not be copied, a line that says so, so a skill another
 * section names is known not to be there.
 */
export function machineSkillsText(listed: string, failed: string | undefined, libraryFailed?: string): string | undefined {
    const note =
        failed === undefined
            ? undefined
            : `pi-phone's own skills (html-plan, ui-verify and the rest) are not on this machine: copying them failed (${failed}). Do not look for them there.`;
    const libraryNote =
        libraryFailed === undefined
            ? undefined
            : `The library skills pinned to this session are not on this machine: copying them failed (${libraryFailed}). Do not look for them there.`;
    const text = [listed, note, libraryNote].filter((part) => part !== undefined && part !== "").join("\n\n");

    return text === "" ? undefined : text;
}
