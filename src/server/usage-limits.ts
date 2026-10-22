/**
 * Plan limits of the subscription accounts (owner's decisions of 2026-10-19, wiki: provider-accounts-and-usage): how much
 * of each window an account has used, and when the window resets, as the providers' own apps show it. Claude and Codex
 * have a 5-hour and a weekly window; Copilot has its monthly premium requests. Each is asked with the account's own
 * sign-in (renewed by Pi's runtime when needed, so a renewed token is kept), through endpoints the providers' apps use and
 * do not document: an answer of another shape is "usage unavailable", with why, never a guess.
 *
 * Asked when the Providers sheet or the model menu opens (`fresh`), and after a run on the account, and kept a minute;
 * every tab gets the new figures (`usage` events).
 */
import { readStoredCredential } from "@earendil-works/pi-coding-agent";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { baseProvider } from "./accounts.ts";
import { describe } from "./errors.ts";

export type UsageWindow = {
    /** "5-hour", "Weekly", "Weekly Opus", "Premium requests". */
    label: string;
    /** 0–100. */
    usedPercent: number;
    /** When it resets, in ms; undefined when the provider does not say. */
    resetsAt?: number;
    /** More, in words: "240 of 300 left". */
    detail?: string;
};

export type AccountUsage =
    | { provider: string; at: number; windows: UsageWindow[]; plan?: string }
    | { provider: string; at: number; error: string };

/** The providers with plan limits: their accounts' too (`anthropic~work`). */
const LIMITED = new Set(["anthropic", "openai-codex", "github-copilot"]);
const KEEP_MS = 60_000;
const TIMEOUT_MS = 10_000;

class UnexpectedAnswer extends Error {}

const percent = (value: unknown): number => {
    if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new UnexpectedAnswer("a usage figure that is not a number");
    }

    return Math.max(0, Math.min(100, value));
};

const isoTime = (value: unknown): number | undefined => {
    if (typeof value !== "string") {
        return undefined;
    }

    const at = Date.parse(value);

    return Number.isNaN(at) ? undefined : at;
};

const object = (value: unknown): Record<string, unknown> | undefined =>
    typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;

/**
 * Claude's `GET /api/oauth/usage`: `five_hour` and `seven_day`, each `{ utilization, resets_at }`, and per-model weekly
 * windows (`seven_day_opus`, `seven_day_sonnet`) that are null where the plan has none.
 */
export function parseClaudeUsage(json: unknown): UsageWindow[] {
    const body = object(json);
    const windows: UsageWindow[] = [];
    const names: [string, string][] = [
        ["five_hour", "5-hour"],
        ["seven_day", "Weekly"],
        ["seven_day_opus", "Weekly Opus"],
        ["seven_day_sonnet", "Weekly Sonnet"],
    ];

    for (const [key, label] of names) {
        const window = object(body?.[key]);

        if (window === undefined) {
            continue;
        }

        const resetsAt = isoTime(window.resets_at);

        windows.push({ label, usedPercent: percent(window.utilization), ...(resetsAt === undefined ? {} : { resetsAt }) });
    }

    if (!windows.some((window) => window.label === "5-hour" || window.label === "Weekly")) {
        throw new UnexpectedAnswer("no 5-hour or weekly window in Claude's answer");
    }

    return windows;
}

/** A window's length in words: 18000 s is "5-hour", 604800 s "Weekly". */
function windowName(seconds: unknown): string {
    if (seconds === 18_000) {
        return "5-hour";
    }

    if (seconds === 604_800) {
        return "Weekly";
    }

    return typeof seconds === "number" && seconds > 0 ? `${Math.round(seconds / 3600)}-hour` : "Window";
}

