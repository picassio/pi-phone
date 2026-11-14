/**
 * A subagent whose prompt cache went cold, compacted before new work (PP-511, story PP-472; the owner's ask of
 * 2026-11-14). The main session often sends work to a subagent long after its last answer: its cache has expired (5
 * minutes, or 1 hour with the long cache, `cache-retention.ts`), so the first request of the new work writes its whole
 * context again at the cache-write price, and every later request of that run reads all of it.
 *
 * - `figures`: a subagent's context in tokens and its model's window, when it last answered, and how long its cache
 *   lasts: `subagent status` shows them.
 * - `check`: before `subagent send` delivers, whether to compact first: the setting is on (`coldSubagent`, Menu ›
 *   Compact context, on by default), the subagent is idle, it last answered longer ago than its cache lasts, its context
 *   is at least `COLD_FLOOR_TOKENS`, and the new work costs more on the context as it is than compacted (`coldCosts`):
 *   its first request writes the context, and each later one reads it from the cache, as many as the subagent's own
 *   runs made (`requestsPerRun`).
 * - `compact`: the compaction, from the reporter that delivers the work (`extensions/subagents.ts`), before it submits:
 *   Pi Durable's own (`conversation.compact()`; the cache is cold, so there is no warm prefix to summarize on, as
 *   self-compaction does), awaited, and restart-safe: a compaction under way is waited for, and one placed after the
 *   check is taken as done, so a restart compacts once. It is recorded as a self-compaction of the subagent's
 *   (`recordCompaction`, reason `cold`): the subagent's transcript line, and Spend's cost and saving.
 */
import type { Context } from "@earendil-works/chord/context";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { estimateMessageTokens } from "@earendil-works/pi-ai/utils/estimate";
import { type ConversationId, type Cursor, type EntryRecord, LiveDoc, type UsageState, UsageDoc } from "@earendil-works/pi-durable";
import type { PocketApp } from "./app.ts";
import { projectStats, usageCost } from "./projection.ts";
import { catalogued, KEEP_RECENT_TOKENS, type Prices, promptTokensOf, recordCompaction, savingOf, writePrice } from "./self-compact.ts";

const context = BACKGROUND_CONTEXT;

/** About how long Pi Durable's summary is (PP-474 measured about 3k tokens). */
const SUMMARY_TOKENS = 3_000;
/** A context smaller than this is never compacted before work, whatever the prices say. */
export const COLD_FLOOR_TOKENS = 50_000;

/** A subagent's figures now. `tokens`: its context, as its last answer measured it (or estimated after a compaction). */
export type SubagentFigures = {
    busy: boolean;
    tokens?: number;
    estimated: boolean;
    /** `provider/modelId`, its window, and prices. */
    model?: string;
    window?: number;
    prices?: Prices;
    /** When its newest request went out (its last answer's timestamp): the cache lives from there. */
    lastAt?: number;
    ttlMs: number;
    /** Pi's sections and tool schemas: what a compaction keeps besides the summary and the recent messages. */
    promptTokens: number;
    /** The newest entry of its context, and what it has spent: a compaction after the check is found by them. */
    mark: number;
    spent: number;
    written: number;
};

/**
 * What `check` decided to compact: the figures the reporter needs, kept in its input, and what the send says: the
 * requests a run is expected to make, and the saving the rule expects over them.
 */
export type ColdPlan = { tokens: number; idleMs: number; promptTokens: number; mark: number; spent: number; written: number; requests: number; saving: number };

/** What compacting came to. */
export type ColdOutcome = { after: number; cost: number; saving: number } | { nothing: true };

/** The requests a run is taken to make when the subagent has no finished run to go by, and the range taken. */
export const DEFAULT_REQUESTS = 10;
export const MIN_REQUESTS = 1;
export const MAX_REQUESTS = 40;
/** The newest finished runs the average is taken over, and the entries read back for them at most. */
const RUNS = 5;
const RUN_ENTRIES = 2_000;

/**
 * The cost rule, in dollars, for new work of `requests` requests (PP-511; the owner's rule of 2026-11-14):
 * - `keep`: the context C as it is. The first request writes it again (the cache is cold), and each later one reads it
 *   from the cache: C × write + (n − 1) × C × cache read.
 * - `compact`: Pi Durable's summarizer reading the part it summarizes (C − Pi's prompt − the 20k kept, uncached, at the
 *   input price) and writing the summary (3k at the output price); then the first request writes what is left, C' =
 *   Pi's prompt + 20k + 3k, and each later one reads it: C' × write + (n − 1) × C' × cache read.
 * The context grows as the run goes, alike both ways, so that part is left out. `saving` is keep − compact.
 */
