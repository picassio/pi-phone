/**
 * The owner's secrets for Pi (`secrets.ts`): which it may use here, said in its prompt; `secrets_list`; asking a person
 * for one (`secret_request`, a hidden field on the call's card, never the chat); saving a command's output as one
 * (`secret_save`). The hooks keep values out: a `bash` command that names a secret it may not use here is refused, one
 * that uses an ask-first secret waits for a person, and every tool's result has values replaced by `[secret NAME]`.
 * The values themselves reach commands as environment variables, set by the app's `bash` (`app.ts`).
 */
import { Type } from "@earendil-works/pi-ai";
import {
    defineExtension,
    defineTool,
    hook,
    section,
    type ToolExecutionResult,
    ToolTask,
} from "@earendil-works/pi-durable";
import type { JsonValue } from "@earendil-works/chord";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { PocketHost } from "../host.ts";
import { namesIn, SECRET_NAME } from "../secrets.ts";

const reply = (text: string, isError = false) => ({
    output: [{ type: "text" as const, text }],
    ...(isError ? { isError: true } : {}),
});

const RULES = `Secrets: the person keeps API keys and tokens in Settings > Secrets, and you use them without seeing them.
- In bash, use a secret as an environment variable by its name: curl -H "Authorization: Bearer $DEEPSEEK_API_KEY" ..., NODE_AUTH_TOKEN=$NPM_TOKEN npm publish, printf '%s' "$NPM_TOKEN" | gh secret set NPM_TOKEN. Only the secrets a command names are set for it.
- Never print, echo, or log a value, and never write one into a file you read back or into the wiki. Output that holds a value shows [secret NAME] instead.
- When you need a secret that is not listed, call secret_request with a name and what it is for: the person types it into a hidden field on the call's card. Never ask anyone to paste a key, token, or password into the chat.
- To keep a value a command makes (a generated key, gh auth token), use secret_save: it stores the command's output without showing it.`;

/** Every string in a result's JSON, with values replaced. */
function redactJson(value: JsonValue, redact: (text: string) => string): JsonValue {
    if (typeof value === "string") {
        return redact(value);
    }

    if (Array.isArray(value)) {
        return value.map((item) => redactJson(item, redact));
    }

    if (value !== null && typeof value === "object") {
        return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactJson(item as JsonValue, redact)]));
    }

    return value;
}

