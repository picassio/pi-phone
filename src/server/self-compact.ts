/**
 * Self-compaction (PP-473, story PP-472, the owner's ask of 2026-11-09): a session that hands out work and waits a long
 * time loses its prompt cache (5 minutes), so the wake-up writes the whole context again at the cache-write price. Pi
 * compacts its own session while the cache is still warm, so the wake-up writes far less.
 *
 * - `compact_self` (the tool, `extensions/self-compact.ts`) queues a compaction of the calling session (`queued`). When
 *   the turn ends, the app asks Pi for the summary in the same run (`onYield`'s continuation, `SUMMARY_PREFIX`): that
 *   request has the context's exact prefix, so it reads the warm cache (about a tenth of the price) where Pi Durable's
 *   own summarizer sends the conversation again as new text, uncached, at the full input price. Pi's answer is the
 *   summary (`ready`); once the run ends, the app compacts (`conversation.compact(SELF_COMPACT_MARK)`), and the
 *   compaction's `beforeCompact` hook supplies the summary instead of asking a model (`summaryFor`). The cut is Pi
 *   Durable's (`keepRecentTokens`, 20k): the summary turn is the newest part of the context, so it is always kept as it
 *   is, and the compaction entry holds what the app reads from its own state (`appSections`): what the session waits on,
 *   its board tasks in progress, the files read and changed, and the last message a person wrote, word for word.
 * - The hook "Remind to compact while waiting" (`compactReminder`, Settings › Hooks): a turn that ends while the session
 *   waits on work (`pending`: subagents, linked sessions, CI runs, schedules) with its context at or past the setting's
 *   share of the window gets one follow-up a wait (`reminded`, the wait's key), with the cost of a cold wake-up against
 *   compacting now. Pi decides.
 * - Compact before the cache expires (`beforeExpiry`, off by default): a waiting session idle for the cache's lifetime
 *   less a lead (at 4.5 of 5 minutes, or 55 of 60 with the 1-hour cache, `cache-retention.ts`), its context at or past
 *   the share, is sent the summary request itself (`#expire`); a report that arrives first starts a run, which cancels it.
 * - The cache's lifetime and the price of a write are the session's (PP-475): 5 minutes at the catalogue's write price,
 *   or 1 hour at twice the input price.
 * - Each self-compaction is recorded (`SelfCompaction`): its cost (the summary turn), the context before and after, and
 *   what it saved (`savingOf`), in the session (the transcript's line) and in Spend.
 */
import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import { type ConversationId, UsageDoc } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import { estimateMessageTokens, estimateTextTokens } from "@earendil-works/pi-ai/utils/estimate";
import type { PocketApp } from "./app.ts";
import { cacheTiming } from "./cache-retention.ts";
import type { SelfCompactSettings } from "./config.ts";
import { AuthorsDoc, CiWatchesDoc, ScheduleDoc, SelfCompactDoc, type SelfCompaction, type SelfCompactReason, type SelfCompactState, SpendDoc, SubagentsDoc } from "./docs.ts";
import { describe, HttpError } from "./errors.ts";
import { projectStats } from "./projection.ts";
import type { TaskState } from "./projects.ts";
import { requestFor } from "./requests.ts";

const context = BACKGROUND_CONTEXT;

/** How the summary request starts (the transcript folds it into the "Compacted" line, `selfCompactionsOf` in web/turns.js). */
export const SUMMARY_VIA = "compact-self";
export const SUMMARY_PREFIX = `[via ${SUMMARY_VIA}] `;
/** How the compact reminder starts. */
export const COMPACT_REMINDER_VIA = "hook compact-reminder";
export const COMPACT_REMINDER_PREFIX = `[via ${COMPACT_REMINDER_VIA}] `;
/** How a self-compaction's entry starts: the transcript finds Pi's summary by it (`SELF_COMPACT_POINTER`, web/turns.js). */
export const SUMMARY_POINTER = "Your summary of the conversation before this point is your answer to the compact-self request";
/** The instructions that mark a compaction as a self-compaction: its summary is the summary turn's answer. */
export const SELF_COMPACT_MARK = "pocket:self-compact";