/** Codex's `GET /backend-api/wham/usage`: `rate_limit.primary_window` and `secondary_window`, and the plan. */
export function parseCodexUsage(json: unknown): { windows: UsageWindow[]; plan?: string } {
    const body = object(json);
    const limits = object(body?.rate_limit);
    const windows: UsageWindow[] = [];

    for (const key of ["primary_window", "secondary_window"]) {
        const window = object(limits?.[key]);

        if (window === undefined) {
            continue;
        }

        windows.push({
            label: windowName(window.limit_window_seconds),
            usedPercent: percent(window.used_percent),
            ...(typeof window.reset_at === "number" ? { resetsAt: window.reset_at * 1000 } : {}),
        });
    }

    if (windows.length === 0) {
        throw new UnexpectedAnswer("no rate limit windows in Codex's answer");
    }

    return { windows, ...(typeof body?.plan_type === "string" ? { plan: body.plan_type } : {}) };
}

/** Copilot's `GET /copilot_internal/user`: the month's premium requests, and the plan. */
export function parseCopilotUsage(json: unknown): { windows: UsageWindow[]; plan?: string } {
    const body = object(json);
    const premium = object(object(body?.quota_snapshots)?.premium_interactions);
    const plan = typeof body?.copilot_plan === "string" ? { plan: body.copilot_plan } : {};

    if (premium === undefined) {
        throw new UnexpectedAnswer("no premium requests in Copilot's answer");
    }

    if (premium.unlimited === true) {
        return { windows: [{ label: "Premium requests", usedPercent: 0, detail: "unlimited" }], ...plan };
    }

    const resetsAt = isoTime(body?.quota_reset_date);

    return {
        windows: [
            {
                label: "Premium requests",
                usedPercent: 100 - percent(premium.percent_remaining),
                ...(resetsAt === undefined ? {} : { resetsAt }),
                ...(typeof premium.remaining === "number" && typeof premium.entitlement === "number"
                    ? { detail: `${Math.floor(premium.remaining)} of ${premium.entitlement} left` }
                    : {}),
            },
        ],
        ...plan,
    };
}

/** The account id a ChatGPT token is for (its claim `https://api.openai.com/auth`), as Codex's own requests send it. */
function chatgptAccount(token: string): string | undefined {
    try {
        const claims = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")) as Record<string, unknown>;
        const id = object(claims["https://api.openai.com/auth"])?.chatgpt_account_id;

        return typeof id === "string" && id !== "" ? id : undefined;
    } catch {
        return undefined;
    }
}

export type UsageLimitsOptions = {
    models: () => ModelRuntime;
    /** Claude Code's version for the user agent its endpoint wants (the billing patch's, phone settings). */
    claudeVersion: () => string;
    /** Every tab hears of new figures. */
    publish: (usage: AccountUsage) => void;
    /** The auth file the sign-ins are in, when not Pi's own (the team server's team accounts, PP-74). */
    authPath?: string;
    fetch?: typeof fetch;
    now?: () => number;
};

export class UsageLimits {
    readonly #options: UsageLimitsOptions;
    readonly #fetch: typeof fetch;
    readonly #now: () => number;
    readonly #kept = new Map<string, AccountUsage>();
    readonly #asking = new Map<string, Promise<AccountUsage | undefined>>();

    constructor(options: UsageLimitsOptions) {
        this.#options = options;
        this.#fetch = options.fetch ?? fetch;
        this.#now = options.now ?? Date.now;
    }

