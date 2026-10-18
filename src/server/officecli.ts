/**
 * OfficeCLI on the phone (DESIGN.md section 4): Word, Excel, and PowerPoint files for Pi and for the person. The binary
 * is the fork's Android release, bundled in the runtime (`scripts/officecli.ts`, `native/android-arm64/officecli/`);
 * its skills are OfficeCLI's own (`third_party/officecli/skills/`), offered to Pi as skills it reads when a task needs
 * them. Pi runs it from bash: `officecli` is a wrapper in the app's `bin/` folder, on the PATH of phone sessions'
 * bash, that runs the binary as it must run on Android:
 *
 * - `LD_LIBRARY_PATH=$PREFIX/lib`: its crypto shim loads libssl, and Android's own (BoringSSL) aborts every command;
 * - `OFFICECLI_SKIP_UPDATE=1`: it never updates itself (the app ships it);
 * - `OFFICECLI_NO_AUTO_INSTALL=1`: a bare `officecli` never installs itself into other agents' config folders.
 *
 * The Files viewer shows Office files through `view <file> html` (`renderHtml`).
 */
import { execFile } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, extname, join } from "node:path";
import { promisify } from "node:util";
import { APP_ROOT } from "./config.ts";

const run = promisify(execFile);

/** The files OfficeCLI reads. */
export const OFFICE_EXTENSIONS = new Set([".docx", ".xlsx", ".pptx"]);
/** How long one render may take. */
const RENDER_MS = 60_000;
/** The largest Office file shown. */
export const MAX_OFFICE_FILE = 50 * 1024 * 1024;

export type OfficeCliOptions = {
    /** The app's data folder: its `bin/` holds the wrapper. */
    dataDir: string;
    /** The binary; default the bundled one. */
    binary?: string;
    /** Termux's prefix, whose `lib/` has OpenSSL 3. */
    prefix?: string;
    /** Whether it can run here: on Android, with the binary bundled. Tests stand in a binary of their own. */
    runs?: boolean;
};

export class OfficeCli {
    readonly binary: string;
    /** The folder the wrapper is in, for bash's PATH. */
    readonly binDir: string;
    /** OfficeCLI's skills, offered to Pi while it runs here. */
    readonly skillsDir = join(APP_ROOT, "third_party", "officecli", "skills");
    readonly #prefix: string;
    readonly #runs: boolean;

    constructor(options: OfficeCliOptions) {
        this.binary = options.binary ?? join(APP_ROOT, "native", "android-arm64", "officecli", "officecli");
        this.binDir = join(options.dataDir, "bin");
        this.#prefix = options.prefix ?? process.env.PREFIX ?? "/usr";
        this.#runs = options.runs ?? (process.platform === "android" && existsSync(this.binary));
    }

    /** Whether Pi and the viewer have it. */
    available(): boolean {
        return this.#runs;
    }

    /** What it runs with (see above). */
    env(): Record<string, string> {
        return {
            LD_LIBRARY_PATH: join(this.#prefix, "lib"),
            OFFICECLI_SKIP_UPDATE: "1",
            OFFICECLI_NO_AUTO_INSTALL: "1",
        };
    }

    /** Write the wrapper bash runs as `officecli`; removes it where OfficeCLI does not run. */
    install(): void {
        const wrapper = join(this.binDir, "officecli");

        if (!this.#runs) {
            rmSync(wrapper, { force: true });

            return;
        }

        mkdirSync(this.binDir, { recursive: true, mode: 0o700 });
        const shell = existsSync(join(this.#prefix, "bin", "sh")) ? join(this.#prefix, "bin", "sh") : "/bin/sh";
        const exports = Object.entries(this.env())
            .map(([name, value]) => `export ${name}=${JSON.stringify(value)}`)
            .join("\n");

        writeFileSync(
            wrapper,
            `#!${shell}\n# pi-phone: OfficeCLI, bundled with the app (src/server/officecli.ts).\n${exports}\nexec ${JSON.stringify(this.binary)} "$@"\n`,
            { mode: 0o700 },
        );
        chmodSync(wrapper, 0o700);
    }

    /**
     * A Word, Excel, or PowerPoint file as one HTML page, as OfficeCLI renders it (`view <file> html`): the page, with
     * its styles and images inlined. Fails with OfficeCLI's own words when it cannot.
     */
    async renderHtml(file: string): Promise<string> {
        if (!this.#runs) {
            throw new Error("OfficeCLI is not available here.");
        }

        if (!OFFICE_EXTENSIONS.has(extname(file).toLowerCase())) {
            throw new Error(`${basename(file)} is not a .docx, .xlsx, or .pptx file.`);
        }

        const work = mkdtempSync(join(tmpdir(), "officecli-view-"));
        const out = join(work, "view.html");

        try {
            await run(this.binary, ["view", file, "html", "-o", out], {
                timeout: RENDER_MS,
                maxBuffer: 8 * 1024 * 1024,
                // A render is one command: no resident process left behind for it.
                env: { ...process.env, ...this.env(), OFFICECLI_NO_AUTO_RESIDENT: "1" },
            }).catch((error: NodeJS.ErrnoException & { stderr?: string; stdout?: string }) => {
                const said = (error.stderr || error.stdout || error.message).trim();

                throw new Error(`OfficeCLI could not show ${basename(file)}: ${said.slice(0, 600)}`);
            });

            if (!existsSync(out)) {
                throw new Error(`OfficeCLI wrote no page for ${basename(file)}.`);
            }

            return readFileSync(out, "utf8");
        } finally {
            rmSync(work, { recursive: true, force: true });
        }
    }
}
