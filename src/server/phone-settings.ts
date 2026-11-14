/**
 * pi-phone's own settings: `phone.json` in the data folder, re-read when its mtime changes, so a change applies to the
 * next model request without a restart. Unknown keys are an error; missing keys take the defaults below.
 */
import { readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface PhoneSettings {
    readonly claudeCodeBilling: {
        /** Bill direct Anthropic OAuth requests as Claude Code (DESIGN.md section 4). */
        readonly enabled: boolean;
        readonly version: string;
    };
}

/**
 * The Claude Code version the billing patch sends unless set newer: the one pi-ai's Anthropic transport reports in its
 * `claude-cli/<version>` user-agent (`test/claude-billing.test.ts` checks that the two match). Anthropic refuses newer
 * models to older versions (400 `claude_code_version_too_old`), so raise it with each Pi update that raises pi-ai's.
 */
export const CLAUDE_CODE_VERSION = "2.1.322";

export const DEFAULT_SETTINGS: PhoneSettings = {
    claudeCodeBilling: { enabled: true, version: CLAUDE_CODE_VERSION },
};

function versionParts(version: string): readonly number[] | undefined {
    return /^\d+\.\d+\.\d+$/.test(version) ? version.split(".").map(Number) : undefined;
}

/** Whether an x.y.z version is older than `CLAUDE_CODE_VERSION`; a version of another form is not compared. */
export function isBelowClaudeCodeVersion(version: string): boolean {
    const parts = versionParts(version);
    const floor = versionParts(CLAUDE_CODE_VERSION);

    if (parts === undefined || floor === undefined) {
        return false;
    }

    for (const [index, part] of parts.entries()) {
        const least = floor[index] ?? 0;

        if (part !== least) {
            return part < least;
        }
    }

    return false;
}

/**
 * A stored or sent version older than `CLAUDE_CODE_VERSION` is raised to it: an older phone's `phone.json` (2.1.280
 * before Pi 1.5.2) would have every newer model refused, and a newer one set on purpose stays.
 */
export function raiseClaudeCodeVersion(version: string): string {
    return isBelowClaudeCodeVersion(version) ? CLAUDE_CODE_VERSION : version;
}

export const PHONE_SETTINGS_FILE = "phone.json";

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertKeys(value: Record<string, unknown>, allowed: readonly string[], where: string): void {
    for (const key of Object.keys(value)) {
        if (!allowed.includes(key)) {
            throw new Error(`Unknown setting "${where}${key}" in ${PHONE_SETTINGS_FILE}`);
        }
    }
}

export function parsePhoneSettings(text: string): PhoneSettings {
    const raw: unknown = JSON.parse(text);

    if (!isRecord(raw)) {
        throw new Error(`${PHONE_SETTINGS_FILE} must be an object`);
    }

    assertKeys(raw, ["claudeCodeBilling"], "");
    let claudeCodeBilling = DEFAULT_SETTINGS.claudeCodeBilling;

    if (raw.claudeCodeBilling !== undefined) {
        const section = raw.claudeCodeBilling;

        if (!isRecord(section)) {
            throw new Error('setting "claudeCodeBilling" must be an object');
        }

        assertKeys(section, ["enabled", "version"], "claudeCodeBilling.");
        const enabled = section.enabled ?? claudeCodeBilling.enabled;
        const version = section.version ?? claudeCodeBilling.version;

        if (typeof enabled !== "boolean") {
            throw new Error('setting "claudeCodeBilling.enabled" must be a boolean');
        }

        if (typeof version !== "string") {
            throw new Error('setting "claudeCodeBilling.version" must be a string');
        }

        claudeCodeBilling = { enabled, version: raiseClaudeCodeVersion(version) };
    }

    return { claudeCodeBilling };
}

/** Live settings: `current()` returns the file's contents as of its last modification, or the defaults without one. */
export class PhoneSettingsFile {
    readonly path: string;
    #mtimeMs = -1;
    #value: PhoneSettings = DEFAULT_SETTINGS;

    constructor(dataDir: string) {
        this.path = join(dataDir, PHONE_SETTINGS_FILE);
    }

    current(): PhoneSettings {
        let mtimeMs: number;

        try {
            mtimeMs = statSync(this.path).mtimeMs;
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
                throw error;
            }

            this.#mtimeMs = -1;
            this.#value = DEFAULT_SETTINGS;

            return this.#value;
        }

        if (mtimeMs !== this.#mtimeMs) {
            this.#value = parsePhoneSettings(readFileSync(this.path, "utf8"));
            this.#mtimeMs = mtimeMs;
        }

        return this.#value;
    }

    /** Change the Claude Code billing patch's settings (Pi's `setting_change`; the file is the app's, not the person's). */
    update(claudeCodeBilling: Partial<PhoneSettings["claudeCodeBilling"]>): PhoneSettings {
        const next: PhoneSettings = { claudeCodeBilling: { ...this.current().claudeCodeBilling, ...claudeCodeBilling } };
        const text = `${JSON.stringify(next, null, 4)}\n`;

        parsePhoneSettings(text);
        writeFileSync(`${this.path}.new`, text);
        renameSync(`${this.path}.new`, this.path);

        return this.current();
    }
}
