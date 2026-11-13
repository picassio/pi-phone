/**
 * `/better` (PP-506): Nico Bailon's pi-better (MIT, `third_party/pi-better/`), built into pi-phone. A read-only helper
 * answers Felix Rieseberg's "Depth" prompt (helper.md) about a prompt, or about the task in progress, with the session's
 * code and files at hand, and ends with a rewrite between `<improved-prompt>` lines; the rewrite goes into the person's
 * message box, and nothing is sent.
 *
 * The helper is a fork of the session (Pi Durable's `forkConversation`), owned by a durable `pocket.better` task of the
 * session: the same transcript up to the newest entry whose tool calls all have results, the same agent (model, thinking
 * level, tools, instructions, folder), the same provider identity. Its first request therefore starts with the session's
 * own opening (tools, system prompt, messages), which the provider has cached, and it runs where the session works: its
 * tools are the session's, on the phone or on its machine. A tool other than read, grep, find, ls and bash is refused
 * (`helperToolBlock`, a `beforeTool` hook in pocket-core). It never adds to the session's context: the session gets no
 * entry, only `BetterDoc`, which the model never sees.
 *
 * A subagent's message that starts with `/better` (the subagent tool, `extensions/subagents.ts`) is checked the same
 * way, with brief.md, before the subagent gets it.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import {
    type ContextView,
    type ConversationId,
    defineDoc,
    defineTask,
    type EntryId,
    type EntryRecord,
    hook,
    ProviderDoc,
    type ToolExecutionApi,
    ToolTask,
} from "@earendil-works/pi-durable";
import { APP_ROOT } from "./config.ts";
import { rebased } from "./docs.ts";
import { whyUnanswered } from "./subagent-runs.ts";

const FOLDER = join(APP_ROOT, "third_party", "pi-better");

/** helper.md and brief.md, as pi-better wrote them, read once. */
let prompts: { helper: string; brief: string } | undefined;

function bundled(): { helper: string; brief: string } {
    prompts ??= {
        helper: readFileSync(join(FOLDER, "helper.md"), "utf8"),
        brief: readFileSync(join(FOLDER, "brief.md"), "utf8"),
    };

    return prompts;
}

/** How long a helper may work before it is stopped (pi-better's limit). */
export const HELPER_TIMEOUT_MS = 20 * 60 * 1000;
/** The tools a helper may run: it reads, searches and runs read-only commands. helper.md keeps bash from writing. */
export const HELPER_TOOLS: readonly string[] = ["read", "grep", "find", "ls", "bash"];

const OPEN = "<improved-prompt>";
const CLOSE = "</improved-prompt>";
/** The opening tag counts only on a line of its own: the prompt itself may name the tag inline. */
const OPEN_LINE = `\n${OPEN}\n`;

/** A subagent's message marked for a check: `/better` and the brief. */
export const BRIEF_MARK = /^\/better(?=\s|$)/;

const returnSection = (last: number, what: string) => `## Return

Give answers (1) to (${last}) in your reply, each starting a new line with its number, like "(1)". Then end it with the ${what}, complete, between these two lines and nothing after them:

${OPEN}
the ${what}
${CLOSE}`;

/** The helper's task for a prompt (or, with none, the task in progress): helper.md, the prompt, how to end. */
export function buildHelperTask(prompt: string, helper = bundled().helper): string {
    return [
        helper.trim(),
        `## Prompt to deepen\n\n${prompt || "None given: deepen the task in progress in the conversation so far, including any feedback I gave on work already done."}`,
        returnSection(4, "rewritten prompt"),
    ].join("\n\n");
}

/** The helper's task for a subagent's brief: brief.md, the brief, how to end. */
export function buildBriefTask(brief: string, check = bundled().brief): string {
    return [check.trim(), `## Brief to check\n\n${brief}`, returnSection(3, "brief")].join("\n\n");
}

/** Why a helper's run gave no prompt, for the person in their language (`web/better.js`) and for Pi's subagent tool. */
export type BetterFailure = "cancelled" | "timeout" | "model" | "no-reply" | "no-block" | "empty-block";

export class BetterError extends Error {
    readonly code: BetterFailure;

    constructor(code: BetterFailure, message: string) {
        super(message);
        this.code = code;
    }
}

