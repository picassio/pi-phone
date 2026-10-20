/**
 * Every app setting Pi may change, and the one-off actions it may take, in one place (PP-7; the owner's request of
 * 2026-10-20: "every setting on our app, but with approval from a human", "a tool, rather than code"). Each setting
 * reads its value as text and applies a new one through the same app method its screen calls, with the same checks and
 * the same events, so every open tab updates. The `settings`, `setting_change`, and `app_action` tools
 * (`extensions/settings.ts`) list them and change one after the person approves a card.
 *
 * Values are text, as Pi writes them: "none" clears a setting that may be empty; numbers are digits. A setting with a
 * target applies to one session (its id) or one person (their name).
 */
import type { ConversationId } from "@earendil-works/pi-durable";
import type { PocketApp } from "./app.ts";
import type { User } from "./config.ts";
import { HttpError } from "./errors.ts";

/** What a setting applies to, when it is not the app as a whole. */
export type TargetKind = "session" | "person";

export type Setting = {
    /** As Pi names it: `area.name` (`models.default`). */
    id: string;
    area: string;
    title: string;
    /** What it does, and the values it takes. */
    help: string;
    /** Only the owner may change it (every setting so far). */
    owner: boolean;
    /** A setting of one session or one person: the target names which. */
    target?: TargetKind;
    /** Its value now, in words. */
    read(target: string | undefined): Promise<string> | string;
    /** Values it may take, when they are a short list. */
    choices?(): Promise<string[]> | string[];
    /** Change it: `value` as Pi wrote it. */
    apply(user: User, value: string, target: string | undefined): Promise<void> | void;
};

/** A one-off action, not a value: what it does, and the arguments it takes (by name). */
export type AppAction = {
    id: string;
    area: string;
    title: string;
    help: string;
    owner: boolean;
    args: Record<string, string>;
    /** In words, for the card: what this run of it will do. */
    describe(args: Record<string, string>): string;
    run(user: User, args: Record<string, string>): Promise<string>;
};

const NONE = /^(none|null|off|-|)$/i;

/** A whole number, or null for "none". */
function count(value: string, what: string): number | null {
    if (NONE.test(value.trim())) {
        return null;
    }

    const number = Number(value.trim());

    if (!Number.isInteger(number)) {
        throw new HttpError(400, `${what} is a whole number, or none.`);
    }

    return number;
}

/** Dollars, or null for none. */
function dollars(value: string): number | null {
    if (NONE.test(value.trim())) {
        return null;
    }

    const number = Number(value.trim().replace(/^\$/, ""));

    if (!Number.isFinite(number)) {
        throw new HttpError(400, "A limit is an amount in dollars (12.50), or none.");
    }

    return number;
}

const onOff = (value: string): boolean => {
    if (/^(on|true|yes|1)$/i.test(value.trim())) {
        return true;
    }

    if (/^(off|false|no|0)$/i.test(value.trim())) {
        return false;
    }

    throw new HttpError(400, "Say on or off.");
};

const money = (amount: number | undefined) => (amount === undefined ? "none" : `$${amount.toFixed(2)}`);