/** Pi Durable's default `keepRecentTokens`: the newest part of the context a compaction keeps as it is. */
export const KEEP_RECENT_TOKENS = 20_000;
/** About how long a summary is, for the reminder's estimate. */
const SUMMARY_TOKENS = 2_000;
/** About what the two requests of a self-compaction add to the prefix (the reminder's answer, the summary request). */
const REQUEST_TOKENS = 1_500;
/** Self-compactions kept in a session, and in Spend. */
const KEEP_DONE = 50;
const KEEP_SPEND = 100;
/** A board task the summary names: the session's own work. */
const OPEN_STATES: readonly TaskState[] = ["in_progress", "review"];

/** What a session waits on, read from the app's state, and its board tasks in progress. */
export type Pending = {
    subagents: { name: string; asked: string; since?: number }[];
    sessions: { id: number; title: string; state: string }[];
    ci: { label: string; url: string; since: number }[];
    schedules: { id: string; text: string; next: number; repeats: boolean }[];
    tasks: { ref: string; title: string; state: TaskState }[];
};

/** Whether the session waits on anything: board tasks are its own work, not a wait. */
export const waitsOn = (pending: Pending): boolean => pending.subagents.length + pending.sessions.length + pending.ci.length + pending.schedules.length > 0;

/** One wait's key: the reminder goes once for it, and again when what the session waits on changes. */
export const waitKey = (pending: Pending): string =>
    [
        ...pending.subagents.map((each) => `subagent:${each.name}:${each.since ?? ""}`),
        ...pending.sessions.map((each) => `session:${each.id}`),
        ...pending.ci.map((each) => `ci:${each.url}`),
        ...pending.schedules.map((each) => `schedule:${each.id}:${each.next}`),
    ]
        .sort()
        .join("|");

const clipped = (text: string, max: number) => {
    const line = text.replace(/\s+/g, " ").trim();

    return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};
const when = (at: number) => `${new Date(at).toISOString().slice(0, 16).replace("T", " ")} UTC`;

/** What the session waits on, one line each, as Pi and the summary read it. */
export function waitLines(pending: Pending): string[] {
    return [
        ...pending.subagents.map((each) => `- Subagent "${each.name}"${each.since === undefined ? "" : ` (asked ${when(each.since)})`}: ${clipped(each.asked, 160)}`),
        ...pending.sessions.map((each) => `- Session #${each.id} "${clipped(each.title, 60)}": ${each.state}`),
        ...pending.ci.map((each) => `- CI run ${each.label} (watch_ci since ${when(each.since)}): ${each.url}`),
        ...pending.schedules.map((each) => `- Schedule ${each.id}${each.repeats ? " (repeats)" : ""}, next ${when(each.next)}: ${clipped(each.text, 120)}`),
    ];
}

/** The session's board tasks in progress or in review. */
export const taskLines = (pending: Pending): string[] => pending.tasks.map((each) => `- ${each.ref} ${clipped(each.title, 100)}: ${each.state === "in_progress" ? "In Progress" : "Review"}`);

/**
 * The prompt a request sends before its messages, as the context's system messages leave it: their instructions, each
 * section's newest text, and the tools still offered, each once (PP-480). A compaction drops these messages and the
 * next request writes them again whole, so they count in what remains after it.
 */
export function promptTokensOf(messages: readonly Message[]): number {
    const texts: string[] = [];
    const sections = new Map<string, string>();
    const tools = new Map<string, unknown>();

    for (const message of messages) {
        if (message.role !== "system") {
            continue;
        }

        texts.push(typeof message.content === "string" ? message.content : message.content.map((part) => part.text).join("\n"));

        for (const [name, text] of Object.entries(message.sections ?? {})) {
            if (text === null) {
                sections.delete(name);
            } else {
                sections.set(name, text);
            }
        }

        for (const tool of message.toolsAdded ?? []) {
            tools.set(tool.name, tool);
        }

        for (const tool of message.toolsRemoved ?? []) {
            tools.delete(tool.name);
        }
    }

    return estimateTextTokens([...texts, ...sections.values()].join("\n\n")) + (tools.size === 0 ? 0 : estimateTextTokens(JSON.stringify([...tools.values()])));
}

/** Prices of a model in dollars per million tokens, as its catalogue says. */
export type Prices = { input: number; output: number; cacheRead: number; cacheWrite: number };

/**
 * What a self-compaction saved: the cache write a cold wake-up would have paid for the whole context, less what the
 * compaction cost and the smaller context's own write at the wake-up. In dollars; negative when it did not pay.
 */
