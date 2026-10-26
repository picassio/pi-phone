/**
 * Secrets: API keys and tokens that Pi uses without seeing them. The owner keeps them in Menu → Secrets; a bash command
 * that names one ($NPM_TOKEN) runs with its value, and output that shows a value shows [secret NPM_TOKEN] instead. Pi can
 * list them, ask the owner for one on a card with a hidden field, and keep a command's output as one.
 *
 * It keeps values out of transcripts, prompts, and other people's screens by accident and by default. It is not a
 * boundary against a model or a command that sets out to leak a value: a value that a command changes (reversed, cut
 * up, encrypted) is not found. Values stay in Pi Pocket's data folder, in secrets/secrets.json (mode 0600).
 */
import { spawn } from "node:child_process";
import { Type } from "@earendil-works/pi-ai";
import {
    AgentDoc,
    defineExtension,
    defineTool,
    hook,
    section,
    ToolTask,
} from "@earendil-works/pi-durable";
// Types only: Node removes this import when the module runs. In the drop-in folder, Pi Pocket writes `_pocket.d.ts`.
import type { CommandRun, Host, Web, WebRequest } from "./_pocket.d.ts";
import {
    formsOf,
    MAX_LENGTH,
    MIN_LENGTH,
    namesIn,
    SECRET_NAME,
    type SecretInfo,
    Store,
} from "./secrets/store.ts";

export const pocketApi = 2;

/** How long an allowed command may take to start, after the hook let it through, before its values are not given. */
const ALLOWED_FOR = 60_000;
/** The longest command `secret_save` runs: all of it fits on the owner's card (2,000 characters with the words). */
const MAX_COMMAND = 1500;
/** How long `secret_save`'s command may run. */
const SAVE_TIMEOUT = 30_000;

const reply = (text: string, isError = false) => ({
    output: [{ type: "text" as const, text }],
    ...(isError ? { isError: true } : {}),
});

const RULES = `Secrets: the owner keeps API keys and tokens in Menu → Secrets, and you use them without seeing them.
- In bash, use a secret as an environment variable by its name: curl -H "Authorization: Bearer $DEEPSEEK_API_KEY" ..., NODE_AUTH_TOKEN=$NPM_TOKEN npm publish, printf '%s' "$NPM_TOKEN" | gh secret set NPM_TOKEN. Only the secrets that a command names are set for it, and only in your bash commands.
- Never print, echo, or log a value, and never write one into a file that you read back. Output that holds a value shows [secret NAME] instead.
- When you need a secret that is not listed, call secret_request with a name and what it is for: the owner types it into a hidden field on the call's card. Never ask anyone to paste a key, token, or password into the chat.
- To keep a value that a command makes (a generated key, gh auth token), use secret_save: it keeps the command's output without showing it.`;

const listed = (secret: SecretInfo) =>
    `$${secret.name}${secret.description === "" ? "" : ` (${secret.description})`}${secret.ask ? " [a person allows each use]" : ""}${secret.guests ? "" : " [only when you work for the owner]"}`;

