/**
 * Pi changes the app's settings with tools, never with code (PP-7; the owner's requests of 2026-10-20): `settings` lists
 * them with their values (it only reads), `setting_change` sets one, and `app_action` takes a one-off action, each of
 * the last two after the person approves the app's usual card. Everything goes through the same app methods as the
 * screens (`settings-registry.ts`), as the person Pi works for: a guest is refused owner settings before anyone is asked.
 */
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, section } from "@earendil-works/pi-durable";
import type { PocketHost } from "../host.ts";
import type { AppAction, Setting } from "../settings-registry.ts";

const reply = (text: string, isError = false) => ({ output: [{ type: "text" as const, text }], ...(isError ? { isError: true } : {}) });
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** In every prompt while the module is on. */
export const SETTINGS_RULE =
    "The app's settings: list them with settings, change one with setting_change, and take one-off actions (reload an extension, refresh models, …) with app_action; each change asks the person on a card. Never change the app with code: no curl or fetch to its API, no edits to its data files or database, no scripts in its WebView.";

export default function createSettings(host: PocketHost) {
    /** The person Pi works for here, or why it cannot act. */
    const personOf = (conversationId: unknown) => {
        const id = host.requesterOf(Number(conversationId) as never);

        if (id === undefined) {
            throw new Error("No one Pi works for here is signed in to pi-phone.");
        }

        return host.person(id);
    };
    const mayChange = (entry: Setting | AppAction, role: string) => {
        if (entry.owner && role !== "owner") {
            throw new Error(`${entry.title}: only the owner changes this.`);
        }
    };
    const ask = (api: { conversationId: unknown; taskId: unknown; callId?: string }, context: unknown, tool: string, subject: string, reason: string) =>
        host.approvals.request(
            {
                id: `${tool}-${String(api.conversationId)}-${String(api.callId)}`,
                conversationId: Number(api.conversationId) as never,
                taskId: api.taskId as never,
                ...(api.callId === undefined ? {} : { callId: api.callId }),
                tool,
                subject,
                reason,
                createdAt: Date.now(),
            },
            context as never,
        );
    const line = async (setting: Setting) => {
        let value: string;

        try {
            value = setting.target === undefined ? await setting.read(undefined) : `(per ${setting.target}: give a target)`;
        } catch (error) {
            value = `(could not read: ${message(error)})`;
        }

        const choices = setting.choices === undefined ? "" : ` [${(await setting.choices()).join(" | ")}]`;

        return `- ${setting.id}: ${value}${choices}\n  ${setting.title}. ${setting.help}${setting.owner ? " Owner only." : ""}`;
    };

    const tools = [
        defineTool({
            name: "settings",
            description:
                "The app's settings Pi may change, with each one's value now and the values it takes, and the one-off actions it may take. Give an area (models, browser, web, wiki, spend, themes, extensions, …) to list only that; give an id and a target for one setting of one session or person.",
            parameters: Type.Object({
                area: Type.Optional(Type.String({ description: "Only this area" })),
                id: Type.Optional(Type.String({ description: "One setting, like spend.sessionLimit" })),
                target: Type.Optional(Type.String({ description: "For a setting of one session (its number) or person (their name)" })),
            }),
            replay: "safe",
            execute: async (args) => {
                try {
                    const { settings, actions, targets } = host.appSettings();

                    if (args.id !== undefined) {
                        const setting = settings.find((each) => each.id === args.id);

                        if (setting === undefined) {
                            throw new Error(`There is no setting ${args.id}: list them with settings.`);
                        }

                        return reply(`${setting.id}${args.target === undefined ? "" : ` (${args.target})`}: ${await setting.read(args.target)}\n${setting.title}. ${setting.help}`);
                    }

                    const shown = settings.filter((each) => args.area === undefined || each.area === args.area);
                    const doing = actions.filter((each) => args.area === undefined || each.area === args.area);
                    const areas = [...new Set([...settings, ...actions].map((each) => each.area))];

                    if (shown.length === 0 && doing.length === 0) {
                        throw new Error(`There is no area ${args.area}. Areas: ${areas.join(", ")}.`);
                    }

                    const lines = await Promise.all(shown.map(line));
                    const kinds = [...new Set(shown.map((each) => each.target).filter((kind) => kind !== undefined))];
                    const targetLines = await Promise.all(kinds.map(async (kind) => `- ${kind}: ${(await targets[kind]()).join(", ") || "none yet"}`));

                    return reply(
                        [
                            `Settings${args.area === undefined ? "" : ` in ${args.area}`} (change one with setting_change):`,
                            ...lines,
                            ...(targetLines.length === 0 ? [] : ["", "Targets:", ...targetLines]),
                            ...(doing.length === 0
                                ? []
                                : [
                                      "",
                                      "Actions (app_action):",
                                      ...doing.map(
                                          (action) =>
                                              `- ${action.id}: ${action.title}. ${action.help}${Object.keys(action.args).length === 0 ? "" : ` Args: ${Object.entries(action.args).map(([name, what]) => `${name} (${what})`).join("; ")}.`}`,
                                      ),
                                  ]),
                            "",
                            "Also with their own tools: devices, secrets, schedules, project boards, board settings, machines (machine_run, machine_copy), Pi sessions.",
                            ...(args.area === undefined ? [`Areas: ${areas.join(", ")}.`] : []),
                        ].join("\n"),
                    );
                } catch (error) {
                    return reply(message(error), true);
                }
            },
        }),
        defineTool({
            name: "setting_change",
            description:
                "Change one of the app's settings (ids from settings), after the person approves a card that shows the value now and the new one. Values are text: \"none\" clears one that may be empty. A setting of one session or person needs its target.",
            parameters: Type.Object({
                id: Type.String({ description: "The setting, like models.default" }),
                value: Type.String({ description: "The new value, as settings describes it" }),
                target: Type.Optional(Type.String({ description: "For a setting of one session (its number) or person (their name)" })),
                reason: Type.String({ description: "Why, in a sentence: shown on the card" }),
            }),
            execute: async (args, api, context) => {
                try {
                    const person = personOf(api.conversationId);
                    const setting = host.appSettings().settings.find((each) => each.id === args.id);

                    if (setting === undefined) {
                        throw new Error(`There is no setting ${args.id}: list them with settings.`);
                    }

                    mayChange(setting, person.role);

                    if (setting.target !== undefined && (args.target === undefined || args.target.trim() === "")) {
                        throw new Error(`${setting.id} is a setting of one ${setting.target}: give its ${setting.target === "session" ? "number" : "name"} as the target.`);
                    }

                    const before = await setting.read(args.target);
                    const answer = await ask(
                        api,
                        context,
                        "setting_change",
                        `Change ${setting.title}${args.target === undefined ? "" : ` (${setting.target} ${args.target})`}: ${before} → ${args.value}`,
                        args.reason,
                    );

                    if (!answer.allow) {
                        return reply(`${answer.by} said no: ${setting.id} stays ${before}.`, true);
                    }

                    await setting.apply(person, args.value, args.target);

                    return reply(`Changed ${setting.id}${args.target === undefined ? "" : ` (${args.target})`}: ${before} → ${await setting.read(args.target)}.`);
                } catch (error) {
                    return reply(message(error), true);
                }
            },
        }),
        defineTool({
            name: "app_action",
            description: "Take one of the app's one-off actions (ids from settings, under Actions), after the person approves a card.",
            parameters: Type.Object({
                id: Type.String({ description: "The action, like extensions.reload" }),
                args: Type.Optional(Type.Record(Type.String(), Type.String(), { description: "Its arguments, by name, as settings lists them" })),
                reason: Type.String({ description: "Why, in a sentence: shown on the card" }),
            }),
            execute: async (args, api, context) => {
                try {
                    const person = personOf(api.conversationId);
                    const action = host.appSettings().actions.find((each) => each.id === args.id);

                    if (action === undefined) {
                        throw new Error(`There is no action ${args.id}: list them with settings.`);
                    }

                    mayChange(action, person.role);

                    const given = args.args ?? {};
                    const missing = Object.keys(action.args).filter((name) => (given[name] ?? "").trim() === "");

                    if (missing.length > 0) {
                        throw new Error(`${action.id} needs ${missing.join(", ")}.`);
                    }

                    const answer = await ask(api, context, "app_action", action.describe(given), args.reason);

                    if (!answer.allow) {
                        return reply(`${answer.by} said no: nothing was done.`, true);
                    }

                    return reply(await action.run(person, given));
                } catch (error) {
                    return reply(message(error), true);
                }
            },
        }),
    ];

    return defineExtension({ name: "pocket-settings", tools, sections: [section("app-settings", () => SETTINGS_RULE)] });
}