export function savingOf(before: number, after: number, cost: number, write: number): number {
    return ((before - after) * write) / 1_000_000 - cost;
}

/**
 * What a cache write costs a million tokens: the catalogue's (Anthropic's 5-minute write, 1.25× input), or twice the
 * input price for the 1-hour cache (PP-474, measured: Opus $5 and $8 against $4 input).
 */
export const writePrice = (prices: Prices, ttlMs: number): number => (ttlMs > 300_000 ? prices.input * 2 : prices.cacheWrite);

const dollars = (amount: number) => `$${amount.toFixed(amount < 0.1 ? 3 : 2)}`;
const thousands = (tokens: number) => `${Math.round(tokens / 1000)}k`;

/** The summary request: Pi's answer to it is the summary (the format is Pi's and Pi Durable's compaction format). */
export function summaryRequest(reason: SelfCompactReason, pending: Pending, focus: string | undefined): string {
    const waits = waitLines(pending);
    const tasks = taskLines(pending);

    return [
        `${SUMMARY_PREFIX}${reason === "pi" ? "You called compact_self." : "This session's prompt cache is about to expire while it waits."} The app compacts this session's context once you answer this. Write the summary that will take the place of the conversation so far, as your whole answer, with no tool calls. You continue from it later, with the most recent messages kept as they are.`,
        "",
        "Use this format, each section short; keep exact file paths, ids, commands and error messages:",
        "## Goal",
        "## Constraints & Preferences (the decisions and rules the owner set in this session, as they said them)",
        "## Progress (### Done, ### In Progress, ### Blocked)",
        "## Key Decisions",
        "## Waiting on (who or what comes back, and what to do with it when it does)",
        "## Next Steps",
        "## Critical Context",
        "",
        "The app keeps beside your summary, read from its own state: what the session waits on, its board tasks in progress, the files read and changed, and the last message a person wrote, word for word. Now:",
        waits.length === 0 ? "- Waiting on nothing." : waits.join("\n"),
        ...(tasks.length === 0 ? [] : ["Board tasks:", tasks.join("\n")]),
        ...(focus === undefined ? [] : ["", `Keep in particular: ${focus}`]),
    ].join("\n");
}

/** The reminder's figures: the context, the window, and what each way costs. */
export type ReminderFigures = { tokens: number; window: number; model: string; prices: Prices; ttlMs: number; promptTokens: number };

/** The compact reminder: what the session waits on, its context, and a cold wake-up's cost against compacting now. */
export function reminderText(pending: Pending, figures: ReminderFigures): string {
    const { tokens, window, model, prices, ttlMs, promptTokens } = figures;
    const after = Math.min(tokens, promptTokens + KEEP_RECENT_TOKENS + SUMMARY_TOKENS);
    const write = writePrice(prices, ttlMs);
    const cold = (tokens * write) / 1_000_000;
    // Two requests on the warm prefix (the one after compact_self's result, and the summary's), each reading the
    // context and writing only its new part; and the summary written out.
    const now = (2 * tokens * prices.cacheRead + REQUEST_TOKENS * write + SUMMARY_TOKENS * prices.output) / 1_000_000;
    const wake = (after * write) / 1_000_000;
    const minutes = Math.round(ttlMs / 60_000);

    return [
        `${COMPACT_REMINDER_PREFIX}This session waits on:`,
        ...waitLines(pending),
        `Its context is ${thousands(tokens)} tokens, ${Math.round((tokens / window) * 100)}% of ${model}'s window. The prompt cache lasts ${minutes} minutes: a wake-up after that writes the whole context again, about ${dollars(cold)}. Compacting now reads it from the warm cache, about ${dollars(now)}, and leaves about ${thousands(after)} tokens to write at the wake-up, about ${dollars(wake)}.`,
        `If you expect the wait to last longer than ${minutes} minutes, call compact_self (load it with tool_search first if it is not offered), then end your turn. If it comes back sooner, just end your turn. This comes once a wait; the owner turns it off in Settings › Hooks.`,
    ].join("\n");
}