/** One line, cut to `max`. */
const line = (text: string, max: number) => {
    const flat = text.replace(/\s+/g, " ").trim();

    return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

/** `$A`, `$A and $B`, `$A, $B and $C`. */
const names = (list: readonly string[]) => {
    const each = list.map((name) => `$${name}`);

    return each.length < 2 ? (each[0] ?? "") : `${each.slice(0, -1).join(", ")} and ${each.at(-1)}`;
};

type Allowed = { command: string; names: string[]; until: number };

export default function createSecrets(host: Host, web: Web) {
    // The points of 0.22.0. On an older server, or before a restart after an update, there is nothing to offer.
    if (
        typeof host.hide !== "function" ||
        typeof host.commandEnv !== "function" ||
        typeof host.ask !== "function"
    ) {
        return undefined;
    }

    const store = new Store(host.dataDir);

    if (store.problem !== undefined) {
        host.notice("warning", store.problem);
    }

    // ─── Hiding ──────────────────────────────────────────────────────────────

    /**
     * The functions that stop hiding each secret's forms, by name. A secret is here only when every form of its value is
     * hidden: one that is not is never given to a command.
     */
    const hidden = new Map<string, (() => void)[]>();

    const unhide = (name: string) => {
        for (const stop of hidden.get(name) ?? []) {
            stop();
        }

        hidden.delete(name);
    };

    /** Hide every form of a secret's value, in every session, from now on. */
    const hide = (name: string) => {
        unhide(name);
        const value = store.value(name);

        if (value === undefined) {
            return;
        }

        const stops: (() => void)[] = [];

        try {
            for (const form of formsOf(value)) {
                stops.push(host.hide({ value: form, label: `secret ${name}` }));
            }
        } catch {
            for (const stop of stops) {
                stop();
            }

            // A fixed message: the error could quote the value.
            host.notice(
                "warning",
                `Secrets could not keep ${name} out of output, so commands do not get it. Change its value in Menu → Secrets.`,
            );

            return;
        }

        hidden.set(name, stops);
    };

    for (const secret of store.list()) {
        hide(secret.name);
    }

    web.onDispose(() => {
        for (const name of [...hidden.keys()]) {
            unhide(name);
        }
    });

    // ─── Who may use what ────────────────────────────────────────────────────

    /**
     * Whether Pi works for the owner in a session now. Nobody known (a schedule, PiP) counts as the owner, as for
     * `host.ask`. Until the owner's id is known (the owner's tab tells it), a known person is not taken for the owner.
     */
    const forOwner = (conversationId: unknown): boolean => {
        const by = host.requesterOf(conversationId as never);

        return by === undefined || (store.owner !== undefined && by === store.owner);
    };

    /** Commands that the hook let through, by session: only these get values, once, within a minute. */
    const allowed = new Map<number, Allowed[]>();

    const allow = (conversationId: number, command: string, list: string[]) => {
        const now = Date.now();
        const kept = (allowed.get(conversationId) ?? []).filter((each) => each.until > now);

        kept.push({ command, names: list, until: now + ALLOWED_FOR });
        allowed.set(conversationId, kept.slice(-20));
    };

    /** The values for a command that is about to run: only for one the hook let through. */
    const environment = (run: CommandRun): Record<string, string> | undefined => {
        const list = allowed.get(run.conversationId);

        if (list === undefined) {
            return undefined;
        }

        const text = typeof run.command === "string" ? run.command : run.command.join(" ");
        const now = Date.now();
        const index = list.findIndex((each) => each.until > now && text.includes(each.command));

        if (index < 0) {
            return undefined;
        }

        const [entry] = list.splice(index, 1);
        const env: Record<string, string> = {};

        for (const name of entry!.names) {
            const value = store.value(name);

            // Only a value whose every form is hidden.
            if (value !== undefined && hidden.has(name)) {
                env[name] = value;
            }
        }

        store.used(Object.keys(env));

        return env;
    };

    web.onDispose(host.commandEnv(environment));

    /** Why a session may not use a secret here, or undefined when it may. */
    const refusal = (name: string, cwd: string, owner: boolean): string | undefined => {
        const secret = store.get(name)!;

        if (!hidden.has(name)) {
            return `$${name} could not be kept out of output, so it is not given (the owner changes its value in Menu → Secrets)`;
        }

        if (!store.inFolder(name, cwd)) {
            return `$${name} may be used only in ${secret.folders.join(", ")}`;
        }

        if (!owner && !secret.guests) {
            return store.owner === undefined
                ? `$${name} waits until the owner opens Pi Pocket once with Secrets on`
                : `$${name} is the owner's: it is used only when you work for the owner`;
        }

        return undefined;
    };

    // Each bash command that names a secret: refuse what may not be used, ask first where the owner said so, and let
    // the rest through to `environment`.
    const guard = hook(ToolTask, {
        beforeTool: async (call, api, context) => {
            if (call.name !== "bash") {
                return undefined;
            }

            const command = (call.arguments as { command?: unknown }).command;

            if (typeof command !== "string") {
                return undefined;
            }

            const used = namesIn(command).filter((name) => store.value(name) !== undefined);

            if (used.length === 0) {
                return undefined;
            }

            const agent = await api.snapshot(AgentDoc, api.conversationId, context);
            const cwd = agent?.cwd ?? process.cwd();
            const owner = forOwner(api.conversationId);
            const refused = used
                .map((name) => refusal(name, cwd, owner))
                .filter((why) => why !== undefined);

            if (refused.length > 0) {
                return {
                    block: `Secrets: ${refused.join("; ")}. Run the command without it, or ask the owner.`,
                };
            }

            const asking = used.filter((name) => store.get(name)!.ask);

            // The owner allows exactly what the card shows.
            if (asking.length > 0 && command.length > MAX_COMMAND) {
                return {
                    block: `Secrets: ${names(asking)} asks first, and this command is longer than the ${MAX_COMMAND} characters the card shows. Keep it shorter.`,
                };
            }

            if (asking.length > 0) {
                // The answer is kept in the call's memo, so a restart after it never asks twice. It holds no value.
                let answer = await api.memo<{ allow: boolean; by: string }>("secrets.ask", context);

                if (answer === undefined) {
                    const asked = await host.ask(
                        {
                            conversationId: api.conversationId,
                            id: `secrets:${String(api.taskId)}:${call.id}`,
                            taskId: api.taskId,
                            callId: call.id,
                            title: line(`Allow ${names(asking)} in this command?`, 120),
                            text: `Pi wants to run: ${command} — the command gets the value; Pi does not see it.`,
                            submit: "Allow",
                        },
                        context,
                    );

                    answer = await api.memo(
                        "secrets.ask",
                        { allow: asked.answered, by: asked.by },
                        context,
                    );
                }

                if (!answer.allow) {
                    return {
                        block: `${answer.by} did not allow ${names(asking)} for this command.`,
                    };
                }
            }

            allow(Number(api.conversationId), command, used);

            return undefined;
        },
    });

    // ─── Tools ───────────────────────────────────────────────────────────────

    const cwdOf = async (
        api: { agent(context: never): Promise<{ cwd?: string | null }> },
        context: unknown,
    ) => (await api.agent(context as never)).cwd ?? process.cwd();

    /** The words for Pi when it does not work for the owner. */
    const ownerOnly = () =>
        store.owner === undefined
            ? "Secrets does not know the owner yet: the owner opens Pi Pocket once with Secrets on, then tries again."
            : "Only the owner keeps secrets: Pi saves one only when it works for the owner.";

    const list = Object.assign(
        defineTool({
            name: "secrets_list",
            description:
                "The secrets you may use in this session's folder: name, what it is for, and whether a call that uses it waits for a person. Never their values.",
            parameters: Type.Object({}),
            replay: "safe",
            execute: async (_args, api, context) => {
                const cwd = await cwdOf(api, context);
                const usable = store.list().filter((secret) => store.inFolder(secret.name, cwd));

                return reply(
                    usable.length === 0
                        ? "No secrets here. Ask for one with secret_request."
                        : usable.map(listed).join("\n"),
                );
            },
        }),
        { annotations: { readOnlyHint: true } },
    );

    const request = defineTool({
        name: "secret_request",
        description:
            "Ask the owner for a secret (an API key, token, or password). They type it into a hidden field on this call's card; it is kept in Menu → Secrets and never enters the chat. Then use it in bash as $NAME.",
        parameters: Type.Object({
            name: Type.String({
                description:
                    "An environment variable's name: capitals, digits, _ (DEEPSEEK_API_KEY)",
            }),
            description: Type.String({
                description: "What it is for and where to get it, shown to the owner",
            }),
        }),
        execute: async (args, api, context) => {
            if (!SECRET_NAME.test(args.name)) {
                return reply(
                    `${args.name} is not a secret's name: use capitals, digits, and _, such as DEEPSEEK_API_KEY.`,
                    true,
                );
            }

            if (!forOwner(api.conversationId)) {
                return reply(ownerOnly(), true);
            }

            const description = line(args.description, 300);
            const answer = await host.ask(
                {
                    conversationId: api.conversationId,
                    id: `secret:${String(api.taskId)}:${api.callId}`,
                    taskId: api.taskId,
                    callId: api.callId,
                    title: line(`Pi asks for a secret: ${args.name}`, 120),
                    // The card shows its text as one paragraph.
                    text: `${description}${/[.!?]$/.test(description) || description === "" ? "" : "."} Kept in Menu → Secrets, out of the chat. Pi uses it as $${args.name} without seeing it.`.trim(),
                    fields: [
                        {
                            name: "value",
                            label: args.name,
                            secret: true,
                            placeholder: "Paste or type the value",
                            autocomplete: "off",
                        },
                    ],
                    submit: "Save secret",
                },
                context,
            );

            if (!answer.answered) {
                return reply(`${answer.by} declined: there is no ${args.name}.`, true);
            }

            try {
                store.set(args.name, { value: answer.values.value, description });
            } catch (error) {
                return reply(`${args.name} was not saved: ${(error as Error).message}`, true);
            }

            hide(args.name);
            web.send("changed", {});
            const cwd = await cwdOf(api, context);

            return reply(
                store.inFolder(args.name, cwd)
                    ? `Saved ${args.name}. Use it in bash as $${args.name}.`
                    : `Saved ${args.name}, but it may not be used in this folder (Menu → Secrets).`,
            );
        },
    });

    const save = defineTool({
        name: "secret_save",
        description:
            "Run a command and keep its output as a secret, without showing the output to anyone: for a key that a command makes or prints (gh auth token, openssl rand -hex 32).",
        parameters: Type.Object({
            name: Type.String({
                description: "An environment variable's name: capitals, digits, _",
            }),
            command: Type.String({ description: "The command whose standard output is the value" }),
            description: Type.String({ description: "What it is for" }),
        }),
        execute: async (args, api, context) => {
            if (!SECRET_NAME.test(args.name)) {
                return reply(
                    `${args.name} is not a secret's name: use capitals, digits, and _.`,
                    true,
                );
            }

            // Secrets are the owner's: a guest's message does not change them.
            if (!forOwner(api.conversationId)) {
                return reply(ownerOnly(), true);
            }

            // The command runs outside Pi's bash, so outside Lancet Guard: the owner reads all of it and allows it first.
            if (args.command.length > MAX_COMMAND) {
                return reply(
                    `The command is longer than ${MAX_COMMAND} characters, more than the owner's card shows. Nothing was run: keep it shorter.`,
                    true,
                );
            }

            const asked = await host.ask(
                {
                    conversationId: api.conversationId,
                    id: `secret-save:${String(api.taskId)}:${api.callId}`,
                    taskId: api.taskId,
                    callId: api.callId,
                    title: line(`Run this and keep its output as ${args.name}?`, 120),
                    // The whole command: the card shows exactly what runs.
                    text: `${args.command} — its output is kept in Menu → Secrets, and nobody sees it.`,
                    submit: "Run and save",
                },
                context,
            );

            if (!asked.answered) {
                return reply(
                    `${asked.by} declined: nothing was run, and there is no new ${args.name}.`,
                    true,
                );
            }

            const cwd = await cwdOf(api, context);
            // The secrets that the command names, as Pi's bash would give them (the owner allowed this command).
            const env: Record<string, string> = {};

            for (const name of namesIn(args.command)) {
                const value = store.value(name);

                if (value !== undefined && hidden.has(name) && store.inFolder(name, cwd)) {
                    env[name] = value;
                }
            }

            const result = await run(
                args.command,
                cwd,
                env,
                (context as { abortSignal?: AbortSignal }).abortSignal,
            );
            const value = result.stdout.replace(/\r?\n$/, "").trim();
            /** Its words with the new value, in each form, taken out. */
            const clean = (text: string) => {
                let out = text;

                for (const form of value === "" ? [] : formsOf(value)) {
                    out = out.split(form).join(`[secret ${args.name}]`);
                }

                return out;
            };

            if (result.error !== undefined) {
                return reply(`The command did not run: ${clean(result.error)}`, true);
            }

            // Not its output: a command can print the new value to stderr, in a form nothing here knows.
            if (result.code !== 0) {
                return reply(
                    `The command failed (exit ${String(result.code)}); nothing was saved. Its output is not shown, since it may hold the value: run it in bash without the secret part to see why.`,
                    true,
                );
            }

            if (value.length < MIN_LENGTH || value.length > MAX_LENGTH) {
                return reply(
                    `The command gave ${value.length} characters: a secret has ${MIN_LENGTH} to ${MAX_LENGTH}. Nothing was saved.`,
                    true,
                );
            }

            try {
                store.set(args.name, { value, description: line(args.description, 300) });
            } catch (error) {
                return reply(clean((error as Error).message), true);
            }

            hide(args.name);
            web.send("changed", {});

            return reply(
                `Saved ${args.name} (${value.length} characters). Use it in bash as $${args.name}.`,
            );
        },
    });

    // ─── The owner's sheet ───────────────────────────────────────────────────

    /** The owner's own requests tell who the owner is, for the guest rule. Routes are the owner's alone. */
    const learn = (request: WebRequest) => {
        if (request.user.role === "owner") {
            store.learnOwner(request.user.id);
        }
    };

    web.route("POST", "hello", (request) => {
        learn(request);

        return { ok: true };
    });

    web.route("GET", "secrets", (request) => {
        learn(request);

        return { secrets: store.list() };
    });

    web.route("PUT", "secrets/:name", (request) => {
        learn(request);
        const name = request.params.name ?? "";

        try {
            store.set(name, request.body);
        } catch (error) {
            throw web.error(400, (error as Error).message);
        }

        hide(name);
        web.send("changed", {});

        return { secret: store.get(name) };
    });

    web.route("DELETE", "secrets/:name", (request) => {
        learn(request);
        const name = request.params.name ?? "";

        unhide(name);

        if (!store.remove(name)) {
            throw web.error(404, `There is no ${name}.`);
        }

        web.send("changed", {});

        return { ok: true };
    });

    web.client("secrets");

    return defineExtension({
        name: "secrets",
        tools: [list, request, save],
        hooks: [guard],
        sections: [
            section("secrets", (input) => {
                // The same for everyone in the session, so the prompt does not change with who writes.
                const cwd = (input.agent as { cwd?: string | null }).cwd ?? process.cwd();
                const usable = store.list().filter((secret) => store.inFolder(secret.name, cwd));
                const here =
                    usable.length === 0
                        ? "None are set for this folder yet."
                        : `Here you may use: ${usable.map(listed).join("; ")}.`;

                return `${RULES}\n${here}`;
            }),
        ],
    });
}

/** Run a command in bash, in `cwd`, with `env` added: its output, up to a size, within a time. */
function run(
    command: string,
    cwd: string,
    env: Record<string, string>,
    signal: AbortSignal | undefined,
): Promise<{ code: number | null; stdout: string; stderr: string; error?: string }> {
    return new Promise((done) => {
        let stdout = "";
        let stderr = "";
        let finished = false;
        const child = spawn("bash", ["-c", command], {
            cwd,
            env: { ...process.env, ...env },
            stdio: ["ignore", "pipe", "pipe"],
        });
        const stop = () => child.kill("SIGKILL");
        const timer = setTimeout(stop, SAVE_TIMEOUT);
        const finish = (result: { code: number | null; error?: string }) => {
            if (finished) {
                return;
            }

            finished = true;
            clearTimeout(timer);
            signal?.removeEventListener("abort", stop);
            done({ ...result, stdout, stderr });
        };

        signal?.addEventListener("abort", stop, { once: true });
        child.stdout.on("data", (chunk: Buffer) => {
            stdout = (stdout + chunk.toString("utf8")).slice(0, 64 * 1024);
        });
        child.stderr.on("data", (chunk: Buffer) => {
            stderr = (stderr + chunk.toString("utf8")).slice(-8 * 1024);
        });
        child.on("error", (error) => finish({ code: null, error: error.message }));
        child.on("close", (code, killed) =>
            finish(
                killed === "SIGKILL"
                    ? { code, error: `it was stopped after ${SAVE_TIMEOUT / 1000} s` }
                    : { code },
            ),
        );
    });
}