export function coldCosts(
    tokens: number,
    promptTokens: number,
    prices: Prices,
    write: number,
    requests: number,
): { keep: number; compact: number; after: number; saving: number } {
    const after = Math.min(tokens, promptTokens + KEEP_RECENT_TOKENS + SUMMARY_TOKENS);
    const summarized = Math.max(0, tokens - promptTokens - KEEP_RECENT_TOKENS);
    const later = Math.max(0, requests - 1) * prices.cacheRead;
    const keep = (tokens * write + tokens * later) / 1_000_000;
    const compact = (summarized * prices.input + SUMMARY_TOKENS * prices.output + after * write + after * later) / 1_000_000;

    return { keep, compact, after, saving: keep - compact };
}

/** Whether compacting pays: past the floor, and the work costs more on the context kept than compacted. */
export const paysToCompact = (tokens: number, costs: { keep: number; compact: number }): boolean => tokens >= COLD_FLOOR_TOKENS && costs.keep > costs.compact;

/** The requests a run is taken to make: the subagent's own average, else `DEFAULT_REQUESTS`, kept in 1–40. */
export const requestsOf = (average: number | undefined): number => Math.min(MAX_REQUESTS, Math.max(MIN_REQUESTS, average ?? DEFAULT_REQUESTS));

/**
 * How many requests the subagent's runs made, on average, over its newest `RUNS` finished ones: the assistant answers
 * after each message it was given (`entries`, newest first), up to the next. By the message, not by the task that
 * appended them: Pi Durable hands a run to a new generation task at each tool round, so each request has its own. A
 * message with no answer of its own (two placed together) counts with the one after it. A message steered into a run
 * starts a new count there, which splits that run in two: rare for a subagent, and it errs toward fewer requests.
 * Undefined when there is none. It reads back `RUN_ENTRIES` entries at most; a run cut by that limit is left out.
 */
export async function requestsPerRun(entries: (cursor: unknown) => Promise<{ items: readonly EntryRecord[]; next?: unknown }>): Promise<number | undefined> {
    const runs: number[] = [];
    let answers = 0;
    let cursor: unknown;
    let read = 0;

    scan: while (runs.length < RUNS && read < RUN_ENTRIES) {
        const page = await entries(cursor);

        for (const entry of page.items) {
            read++;

            if (entry.kind === "pi.assistant") {
                answers++;
            } else if (entry.kind === "pi.user" && answers > 0) {
                runs.push(answers);
                answers = 0;
            }

            if (runs.length === RUNS || read >= RUN_ENTRIES) {
                break scan;
            }
        }

        if (page.next === undefined) {
            break;
        }

        cursor = page.next;
    }

    return runs.length === 0 ? undefined : runs.reduce((sum, count) => sum + count, 0) / runs.length;
}

/** The usage's tokens written (input and cache writes) by its models. */
function writtenOf(usage: UsageState | undefined): number {
    return Object.values(usage?.models ?? {}).reduce((sum, value) => sum + (value.input ?? 0) + (value.cacheWrite ?? 0), 0);
}

const isCompaction = (entry: EntryRecord, mark: number) => entry.kind === "pi.compaction" && Number(entry.id) > mark;

export class ColdSubagents {
    readonly #app: PocketApp;

    constructor(app: PocketApp) {
        this.#app = app;
    }

    /** The owner's switch (Menu › Compact context): on by default. */
    on(): boolean {
        return this.#app.config.selfCompact.coldSubagent;
    }

    async figures(id: ConversationId): Promise<SubagentFigures> {
        const app = this.#app;
        const busy = (await app.harness.snapshot(LiveDoc, id, context))?.run !== undefined;
        const view = await (await app.conversation(id)).context(context);
        const usage = await app.harness.snapshot(UsageDoc, id, context);
        const stats = projectStats(usage, view.entries);
        const answer = view.entries.findLast((entry) => entry.kind === "pi.assistant");
        const lastAt = (answer?.model?.[0] as { timestamp?: number } | undefined)?.timestamp;
        const ref = (await app.agentState(id))?.model;
        // One the catalogue does not know has no window or prices: status says so, and nothing is compacted for it.
        const found = ref === undefined ? undefined : app.models.getModel(ref.provider, ref.modelId);
        const model = ref === undefined ? undefined : { model: `${ref.provider}/${ref.modelId}`, ...(found === undefined ? {} : { window: found.contextWindow, prices: found.cost }) };

        return {
            busy,
            ...(stats.contextTokens === undefined ? {} : { tokens: stats.contextTokens }),
            estimated: stats.contextEstimated === true,
            ...(model === undefined ? {} : model),
            ...(lastAt === undefined ? {} : { lastAt }),
            ttlMs: app.selfCompact.timingOf(id).ttlMs,
            promptTokens: promptTokensOf(view.messages),
            mark: view.entries.reduce((newest, entry) => Math.max(newest, Number(entry.id)), 0),
            spent: usageCost(usage),
            written: writtenOf(usage),
        };
    }