/** The prompt in the reply's last `<improved-prompt>` block, whose opening tag is on a line of its own. */
export function parseMarkedPrompt(reply: string): string {
    const end = reply.lastIndexOf(CLOSE);
    const before = `\n${reply.slice(0, Math.max(end, 0))}`;
    const start = before.lastIndexOf(OPEN_LINE);

    if (end < 0 || start < 0) {
        throw new BetterError("no-block", `The reply has no ${OPEN} … ${CLOSE} block.`);
    }

    const prompt = before.slice(start + OPEN_LINE.length).trim();

    if (prompt === "") {
        throw new BetterError("empty-block", `The reply's ${OPEN} block is empty.`);
    }

    return prompt;
}

/** How far the reply is: the highest of the answers (1) to (4) it started, and whether the marked prompt began. */
export function replyProgress(text: string): { answered: number; writing: boolean } {
    let answered = 0;

    for (const [, n] of text.matchAll(/^\W*\(([1-4])\)/gm)) {
        answered = Math.max(answered, Number(n));
    }

    return { answered, writing: `\n${text}`.includes(OPEN_LINE) };
}

/** Why a helper may not run `tool`, naming the tools it has of those it may run; undefined when it may. */
export function helperToolBlock(tool: string, has: readonly string[]): string | undefined {
    if (HELPER_TOOLS.includes(tool)) {
        return undefined;
    }

    const usable = HELPER_TOOLS.filter((each) => has.includes(each)).join(", ");

    return `/better's helper only reads and rewrites, so ${tool} is off.${usable === "" ? "" : ` Use ${usable}.`}`;
}

/**
 * Where the helper's copy ends: the newest entry after which every tool call has its result. A session at work may
 * have an answer whose calls still run; a copy that ended there would hold calls without results.
 */
export function closedCutoff(view: Pick<ContextView, "entries" | "contributions">): EntryId | undefined {
    const open = new Set<string>();
    let cutoff: EntryId | undefined;

    view.entries.forEach((entry, index) => {
        for (const message of view.contributions[index] ?? []) {
            if (message.role === "assistant") {
                for (const part of message.content) {
                    if (part.type === "toolCall") {
                        open.add(part.id);
                    }
                }
            } else if (message.role === "toolResult") {
                open.delete(message.toolCallId);
            }
        }

        if (open.size === 0) {
            cutoff = entry.id;
        }
    });

    return cutoff;
}

/** An answer's text, without its thinking and tool calls. */
export function textOf(message: Message | undefined): string {
    if (message?.role !== "assistant") {
        return "";
    }

    return message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
}

/** The last answer with text among a helper's own messages. */
export function lastReply(messages: readonly Message[]): string {
    for (let index = messages.length - 1; index >= 0; index--) {
        const text = textOf(messages[index]).trim();

        if (text !== "") {
            return text;
        }
    }

    return "";
}

/** What the session shows of `/better`: the run under way, and the last result, for the person who asked. */
export type BetterRun = { task: number; by: string; prompt: string; startedAt: number; helper?: number };
type ResultBody = { helper?: number } & ({ ok: true; improved: string } | { ok: false; error: BetterFailure; detail?: string });
export type BetterResult = { id: number; by: string; at: number; prompt: string } & ResultBody;

/** In the session: its `/better` run and last result. Never the model's to see; a fork starts without either. */
export const BetterDoc = defineDoc<{ run?: BetterRun; last?: BetterResult }>({
    kind: "pocket.better",
    version: 1,
    ...rebased,
    scope: "conversation",
    history: "latest",
    fork: "initial",
    initial: () => ({}),
});

/** In a helper: the session it reads for, and where its copy of the session ends. Its tools are held to reading. */
export const BetterHelperDoc = defineDoc<{ parent?: number; at?: number }>({
    kind: "pocket.better-helper",
    version: 1,
    ...rebased,
    scope: "conversation",
    history: "latest",
    fork: "initial",
    initial: () => ({}),
});

/** `prompt`: the person's `/better` (`by`); `brief`: the subagent tool's check of a brief, which waits for the result. */
export type BetterInput = { kind: "prompt"; by: string; prompt: string } | { kind: "brief"; brief: string };
type BetterState = { phase: "fork" } | { phase: "ask"; helper: ConversationId; startedAt: number };
export type BetterOutcome = { helper: number } & ({ ok: true; improved: string; reply: string } | { ok: false; error: BetterFailure; detail: string });

/** The person's run ends: its result replaces the run, by the task's id. */
function settle(doc: { run?: BetterRun; last?: BetterResult }, task: number, by: string, prompt: string, result: ResultBody, at: number) {
    if (doc.run?.task === task) {
        delete doc.run;
    }

    doc.last = { id: task, by, at, prompt, ...result };
}

