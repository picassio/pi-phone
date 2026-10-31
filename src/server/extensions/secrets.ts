/**
 * The owner's secrets for Pi (`secrets.ts`): which it may use here, said in its prompt; `secrets_list`; asking a person
 * for one (`secret_request`, a hidden field on the call's card, never the chat); saving a command's output as one
 * (`secret_save`). The hooks keep values out: a `bash` command that names a secret it may not use here is refused, one
 * that uses an ask-first secret waits for a person, and every tool's result has values replaced by `[secret NAME]`, and
 * the values extensions hide in its session (`host.hide`, `hidden.ts`) by their `[label]`.
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
import { mayUseMachines, NOT_FOR_TEAMMATES } from "./sharing.ts";

const reply = (text: string, isError = false) => ({
    output: [{ type: "text" as const, text }],
    ...(isError ? { isError: true } : {}),
});

/** The longest command secret_save asks about: the card shows it whole. */
export const MAX_SAVE_COMMAND = 1500;

const RULES = `Secrets: the person keeps API keys and tokens in Settings > Secrets, and you use them without seeing them.
- In bash, use a secret as an environment variable by its name: curl -H "Authorization: Bearer $DEEPSEEK_API_KEY" ..., NODE_AUTH_TOKEN=$NPM_TOKEN npm publish, printf '%s' "$NPM_TOKEN" | gh secret set NPM_TOKEN. Only the secrets a command names are set for it.
- Never print, echo, or log a value, and never write one into a file you read back or into the wiki. Output that holds a value shows [secret NAME] instead.
- When you need a secret that is not listed, call secret_request with a name and what it is for: the person types it into a hidden field on the call's card. Never ask anyone to paste a key, token, or password into the chat.
- To keep a value a command makes (a generated key, gh auth token), use secret_save: the owner sees the whole command on a card first, and it stores the command's output without showing it.`;

/** With secrets as a tool (PP-276): how Pi finds the secrets it may use, instead of a list in the prompt. */
const FIND_THEM =
    "Which secrets you may use here: secrets_list (their names, what each is for, and whether a person allows each use; query finds them by words, such as azure devops). Look before you ask the person for one with secret_request.";

/** Every string in a result's JSON, object keys too (pi-pocket 0.22.0's `host.hide` does keys), with values replaced. */
function redactJson(value: JsonValue, redact: (text: string) => string): JsonValue {
    if (typeof value === "string") {
        return redact(value);
    }

    if (Array.isArray(value)) {
        return value.map((item) => redactJson(item, redact));
    }

    if (value !== null && typeof value === "object") {
        return Object.fromEntries(Object.entries(value).map(([key, item]) => [redact(key), redactJson(item as JsonValue, redact)]));
    }

    return value;
}

/**
 * The secrets a browser call (PP-32) or a computer call (`computer_act`'s set_value and type_text, PP-178) types by
 * name, and a line saying so for an approval card; undefined for any other call, or one that names none.
 */
export function browserSecretNames(tool: string, args: Record<string, unknown>): { names: string[]; subject: string } | undefined {
    if (tool === "browser_type" && typeof args.secret === "string") {
        return { names: [args.secret], subject: `Type [secret ${args.secret}] into [${String(args.index)}]` };
    }

    if (tool === "computer_act" && typeof args.secret === "string") {
        const where = args.action === "set_value" ? `[${String(args.index)}]` : "the field in focus";

        return { names: [args.secret], subject: `Fill [secret ${args.secret}] into ${where}${typeof args.app === "string" ? ` of ${args.app}` : ""} on the computer` };
    }

    if (tool === "browser_run" && typeof args.values === "object" && args.values !== null) {
        const names = Object.values(args.values as Record<string, unknown>).flatMap((value) =>
            typeof value === "object" && value !== null && typeof (value as { secret?: unknown }).secret === "string" ? [(value as { secret: string }).secret] : [],
        );

        return names.length === 0 ? undefined : { names, subject: `Browser run "${String(args.goal ?? "").slice(0, 80)}" types ${names.map((name) => `[secret ${name}]`).join(", ")}` };
    }

    return undefined;
}