/** Every setting and action as the app is now (the extensions list changes as modules come and go). */
export function appSettings(app: PocketApp): { settings: Setting[]; actions: AppAction[] } {
    const session = (target: string | undefined) => {
        const id = Number(target);

        if (!Number.isInteger(id) || id <= 0 || app.sessionMeta(id as unknown as ConversationId) === undefined) {
            throw new HttpError(404, `There is no session ${target ?? ""}: give its number as the target.`);
        }

        return id as unknown as ConversationId;
    };
    const person = (target: string | undefined) => {
        const found = app.config.users.find((user) => user.name.toLowerCase() === (target ?? "").trim().toLowerCase() || user.id === target);

        if (found === undefined) {
            throw new HttpError(404, `Nobody is called ${target ?? ""}. People: ${app.config.users.map((user) => user.name).join(", ")}.`);
        }

        return found;
    };
    const wiki = async <K extends keyof Awaited<ReturnType<PocketApp["para"]["settings"]>>>(key: K) => (await app.para.settings())[key];

    const settings: Setting[] = [
        // ─── Models ───
        {
            id: "models.default",
            area: "models",
            title: "Default model",
            help: 'The model and thinking level new sessions start with: "provider/modelId level" (level optional: off, minimal, low, medium, high, xhigh), or none for the last model picked.',
            owner: true,
            read: () => {
                const chosen = app.config.defaultModel;

                return chosen === undefined ? "none (the last model picked)" : `${chosen.provider}/${chosen.modelId} ${chosen.thinkingLevel}`;
            },
            apply: (user, value) => {
                if (NONE.test(value.trim())) {
                    return app.setDefaultModel(user, null);
                }

                const [spec = "", level] = value.trim().split(/\s+/);
                const slash = spec.indexOf("/");

                if (slash <= 0) {
                    throw new HttpError(400, 'Give the model as provider/modelId, like "anthropic/claude-opus-5-5 high".');
                }

                return app.setDefaultModel(user, { provider: spec.slice(0, slash), modelId: spec.slice(slash + 1), ...(level === undefined ? {} : { thinkingLevel: level }) });
            },
        },
        {
            id: "models.subagents",
            area: "models",
            title: "Models subagents may run on",
            help: "Besides their session's own: provider/modelId, comma-separated, or none.",
            owner: true,
            read: () => (app.config.subagentModels.length === 0 ? "none" : app.config.subagentModels.join(", ")),
            apply: (user, value) =>
                app.setSubagentModels(
                    user,
                    NONE.test(value.trim())
                        ? []
                        : value
                              .split(",")
                              .map((each) => each.trim())
                              .filter(Boolean),
                ),
        },
        {
            id: "approvals.rule",
            area: "approvals",
            title: "Who may allow risky calls",
            help: "anyone (anyone who can steer the session) or others (someone other than who asked).",
            owner: true,
            read: () => app.config.approvalRule,
            choices: () => ["anyone", "others"],
            apply: (user, value) => app.setApprovalRule(user, value.trim()),
        },
        {
            id: "sessions.sendLimit",
            area: "sessions",
            title: "Messages a session may send other sessions, an hour",
            help: "For every session: a whole number from 1 to 10000, or none.",
            owner: true,
            read: () => String(app.config.sessionSendLimit ?? "none"),
            apply: (user, value) => app.setSessionSendLimit(user, count(value, "The limit")),
        },
        // ─── Pi's browser ───
        {
            id: "browser.runModel",
            area: "browser",
            title: "Run model for browser_run, every session",
            help: 'session (each session\'s own model) or a Jev model\'s OpenRouter id, like typesafe/jev-1.13.',
            owner: true,
            read: () => app.config.browserRunModel ?? "session",
            apply: (user, value) => app.setBrowserRunModel(user, value.trim()),
        },
        {
            id: "browser.sessionRunModel",
            area: "browser",
            title: "Run model for browser_run, one session",
            help: "inherit (the default for every session), session, or a Jev model's OpenRouter id. Target: the session's number.",
            owner: true,
            target: "session",
            read: (target) => app.sessionMeta(session(target))?.browserRunModel ?? "inherit",
            apply: (user, value, target) => app.setBrowserRunModel(user, value.trim(), session(target)),
        },
        // ─── Web access ───
        {
            id: "web.provider",
            area: "web",
            title: "Web search provider",
            help: "A provider's id (its key comes from Secrets or Settings › Web access), or none to turn web search off.",
            owner: true,
            read: () => app.web.provider ?? "none",
            choices: async () => (await app.web.providers()).map((provider) => `${provider.id}${provider.missing === undefined ? "" : " (not ready)"}`),
            apply: (_user, value) => {
                try {
                    app.web.set({ provider: NONE.test(value.trim()) ? null : value.trim() });
                } catch (error) {
                    throw new HttpError(400, error instanceof Error ? error.message : String(error));
                }
            },
        },
        // ─── Wiki ───
        {
            id: "wiki.captureMinutes",
            area: "wiki",
            title: "Capture idle sessions into the wiki after",
            help: "Minutes a session is idle before it is captured, 1 to 1440, or none for only when asked.",
            owner: true,
            read: () => String(app.config.wikiCaptureMinutes ?? "none"),
            apply: (user, value) => app.setWikiCaptureMinutes(user, count(value, "Minutes")),
        },
        {
            id: "wiki.captureModel",
            area: "wiki",
            title: "Model that writes wiki captures",
            help: 'auto (the app\'s default model) or provider/modelId.',
            owner: true,
            read: () => wiki("captureModel"),
            apply: async (_user, value) => {
                await app.para.updateSettings({ captureModel: value.trim() });
            },
        },
        {
            id: "wiki.embeddingModel",
            area: "wiki",
            title: "Embedding model for wiki search",
            help: "An OpenRouter embedding model's id, or none for keyword search only.",
            owner: true,
            read: async () => (await wiki("embeddingModel")) ?? "none",
            apply: async (_user, value) => {
                await app.para.updateSettings({ embeddingModel: NONE.test(value.trim()) ? null : value.trim() });
            },
        },
        {
            id: "wiki.contextTokens",
            area: "wiki",
            title: "Wiki context in each prompt, in tokens",
            help: "A whole number.",
            owner: true,
            read: async () => String(await wiki("contextTokens")),
            apply: async (_user, value) => {
                await app.para.updateSettings({ contextTokens: count(value, "Tokens") ?? 0 });
            },
        },
        {
            id: "wiki.lintAutoFix",
            area: "wiki",
            title: "wiki_lint fixes simple issues by itself",
            help: "on or off.",
            owner: true,
            read: async () => ((await wiki("lintAutoFix")) ? "on" : "off"),
            choices: () => ["on", "off"],
            apply: async (_user, value) => {
                await app.para.updateSettings({ lintAutoFix: onOff(value) });
            },
        },
        {
            id: "wiki.lintStaleDays",
            area: "wiki",
            title: "Days before a wiki page counts as stale",
            help: "A whole number of days.",
            owner: true,
            read: async () => String(await wiki("lintStaleDays")),
            apply: async (_user, value) => {
                await app.para.updateSettings({ lintStaleDays: count(value, "Days") ?? 0 });
            },
        },
        {
            id: "wiki.lintQuestionDays",
            area: "wiki",
            title: "Days an open question may stay open before wiki_lint warns",
            help: "A whole number of days.",
            owner: true,
            read: async () => String(await wiki("lintQuestionDays")),
            apply: async (_user, value) => {
                await app.para.updateSettings({ lintQuestionDays: count(value, "Days") ?? 0 });
            },
        },
        // ─── Spend ───
        {
            id: "spend.sessionLimit",
            area: "spend",
            title: "Spend limit of one session",
            help: "Dollars (12.50), or none. Target: the session's number.",
            owner: true,
            target: "session",
            read: (target) => money(app.sessionMeta(session(target))?.budget),
            apply: (user, value, target) => app.spend.setSessionBudget(user, session(target), dollars(value)),
        },
        {
            id: "spend.personLimit",
            area: "spend",
            title: "Spend limit of one invited person",
            help: "Dollars (12.50), or none. Target: the person's name. The owner has none.",
            owner: true,
            target: "person",
            read: (target) => money(person(target).budget),
            apply: (user, value, target) => app.spend.setPersonBudget(user, person(target).id, dollars(value)),
        },
        // ─── Themes ───
        {
            id: "themes.default",
            area: "themes",
            title: "Theme and colors browsers start with",
            help: 'Until each person picks their own: "themeId colorsId" (colors may end in @dark or @light), or none for the app\'s own.',
            owner: true,
            read: () => (app.config.themeDefault === undefined ? "none (the app's own)" : `${app.config.themeDefault.look} ${app.config.themeDefault.colors}`),
            choices: () => app.themes.list().filter((theme) => theme.usable).map((theme) => theme.id),
            apply: (user, value) => {
                if (NONE.test(value.trim())) {
                    return app.setThemeDefault(user, null);
                }

                const [look, colors] = value.trim().split(/\s+/);

                return app.setThemeDefault(user, { look, colors: colors ?? look });
            },
        },
        // ─── Extensions: one setting each ───
        ...app.loader.list().map(
            (module): Setting => ({
                id: `extensions.${module.file}`,
                area: "extensions",
                title: `Extension: ${module.title}`,
                help: `${module.summary} on or off${module.required ? " (required: it stays on)" : ""}.`,
                owner: true,
                read: () => (module.enabled ? "on" : "off"),
                choices: () => ["on", "off"],
                apply: (user, value) => app.setExtensionEnabled(user, module.file, onOff(value)),
            }),
        ),
    ];

    const actions: AppAction[] = [
        {
            id: "extensions.reload",
            area: "extensions",
            title: "Reload an extension",
            help: "Load an extension module's code again (after its file changed).",
            owner: true,
            args: { file: "The module's file, as settings lists it (extensions.<file>)" },
            describe: (args) => `Reload the extension ${args.file ?? ""}`,
            run: async (_user, args) => {
                await app.reloadExtension(args.file ?? "");

                return `Reloaded ${args.file}.`;
            },
        },
        {
            id: "models.refresh",
            area: "models",
            title: "Refresh the model lists",
            help: "Ask every signed-in provider for its models again.",
            owner: true,
            args: {},
            describe: () => "Refresh every provider's model list",
            run: async () => {
                await app.providers.modelRefresh.refresh();

                return "Refreshed the providers' model lists.";
            },
        },
    ];

    return { settings, actions };
}