    /** Whether to compact `id` before work goes to it now: a plan, or undefined to send at once. */
    async check(id: ConversationId): Promise<{ figures: SubagentFigures; plan?: ColdPlan }> {
        const figures = await this.figures(id);
        const { busy, tokens, estimated, prices, lastAt, ttlMs, promptTokens } = figures;

        if (!this.on() || busy || tokens === undefined || estimated || prices === undefined || lastAt === undefined) {
            return { figures };
        }

        const idleMs = Date.now() - lastAt;

        if (idleMs < ttlMs || tokens < COLD_FLOOR_TOKENS) {
            return { figures };
        }

        const conversation = await this.#app.conversation(id);
        const requests = requestsOf(await requestsPerRun((cursor) => conversation.entries({ order: "descending" }, 100, cursor as Cursor | undefined, context)));
        const costs = coldCosts(tokens, promptTokens, prices, writePrice(prices, ttlMs), requests);

        if (!paysToCompact(tokens, costs)) {
            return { figures };
        }

        return { figures, plan: { tokens, idleMs, promptTokens, mark: figures.mark, spent: figures.spent, written: figures.written, requests, saving: costs.saving } };
    }

    /**
     * Compact `id` as `plan` decided, and wait for it: a compaction already under way is waited for, and one placed since
     * the check is taken as this one, so a restart that runs this again compacts once. Throws when it fails.
     */
    async compact(id: ConversationId, plan: ColdPlan, at: Context): Promise<ColdOutcome> {
        const app = this.#app;
        const conversation = await app.conversation(id);
        const placed = async () => (await conversation.context(at)).entries.find((entry) => isCompaction(entry, plan.mark));
        let entry = await placed();

        if (entry === undefined) {
            const running = (await app.harness.snapshot(LiveDoc, id, at))?.compactions?.find((each) => each.trigger === "manual");
            const taskId = running?.taskId ?? (await conversation.compact(undefined, at));
            const outcome = (await app.harness.waitForTask(taskId, at)).state.outcome;

            if (outcome.status !== "completed") {
                const why = "error" in outcome ? outcome.error?.message : undefined;

                throw new Error(`the compaction ${outcome.status}${why === undefined ? "" : `: ${why}`}`);
            }

            if (outcome.result.submissionId !== undefined) {
                await (await app.harness.submission(outcome.result.submissionId, at))?.wait(at);
            }

            entry = await placed();
        }

        if (entry === undefined) {
            return { nothing: true };
        }

        const view = await conversation.context(at);
        // The next request's whole prompt, as self-compaction reckons it (PP-480): Pi's prompt, then what the view keeps.
        const after = plan.promptTokens + view.messages.reduce((sum, message) => sum + estimateMessageTokens(message), 0);
        const usage = await app.harness.snapshot(UsageDoc, id, at);
        // The subagent was idle: what it spent since the check is the summarizer's.
        const cost = usageCost(usage) - plan.spent;
        const ref = (await app.agentState(id))?.model;

        if (ref === undefined) {
            throw new Error("the subagent has no model");
        }

        const { prices } = catalogued(app, ref.provider, ref.modelId);
        const saving = savingOf(plan.tokens, after, cost, writePrice(prices, app.selfCompact.timingOf(id).ttlMs));

        await recordCompaction(
            app,
            id,
            {
                session: Number(app.rootOf(id)),
                entry: Number(entry.id),
                at: Date.now(),
                reason: "cold",
                before: plan.tokens,
                after,
                cost,
                saving,
                read: 0,
                written: writtenOf(usage) - plan.written,
                model: `${ref.provider}/${ref.modelId}`,
            },
            at,
        );

        return { after, cost, saving };
    }
}