/** A tool's result with secrets' values replaced on every channel: what the model reads, programs get, and UIs show. */
export function redactToolResult(result: ToolExecutionResult, redact: (text: string) => string): ToolExecutionResult {
    return {
        ...result,
        ...(result.output === undefined
            ? {}
            : { output: result.output.map((part) => (part.type === "text" ? { ...part, text: redact(part.text) } : part)) }),
        ...(result.details === undefined ? {} : { details: redactJson(result.details, redact) }),
        ...(result.structuredOutput === undefined ? {} : { structuredOutput: redactJson(result.structuredOutput, redact) }),
        // Diagnostics end the result the model reads, so they are redacted too (PP-92).
        ...(result.diagnostics === undefined
            ? {}
            : { diagnostics: result.diagnostics.map((diagnostic) => ({ ...diagnostic, message: redact(diagnostic.message) })) }),
    };
}

/** A phone path in `machine_copy` (`/…` or `~/…`); `<machine>:<path>` is on a machine, out of the app's stores. */
const onPhone = (spec: string) => !(spec.indexOf(":") > 0 && !spec.startsWith("/") && !spec.startsWith("~"));

/**
 * The files a call reads (`read`) and writes (`write`), by the tool's own path arguments: `read`, `write` and `edit`,
 * and every other tool that takes a file on the phone (an upload to a page, a copy to a machine, a document's image, a
 * wiki source, a picture saved). Without them, a misled Pi sent the secrets' file to a page with `browser_upload`, or
 * copied the database (private SSH keys) to a machine, where `read` is refused (PP-204).
 */