    /** The figures known now, without asking anyone. */
    known(): AccountUsage[] {
        return [...this.#kept.values()];
    }

    /**
     * Whether a provider's account has plan limits to show: a subscription (OAuth) sign-in of Claude, Codex, or Copilot.
     * Asked of the sign-in itself (`checkAuth`), not the runtime's status, which a new account has only once its first
     * check is done.
     */
    async limited(provider: string): Promise<boolean> {
        const models = this.#options.models();

        if (!LIMITED.has(baseProvider(provider)) || models.getProvider(provider) === undefined) {
            return false;
        }

        return (await models.checkAuth(provider).catch(() => undefined))?.type === "oauth";
    }

    /** Every signed-in subscription account's figures: kept ones under a minute old, unless `fresh`. */
    async all(fresh = false): Promise<AccountUsage[]> {
        const ids = this.#options
            .models()
            .getProviders()
            .map((provider) => provider.id)
            .filter((id) => LIMITED.has(baseProvider(id)));
        const found = await Promise.all(ids.map((id) => this.get(id, fresh)));

        return found.filter((each): each is AccountUsage => each !== undefined);
    }

    /** One account's figures; undefined for one without plan limits. */
    async get(provider: string, fresh = false): Promise<AccountUsage | undefined> {
        if (!(await this.limited(provider))) {
            return undefined;
        }

        const kept = this.#kept.get(provider);

        if (!fresh && kept !== undefined && this.#now() - kept.at < KEEP_MS) {
            return kept;
        }

        let asking = this.#asking.get(provider);

        if (asking === undefined) {
            asking = this.#ask(provider).finally(() => this.#asking.delete(provider));
            this.#asking.set(provider, asking);
        }

        return asking;
    }

    /** A run on `provider` ended: its figures changed, so it is asked again (at most once a minute) and every tab told. */
    afterRun(provider: string): void {
        const kept = this.#kept.get(provider);

        if (!LIMITED.has(baseProvider(provider)) || (kept !== undefined && this.#now() - kept.at < KEEP_MS)) {
            return;
        }

        void this.get(provider, true);
    }

    async #ask(provider: string): Promise<AccountUsage> {
        let usage: AccountUsage;

        try {
            usage = { provider, at: this.#now(), ...(await this.#request(provider)) };
        } catch (error) {
            usage = {
                provider,
                at: this.#now(),
                error: error instanceof UnexpectedAnswer ? `usage unavailable: ${error.message}` : `usage unavailable: ${describe(error)}`,
            };
        }

        this.#kept.set(provider, usage);
        this.#options.publish(usage);

        return usage;
    }

    async #request(provider: string): Promise<{ windows: UsageWindow[]; plan?: string }> {
        const base = baseProvider(provider);
        const call = async (url: string, headers: Record<string, string>) => {
            const response = await this.#fetch(url, { headers: { accept: "application/json", ...headers }, signal: AbortSignal.timeout(TIMEOUT_MS) });

            if (!response.ok) {
                throw new Error(`${new URL(url).host} answered ${response.status}`);
            }

            return (await response.json()) as unknown;
        };

        if (base === "github-copilot") {
            // Its usage is the GitHub account's: asked with the GitHub token the sign-in keeps, not the short Copilot one.
            const credential = readStoredCredential(provider, this.#options.authPath);
            const github = credential?.type === "oauth" ? credential.refresh : undefined;

            if (typeof github !== "string" || github === "") {
                throw new Error("no GitHub sign-in kept for Copilot");
            }

            return parseCopilotUsage(
                await call("https://api.github.com/copilot_internal/user", {
                    authorization: `token ${github}`,
                    "editor-version": "vscode/1.96.2",
                    "editor-plugin-version": "copilot-chat/0.26.7",
                    "user-agent": "GitHubCopilotChat/0.26.7",
                    "x-github-api-version": "2025-04-01",
                }),
            );
        }

        const token = (await this.#options.models().getAuth(provider))?.auth.apiKey;

        if (token === undefined || token === "") {
            throw new Error("not signed in");
        }

        if (base === "openai-codex") {
            const account = chatgptAccount(token);

            return parseCodexUsage(
                await call("https://chatgpt.com/backend-api/wham/usage", {
                    authorization: `Bearer ${token}`,
                    ...(account === undefined ? {} : { "chatgpt-account-id": account }),
                }),
            );
        }

        return {
            windows: parseClaudeUsage(
                await call("https://api.anthropic.com/api/oauth/usage", {
                    authorization: `Bearer ${token}`,
                    "anthropic-beta": "oauth-2025-04-20",
                    "user-agent": `claude-code/${this.#options.claudeVersion()}`,
                }),
            ),
        };
    }
}