/**
 * One helper's run, durable: `fork` makes the helper (a fork of the session up to `closedCutoff`, or, before its first
 * message, a new conversation that starts as a copy of its agent), and `ask` sends it the task and waits for the
 * answer, 20 minutes at most. Stopped (`abortTask`), the helper's run stops with it: the helper is the task's own.
 */
export const BetterTask = defineTask<BetterInput, BetterState, BetterOutcome>({
    name: "pocket.better",
    version: 1,
    initial: () => ({ phase: "fork" }),
    phases: {
        fork: async (task, runtime, context) => {
            const parent = runtime.conversationId;
            const at = closedCutoff(await runtime.context(parent, context));

            await runtime.commit(async (tx) => {
                const provider = (await tx.doc(ProviderDoc, parent)).sessionId;
                const ownership = { kind: "task", taskId: runtime.taskId } as const;
                const helper = at === undefined ? await tx.createConversation({ ownership }) : await tx.forkConversation(parent, at, { ownership });

                // The provider's cache routing (OpenAI's prompt_cache_key, Anthropic's metadata) is the session's too.
                (await tx.doc(ProviderDoc, helper.id)).sessionId = provider;
                Object.assign(await tx.doc(BetterHelperDoc, helper.id), { parent: Number(parent), ...(at === undefined ? {} : { at: Number(at) }) });

                if (task.input.kind === "prompt") {
                    const doc = await tx.doc(BetterDoc, parent);

                    if (doc.run?.task === Number(runtime.taskId)) {
                        doc.run.helper = Number(helper.id);
                    }
                }

                return { status: "running", checkpoint: { phase: "ask", helper: helper.id, startedAt: runtime.now() } };
            }, context);
        },
        ask: async (task, runtime, context) => {
            const { helper, startedAt } = task.state.checkpoint as Extract<BetterState, { phase: "ask" }>;
            const handle = await runtime.conversation(helper, context);

            if (handle === undefined) {
                throw new Error(`The /better helper ${String(helper)} is gone.`);
            }

            const input = task.input;
            const content = input.kind === "prompt" ? buildHelperTask(input.prompt) : buildBriefTask(input.brief);
            // The same request after a restart finds the same submission.
            const submission = await handle.submit({ type: "input", content, requestId: `better:${String(runtime.taskId)}` }, context);
            let timedOut = false;
            const timer = setTimeout(
                () => {
                    timedOut = true;
                    handle.abort(context).catch(() => {
                        // The task's own abort reaches it too.
                    });
                },
                Math.max(0, startedAt + HELPER_TIMEOUT_MS - runtime.now()),
            );
            let settled: Awaited<ReturnType<typeof submission.wait>>;

            try {
                settled = await submission.wait(context);
            } finally {
                clearTimeout(timer);
            }

            let outcome: BetterOutcome;

            if (settled.status !== "done") {
                const failed = timedOut ? new BetterError("timeout", `The helper timed out after ${HELPER_TIMEOUT_MS / 60_000} minutes.`) : new BetterError("model", whyUnanswered(settled.reason ?? "unanswered", settled.detail));

                outcome = { helper: Number(helper), ok: false, error: failed.code, detail: failed.message };
            } else {
                // Its own entries only: the copy of the session before them is the session's.
                const own = (await runtime.context(helper, context)).entries.filter((entry) => entry.conversationId === helper);
                const reply = lastReply(own.flatMap((entry) => entry.model ?? []));

                try {
                    if (reply === "") {
                        throw new BetterError("no-reply", "The helper finished without replying.");
                    }

                    outcome = { helper: Number(helper), ok: true, improved: parseMarkedPrompt(reply), reply };
                } catch (error) {
                    const failed = error instanceof BetterError ? error : new BetterError("no-reply", String(error));

                    outcome = { helper: Number(helper), ok: false, error: failed.code, detail: failed.message };
                }
            }

            await runtime.commit(async (tx) => {
                if (input.kind === "prompt") {
                    settle(
                        await tx.doc(BetterDoc, runtime.conversationId),
                        Number(runtime.taskId),
                        input.by,
                        input.prompt,
                        outcome.ok ? { helper: outcome.helper, ok: true, improved: outcome.improved } : { helper: outcome.helper, ok: false, error: outcome.error, detail: outcome.detail },
                        runtime.now(),
                    );
                }

                return { status: "terminal", outcome: { status: "completed", result: outcome } };
            }, context);
        },
    },
    // Stop, or the subagent call that waits for it stopped: the helper's run, its own, stops first.
    abort: (task, runtime, context) =>
        runtime.commit(async (tx) => {
            const input = task.input;

            if (input.kind === "prompt") {
                const doc = await tx.doc(BetterDoc, runtime.conversationId);
                const helper = doc.run?.task === Number(task.id) ? doc.run.helper : undefined;

                settle(doc, Number(task.id), input.by, input.prompt, { ...(helper === undefined ? {} : { helper }), ok: false, error: "cancelled" }, runtime.now());
            }

            return { status: "terminal", outcome: { status: "aborted" } };
        }, context),
});

