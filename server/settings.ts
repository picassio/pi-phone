// pi-phone settings: `~/.pi-phone/settings.json`, re-read when its mtime changes, so a change from the app applies
// to the next request without restarting workers. Unknown keys are an error; missing keys take the defaults below.
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export interface PhoneSettings {
	readonly claudeCodeBilling: {
		/** Bill direct Anthropic OAuth requests as Claude Code (DESIGN.md section 4). */
		readonly enabled: boolean;
		readonly version: string;
	};
}

export const DEFAULT_SETTINGS: PhoneSettings = {
	claudeCodeBilling: { enabled: true, version: "2.1.280" },
};

const SETTINGS_FILE = "settings.json";
/** Set by server/main.ts and inherited by the workers pi spawns. */
export const DATA_DIR_ENV = "PI_PHONE_DATA_DIR";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertKeys(value: Record<string, unknown>, allowed: readonly string[], where: string): void {
	for (const key of Object.keys(value)) {
		if (!allowed.includes(key)) throw new Error(`Unknown setting "${where}${key}"`);
	}
}

export function parseSettings(text: string): PhoneSettings {
	const raw: unknown = JSON.parse(text);
	if (!isRecord(raw)) throw new Error("settings.json must be an object");
	assertKeys(raw, ["claudeCodeBilling"], "");
	let claudeCodeBilling = DEFAULT_SETTINGS.claudeCodeBilling;
	if (raw.claudeCodeBilling !== undefined) {
		const section = raw.claudeCodeBilling;
		if (!isRecord(section)) throw new Error('setting "claudeCodeBilling" must be an object');
		assertKeys(section, ["enabled", "version"], "claudeCodeBilling.");
		const enabled = section.enabled ?? claudeCodeBilling.enabled;
		const version = section.version ?? claudeCodeBilling.version;
		if (typeof enabled !== "boolean") throw new Error('setting "claudeCodeBilling.enabled" must be a boolean');
		if (typeof version !== "string") throw new Error('setting "claudeCodeBilling.version" must be a string');
		claudeCodeBilling = { enabled, version };
	}
	return { claudeCodeBilling };
}

/** Live settings: `current()` returns the file's contents as of its last modification. */
export class PhoneSettingsFile {
	readonly path: string;
	#mtimeMs = -1;
	#value: PhoneSettings = DEFAULT_SETTINGS;

	constructor(dataDir: string) {
		this.path = join(dataDir, SETTINGS_FILE);
	}

	current(): PhoneSettings {
		let mtimeMs: number;
		try {
			mtimeMs = statSync(this.path).mtimeMs;
		} catch (error) {
			if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
			this.#mtimeMs = -1;
			this.#value = DEFAULT_SETTINGS;
			return this.#value;
		}
		if (mtimeMs !== this.#mtimeMs) {
			this.#value = parseSettings(readFileSync(this.path, "utf8"));
			this.#mtimeMs = mtimeMs;
		}
		return this.#value;
	}
}