/** The files the summarized messages read and changed, as Pi's compaction tracks them (`read`, `edit`, `write`). */
export function filesOf(messages: readonly Message[]): { read: string[]; changed: string[] } {
    const read = new Set<string>();
    const changed = new Set<string>();

    for (const message of messages) {
        if (message.role !== "assistant") {
            continue;
        }

        for (const block of message.content) {
            const path = block.type === "toolCall" ? block.arguments.path : undefined;

            if (typeof path === "string") {
                if (block.type === "toolCall" && block.name === "read") {
                    read.add(path);
                } else if (block.type === "toolCall" && (block.name === "edit" || block.name === "write")) {
                    changed.add(path);
                }
            }
        }
    }

    return { read: [...read].filter((path) => !changed.has(path)), changed: [...changed] };
}

/** What the compaction entry holds: the app's own sections, and where Pi's summary is. */
export function appSections(pending: Pending, files: { read: string[]; changed: string[] }, lastMessage: { name: string; text: string } | undefined): string {
    const waits = waitLines(pending);
    const tasks = taskLines(pending);

    return [
        `${SUMMARY_POINTER} among the recent messages below. Read from the app's state when it compacted:`,
        "",
        "## Waiting on",
        waits.length === 0 ? "- Nothing." : waits.join("\n"),
        "",
        "## Board tasks in progress",
        tasks.length === 0 ? "- None." : tasks.join("\n"),
        ...(files.read.length === 0 ? [] : ["", "## Files read", ...files.read.map((path) => `- ${path}`)]),
        ...(files.changed.length === 0 ? [] : ["", "## Files changed", ...files.changed.map((path) => `- ${path}`)]),
        ...(lastMessage === undefined ? [] : ["", `## The last message a person wrote (${lastMessage.name}), word for word`, "<message>", lastMessage.text, "</message>"]),
    ].join("\n");
}

/** A decision of the generation's `onYield`, kept in its memo so a restart applies it again rather than deciding anew. */
export type YieldDecision = {
    continue?: string;
    /** Fields of `SelfCompactDoc` to set; null removes one. */
    patch: { queued?: null; asked?: SelfCompactState["asked"] | null; ready?: SelfCompactState["ready"] | null; reminded?: string };
    /** What the session is told: the summary turn gave none, or a message came before the summary request. */
    notice?: "no-summary" | "came-first";
};

/** What the hook knows of the turn: the newest user message's text, and whether the context was compacted in it. */
export type TurnInfo = { lastUser: string | undefined; compacted: boolean; costAfterCall: number };

export class SelfCompact {
    readonly #app: PocketApp;
    /** Sessions compacting now: one at a time each. */
    readonly #compacting = new Set<ConversationId>();
    /** The expiry mode's timer of each waiting session. */
    readonly #timers = new Map<ConversationId, NodeJS.Timeout>();
    /** Tests make the cache's lifetime and the expiry mode's lead short; otherwise each session's (`timingOf`). */
    timing: { ttlMs: number; leadMs: number } | undefined;

    constructor(app: PocketApp) {
        this.#app = app;
    }