/** Background work of the session: its Stop and idle waits do not reach it, and it works while Pi does. */
export const BETTER_TASK_OPTIONS = { ownership: { kind: "conversation" }, background: true } as const;

/** pocket-core's hook: in a helper, a tool other than those it may run is refused, saying which it has. */
export const helperToolHook = hook(ToolTask, {
    beforeTool: async (call, api, context) => {
        if ((await api.snapshot(BetterHelperDoc, api.conversationId, context))?.parent === undefined) {
            return undefined;
        }

        // As plan mode reads it (`extensions/plan.ts`): the tool task's own runtime has the agent.
        const runtime = api as typeof api & Partial<Pick<ToolExecutionApi, "agent">>;
        const agent = await runtime.agent?.(context);
        const has = [...(agent?.tools ?? []), ...(agent?.callable ?? [])].map((tool) => tool.name);
        const block = helperToolBlock(call.name, has);

        return block === undefined ? undefined : { block };
    },
});

/** A tool call as the progress rows show it: a path short, a command's first part. */
export function toolLabel(name: string, args: unknown, cwd: string, home: string): string {
    const given = (args ?? {}) as { command?: unknown; path?: unknown; pattern?: unknown };
    const short = (path: string) =>
        path === cwd ? "." : path.startsWith(`${cwd}/`) ? path.slice(cwd.length + 1) : path === home || path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
    let label = name;

    if (name === "bash" && typeof given.command === "string") {
        const parts = (given.command.match(/(?:'[^']*'|"[^"]*"|(?<!&)&(?!&)|[^'"|;&\n])+/g) ?? []).map((part) => part.trim().replace(/^(\w+=\S*\s+)+/, ""));

        label = (parts.find((part) => part !== "" && !/^(cd\s|\w+=\S*$)/.test(part)) ?? "").replace(/(?<![\w.~$>:/])\/(?!dev\/)[\w.@+-]+(?:\/[\w.@+-]*)*/g, short);
    } else {
        const path = typeof given.path === "string" ? short(given.path) : ".";
        const target = path === "." ? given.pattern : path;

        if (typeof target === "string") {
            label = `${name} ${target}`;
        }
    }

    // One row: a new line or tab in a command would make the row taller.
    return label.replace(/[\s\x00-\x1f\x7f]+/g, " ").trim().slice(0, 120) || name;
}

export type BetterTool = { label: string; state: "running" | "ok" | "failed" };
/** What the progress rows show: the step (0 reading, 1 to 4 the answers, 5 writing), the tools, newest last. */
export type BetterProgress = { stage: number; tools: BetterTool[]; count: number; failed: number };

/** How many of a helper's newest tools the rows get: a phone's row shows two or three, a wide one more. */
const SHOWN_TOOLS = 8;

/**
 * The progress of a helper from its own entries (those after its copy of the session) and the answer it is writing.
 * `running`: the calls of the round under way that have not finished.
 */
export function helperProgress(entries: readonly EntryRecord[], partial: AssistantMessage | undefined, cwd: string, home: string): BetterProgress {
    const tools: (BetterTool & { id: string })[] = [];
    let answered = 0;
    let writing = false;
    const read = (message: Message) => {
        if (message.role === "assistant") {
            const progress = replyProgress(textOf(message));

            answered = Math.max(answered, progress.answered);
            writing ||= progress.writing;

            for (const part of message.content) {
                if (part.type === "toolCall" && !tools.some((tool) => tool.id === part.id)) {
                    tools.push({ id: part.id, label: toolLabel(part.name, part.arguments, cwd, home), state: "running" });
                }
            }
        } else if (message.role === "toolResult") {
            const tool = tools.find((each) => each.id === message.toolCallId);

            if (tool !== undefined) {
                tool.state = message.isError ? "failed" : "ok";
            }
        }
    };

    for (const entry of entries) {
        for (const message of entry.model ?? []) {
            read(message);
        }
    }

    if (partial !== undefined) {
        read(partial);
    }

    return {
        stage: writing ? 5 : answered,
        tools: tools.slice(-SHOWN_TOOLS).map(({ label, state }) => ({ label, state })),
        count: tools.length,
        failed: tools.filter((tool) => tool.state === "failed").length,
    };
}
