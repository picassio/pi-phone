/**
 * What extensions add to the commands Pi runs, and hide from what comes back (pi-pocket 0.22.0's extension points,
 * experimental; ported from its `src/server/hidden.ts`, commits 46d7353 and 8fe0121 with the review fixes cdef41e and
 * c5d649f):
 *
 * - `HiddenValues`: values an extension hides from what Pi and people read (`host.hide`). Each shows as `[label]`. They
 *   go through the same redaction as the owner's secrets (`secrets.ts`): command output as it streams
 *   (`Secrets.guard`), every tool's result (the secrets extension's `afterTool` hook), and people's messages to Pi
 *   (`Commands.submit`, `resend`). A `!` command that holds one is refused (`shell.ts`).
 * - `CommandEnvs`: environment variables an extension gives one command, by what it runs and where (`host.commandEnv`).
 *   A secrets extension puts a key into `$NAME` for the commands that name it, so the value never goes through Pi. They
 *   reach every command a session runs through its environment (`withCommandEnvs`): bash, `!` commands, goal checks.
 *
 * This keeps values out of transcripts by accident and by default: it is no boundary against a command that transforms
 * a value on purpose.
 */
import type { Context } from "@earendil-works/chord";
import type { ConversationId } from "@earendil-works/pi-durable";
import type { ExecutionEnv, ShellExecOptions, ShellOutputInfo } from "@earendil-works/pi-durable/env";

/** The shortest value an extension hides: shorter ones would turn up by chance in ordinary output. */
export const MIN_HIDDEN = 4;
/** The longest. */
export const MAX_HIDDEN = 4096;
/** The most values hidden at once, across the app. */
export const MAX_HIDDEN_VALUES = 2000;
const LABEL = /^[A-Za-z0-9 _.:-]{1,60}$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

/** How long a `host.commandEnv` provider may take for one command. Tests shorten it. */
export const commandEnvLimits = { providerMs: 5000 };
/** The most bytes of variables extensions add to one command. */
const MAX_ENV_BYTES = 256 * 1024;

export interface HiddenValue {
    /** The text to hide. */
    value: string;
    /** What shows in its place, as `[label]`, such as `secret GITHUB_TOKEN`. */
    label: string;
    /** Only in this session; absent: in every session. */
    conversationId?: number;
}

/** A text that output must not show, and what shows instead. */
export type Replacement = { text: string; replacement: string };

type Hidden = { value: string; replacement: string; conversationId?: number };

export class HiddenValues {
    readonly #values = new Set<Hidden>();
    /** The session a conversation belongs to: a subagent's values are its session's. */
    readonly #rootOf: (conversationId: number) => number;

    constructor(rootOf: (conversationId: number) => number = (id) => id) {
        this.#rootOf = rootOf;
    }

    /** Hide a value until the returned function is called. A value out of bounds throws. */
    add(hidden: HiddenValue): () => void {
        const { value, label, conversationId } = hidden ?? ({} as HiddenValue);

        if (typeof value !== "string" || value.length < MIN_HIDDEN || value.length > MAX_HIDDEN) {
            throw new Error(`host.hide: a value is ${MIN_HIDDEN} to ${MAX_HIDDEN} characters of text`);
        }

        if (typeof label !== "string" || !LABEL.test(label)) {
            throw new Error("host.hide: a label is 1 to 60 letters, digits, spaces, and _ . : -");
        }

        if (conversationId !== undefined && (!Number.isSafeInteger(conversationId) || conversationId < 1)) {
            throw new Error("host.hide: conversationId is a session's id");
        }

        if (this.#values.size >= MAX_HIDDEN_VALUES) {
            throw new Error(`host.hide: ${MAX_HIDDEN_VALUES} values are hidden already`);
        }

        const entry: Hidden = {
            value,
            replacement: `[${label}]`,
            ...(conversationId === undefined ? {} : { conversationId }),
        };

        this.#values.add(entry);

        return () => {
            this.#values.delete(entry);
        };
    }