    /** How long `id`'s cache lasts, and how long before its end the expiry mode compacts: its setting's (PP-475). */
    timingOf(id: ConversationId): { ttlMs: number; leadMs: number } {
        return this.timing ?? cacheTiming(this.#app.cacheRetentionOf(id));
    }

    settings(): SelfCompactSettings {
        return this.#app.config.selfCompact;
    }

    /** The owner's: one part of the settings for every session (Menu › Compact context, `sessions.compact*`). */
    set(user: { role: string }, part: string, value: unknown): void {
        if (user.role !== "owner") {
            throw new HttpError(403, "Only the owner can do that");
        }

        if (part === "tool" || part === "beforeExpiry" || part === "coldSubagent") {
            if (typeof value !== "boolean") {
                throw new HttpError(
                    400,
                    part === "tool"
                        ? "compact_self is on (true) or off (false)."
                        : part === "beforeExpiry"
                          ? "Compacting before the cache expires is on (true) or off (false)."
                          : "Compacting a subagent whose cache went cold before new work is on (true) or off (false).",
                );
            }

            this.#app.config.setSelfCompact(part, value);
        } else if (part === "remindAt") {
            const percent = Number(String(value).trim().replace(/%$/, ""));

            if (!Number.isInteger(percent) || percent < 10 || percent > 95) {
                throw new HttpError(400, "The compact reminder's share is a whole percentage from 10 to 95.");
            }

            this.#app.config.setSelfCompact("remindAt", percent);
        } else {
            throw new HttpError(400, "Self-compaction's settings are tool, remindAt, beforeExpiry and coldSubagent.");
        }

        if (!this.settings().beforeExpiry || !this.settings().tool) {
            for (const timer of this.#timers.values()) {
                clearTimeout(timer);
            }

            this.#timers.clear();
        }
    }

    /** Why `id` may not compact itself, or undefined when it may. */
    refused(id: ConversationId): string | undefined {
        if (!this.settings().tool) {
            return "compact_self is turned off for every session (Menu › Compact context).";
        }

        if (this.#app.parentOf(id) !== undefined) {
            return "A subagent does not compact itself: its final answer is its report to its parent, and the summary turn would take that answer's place. Its context ends with its task.";
        }

        return undefined;
    }

    /** compact_self: queue a compaction of `id`, to start when its turn ends. */
    async queue(id: ConversationId, focus: string | undefined): Promise<void> {
        const why = this.refused(id);

        if (why !== undefined) {
            throw new Error(why);
        }

        await this.#app.harness.commit(async (tx) => {
            const doc = await tx.doc(SelfCompactDoc, id);

            doc.queued = { reason: "pi", at: Date.now(), ...(focus === undefined ? {} : { focus }) };
        }, context);
    }

    /** What `id` waits on and its board tasks in progress, read from the app's state. */
    async pending(id: ConversationId): Promise<Pending> {
        const app = this.#app;
        const harness = app.harness;
        const root = app.rootOf(id);
        const agents = (await harness.snapshot(SubagentsDoc, id, context))?.agents ?? {};
        const subagents = Object.entries(agents)
            .filter(([, record]) => app.isBusy(record.conversationId) || (record.askedAt !== undefined && (record.answeredAt ?? 0) < record.askedAt))
            .map(([name, record]) => ({ name, asked: record.asked ?? "", ...(record.askedAt === undefined ? {} : { since: record.askedAt }) }));
        const sessions = Object.entries(app.sessionCatalogue())
            .filter(([key, meta]) => meta.linkedFrom?.id === Number(root) && meta.archived !== true && app.isBusy(Number(key) as ConversationId))
            .map(([key, meta]) => ({ id: Number(key), title: meta.title ?? "New session", state: "working" }));
        const ci = Object.values((await harness.snapshot(CiWatchesDoc, id, context))?.items ?? {}).map((watch) => ({ label: watch.label, url: watch.url, since: watch.startedAt }));
        const schedules = Object.values((await harness.snapshot(ScheduleDoc, id, context))?.items ?? {})
            .sort((a, b) => a.next - b.next)
            .map((each) => ({ id: each.id, text: each.text, next: each.next, repeats: each.every !== undefined }));
        const tasks = app.boardTasksOf(String(root), OPEN_STATES).map((task) => ({ ref: task.ref, title: task.title, state: task.state }));

        return { subagents, sessions, ci, schedules, tasks };
    }

    #model(provider: string, modelId: string): { prices: Prices; window: number } {
        return catalogued(this.#app, provider, modelId);
    }

    /**
     * A turn of `id` ended with `answer` (the generation's `onYield`): the summary turn's answer becomes the summary; a
     * compaction compact_self queued asks for the summary; or the compact reminder goes out. `hookOn`: the hook's switch.
     */
    async onYield(id: ConversationId, answer: AssistantMessage, turn: TurnInfo, hookOn: boolean): Promise<YieldDecision> {
        const state = await this.#app.harness.snapshot(SelfCompactDoc, id, context);

        if (state?.asked !== undefined) {
            if (turn.lastUser?.startsWith(SUMMARY_PREFIX) === true) {
                const summary = answer.content
                    .flatMap((block) => (block.type === "text" ? [block.text] : []))
                    .join("\n")
                    .trim();

                if (answer.stopReason !== "stop" || summary === "") {
                    return { patch: { asked: null }, notice: "no-summary" };
                }

                const usage = answer.usage;

                return {
                    patch: {
                        asked: null,
                        ready: {
                            reason: state.asked.reason,
                            summary,
                            before: usage.input + usage.cacheRead + usage.cacheWrite,
                            // The summary's request and the one compact_self's result took: what compacting cost.
                            cost: usage.cost.total + turn.costAfterCall,
                            read: usage.cacheRead,
                            written: usage.input + usage.cacheWrite,
                            model: `${answer.provider}/${answer.model}`,
                            at: Date.now(),
                        },
                    },
                };
            }

            // A message came before the summary request went out (a report): the wait is over, and the compaction with it.
            return { patch: { asked: null }, notice: "came-first" };
        }

        if (state?.queued !== undefined) {
            const pending = await this.pending(id);

            return { continue: summaryRequest(state.queued.reason, pending, state.queued.focus), patch: { queued: null, asked: state.queued } };
        }

        return this.#remind(id, answer, turn, state, hookOn);
    }

    async #remind(id: ConversationId, answer: AssistantMessage, turn: TurnInfo, state: SelfCompactState | undefined, hookOn: boolean): Promise<YieldDecision> {
        const none: YieldDecision = { patch: {} };

        if (!hookOn || this.refused(id) !== undefined || turn.compacted || turn.lastUser?.startsWith(COMPACT_REMINDER_PREFIX) === true || turn.lastUser?.startsWith(SUMMARY_PREFIX) === true) {
            return none;
        }

        const usage = answer.usage;
        const tokens = usage.input + usage.cacheRead + usage.cacheWrite + usage.output;
        const { prices, window } = this.#model(answer.provider, answer.model);

        if (window <= 0 || (tokens / window) * 100 < this.settings().remindAt) {
            return none;
        }

        const pending = await this.pending(id);
        const key = waitKey(pending);

        if (!waitsOn(pending) || key === state?.reminded) {
            return none;
        }

        // The prompt's part a compaction keeps: Pi's sections and tool schemas.
        const view = await (await this.#app.conversation(id)).context(context);
        const promptTokens = promptTokensOf(view.messages);

        return {
            continue: reminderText(pending, { tokens, window, model: answer.model, prices, ttlMs: this.timingOf(id).ttlMs, promptTokens }),
            patch: { reminded: key },
        };
    }

    /** Apply an `onYield` decision: its document changes, and its notice. */
    async apply(id: ConversationId, decision: YieldDecision): Promise<void> {
        const { patch } = decision;

        if (Object.keys(patch).length > 0) {
            await this.#app.harness.commit(async (tx) => {
                const doc = await tx.doc(SelfCompactDoc, id);

                for (const key of ["queued", "asked", "ready"] as const) {
                    if (patch[key] === null) {
                        delete doc[key];
                    }
                }

                if (patch.asked !== undefined && patch.asked !== null) {
                    doc.asked = patch.asked;
                }

                if (patch.ready !== undefined && patch.ready !== null) {
                    doc.ready = patch.ready;
                }

                if (patch.reminded !== undefined) {
                    doc.reminded = patch.reminded;
                }
            }, context);
        }

        if (decision.notice === "no-summary") {
            this.#app.notice("error", "Not compacted: the summary turn gave no summary.", id);
        } else if (decision.notice === "came-first") {
            this.#app.notice("info", "Not compacted: a message came first.", id);
        }
    }

    /**
     * The compaction's summary (its `beforeCompact`): the app's sections, read now, pointing at Pi's summary among the
     * kept messages; undefined when no summary is ready (the compaction then declines).
     */
    async summaryFor(id: ConversationId, messages: readonly Message[]): Promise<string | undefined> {
        const ready = (await this.#app.harness.snapshot(SelfCompactDoc, id, context))?.ready;

        if (ready === undefined) {
            return undefined;
        }

        return appSections(await this.pending(id), filesOf(messages), await this.#lastMessage(id));
    }

    /** The newest message a person wrote here, word for word, and who wrote it. */
    async #lastMessage(id: ConversationId): Promise<{ name: string; text: string } | undefined> {
        const authors = (await this.#app.harness.snapshot(AuthorsDoc, id, context))?.entries ?? {};
        const conversation = await this.#app.conversation(id);
        const page = await conversation.entries({ order: "descending" }, 400, undefined, context);

        for (const entry of page.items) {
            const userId = authors[String(entry.id)];

            if (entry.kind === "pi.user" && userId !== undefined) {
                const content = (entry.model?.[0] as { content?: unknown } | undefined)?.content;
                const text =
                    typeof content === "string"
                        ? content
                        : Array.isArray(content)
                          ? (content as { type: string; text?: string }[]).flatMap((part) => (part.type === "text" && part.text !== undefined ? [part.text] : [])).join("\n")
                          : "";

                return { name: this.#app.config.userById(userId)?.name ?? userId, text };
            }
        }

        return undefined;
    }

    /**
     * A run of `id` ended: a summary ready compacts it now (true: auto-compact waits); otherwise the expiry mode plans its
     * look at the cache's end.
     */
    afterRun(id: ConversationId): Promise<boolean> {
        return this.#afterRun(id).catch((error: unknown) => {
            this.#app.log(`self-compact in ${String(id)}: ${describe(error)}`);

            return false;
        });
    }

    async #afterRun(id: ConversationId): Promise<boolean> {
        const ready = (await this.#app.harness.snapshot(SelfCompactDoc, id, context))?.ready;

        clearTimeout(this.#timers.get(id));
        this.#timers.delete(id);

        if (ready !== undefined) {
            if (!this.#compacting.has(id)) {
                void this.#compact(id, ready);
            }

            return true;
        }

        if (this.settings().beforeExpiry && this.refused(id) === undefined) {
            const { ttlMs, leadMs } = this.timingOf(id);
            const timer = setTimeout(() => {
                this.#timers.delete(id);
                void this.#expire(id).catch((error: unknown) => this.#app.log(`self-compact before expiry in ${String(id)}: ${describe(error)}`));
            }, Math.max(0, ttlMs - leadMs));

            timer.unref();
            this.#timers.set(id, timer);
        }

        return false;
    }

    /** Whether the expiry mode has a look planned for `id`. */
    planned(id: ConversationId): boolean {
        return this.#timers.has(id);
    }

    /** The cache is about to expire: a session still idle and waiting, its context past the share, is asked for its summary. */
    async #expire(id: ConversationId): Promise<void> {
        const app = this.#app;

        if (!this.settings().beforeExpiry || this.refused(id) !== undefined || app.isBusy(id) || app.spend.heldBack(id) !== undefined) {
            return;
        }

        const pending = await this.pending(id);

        if (!waitsOn(pending)) {
            return;
        }

        const conversation = await app.conversation(id);
        const view = await conversation.context(context);
        const stats = projectStats(await app.harness.snapshot(UsageDoc, id, context), view.entries);
        const ref = (await app.agentState(id))?.model;

        if (stats.contextTokens === undefined || stats.contextEstimated === true || ref === undefined) {
            return;
        }

        const { window } = this.#model(ref.provider, ref.modelId);

        if (window <= 0 || (stats.contextTokens / window) * 100 < this.settings().remindAt) {
            return;
        }

        const asked = { reason: "expiry" as const, at: Date.now() };
        const requester = app.attribution.requesterOf(id);
        const key = `self-compact-${String(id)}-${asked.at}`;

        await app.harness.commit(async (tx) => {
            (await tx.doc(SelfCompactDoc, id)).asked = asked;
        }, context);
        // Only while it is idle: a report or a message that came in the meantime ended the wait, and this with it.
        await conversation
            .submit({ type: "input", content: summaryRequest("expiry", pending, undefined), whenBusy: "reject", requestId: requester === undefined ? key : requestFor(requester, key) }, context)
            .catch(async (error: unknown) => {
                await app.harness.commit(async (tx) => {
                    delete (await tx.doc(SelfCompactDoc, id)).asked;
                }, context);
                app.log(`self-compact before expiry in ${String(id)} not sent: ${describe(error)}`);
            });
    }

    /** Compact `id` with the summary `ready` holds, then record what it cost and saved. */
    async #compact(id: ConversationId, ready: NonNullable<SelfCompactState["ready"]>): Promise<void> {
        const app = this.#app;

        this.#compacting.add(id);

        try {
            const conversation = await app.conversation(id);
            // Read before the compaction drops the system messages that hold it.
            const promptTokens = promptTokensOf((await conversation.context(context)).messages);
            const taskId = await conversation.compact(SELF_COMPACT_MARK, context);
            const outcome = (await app.harness.waitForTask(taskId, context)).state.outcome;

            if (outcome.status !== "completed") {
                const why = "error" in outcome ? outcome.error?.message : undefined;

                await this.#clearReady(id);
                app.notice("error", `Self-compaction ${outcome.status}${why ? `: ${why}` : ""}`, id);

                return;
            }

            const { submissionId } = outcome.result;

            if (submissionId === undefined) {
                await this.#clearReady(id);
                app.notice("info", "Nothing to compact: the context fits in the recent window.", id);

                return;
            }

            await (await app.harness.submission(submissionId, context))?.wait(context);
            const view = await conversation.context(context);
            const entry = view.entries.reduce<number | undefined>((newest, each) => (each.kind === "pi.compaction" && (newest === undefined || Number(each.id) > newest) ? Number(each.id) : newest), undefined);
            // The next request's whole prompt: Pi's sections and tool schemas, the summary and the messages kept (PP-480:
            // the messages alone left out about 69k of a 91k wake-up, and overstated the saving). The same base as the
            // reminder's estimate and as `before`, the last request's measured prompt.
            const after = promptTokens + view.messages.reduce((sum, message) => sum + estimateMessageTokens(message), 0);
            const [provider = "", ...rest] = ready.model.split("/");
            const { prices } = this.#model(provider, rest.join("/"));
            const write = writePrice(prices, this.timingOf(id).ttlMs);
            const record: SelfCompaction = {
                session: Number(app.rootOf(id)),
                entry: entry ?? 0,
                at: Date.now(),
                reason: ready.reason,
                before: ready.before,
                after,
                cost: ready.cost,
                saving: savingOf(ready.before, after, ready.cost, write),
                read: ready.read,
                written: ready.written,
                model: ready.model,
            };

            await recordCompaction(app, id, record, context);
            app.log(`self-compact in ${String(id)}: ${compactedLine(record)}`);
            // The transcript's line says how much, in the person's language.
            app.notice("info", "Compacted.", id);
        } catch (error) {
            app.notice("error", `Self-compaction failed: ${describe(error)}`, id);
            await this.#clearReady(id).catch((cleared: unknown) => app.log(`self-compact in ${String(id)}: the summary was not cleared: ${describe(cleared)}`));
        } finally {
            this.#compacting.delete(id);
        }
    }

    async #clearReady(id: ConversationId): Promise<void> {
        await this.#app.harness.commit(async (tx) => {
            delete (await tx.doc(SelfCompactDoc, id)).ready;
        }, context);
    }
}

