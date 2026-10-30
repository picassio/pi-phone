/**
 * A role's policy in a person's pi-phone (PP-22): what the server edition's gateway says this person may do, applied
 * here. Without one (the phone, the single-owner server), everything is allowed. The gateway sends it
 * (`POST /api/policy`, with the container's owner token) each time it starts the container and when the person's role
 * changes; people cannot send it themselves (the gateway refuses that route from browsers).
 *
 * - Tools: Pi's browser, web access, and machines are whole extensions: turned off (and kept off) without their
 *   permission, so their tools are absent. Secrets' and settings' tools are refused (`extensions/policy.ts`).
 * - Routes: the app's API for those features is refused without the permission (`ROUTES`), the terminal too.
 * - Models: only those listed (none listed: any) are offered and accepted.
 * - Spend: a monthly cap on the person's own spend (`Spend`), from what they had spent when the month began.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type Policy = {
    /** Permissions from the gateway's catalogue (`src/gateway/roles.ts`). */
    permissions: string[];
    /** `provider/model` ids allowed; empty: any. */
    models: string[];
    /** Dollars a month; null: no limit. */
    spendLimit: number | null;
    /** The role's name, for messages ("Your role, Member, …"). */
    role: string;
};

/** Extension modules that are a permission's whole feature: off without it. */
// Phone control (PP-141) has no permission in the gateway's catalogue: the team server has no phone, so no role has it.
// Computer control (PP-178) has none either: the owner's machines, from the owner's pi-phone.
export const EXTENSIONS: Readonly<Record<string, string>> = {
    "browser.ts": "browser.use",
    "web.ts": "web.search",
    "machines.ts": "machines.use",
    "phone.ts": "phone.control",
    "computer.ts": "computer.control",
};

/** Tools refused without a permission (besides those of the extensions above, which are absent). */
export const TOOLS: Readonly<Record<string, string>> = {
    secrets_list: "secrets.use",
    secret_request: "secrets.use",
    secret_save: "secrets.use",
    setting_change: "settings.change",
    app_action: "settings.change",
    machine_run: "machines.use",
    machine_copy: "machines.use",
    machine_add: "machines.use",
    phone_control: "phone.control",
    phone_screen: "phone.control",
    phone_act: "phone.control",
    phone_screenshot: "phone.control",
    computer_control: "computer.control",
    computer_screen: "computer.control",
    computer_act: "computer.control",
    computer_screenshot: "computer.control",
    web_search: "web.search",
    fetch_content: "web.search",
};

/** The app's routes (`/api/<first>`) and the permission each needs: for every method, or only for changes. */
export const ROUTES: readonly { first: string; permission: string; writes: boolean }[] = [
    { first: "machines", permission: "machines.use", writes: false },
    { first: "ssh-keys", permission: "machines.use", writes: false },
    { first: "forwards", permission: "machines.use", writes: false },
    { first: "secrets", permission: "secrets.use", writes: false },
    { first: "phone-control", permission: "phone.control", writes: false },
    { first: "computer-control", permission: "computer.control", writes: false },
    { first: "computer", permission: "computer.control", writes: false },
    { first: "browser", permission: "browser.use", writes: false },
    { first: "web-access", permission: "web.search", writes: true },
    { first: "providers", permission: "providers.signin", writes: true },
    // Seeing them too: they name the secrets keys are in, and finding models makes the server call any address.
    { first: "custom-providers", permission: "providers.custom", writes: false },
    { first: "accounts", permission: "providers.signin", writes: true },
    { first: "auth", permission: "providers.signin", writes: true },
    { first: "github", permission: "providers.signin", writes: true },
    { first: "extensions", permission: "extensions.manage", writes: true },
    { first: "settings", permission: "settings.change", writes: true },
    { first: "themes", permission: "settings.change", writes: true },
    { first: "phone", permission: "settings.change", writes: true },
    { first: "backup", permission: "settings.change", writes: true },
    { first: "restore", permission: "settings.change", writes: true },
    { first: "restart", permission: "settings.change", writes: true },
    { first: "subagent-models", permission: "settings.change", writes: true },
];