    /** The values hidden in a session, as replacements. */
    for(conversationId: ConversationId | number): Replacement[] {
        const id = Number(conversationId);
        const root = this.#rootOf(id);

        return [...this.#values]
            .filter((each) => each.conversationId === undefined || each.conversationId === id || each.conversationId === root)
            .map((each) => ({ text: each.value, replacement: each.replacement }));
    }

    /** `text` with each value hidden in the session replaced. */
    replace(text: string, conversationId: ConversationId | number): string {
        return replaceAll(text, longestFirst(this.for(conversationId)));
    }
}

/** Replacements longest first, so a value inside a longer one does not split it. */
export function longestFirst(replacements: readonly Replacement[]): Replacement[] {
    return [...replacements].sort((a, b) => b.text.length - a.text.length);
}

/** `text` with each replacement made, in the order given (longest first: `longestFirst`). */
export function replaceAll(text: string, replacements: readonly Replacement[]): string {
    let out = text;

    for (const each of replacements) {
        if (out.includes(each.text)) {
            out = out.split(each.text).join(each.replacement);
        }
    }

    return out;
}

/**
 * An output callback that replaces values as they stream. It holds back the end of each stream that could still be the
 * start of a value (`hold` characters: the longest value's length less one), and `flush` sends it once the command ends.
 */
export function redactStream(
    replace: (text: string) => string,
    hold: number,
    onOutput: NonNullable<ShellExecOptions["onOutput"]>,
): { onOutput: NonNullable<ShellExecOptions["onOutput"]>; flush: () => void } {
    const pending = new Map<string, { text: string; context: Context; info: ShellOutputInfo }>();

    const emit = (text: string, context: Context, info: ShellOutputInfo) => {
        if (text !== "" || info.skipped !== undefined) {
            onOutput(text, context, info);
        }
    };

    const flushOne = (stream: string) => {
        const held = pending.get(stream);

        pending.delete(stream);

        if (held !== undefined && held.text !== "") {
            emit(replace(held.text), held.context, { stream: held.info.stream });
        }
    };

    return {
        onOutput: (text, context, info) => {
            // Output keeps its order: what the other stream holds back goes out before this chunk. A value one stream
            // writes in two pieces, with the other stream's output between them, is then not joined.
            flushOne(info.stream === "stdout" ? "stderr" : "stdout");

            // What came before an omission is not joined to what comes after it.
            if (info.skipped !== undefined) {
                flushOne(info.stream);
            }

            const before = pending.get(info.stream)?.text ?? "";
            const joined = replace(before + text);
            const cut = Math.max(0, joined.length - hold);

            pending.set(info.stream, { text: joined.slice(cut), context, info });
            emit(joined.slice(0, cut), context, info);
        },
        flush: () => {
            flushOne("stdout");
            flushOne("stderr");
        },
    };
}

/** What a command-environment provider gets: the command, where it runs, and for which session. */
export interface CommandRun {
    readonly conversationId: number;
    /** The command as the shell gets it, or the program and its arguments. */
    readonly command: string | readonly string[];
    readonly cwd: string;
}

export type CommandEnvProvider = (
    run: CommandRun,
) => Record<string, string> | undefined | Promise<Record<string, string> | undefined>;

export class CommandEnvs {
    readonly #providers = new Set<CommandEnvProvider>();
    readonly #log: (line: string) => void;
    readonly #wrapped = new WeakMap<ExecutionEnv, ExecutionEnv>();

    constructor(log: (line: string) => void) {
        this.#log = log;
    }

    get any(): boolean {
        return this.#providers.size > 0;
    }

    /** Add a provider until the returned function is called. */
    add(provider: CommandEnvProvider): () => void {
        if (typeof provider !== "function") {
            throw new Error("host.commandEnv: give it a function");
        }

        this.#providers.add(provider);

        return () => {
            this.#providers.delete(provider);
        };
    }

    /**
     * The variables every provider gives a command, later ones over earlier ones. A provider that throws, takes too
     * long, or gives something that is not a set of variables, adds nothing, and the log says why: the command runs as
     * it would.
     */
    async for(run: CommandRun, signal?: AbortSignal): Promise<Record<string, string>> {
        const env: Record<string, string> = {};
        let bytes = 0;

        for (const provider of [...this.#providers]) {
            let given: unknown;
            let timer: NodeJS.Timeout | undefined;
            let stopped: (() => void) | undefined;

            try {
                signal?.throwIfAborted();
                // A provider has a few seconds, and stops with the command: one that hangs must not hold every command.
                given = await Promise.race([
                    Promise.resolve().then(() => provider(Object.freeze({ ...run }))),
                    new Promise<never>((_, reject) => {
                        timer = setTimeout(
                            () => reject(new Error(`took more than ${commandEnvLimits.providerMs} ms`)),
                            commandEnvLimits.providerMs,
                        );
                        stopped = () => reject(new Error("the command was stopped"));
                        signal?.addEventListener("abort", stopped, { once: true });
                    }),
                ]);
            } catch (error) {
                // The command was stopped: it runs no more, and the environment says so as it always does.
                if (signal?.aborted) {
                    return env;
                }

                this.#log(`host.commandEnv: a provider failed: ${error instanceof Error ? error.message : String(error)}`);
                continue;
            } finally {
                clearTimeout(timer);

                if (stopped !== undefined) {
                    signal?.removeEventListener("abort", stopped);
                }
            }

            if (given === undefined || given === null) {
                continue;
            }

            if (typeof given !== "object" || Array.isArray(given)) {
                this.#log("host.commandEnv: a provider gave something that is not variables");
                continue;
            }

            for (const [name, value] of Object.entries(given)) {
                if (!ENV_NAME.test(name) || typeof value !== "string" || value.includes("\0")) {
                    this.#log(`host.commandEnv: skipped a variable that is not NAME=text: ${name.slice(0, 64)}`);
                    continue;
                }

                bytes += name.length + value.length;

                if (bytes > MAX_ENV_BYTES) {
                    this.#log("host.commandEnv: the variables for one command are too large");

                    return env;
                }

                env[name] = value;
            }
        }

        return env;
    }

    /**
     * A session's environment whose commands get what providers add (`base` is one per session: `Secrets.guard`'s).
     * What the caller sets itself (bash's PATH, the owner's secrets a command names) stays as the caller set it.
     */
    wrap(base: ExecutionEnv, conversationId: number, cwd: string): ExecutionEnv {
        const known = this.#wrapped.get(base);

        if (known !== undefined) {
            return known;
        }

        const exec: ExecutionEnv["exec"] = async (command, options, context) => {
            if (!this.any) {
                return base.exec(command, options, context);
            }

            const added = await this.for({ conversationId, command, cwd: options?.cwd ?? cwd }, context.abortSignal);

            return base.exec(
                command,
                Object.keys(added).length === 0 ? options : { ...options, env: { ...added, ...options?.env } },
                context,
            );
        };
        const wrapped = new Proxy(base, {
            get(target, property) {
                if (property === "exec") {
                    return exec;
                }

                // Methods run on the environment itself: its private fields are not the proxy's.
                const value: unknown = Reflect.get(target, property, target);

                return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
            },
        });

        this.#wrapped.set(base, wrapped);

        return wrapped;
    }
}