export function pathsOf(tool: string, args: Record<string, unknown>): { read: string[]; write: string[] } {
    const one = (value: unknown) => (typeof value === "string" && value.trim() !== "" ? [value] : []);

    switch (tool) {
        case "read":
            return { read: one(args.path), write: [] };
        case "write":
        case "edit":
            return { read: one(args.path), write: one(args.path) };
        case "browser_upload":
            return { read: Array.isArray(args.paths) ? args.paths.flatMap(one) : [], write: [] };
        // Its images to edit go to the image model's provider (PP-275); what it makes goes in `images/` of the session.
        case "image_generate":
            return { read: Array.isArray(args.images) ? args.images.flatMap(one) : [], write: [] };
        case "file_to_markdown":
            // It saves the Markdown beside it, too.
            return { read: one(args.path), write: one(args.path).map((path) => `${path}.md`) };
        case "doc_image":
        case "image_markup":
            return { read: one(args.path), write: one(args.out) };
        case "wiki_ingest":
            return { read: one(args.source).filter((source) => !/^https?:\/\//i.test(source) && args.sourceType !== "text"), write: [] };
        case "interview":
            return { read: one(args.questions).filter((source) => !source.trim().startsWith("{") && !source.trim().startsWith("`")), write: [] };
        case "machine_copy":
            return { read: one(args.from).filter(onPhone), write: one(args.to).filter(onPhone) };
        case "browser_save_pdf":
        case "browser_screenshot":
        case "phone_screenshot":
        case "computer_screenshot":
            return { read: [], write: one(args.path) };
        case "screenshot":
            return { read: one(args.path), write: one(args.save) };
        default:
            return { read: [], write: [] };
    }
}

/**
 * Why a call may not run, if it reaches the app's key stores (its ssh folder, the database with the private SSH keys, the
 * secrets' file) or writes into the drop-in extensions' folder: a path tool on one, or a command that names one.
 * `cwd`: the session's folder, for relative paths.
 */
export function keyStoreRefusal(tool: string, args: Record<string, unknown>, where: { dataDir: string; home: string; cwd: string }): string | undefined {
    const stores = [join(where.dataDir, "ssh"), join(where.dataDir, "pocket.sqlite"), join(where.dataDir, "secrets.json")];
    const spell = (path: string) => [path, ...(path.startsWith(`${where.home}/`) ? [`~${path.slice(where.home.length)}`] : [])];
    const STORES = "The app keeps its keys (SSH keys, its ssh-agent, the secrets) out of Pi's tools: use machine_run, machine_copy, or a session on a machine for machines, and secrets by name in bash.";
    // The owner's drop-in extensions (PP-171): code that runs in the server with the app's host, secrets included, and
    // loads again when its file changes. Only the owner puts files there; Pi's tools do not write or name it.
    const dropIns = join(where.dataDir, "extensions");
    const DROP_INS = `Drop-in extensions (${dropIns}) are the owner's to put in place: Pi's tools do not write there. Write the module elsewhere and install it with extension_install (the owner approves it on a card); it lands off, and Settings > Extensions turns it on.`;

    if (tool === "bash" && typeof args.command === "string") {
        const command = args.command;

        if (spell(dropIns).some((folder) => command.includes(folder))) {
            return DROP_INS;
        }

        return stores.flatMap(spell).some((store) => command.includes(store)) || /\bSSH_AUTH_SOCK\b|\bssh-add\b/.test(command) ? STORES : undefined;
    }

    const { read, write } = pathsOf(tool, args);
    const base = where.cwd.startsWith("/") ? where.cwd : process.cwd();
    const absolute = (path: string) => resolve(base, path.replace(/^~(?=\/|$)/, where.home));

    if (write.map(absolute).some((path) => path === dropIns || path.startsWith(`${dropIns}/`))) {
        return DROP_INS;
    }

    return [...read, ...write].map(absolute).some((path) => stores.some((store) => path === store || path.startsWith(`${store}/`) || path.startsWith(`${store}-`))) ? STORES : undefined;
}

export default function createSecrets(host: PocketHost) {
    const { secrets } = host;
    /** Why a call may not run, if it reaches the app's key stores (`keyStoreRefusal`). */
    const keyStores = (tool: string, args: Record<string, unknown>, cwd: string): string | undefined => keyStoreRefusal(tool, args, { dataDir: host.dataDir, home: homedir(), cwd });
    const cwdOf = async (api: { agent?: (context: never) => Promise<{ cwd?: string }> }, context: unknown) =>
        (await api.agent?.(context as never))?.cwd ?? "";

    const list = defineTool({
        name: "secrets_list",
        description:
            "The secrets you may use in this session's folder: name, what it is for, and whether a call using it waits for a person. Never their values. query: only those whose name or description has all these words.",
        parameters: Type.Object({
            query: Type.Optional(Type.String({ description: "Words to find in a secret's name or description, such as azure devops" })),
        }),
        replay: "safe",
        execute: async (args, api, context) => {
            const all = secrets.usableIn(await cwdOf(api, context));
            const words = (args.query ?? "").toLowerCase().split(/[\s,]+/).filter((word) => word !== "");
            const usable = all.filter((secret) => words.every((word) => `${secret.name} ${secret.description}`.toLowerCase().includes(word)));

            return reply(
                usable.length === 0
                    ? all.length === 0
                        ? "No secrets here. Ask for one with secret_request."
                        : `None of the ${all.length} secrets here match "${args.query}". Try other words, or none to list them all; ask for a new one with secret_request.`
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

            // It runs a command Pi chose and keeps its output: the owner's, and only after they read the whole command on
            // a card (pi-pocket's review of our port, TannerMidd/pi-pocket-extensions#28; pi-phone has no other guard).
            const asker = host.requesterOf(api.conversationId as never);

            if (asker === undefined || host.person(asker).role !== "owner") {
                return reply("secret_save is the owner's: it runs a command and keeps its output as a secret. Ask the owner, or use secret_request.", true);
            }

            if (args.command.length > MAX_SAVE_COMMAND) {
                return reply(
                    `The command is ${args.command.length} characters; the card that asks the owner shows at most ${MAX_SAVE_COMMAND.toLocaleString("en")}. Use a shorter one (a script it runs, say). Nothing ran.`,
                    true,
                );
            }

            const answer = await host.approvals.request(
                {
                    id: `secret-save-${String(api.taskId)}-${api.callId}`,
                    conversationId: api.conversationId,
                    taskId: api.taskId,
                    callId: api.callId,
                    tool: "secret_save",
                    subject: args.command,
                    reason: `Run this and save its output as $${args.name}: ${args.description}`,
                    createdAt: Date.now(),
                },
                context,
            );

            if (!answer.allow) {
                return reply(`${answer.by === "superseded" ? "The request was replaced" : `${answer.by} declined`}: nothing ran, and nothing was saved.`, true);
            }

            const cwd = await cwdOf(api, context);
            let stdout = "";
            const result = await host.envOf(cwd).exec(
                args.command,
                {
                    timeout: 120,
                    // Only standard output, the value: what the command says on stderr is never shown, nor kept.
                    onOutput: (text, _context, info) => {
                        if (info.stream === "stdout") {
                            stdout += text;
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

            // None of a failed command's output: what it printed may be the value itself, on stderr or half-written to
            // stdout, where hiding the (unknown) value cannot find it (pi-pocket's review of our port, 2026-10-26).
            if (result.value.exitCode !== 0) {
                return reply(`The command failed (exit ${result.value.exitCode}); nothing was saved. Its output is not shown, since it may hold the value.`, true);
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
                // With secrets as a tool (PP-276), the section does not change as secrets come and go: the list is
                // secrets_list's, and a new secret is said by the call that asked for it.
                if (host.contextPolicy(input.conversationId).secrets === "tool") {
                    return `${RULES}\n${FIND_THEM}`;
                }

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
                    const args = call.arguments as Record<string, unknown>;
                    const paths = pathsOf(call.name, args);
                    // The session's folder only for a call with paths: relative ones are from there.
                    const guarded =
                        call.name === "bash" || paths.read.length + paths.write.length > 0 ? keyStores(call.name, args, paths.read.length + paths.write.length > 0 ? await cwdOf(api as never, context) : "") : undefined;

                    if (guarded !== undefined) {
                        return { block: guarded };
                    }

                    // machine_run runs a command as bash does, on a machine: the same rules for the secrets it names. Pi's browser
                    // types a secret by name (browser_type's secret, browser_run's { secret } values; PP-32), and so does Pi's
                    // computer (computer_act's secret): the same rules too.
                    const browserSecrets = browserSecretNames(call.name, call.arguments as Record<string, unknown>);

                    if (call.name !== "bash" && call.name !== "machine_run" && browserSecrets === undefined) {
                        return undefined;
                    }

                    const command = browserSecrets === undefined ? (call.arguments as { command?: unknown }).command : browserSecrets.subject;

                    if (typeof command !== "string") {
                        return undefined;
                    }

                    const named = (browserSecrets?.names ?? namesIn(command)).filter((name) => secrets.get(name) !== undefined);

                    if (named.length === 0) {
                        return undefined;
                    }

                    // A teammate's message in a shared session (PP-57): the owner's secrets only where the share allows.
                    if (!mayUseMachines(host, Number(api.conversationId))) {
                        return { block: NOT_FOR_TEAMMATES };
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
                                tool: call.name,
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
                // Every result, with secrets' values, and the values extensions hide in this session (`host.hide`),
                // replaced before it is stored and reaches the model.
                afterTool: (_call, result, api): ToolExecutionResult | undefined =>
                    secrets.longest(api.conversationId) === 0
                        ? undefined
                        : redactToolResult(result, (text) => secrets.redact(text, api.conversationId)),
            }),
        ],
    });
}
