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
 *   is at least `COLD_FLOOR_TOKENS`, and writing that context again costs more than compacting it (`coldCosts`).
 * - `compact`: the compaction, from the reporter that delivers the work (`extensions/subagents.ts`), before it submits:
 *   Pi Durable's own (`conversation.compact()`; the cache is cold, so there is no warm prefix to summarize on, as
 *   self-compaction does), awaited, and restart-safe: a compaction under way is waited for, and one placed after the
 *   check is taken as done, so a restart compacts once. It is recorded as a self-compaction of the subagent's
 *   (`recordCompaction`, reason `cold`): the subagent's transcript line, and Spend's cost and saving.
 */
import type { Context } from "@earendil-works/chord/context";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { estimateMessageTokens } from "@earendil-works/pi-ai/utils/estimate";
import { type ConversationId, type EntryRecord, LiveDoc, type UsageState, UsageDoc } from "@earendil-works/pi-durable";
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

/** What `check` decided to compact: the figures the reporter needs, kept in its input. */
export type ColdPlan = { tokens: number; idleMs: number; promptTokens: number; mark: number; spent: number; written: number };

/** What compacting came to. */
export type ColdOutcome = { after: number; cost: number; saving: number } | { nothing: true };

/**
 * The cost rule, in dollars: `cold`, the first request of new work writing the whole context again; `compact`, Pi
 * Durable's summarizer reading the part it summarizes (uncached, at the input price), writing the summary, and the
 * first request writing what is left (Pi's prompt, the recent messages, the summary). Later requests of the run read
 * less too; that saving is not counted, so the rule leans toward leaving a subagent as it is.
 */
export function coldCosts(tokens: number, promptTokens: number, prices: Prices, write: number): { cold: number; compact: number; after: number } {
    const after = Math.min(tokens, promptTokens + KEEP_RECENT_TOKENS + SUMMARY_TOKENS);
    const summarized = Math.max(0, tokens - promptTokens - KEEP_RECENT_TOKENS);

    return {
        cold: (tokens * write) / 1_000_000,
        compact: (summarized * prices.input + SUMMARY_TOKENS * prices.output + after * write) / 1_000_000,
        after,
    };
}

/** Whether compacting pays: past the floor, and cheaper than writing the context again. */
export const paysToCompact = (tokens: number, costs: { cold: number; compact: number }): boolean => tokens >= COLD_FLOOR_TOKENS && costs.cold > costs.compact;

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

        if (idleMs < ttlMs || !paysToCompact(tokens, coldCosts(tokens, promptTokens, prices, writePrice(prices, ttlMs)))) {
            return { figures };
        }

        return { figures, plan: { tokens, idleMs, promptTokens, mark: figures.mark, spent: figures.spent, written: figures.written } };
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