/** What a permission is, in words, for refusals. */
const WORDS: Readonly<Record<string, string>> = {
    "machines.use": "machines",
    "phone.control": "controlling the phone",
    "computer.control": "controlling computers",
    "secrets.use": "secrets",
    "browser.use": "Pi's browser",
    "web.search": "web access",
    "providers.signin": "signing in to providers",
    "providers.custom": "adding OpenAI-compatible providers",
    "extensions.manage": "turning extensions on and off",
    "settings.change": "changing settings",
    "terminal.use": "the terminal",
};

export function checkPolicy(given: unknown): Policy {
    const value = given as Partial<Policy> | null;

    if (value === null || typeof value !== "object" || !Array.isArray(value.permissions) || !Array.isArray(value.models)) {
        throw new Error("A policy is { permissions: [], models: [], spendLimit, role }.");
    }

    const spendLimit = value.spendLimit === null || value.spendLimit === undefined ? null : Number(value.spendLimit);

    if (spendLimit !== null && (!Number.isFinite(spendLimit) || spendLimit < 0)) {
        throw new Error("spendLimit is a number of dollars, or null.");
    }

    return { permissions: value.permissions.map(String), models: value.models.map(String), spendLimit, role: String(value.role ?? "your role") };
}

export class PolicyStore {
    readonly #file: string;
    #policy: Policy | undefined;
    /** The month a cap counts from (`YYYY-MM`), and the person's spend when it began. */
    #month: { key: string; baseline: number } | undefined;

    constructor(dataDir: string) {
        this.#file = join(dataDir, "policy.json");

        if (existsSync(this.#file)) {
            const kept = JSON.parse(readFileSync(this.#file, "utf8")) as { policy?: Policy; month?: { key: string; baseline: number } };

            this.#policy = kept.policy;
            this.#month = kept.month;
        }
    }

    get(): Policy | undefined {
        return this.#policy;
    }

    set(policy: Policy): void {
        this.#policy = policy;
        this.#save();
    }

    #save(): void {
        writeFileSync(this.#file, JSON.stringify({ policy: this.#policy, month: this.#month }), { mode: 0o600 });
    }

    /** Whether the policy allows a permission: always, without a policy. */
    allows(permission: string): boolean {
        return this.#policy === undefined || this.#policy.permissions.includes(permission);
    }

    /** Why a permission is not this person's, for a refusal; undefined when it is. */
    refusal(permission: string): string | undefined {
        return this.allows(permission) ? undefined : `${this.#policy!.role} does not include ${WORDS[permission] ?? permission}: ask your team's owner.`;
    }

    modelAllowed(provider: string, modelId: string): boolean {
        const models = this.#policy?.models ?? [];

        return models.length === 0 || models.includes(`${provider}/${modelId}`);
    }

    /**
     * What the person has spent this month and their cap, from their spend so far (`spent`): undefined without a cap. A
     * new month starts counting from what they had spent when it began.
     */
    month(spent: number, now = new Date()): { spent: number; cap: number } | undefined {
        const cap = this.#policy?.spendLimit ?? null;

        if (cap === null) {
            return undefined;
        }

        const key = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;

        if (this.#month?.key !== key) {
            this.#month = { key, baseline: spent };
            this.#save();
        }

        return { spent: Math.max(0, spent - this.#month.baseline), cap };
    }

    /** The route a request is to, refused without its permission: why, or undefined. */
    routeRefusal(first: string | undefined, method: string): string | undefined {
        const rule = ROUTES.find((each) => each.first === first);

        if (rule === undefined || (rule.writes && method === "GET")) {
            return undefined;
        }

        return this.refusal(rule.permission);
    }
}
