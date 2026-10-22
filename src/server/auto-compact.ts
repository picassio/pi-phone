/**
 * Auto-compact at a context percentage (PP-78, the owner's request of 2026-10-22). Pi Durable compacts by itself only
 * when the context nearly fills the model's window (its reserve); people may want it sooner, to keep sessions quick
 * and cheap. A setting for every session (`ConfigStore.compactAt`), and a session's own (`SessionMeta.compactAt`),
 * say "full" (only when nearly full, as before) or a percentage: when a run ends with the context at or past it, the
 * session compacts, as Compact context does. Pi Durable's own compaction near a full window stays: a context never
 * overflows whatever the setting.
 */
import type { ConversationId } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { PocketApp } from "./app.ts";
import { describe, HttpError } from "./errors.ts";
import { projectStats } from "./projection.ts";

const context = BACKGROUND_CONTEXT;

/** "full": only when nearly full (Pi Durable's own); a number: at that percentage of the model's window. */
export type CompactAt = number | "full";

export const MIN_COMPACT_AT = 10;
export const MAX_COMPACT_AT = 95;

/** A value as given ("70", 70, "70%", "full"), checked; "inherit" too when `inherit` (a session's: the setting for all). */
export function checkCompactAt(value: unknown, inherit: false): CompactAt;
export function checkCompactAt(value: unknown, inherit: true): CompactAt | "inherit";
export function checkCompactAt(value: unknown, inherit: boolean): CompactAt | "inherit" {
    const text = String(value ?? "").trim().toLowerCase().replace(/%$/, "");

    if (text === "full" || (inherit && text === "inherit")) {
        return text;
    }

    const percent = Number(text);

    if (text === "" || !Number.isInteger(percent) || percent < MIN_COMPACT_AT || percent > MAX_COMPACT_AT) {
        throw new HttpError(400, `Auto-compact is a whole percentage from ${MIN_COMPACT_AT} to ${MAX_COMPACT_AT}, or full (only when nearly full)${inherit ? ", or inherit (the setting for all sessions)" : ""}.`);
    }

    return percent;
}

/** As a person reads it. */
export const compactAtText = (at: CompactAt) => (at === "full" ? "only when nearly full" : `at ${at}% of the context`);

export class AutoCompact {
    readonly #app: PocketApp;
    /** Conversations compacting by this rule now: one at a time each. */
    readonly #compacting = new Set<ConversationId>();

    constructor(app: PocketApp) {
        this.#app = app;
    }

    /** Where a session compacts: its own setting, else the one for all. */
    effective(id: ConversationId): CompactAt {
        return this.#app.sessionMeta(this.#app.rootOf(id))?.compactAt ?? this.#app.config.compactAt;
    }

    /**
     * A run ended in `id`: compact when its context reached the session's percentage. Not while one compacts; not on a
     * figure that is only an estimate (right after a compaction or a fresh start); not when spend limits hold work back.
     */
    async afterRun(id: ConversationId, contextWindow: number | undefined): Promise<void> {
        const app = this.#app;
        const at = this.effective(id);

        if (at === "full" || contextWindow === undefined || contextWindow <= 0 || this.#compacting.has(id) || app.spend.heldBack(id) !== undefined) {
            return;
        }

        const conversation = await app.conversation(id);
        const view = await conversation.context(context);
        const stats = projectStats(undefined, view.entries);

        if (stats.contextTokens === undefined || stats.contextEstimated === true) {
            return;
        }

        const percent = (stats.contextTokens / contextWindow) * 100;

        if (percent < at) {
            return;
        }

        this.#compacting.add(id);

        try {
            const taskId = await conversation.compact(undefined, context);

            app.notice("info", `The context is at ${Math.round(percent)}%: compacting (auto-compact at ${at}%).`, id);
            const receipt = await app.harness.waitForTask(taskId, context);
            const outcome = receipt.state.outcome;

            if (outcome.status === "completed") {
                // Nothing older than the recent window to summarize: quietly nothing.
                if (outcome.result.entryId !== undefined || outcome.result.submissionId !== undefined) {
                    app.notice("info", "Compacted.", id);
                }
            } else if (outcome.status !== "aborted") {
                const why = "error" in outcome ? outcome.error?.message : undefined;

                app.notice("error", `Auto-compact ${outcome.status}${why ? `: ${why}` : ""}`, id);
            }
        } catch (error) {
            app.log(`auto-compact in ${String(id)}: ${describe(error)}`);
        } finally {
            this.#compacting.delete(id);
        }
    }
}