export default function createSecrets(host: PocketHost) {
    const { secrets } = host;
    // The app's own stores of keys: its ssh folder (keys, its agent's socket), the database (private SSH keys), and the
    // secrets' file. Pi's tools stay out of them; uploads, in the same data folder, stay Pi's to read.
    const stores = [join(host.dataDir, "ssh"), join(host.dataDir, "pocket.sqlite"), join(host.dataDir, "secrets.json")];
    const spelled = stores.flatMap((path) => [path, ...(path.startsWith(`${homedir()}/`) ? [`~${path.slice(homedir().length)}`] : [])]);
    const STORES = "The app keeps its keys (SSH keys, its ssh-agent, the secrets) out of Pi's tools: use machine_run, machine_copy, or a session on a machine for machines, and secrets by name in bash.";

    /** Why a call may not run, if it reaches the app's key stores: a path tool on one, or a command that names one. */
    const keyStores = (tool: string, args: Record<string, unknown>): string | undefined => {
        if ((tool === "read" || tool === "write" || tool === "edit") && typeof args.path === "string") {
            const path = resolve(args.path.replace(/^~(?=\/|$)/, homedir()));

            return stores.some((store) => path === store || path.startsWith(`${store}/`) || path.startsWith(`${store}-`)) ? STORES : undefined;
        }

        if (tool === "bash" && typeof args.command === "string") {
            const command = args.command;

            return spelled.some((store) => command.includes(store)) || /\bSSH_AUTH_SOCK\b|\bssh-add\b/.test(command) ? STORES : undefined;
        }

        return undefined;
    };
    const cwdOf = async (api: { agent?: (context: never) => Promise<{ cwd?: string }> }, context: unknown) =>
        (await api.agent?.(context as never))?.cwd ?? "";

    const list = defineTool({
        name: "secrets_list",
        description:
            "The secrets you may use in this session's folder: name, what it is for, and whether a call using it waits for a person. Never their values.",
        parameters: Type.Object({}),
        replay: "safe",
        execute: async (_args, api, context) => {
            const usable = secrets.usableIn(await cwdOf(api, context));

            return reply(
                usable.length === 0
                    ? "No secrets here. Ask for one with secret_request."
                    : usable
                          .map(
                              (secret) =>
                                  `$${secret.name}${secret.description === "" ? "" : ` — ${secret.description}`}${secret.ask ? " (a person allows each use)" : ""}`,
                          )
                          .join("\n"),
            );
        },
    });

    const request = defineTool({
        name: "secret_request",
        description:
            "Ask the person for a secret (an API key, token, or password). They type it into a hidden field on this call's card; it is stored in Settings > Secrets and never enters the chat. Then use it in bash as $NAME.",
        parameters: Type.Object({
            name: Type.String({ description: "An environment variable's name: capitals, digits, _ (DEEPSEEK_API_KEY)" }),
            description: Type.String({ description: "What it is for and where to get it, shown to the person" }),
        }),
        // Waiting for a person: after a restart it asks again.
        replay: "safe",
        execute: async (args, api, context) => {
            if (!SECRET_NAME.test(args.name)) {
                return reply(`${args.name} is not a secret's name: use capitals, digits, and _, such as DEEPSEEK_API_KEY.`, true);
            }

            const before = secrets.get(args.name)?.updatedAt;
            const answer = await host.approvals.request(
                {
                    id: `secret-${String(api.taskId)}-${api.callId}`,
                    conversationId: api.conversationId,
                    taskId: api.taskId,
                    callId: api.callId,
                    tool: "secret_request",
                    subject: args.name,
                    reason: args.description,
                    form: { type: "secret", name: args.name, description: args.description },
                    createdAt: Date.now(),
                },
                context,
            );

            if (!answer.allow) {
                return reply(`${answer.by === "superseded" ? "The request was replaced" : `${answer.by} declined`}: there is no ${args.name}.`, true);
            }

            const after = secrets.get(args.name);

            if (after === undefined || after.updatedAt === before) {
                return reply(`${args.name} was not saved.`, true);
            }

            const cwd = await cwdOf(api, context);

            return reply(
                secrets.allowed(args.name, cwd)
                    ? `Saved ${args.name}. Use it in bash as $${args.name}.`
                    : `Saved ${args.name}, but it may not be used in this folder (Settings > Secrets).`,
            );
        },
    });

    const save = defineTool({
        name: "secret_save",
        description:
            "Run a command and store its output as a secret, without showing the output to anyone: for a key a command makes or prints (gh auth token, openssl rand -hex 32).",
        parameters: Type.Object({
            name: Type.String({ description: "An environment variable's name: capitals, digits, _" }),
            command: Type.String({ description: "The command whose standard output is the value" }),
            description: Type.String({ description: "What it is for" }),
        }),
        execute: async (args, api, context) => {
            if (!SECRET_NAME.test(args.name)) {
                return reply(`${args.name} is not a secret's name: use capitals, digits, and _.`, true);
            }

            const cwd = await cwdOf(api, context);
            let stdout = "";
            let stderr = "";
            const result = await host.envOf(cwd).exec(
                args.command,
                {
                    timeout: 120,
                    onOutput: (text, _context, info) => {
                        if (info.stream === "stdout") {
                            stdout += text;
                        } else {
                            stderr += text;
                        }
                    },
                },
                context,
            );

            if (!result.ok) {
                return reply(`The command did not run: ${result.error.message}`, true);
            }

            const value = stdout.trim();
            const hide = (text: string) => secrets.redact(value === "" ? text : text.split(value).join(`[secret ${args.name}]`));

            if (result.value.exitCode !== 0) {
                return reply(`The command failed (exit ${result.value.exitCode}); nothing was saved.\n${hide(stderr).slice(-2000)}`, true);
            }

            try {
                secrets.set(args.name, { value, description: args.description });
            } catch (error) {
                return reply(hide(error instanceof Error ? error.message : String(error)), true);
            }

            return reply(`Saved ${args.name} (${value.length} characters). Use it in bash as $${args.name}.`);
        },
    });

    return defineExtension({
        name: "pocket-secrets",
        tools: [list, request, save],
        sections: [
            section("secrets", async (input) => {
                const usable = secrets.usableIn(input.agent.cwd ?? "");
                const names =
                    usable.length === 0
                        ? "None are set for this folder yet."
                        : `Here you may use: ${usable.map((secret) => `$${secret.name}${secret.description === "" ? "" : ` (${secret.description})`}${secret.ask ? " [a person allows each use]" : ""}`).join("; ")}.`;

                return `${RULES}\n${names}`;
            }),
        ],
        hooks: [
            hook(ToolTask, {
                // A command naming a secret: refused where it may not be used, held for a person where it asks first.
                beforeTool: async (call, api, context) => {
                    const guarded = keyStores(call.name, call.arguments as Record<string, unknown>);

                    if (guarded !== undefined) {
                        return { block: guarded };
                    }

                    // machine_run runs a command as bash does, on a machine: the same rules for the secrets it names.
                    if (call.name !== "bash" && call.name !== "machine_run") {
                        return undefined;
                    }

                    const command = (call.arguments as { command?: unknown }).command;

                    if (typeof command !== "string") {
                        return undefined;
                    }

                    const named = namesIn(command).filter((name) => secrets.get(name) !== undefined);

                    if (named.length === 0) {
                        return undefined;
                    }

                    const cwd = await cwdOf(api as never, context);
                    const refused = named.filter((name) => !secrets.allowed(name, cwd));

                    if (refused.length > 0) {
                        return {
                            block: `${refused.map((name) => `$${name}`).join(", ")} may not be used in this folder: the person allows it in Settings > Secrets.`,
                        };
                    }

                    const asking = named.filter((name) => secrets.get(name)?.ask === true);

                    if (asking.length > 0) {
                        const answer = await host.approvals.request(
                            {
                                id: `secret-use-${String(api.taskId)}-${call.id}`,
                                conversationId: api.conversationId,
                                taskId: api.taskId,
                                callId: call.id,
                                tool: "bash",
                                subject: command,
                                reason: `Uses ${asking.map((name) => `$${name}`).join(", ")}`,
                                createdAt: Date.now(),
                            },
                            context,
                        );

                        if (!answer.allow) {
                            return { block: `${answer.by} did not allow this use of ${asking.map((name) => `$${name}`).join(", ")}.` };
                        }
                    }

                    return undefined;
                },
                // Every result, with secrets' values replaced before it is stored and reaches the model.
                afterTool: (_call, result): ToolExecutionResult | undefined => {
                    if (secrets.longest() === 0) {
                        return undefined;
                    }

                    const redact = (text: string) => secrets.redact(text);

                    return {
                        ...result,
                        ...(result.output === undefined
                            ? {}
                            : {
                                  output: result.output.map((part) =>
                                      part.type === "text" ? { ...part, text: redact(part.text) } : part,
                                  ),
                              }),
                        ...(result.details === undefined ? {} : { details: redactJson(result.details, redact) }),
                        ...(result.structuredOutput === undefined
                            ? {}
                            : { structuredOutput: redactJson(result.structuredOutput, redact) }),
                    };
                },
            }),
        ],
    });
}