/** A model's prices and window, from the catalogue; an error names one it does not know. */
export function catalogued(app: Pick<PocketApp, "models">, provider: string, modelId: string): { prices: Prices; window: number } {
    const model = app.models.getModel(provider, modelId);

    if (model === undefined) {
        throw new Error(`Model ${provider}/${modelId} is not in the catalogue.`);
    }

    return { prices: model.cost, window: model.contextWindow };
}

/**
 * Record a compaction of `id` (`record.entry`, its compaction entry) in the conversation (the transcript's line) and in
 * Spend, and clear a self-compaction's summary. Once: a compaction recorded already (a restart that runs this again) is
 * left as it is.
 */
export async function recordCompaction(app: PocketApp, id: ConversationId, record: SelfCompaction, at: Context): Promise<void> {
    const all = await app.harness.commit(async (tx) => {
        const doc = await tx.doc(SelfCompactDoc, id);

        delete doc.ready;

        if (doc.done.some((each) => each.entry === record.entry)) {
            return undefined;
        }

        doc.done = [...doc.done, record].slice(-KEEP_DONE);
        const spend = await tx.doc(SpendDoc);
        const before = spend.selfCompactions ?? { count: 0, cost: 0, saved: 0, recent: [] };
        // Plain copies: the document's own records cannot be read once the commit settles, and Spend keeps these.
        const recent = [...before.recent.map((each) => ({ ...each })), record].slice(-KEEP_SPEND);
        const now = { count: before.count + 1, cost: before.cost + record.cost, saved: before.saved + record.saving, recent };

        spend.selfCompactions = now;

        return now;
    }, at);

    if (all !== undefined) {
        app.spend.selfCompacted(all);
    }
}

const REASONS = { pi: "Pi chose to while waiting", expiry: "the prompt cache was about to expire", cold: "the subagent's prompt cache had gone cold before new work" } as const;

/** The line a self-compaction leaves, in English (the transcript has its own, in the person's language). */
export function compactedLine(record: SelfCompaction): string {
    return `Compacted: ${REASONS[record.reason]}, ${thousands(record.before)} → ${thousands(record.after)} tokens, ${dollars(record.cost)}, saved about ${dollars(record.saving)}; the summary request read ${record.read} tokens from the cache and wrote ${record.written}.`;
}
