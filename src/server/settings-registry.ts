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
import { MAX_COMPACT_AT, MIN_COMPACT_AT } from "./auto-compact.ts";
import { makeBackup } from "./backup.ts";
import { type VoiceCheck, VOICES } from "./voice.ts";
import { copyFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** What a setting applies to, when it is not the app as a whole. */
export type TargetKind = "session" | "person" | "secret" | "machine" | "ssh-key" | "device";

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

/** What a voice model check found, in words. */
function voiceModels(check: VoiceCheck | undefined): string {
    if (check === undefined) {
        return "No check yet.";
    }

    const live = check.live.map((each) => `${each.id} (${each.path === "key" ? "short-lived key" : each.path === "server" ? "through pi-phone" : "Codex's endpoint"})`).join(", ");

    return `Live: ${live || "none"}. Dictation: ${check.dictation.join(", ") || "none"}. Not for this sign-in: ${check.hidden.join(", ") || "none"}.`;
}

/** Every setting and action as the app is now (the extensions list changes as modules come and go). */
export function appSettings(app: PocketApp): { settings: Setting[]; actions: AppAction[]; targets: Record<TargetKind, () => Promise<string[]> | string[]> } {
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
    const owner = () => {
        const found = app.config.users.find((user) => user.role === "owner");

        if (found === undefined) {
            throw new HttpError(500, "This pi-phone has no owner.");
        }

        return found;
    };
    const machine = (target: string | undefined) => {
        const found = app.machines.list().find((each) => each.id === target || each.name.toLowerCase() === (target ?? "").trim().toLowerCase());

        if (found === undefined) {
            throw new HttpError(404, `There is no machine ${target ?? ""}. Machines: ${app.machines.list().map((each) => each.name).join(", ") || "none"}.`);
        }

        return found;
    };
    const secret = (target: string | undefined) => {
        const found = app.secrets.list().find((each) => each.name === (target ?? "").trim());

        if (found === undefined) {
            throw new HttpError(404, `There is no secret ${target ?? ""}. Secrets: ${app.secrets.list().map((each) => each.name).join(", ") || "none"}.`);
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
            id: "providers.limitWait",
            area: "providers",
            title: "Wait for a limit",
            help: "When a provider's limit stops a run, it waits until the provider's reset and goes on by itself, up to this many hours: 0 (off), 1, 6, 12 or 24. A reset further away, billing, or an expired sign-in fails at once.",
            owner: true,
            read: () => String(app.config.limitWaitHours),
            choices: () => ["0", "1", "6", "12", "24"],
            apply: (user, value) => app.setLimitWaitHours(user, NONE.test(value.trim()) ? 0 : Number(value.trim().replace(/\s*h(ours?)?$/i, ""))),
        },
        {
            id: "providers.limitNotice",
            area: "providers",
            title: "Tell me of a long wait for a limit",
            help: "on or off: one phone notification (and web push) when a run begins to wait 10 minutes or more for a provider's limit.",
            owner: true,
            read: () => (app.config.limitNotice ? "on" : "off"),
            choices: () => ["on", "off"],
            apply: (user, value) => app.setLimitNotice(user, onOff(value)),
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
        // ─── Auto-compact (PP-78) ───
        {
            id: "sessions.compactAt",
            area: "sessions",
            title: "When sessions compact their context by themselves",
            help: `For every session: a percentage of the model's context window (${MIN_COMPACT_AT} to ${MAX_COMPACT_AT}), or full (only when nearly full, the default). A session's own setting comes first.`,
            owner: true,
            read: () => String(app.config.compactAt),
            apply: (user, value) => app.setCompactAt(user, value),
        },
        {
            id: "sessions.sessionCompactAt",
            area: "sessions",
            title: "When one session compacts its context by itself",
            help: `A percentage (${MIN_COMPACT_AT} to ${MAX_COMPACT_AT}), full (only when nearly full), or inherit (the setting for every session). Target: the session's number.`,
            owner: true,
            target: "session",
            read: (target) => {
                const own = app.sessionMeta(session(target))?.compactAt;

                return own === undefined ? `inherit (${String(app.config.compactAt)})` : String(own);
            },
            apply: (user, value, target) => app.setSessionCompactAt(session(target), user, value),
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
            title: "Embedding model for search",
            help: "An OpenRouter embedding model's id, for search by meaning in the wiki and your documents, or none for keyword search only.",
            owner: true,
            read: async () => (await wiki("embeddingModel")) ?? "none",
            apply: async (_user, value) => {
                await app.para.updateSettings({ embeddingModel: NONE.test(value.trim()) ? null : value.trim() });
            },
        },
        {
            id: "docs.imageModel",
            area: "documents",
            title: "Model that describes images in documents",
            help: "provider/modelId of a signed-in model that reads images, or none: images are then found by their names only.",
            owner: true,
            read: () => app.config.docsImageModel ?? "none",
            choices: () => app.imageModels(),
            apply: (user, value) => app.setDocsImageModel(user, NONE.test(value.trim()) ? null : value.trim()),
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
        // ─── Language (PP-81) ───
        {
            id: "appearance.language",
            area: "appearance",
            title: "The app's language for one person",
            help: "auto (their browser's or phone's), en (English), zh-CN (简体中文), or vi (Tiếng Việt). Target: the person's name. Their open tabs load again in it.",
            owner: true,
            target: "person",
            read: (target) => person(target).language ?? "auto",
            choices: () => ["auto", "en", "zh-CN", "vi"],
            apply: (_user, value, target) => app.setLanguage(person(target), value.trim()),
        },
        // ─── Notifications and dictation (PP-235: what a Getting started guide sets up) ───
        {
            id: "notifications.device",
            area: "notifications",
            title: "Notifications on a browser or device (web push)",
            help: "on or off, for the device named as the target (as Menu › Notifications lists them). Off forgets that device. On is turned on only on the device itself, with a tap: show the person Menu › Notifications there (show_screen notifications). The pi-phone app has its own notifications (Android's settings).",
            owner: true,
            target: "device",
            read: (target) => {
                const found = app.webPush.list().find((each) => each.name === (target ?? "").trim());

                return found === undefined ? "off" : found.lastError === undefined ? "on" : `on (the last one did not go: ${found.lastError})`;
            },
            choices: () => ["on", "off"],
            apply: (_user, value, target) => {
                const wanted = value.trim();

                if (wanted !== "on" && wanted !== "off") {
                    throw new HttpError(400, "Notifications are on or off.");
                }

                const found = app.webPush.list().find((each) => each.name === (target ?? "").trim());

                if (wanted === "on") {
                    if (found === undefined) {
                        throw new HttpError(400, "Notifications turn on only on the device itself, with a tap: Menu › Notifications there.");
                    }

                    return;
                }

                if (found === undefined) {
                    throw new HttpError(404, `No device gets notifications as ${target ?? ""}. Devices: ${app.webPush.list().map((each) => each.name).join(", ") || "none"}.`);
                }

                app.webPush.remove(found.id);
            },
        },
        {
            id: "dictation.language",
            area: "dictation",
            title: "The language dictation listens for, on every device of one person",
            help: "A language tag (vi-VN, en-US, zh-CN, …), or auto for each device's own language. Target: the person's name. Menu › Dictation sets it too.",
            owner: true,
            target: "person",
            read: (target) => person(target).dictation ?? "auto",
            apply: (_user, value, target) => app.setDictationLanguage(person(target), value.trim()),
        },
        // ─── Onboarding (PP-234) ───
        {
            id: "onboarding.welcome",
            area: "onboarding",
            title: "The first-run welcome (language, a model, the phone's permissions)",
            help: "show (it opens again the next time the app opens, and in the open tabs now), done, or skipped. Only the owner has it.",
            owner: true,
            read: () => app.welcomeOf(owner()),
            choices: () => ["show", "done", "skipped"],
            apply: (user, value) => app.setWelcome(user, value.trim()),
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
        // ─── People and access ───
        {
            id: "people.role",
            area: "people",
            title: "What an invited person may do",
            help: "guest (can steer the sessions shared with them) or viewer (only reads). Target: the person's name.",
            owner: true,
            target: "person",
            read: (target) => person(target).role,
            choices: () => ["guest", "viewer"],
            apply: (user, value, target) => app.setAccess(user, person(target).id, { role: value.trim() }),
        },
        {
            id: "people.sessions",
            area: "people",
            title: "Sessions an invited person may open",
            help: "all, or session numbers, comma-separated. Target: the person's name.",
            owner: true,
            target: "person",
            read: (target) => person(target).sessions?.join(", ") ?? "all",
            apply: (user, value, target) =>
                app.setAccess(user, person(target).id, {
                    sessions: /^all$/i.test(value.trim())
                        ? null
                        : value
                              .split(",")
                              .map((each) => each.trim().replace(/^#/, ""))
                              .filter(Boolean),
                }),
        },
        {
            id: "access.tailscale",
            area: "people",
            title: "Serve other devices over Tailscale",
            help: "on or off: your laptop's browser and invited people reach the app through your tailnet.",
            owner: true,
            read: () => (app.config.tailscale ? "on" : "off"),
            choices: () => ["on", "off"],
            apply: async (_user, value) => {
                if (app.tailnet === undefined) {
                    throw new HttpError(503, "This server is not serving the network.");
                }

                app.config.tailscale = onOff(value);
                await app.tailnet.set(app.config.tailscale);
            },
        },
        // ─── Phone ───
        {
            id: "phone.claudeCodeBilling",
            area: "phone",
            title: "Bill Anthropic sign-ins as Claude Code",
            help: "on or off: requests on an Anthropic subscription sign-in are sent as Claude Code's.",
            owner: true,
            read: () => (app.phoneSettings.current().claudeCodeBilling.enabled ? "on" : "off"),
            choices: () => ["on", "off"],
            apply: (_user, value) => {
                app.phoneSettings.update({ enabled: onOff(value) });
            },
        },
        {
            id: "phone.claudeCodeVersion",
            area: "phone",
            title: "Claude Code version the billing patch sends",
            help: "A version like 2.1.280.",
            owner: true,
            read: () => app.phoneSettings.current().claudeCodeBilling.version,
            apply: (_user, value) => {
                if (!/^\d+\.\d+\.\d+$/.test(value.trim())) {
                    throw new HttpError(400, "A version is three numbers, like 2.1.280.");
                }

                app.phoneSettings.update({ version: value.trim() });
            },
        },
        // ─── The phone's assistant (PP-146) ───
        {
            id: "assistant.opens",
            area: "assistant",
            title: "Where the side key's assistant sends your words",
            help: "last (the last session you were in), new (a new session in assistant.folder), or session (always assistant.session).",
            owner: true,
            read: () => app.config.assistant.opens,
            choices: () => ["last", "new", "session"],
            apply: (user, value) => app.setAssistant(user, { opens: value.trim().toLowerCase() }),
        },
        {
            id: "assistant.folder",
            area: "assistant",
            title: "Folder of the assistant's new sessions",
            help: "A folder on this phone, or none for the app's default folder. Used when assistant.opens is new.",
            owner: true,
            read: () => app.config.assistant.folder ?? `none (the default folder, ${app.defaultCwd})`,
            apply: (user, value) => app.setAssistant(user, { folder: NONE.test(value.trim()) ? null : value.trim() }),
        },
        {
            id: "assistant.session",
            area: "assistant",
            title: "The session the assistant always sends to",
            help: "A session's number (from the sessions tool). Used when assistant.opens is session.",
            owner: true,
            read: () => (app.config.assistant.session === null ? "none" : String(app.config.assistant.session)),
            apply: async (user, value) => {
                const id = count(value.replace(/^#/, ""), "The session");

                if (id !== null) {
                    app.requireSee(user, id as ConversationId);
                }

                await app.setAssistant(user, { session: id, ...(id === null && app.config.assistant.opens === "session" ? { opens: "last" } : {}) });
            },
        },
        {
            id: "assistant.send",
            area: "assistant",
            title: "When you stop speaking to the assistant",
            help: "tap (the words wait for Send) or auto (they go by themselves after 3 seconds, unless you tap them).",
            owner: true,
            read: () => app.config.assistant.send,
            choices: () => ["tap", "auto"],
            apply: (user, value) => app.setAssistant(user, { send: value.trim().toLowerCase() }),
        },
        {
            id: "assistant.from",
            area: "assistant",
            title: "The assistant notes the app you were in",
            help: "on or off: a message from the side key starts with the app that was in front (its name only), so Pi can offer phone control for it.",
            owner: true,
            read: () => (app.config.assistant.from ? "on" : "off"),
            choices: () => ["on", "off"],
            apply: (user, value) => app.setAssistant(user, { from: onOff(value) }),
        },
        {
            id: "assistant.talk",
            area: "assistant",
            title: "What the side key's sheet does when it opens",
            help: "dictate (it listens for a message) or call (a voice call with the session's Pi, which moves to the app when the sheet goes; needs the ChatGPT sign-in, Settings › Voice).",
            owner: true,
            read: () => app.config.assistant.talk,
            choices: () => ["dictate", "call"],
            apply: (user, value) => app.setAssistant(user, { talk: value.trim().toLowerCase() }),
        },
        // ─── Voice with the ChatGPT sign-in (PP-185) ───
        {
            id: "voice.model",
            area: "voice",
            title: "Live model of voice calls",
            help: "A live model's id the ChatGPT sign-in has, checked with OpenAI before it is kept (gpt-realtime-2, gpt-realtime-mini; gpt-live-1.1-codex is Codex's own voice on ChatGPT's private endpoint).",
            owner: true,
            read: () => app.config.voice.model,
            choices: () => (app.config.voiceCheck?.live ?? []).map((each) => each.id),
            apply: (user, value) => app.setVoice(user, { model: value.trim() }),
        },
        {
            id: "voice.dictationModel",
            area: "voice",
            title: "Model that writes down what you say",
            help: "A transcription model the ChatGPT sign-in has (gpt-4o-transcribe, gpt-4o-mini-transcribe, whisper-1), checked with OpenAI: used in calls and by the Codex dictation engine.",
            owner: true,
            read: () => app.config.voice.dictationModel,
            choices: () => [...(app.config.voiceCheck?.dictation ?? [])],
            apply: (user, value) => app.setVoice(user, { dictationModel: value.trim() }),
        },
        {
            id: "voice.engine",
            area: "voice",
            title: "Who listens to the message box's mic",
            help: "android (the phone's recognizer, free) or codex (the dictation model, on the ChatGPT sign-in).",
            owner: true,
            read: () => app.config.voice.engine,
            choices: () => ["android", "codex"],
            apply: (user, value) => app.setVoice(user, { engine: value.trim().toLowerCase() }),
        },
        {
            id: "voice.voice",
            area: "voice",
            title: "The voice calls speak with",
            help: "A voice the live model has (marin, cedar, alloy, ash, ballad, coral, echo, sage, shimmer, verse), checked with OpenAI.",
            owner: true,
            read: () => app.config.voice.voice,
            choices: () => [...VOICES],
            apply: (user, value) => app.setVoice(user, { voice: value.trim() }),
        },
        {
            id: "voice.language",
            area: "voice",
            title: "Language voice listens for",
            help: "auto (the language you speak) or a two-letter code the dictation model takes (vi, en), checked with OpenAI.",
            owner: true,
            read: () => app.config.voice.language,
            apply: (user, value) => app.setVoice(user, { language: value.trim() }),
        },
        {
            id: "voice.mode",
            area: "voice",
            title: "Who thinks in voice calls of new sessions",
            help: "work (the voice talks and hands real work to Pi, then speaks Pi's answer), chat (the voice only chats), or think (Pi thinks; voice is speech in and out). A session's own: sessions.voiceMode.",
            owner: true,
            read: () => app.config.voice.mode,
            choices: () => ["work", "chat", "think"],
            apply: (user, value) => app.setVoice(user, { mode: value.trim().toLowerCase() }),
        },
        {
            id: "voice.turns",
            area: "voice",
            title: "How you take turns in a call",
            help: "hands-free (talk any time; talking over the voice stops it), tap (a tap opens the mic for one turn; it mutes itself when you stop talking, so people near you are not heard), or hold (hold the button to talk).",
            owner: true,
            read: () => app.config.voice.turns,
            choices: () => ["hands-free", "tap", "hold"],
            apply: (user, value) => app.setVoice(user, { turns: value.trim().toLowerCase() }),
        },
        {
            id: "voice.progress",
            area: "voice",
            title: "What the voice says while Pi works",
            help: "text (Pi's words as they come) or answer (only Pi's answer).",
            owner: true,
            read: () => app.config.voice.progress,
            choices: () => ["text", "answer"],
            apply: (user, value) => app.setVoice(user, { progress: value.trim().toLowerCase() }),
        },
        {
            id: "voice.cueSeconds",
            area: "voice",
            title: "A tool cue at most every",
            help: "Seconds between short cues on what Pi runs (\"still running the tests\"), 0 for none, up to 600.",
            owner: true,
            read: () => String(app.config.voice.cueSeconds),
            apply: (user, value) => app.setVoice(user, { cueSeconds: Number(value.trim().replace(/\s*s(ec(ond)?s?)?$/i, "")) }),
        },
        {
            id: "voice.reader",
            area: "voice",
            title: "Who reads Pi's answers in \"Pi thinks\"",
            help: "live (the live model reads Pi's text as written) or device (the device's own voice: Android's text-to-speech in the app, the browser's elsewhere; a call does not start where there is none).",
            owner: true,
            read: () => app.config.voice.reader,
            choices: () => ["live", "device"],
            apply: (user, value) => app.setVoice(user, { reader: value.trim().toLowerCase() }),
        },
        {
            id: "voice.noise",
            area: "voice",
            title: "Noise reduction on the mic",
            help: "In calls and Codex dictation: near_field (a phone at your face, or a headset; the default), far_field (a speakerphone, a laptop, a phone on the table), or off.",
            owner: true,
            read: () => app.config.voice.noise,
            choices: () => ["near_field", "far_field", "off"],
            apply: (user, value) => app.setVoice(user, { noise: value.trim().toLowerCase().replace(/[ -]/g, "_") }),
        },
        {
            id: "voice.eagerness",
            area: "voice",
            title: "How readily hands-free takes your turn as ended",
            help: "auto (the default), low (waits longer for you to finish: better in noise), medium, or high (answers soonest).",
            owner: true,
            read: () => app.config.voice.eagerness,
            choices: () => ["auto", "low", "medium", "high"],
            apply: (user, value) => app.setVoice(user, { eagerness: value.trim().toLowerCase() }),
        },
        {
            id: "voice.vad",
            area: "voice",
            title: "What starts and ends your turn in a call",
            help: "semantic (the default: OpenAI's semantic turn detection, by what you say, at voice.eagerness; no loudness threshold) or server (by loudness: voice.vadThreshold and voice.vadSilenceMs; people talking further away do not start a turn). Also used by Codex dictation's turns.",
            owner: true,
            read: () => app.config.voice.vad,
            choices: () => ["semantic", "server"],
            apply: (user, value) => app.setVoice(user, { vad: value.trim().toLowerCase() }),
        },
        {
            id: "voice.vadThreshold",
            area: "voice",
            title: "By loudness: how loud you must be",
            help: "0 to 1, 0.7 by default (OpenAI's own default is 0.5): higher needs louder, closer speech to start a turn. Used when voice.vad is server.",
            owner: true,
            read: () => String(app.config.voice.vadThreshold),
            apply: (user, value) => app.setVoice(user, { vadThreshold: value.trim() === "" ? Number.NaN : Number(value.trim()) }),
        },
        {
            id: "voice.vadSilenceMs",
            area: "voice",
            title: "By loudness: the pause before it answers",
            help: "Milliseconds of silence that end your turn, 200 to 3000, 500 by default. Used when voice.vad is server.",
            owner: true,
            read: () => String(app.config.voice.vadSilenceMs),
            apply: (user, value) => app.setVoice(user, { vadSilenceMs: Number(value.trim().replace(/\s*ms$/i, "")) }),
        },
        {
            id: "voice.autoMuteSeconds",
            area: "voice",
            title: "Hands-free: mute the mic after a quiet spell",
            help: "Seconds after the voice finished answering (or the mic was turned on) with nothing said before the mic mutes itself, 0 for never (the default), up to 600. Mute or a mute key turns it on again.",
            owner: true,
            read: () => String(app.config.voice.autoMuteSeconds),
            apply: (user, value) => app.setVoice(user, { autoMuteSeconds: Number(value.trim().replace(/\s*s(ec(ond)?s?)?$/i, "")) }),
        },
        {
            id: "voice.muteKey",
            area: "voice",
            title: "A key that turns the mic off and on in a call",
            help: "headset (a Bluetooth or wired headset's button; the default), volume (the volume keys, while pi-phone or its assistant sheet is in front: they then do not change the volume), both, or off.",
            owner: true,
            read: () => app.config.voice.muteKey,
            choices: () => ["off", "headset", "volume", "both"],
            apply: (user, value) => app.setVoice(user, { muteKey: value.trim().toLowerCase() }),
        },
        {
            id: "voice.proximityMute",
            area: "voice",
            title: "Mute the mic unless the phone is at your ear",
            help: "on or off (the default): in a call in the Android app, the mic is off while the proximity sensor sees nothing near or the phone lies face down, and on again at your ear. Not for speakerphone calls.",
            owner: true,
            read: () => (app.config.voice.proximityMute ? "on" : "off"),
            choices: () => ["on", "off"],
            apply: (user, value) => app.setVoice(user, { proximityMute: onOff(value) }),
        },
        {
            id: "voice.dailyLimit",
            area: "voice",
            title: "Minutes of voice a day",
            help: "Calls and Codex dictation together, 1 to 1440 minutes, or none (the default). Minutes used are in Spend.",
            owner: true,
            read: () => (app.config.voice.dailyLimit === null ? "none" : String(app.config.voice.dailyLimit)),
            apply: (user, value) => app.setVoice(user, { dailyLimit: count(value.replace(/\s*min(ute)?s?$/i, ""), "The limit") }),
        },
        {
            id: "sessions.voiceMode",
            area: "sessions",
            title: "Who thinks in one session's voice calls",
            help: "work, chat, think, or inherit (Settings › Voice's mode for new sessions). Target: the session's number.",
            owner: false,
            target: "session",
            read: (target) => {
                const own = app.sessionMeta(session(target))?.voiceMode;

                return own === undefined ? `inherit (${app.config.voice.mode})` : own;
            },
            choices: () => ["work", "chat", "think", "inherit"],
            apply: (user, value, target) => app.setSessionVoiceMode(session(target), user, value.trim().toLowerCase()),
        },
        // ─── One session ───
        {
            id: "sessions.model",
            area: "sessions",
            title: "A session's model",
            help: '"provider/modelId level" (level optional). Target: the session\'s number.',
            owner: false,
            target: "session",
            read: async (target) => {
                const state = await app.agentState(session(target));

                return state?.model === undefined ? "(not set)" : `${state.model.provider}/${state.model.modelId} ${state.thinkingLevel ?? "off"}`;
            },
            apply: (user, value, target) => {
                const [spec = "", level] = value.trim().split(/\s+/);
                const slash = spec.indexOf("/");

                if (slash <= 0) {
                    throw new HttpError(400, 'Give the model as provider/modelId, like "anthropic/claude-opus-5-5 high".');
                }

                return app.commands.configure(session(target), user, {
                    model: { provider: spec.slice(0, slash), modelId: spec.slice(slash + 1) },
                    ...(level === undefined ? {} : { thinkingLevel: level }),
                });
            },
        },
        {
            id: "sessions.instructions",
            area: "sessions",
            title: "A session's instructions for Pi",
            help: "Text Pi reads in that session's every prompt, or none. Target: the session's number.",
            owner: false,
            target: "session",
            read: async (target) => (await app.agentState(session(target)))?.instructions ?? "none",
            apply: (user, value, target) => app.commands.setInstructions(session(target), user, NONE.test(value.trim()) ? "" : value),
        },
        {
            id: "sessions.trust",
            area: "sessions",
            title: "Whether Pi trusts a session's project (its own skills)",
            help: "trust, trust-parent (the folder above too), or distrust. Target: the session's number.",
            owner: true,
            target: "session",
            read: () => "(see the session's trust card)",
            choices: () => ["trust", "trust-parent", "distrust"],
            apply: (user, value, target) => {
                const choice = value.trim();

                if (choice !== "trust" && choice !== "trust-parent" && choice !== "distrust") {
                    throw new HttpError(400, "trust, trust-parent, or distrust.");
                }

                app.setProjectTrust(session(target), user, choice);
            },
        },
        {
            id: "sessions.ownSendLimit",
            area: "sessions",
            title: "One session's limit on messages to other sessions, an hour",
            help: "A whole number from 1 to 10000, none, or inherit (every session's). Target: the session's number.",
            owner: true,
            target: "session",
            read: (target) => {
                const own = app.sessionMeta(session(target))?.sendLimit;

                return own === undefined ? "inherit" : String(own ?? "none");
            },
            apply: (user, value, target) =>
                app.setSendLimit(session(target), user, /^inherit$/i.test(value.trim()) ? "inherit" : count(value, "The limit")),
        },
        // ─── Secrets: their settings (a value is typed by the person: secret_request) ───
        {
            id: "secrets.ask",
            area: "secrets",
            title: "A secret's uses wait for a person",
            help: "on (each call that uses it asks first) or off. Target: the secret's name.",
            owner: true,
            target: "secret",
            read: (target) => (secret(target).ask ? "on" : "off"),
            choices: () => ["on", "off"],
            apply: (_user, value, target) => {
                app.secrets.set(secret(target).name, { ask: onOff(value) });
            },
        },
        {
            id: "secrets.description",
            area: "secrets",
            title: "What a secret is for",
            help: "Its description, as the list shows it. Target: the secret's name.",
            owner: true,
            target: "secret",
            read: (target) => secret(target).description,
            apply: (_user, value, target) => {
                app.secrets.set(secret(target).name, { description: value.trim() });
            },
        },
        {
            id: "secrets.machines",
            area: "secrets",
            title: "Sessions on machines may use a secret",
            help: "on or off. Target: the secret's name.",
            owner: true,
            target: "secret",
            read: (target) => (secret(target).machines ? "on" : "off"),
            choices: () => ["on", "off"],
            apply: (_user, value, target) => {
                app.secrets.set(secret(target).name, { machines: onOff(value) });
            },
        },
        // ─── Machines and keys ───
        {
            id: "machines.name",
            area: "machines",
            title: "A machine's name",
            help: "The name sessions, the folder picker, and pi-ssh use. Target: the machine's name or id.",
            owner: true,
            target: "machine",
            read: (target) => machine(target).name,
            apply: async (_user, value, target) => {
                await app.machines.edit(machine(target).id, { name: value.trim() });
            },
        },
        {
            id: "machines.askRun",
            area: "machines",
            title: "Pi asks before each command on a machine",
            help: "on: each machine_run command there waits for a person to allow it on a card that shows it; off (the default): it runs as bash on the phone does. Target: the machine's name or id.",
            owner: true,
            target: "machine",
            read: (target) => (machine(target).askRun === true ? "on" : "off"),
            choices: () => ["on", "off"],
            apply: async (_user, value, target) => {
                await app.machines.edit(machine(target).id, { askRun: onOff(value) });
            },
        },
        {
            id: "sshKeys.name",
            area: "machines",
            title: "An SSH key's name",
            help: "Target: the key's id (settings lists the keys under Targets).",
            owner: true,
            target: "ssh-key",
            read: async (target) => (await app.sshKeys.list()).find((key) => key.id === target)?.name ?? `(no key ${target ?? ""})`,
            apply: (_user, value, target) => app.sshKeys.rename(target ?? "", value.trim()),
        },
        // ─── Extensions: one setting each ───
        ...app.loader.list().map(
            (module): Setting => ({
                id: `extensions.${module.file}`,
                area: "extensions",
                title: `Extension: ${module.title}`,
                help: `${module.source === "drop-in" ? "A drop-in (the owner's, in the data folder's extensions). " : ""}${module.summary} on or off${module.required ? " (required: it stays on)" : ""}.${module.error === undefined ? "" : ` ${module.refused === undefined ? "It failed to load" : "It is refused"}: ${module.error}`}`,
                owner: true,
                // Read now, not from the list the settings were made from: after a change it says the new state.
                read: () => (app.loader.list().find((each) => each.file === module.file)?.enabled ? "on" : "off"),
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
            id: "voice.check",
            area: "voice",
            title: "Check the voice models",
            help: "Ask OpenAI which live and dictation models the ChatGPT sign-in has now, and how each live model's calls are set up.",
            owner: true,
            args: {},
            describe: () => "Ask OpenAI which voice models the ChatGPT sign-in has",
            run: async (user) => {
                await app.checkVoice(user);

                return voiceModels(app.config.voiceCheck);
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

    actions.push(
        {
            id: "machines.installTools",
            area: "machines",
            title: "Install tools on a machine",
            help: "Machine tools (officecli, rg, fd, chrome), each checked by its SHA-256 before it is kept; only those the machine has no own copy of are offered.",
            owner: true,
            args: { machine: "The machine's name or id", tools: "Tool ids, comma-separated (officecli, rg, fd, chrome)" },
            describe: (args) => `Install ${args.tools ?? ""} on ${args.machine ?? ""}`,
            run: async (_user, args) => {
                const found = machine(args.machine);
                const done = await app.machineTools.install(
                    found.id,
                    (args.tools ?? "").split(",").map((each) => each.trim()).filter(Boolean),
                );

                return done.results.map((result) => `${result.id}: ${result.ok ? `${result.version} installed` : `not installed: ${result.said}`}`).join("\n");
            },
        },
        {
            id: "machines.remove",
            area: "machines",
            title: "Remove a machine",
            help: "Forget a machine: its sessions stay, but can no longer run there.",
            owner: true,
            args: { machine: "The machine's name or id" },
            describe: (args) => `Remove the machine ${args.machine ?? ""}`,
            run: async (_user, args) => {
                const found = machine(args.machine);

                await app.machines.remove(found.id);

                return `Removed ${found.name}.`;
            },
        },
        {
            id: "machines.openPort",
            area: "machines",
            title: "Open a machine's port on this phone",
            help: "A dev server there (localhost:5173), at http://127.0.0.1:<port> here, through ssh.",
            owner: true,
            args: { machine: "The machine's name or id", port: "The port on the machine" },
            describe: (args) => `Open port ${args.port ?? ""} of ${args.machine ?? ""} on this phone`,
            run: async (_user, args) => {
                const forward = await app.forwards.open(machine(args.machine).id, Number(args.port));

                return `Port ${forward.remotePort} of ${forward.machine} is at ${forward.url}.`;
            },
        },
        {
            id: "machines.closePort",
            area: "machines",
            title: "Close an opened port",
            help: "Stop forwarding a machine's port here.",
            owner: true,
            args: { machine: "The machine's name or id", port: "The port on the machine" },
            describe: (args) => `Close port ${args.port ?? ""} of ${args.machine ?? ""}`,
            run: async (_user, args) => {
                const id = machine(args.machine).id;
                const open = app.forwards.list().find((each) => each.machineId === id && each.remotePort === Number(args.port));

                if (open === undefined) {
                    throw new HttpError(404, `Port ${args.port ?? ""} of ${args.machine ?? ""} is not open.`);
                }

                app.forwards.close(open.id);

                return `Closed port ${args.port}.`;
            },
        },
        {
            id: "sshKeys.make",
            area: "machines",
            title: "Make an SSH key",
            help: "A new ed25519 key for machines; its private half stays in the app.",
            owner: true,
            args: { name: "Its name" },
            describe: (args) => `Make an SSH key named ${args.name ?? ""}`,
            run: async (_user, args) => {
                const key = await app.sshKeys.generate(args.name);

                return `Made ${key.name} (${key.id}): ${key.publicKey}`;
            },
        },
        {
            id: "sshKeys.delete",
            area: "machines",
            title: "Delete an SSH key",
            help: "For good; refused while a machine uses it.",
            owner: true,
            args: { id: "The key's id" },
            describe: (args) => `Delete the SSH key ${args.id ?? ""}, for good`,
            run: async (_user, args) => {
                const using = app.machines.usingKey(args.id ?? "");

                if (using.length > 0) {
                    throw new HttpError(409, `This key is used by ${using.map((each) => each.name).join(", ")}. Give those machines another key first.`);
                }

                await app.sshKeys.remove(args.id ?? "");

                return `Deleted the key ${args.id}.`;
            },
        },
        {
            id: "folders.star",
            area: "folders",
            title: "Star or unstar a favorite folder",
            help: "Favorites show first in the folder picker.",
            owner: false,
            args: { path: "The folder (a phone path, or machine:<id>:<path>)", starred: "on or off" },
            describe: (args) => `${onOff(args.starred ?? "") ? "Star" : "Unstar"} the folder ${args.path ?? ""}`,
            run: async (user, args) => {
                await app.folderFavorites.set(user, { path: args.path, starred: onOff(args.starred ?? "") });

                return `${onOff(args.starred ?? "") ? "Starred" : "Unstarred"} ${args.path}.`;
            },
        },
        {
            id: "people.remove",
            area: "people",
            title: "Remove an invited person",
            help: "Their sign-ins and devices go; their sessions stay.",
            owner: true,
            args: { person: "Their name" },
            describe: (args) => `Remove ${args.person ?? ""} and sign out their devices`,
            run: async (user, args) => {
                const found = person(args.person);

                app.removeUser(user, found.id);

                return `Removed ${found.name}.`;
            },
        },
        {
            id: "secrets.delete",
            area: "secrets",
            title: "Delete a secret",
            help: "For good: commands that name it get nothing.",
            owner: true,
            args: { name: "The secret's name" },
            describe: (args) => `Delete the secret ${args.name ?? ""}, for good`,
            run: async (_user, args) => {
                if (!app.secrets.remove(secret(args.name).name)) {
                    throw new HttpError(404, "No such secret");
                }

                return `Deleted ${args.name}.`;
            },
        },
        {
            id: "limits.retryNow",
            area: "limits",
            title: "Retry a waiting request now",
            help: "A session waiting for a provider's limit (it or its subagents) sends its request now rather than at its time: once each 30 seconds.",
            owner: true,
            args: { session: "The session's number" },
            describe: (args) => `Send session ${args.session ?? ""}'s waiting request now`,
            run: async (user, args) => ((await app.commands.retryLimit(session(args.session), user)) ? `Session ${args.session} tried again.` : `Session ${args.session} is in no wait, or tried less than 30 seconds ago.`),
        },
        {
            id: "limits.answer",
            area: "limits",
            title: "Answer a limit's account card",
            help: "A session whose request waits for one account's limit, with other accounts of the provider listed on its card (the person's own first, then team accounts): choice wait (keep waiting) or move (send the request through the account you name, checked again now, and use it from now on; a subagent's move moves its session too). conversation: the waiting subagent's number, when it is a subagent's.",
            owner: true,
            args: { session: "The session's number", choice: "wait or move", account: "For move: the chosen account's provider id, one the card lists", conversation: "Optional: the waiting subagent's conversation number" },
            describe: (args) => (args.choice === "move" ? `Move session ${args.session ?? ""}'s waiting request to ${args.account ?? ""}` : `Keep session ${args.session ?? ""} waiting for its limit`),
            run: async (user, args) => {
                await app.commands.answerLimit(session(args.session), user, {
                    choice: args.choice,
                    ...(args.account === undefined ? {} : { to: args.account }),
                    ...(args.conversation === undefined || args.conversation === "" ? {} : { conversationId: Number(args.conversation) }),
                });

                return args.choice === "move" ? `Moved to ${args.account}.` : "It keeps waiting.";
            },
        },
        {
            id: "providers.removeAccount",
            area: "providers",
            title: "Remove a provider account",
            help: "One of a subscription's extra accounts (provider~name), with its sign-in.",
            owner: true,
            args: { account: "The account's id, provider~name" },
            describe: (args) => `Remove the account ${args.account ?? ""} and its sign-in`,
            run: async (_user, args) => {
                await app.accounts.remove(args.account ?? "");
                app.providers.modelsChanged();

                return `Removed ${args.account}.`;
            },
        },
        {
            id: "providers.signOut",
            area: "providers",
            title: "Sign out of a provider",
            help: "Its models go until someone signs in again (only a person can).",
            owner: true,
            args: { provider: "The provider's id" },
            describe: (args) => `Sign out of ${args.provider ?? ""}`,
            run: async (_user, args) => {
                await app.providers.logout(args.provider ?? "");

                return `Signed out of ${args.provider}.`;
            },
        },
        {
            id: "github.signOut",
            area: "github",
            title: "Sign gh and git out of GitHub",
            help: "The app's GitHub sign-in (only a person can sign in again).",
            owner: true,
            args: {},
            describe: () => "Sign the app's gh and git out of GitHub",
            run: async () => {
                await app.github.logout();

                return "Signed out of GitHub.";
            },
        },
        {
            id: "backup.make",
            area: "backup",
            title: "Make a backup",
            help: "The app's data, sign-ins, and keys in one file: keep it safe. Restoring stays the person's (Settings › Phone).",
            owner: true,
            args: { folder: "Where to put it, a folder on this phone" },
            describe: (args) => `Make a backup (with your sign-ins and keys) into ${args.folder ?? ""}`,
            run: async (_user, args) => {
                const made = await makeBackup(app.home, app.dataDir, tmpdir());

                try {
                    const into = join(args.folder ?? "", made.name);

                    copyFileSync(made.file, into);

                    return `Saved the backup as ${into}.`;
                } finally {
                    rmSync(made.file, { force: true });
                }
            },
        },
        {
            id: "server.restart",
            area: "backup",
            title: "Restart the server",
            help: "The app starts it again in a few seconds; runs in progress go on after it.",
            owner: true,
            args: {},
            describe: () => "Restart pi-phone's server (a few seconds)",
            run: async () => {
                if (app.restart === undefined || !app.supervised) {
                    throw new HttpError(409, "Restarting needs the pi-phone app, which starts the server again.");
                }

                // After the answer is on its way.
                setTimeout(() => app.restart?.(), 2000);

                return "Restarting in two seconds.";
            },
        },
    );

    // What a target may name, for the settings list: ids and names as setting_change takes them.
    const targets: Record<TargetKind, () => Promise<string[]> | string[]> = {
        session: () => ["a session's number (#993 is 993)"],
        person: () => app.config.users.filter((user) => user.role !== "owner").map((user) => user.name),
        secret: () => app.secrets.list().map((each) => each.name),
        machine: () => app.machines.list().map((each) => each.name),
        "ssh-key": async () => (await app.sshKeys.list()).map((key) => `${key.id} (${key.name})`),
        device: () => app.webPush.list().map((each) => each.name),
    };

    return { settings, actions, targets };
}
