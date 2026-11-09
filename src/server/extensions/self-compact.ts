/**
 * Self-compaction (PP-473, `self-compact.ts`): the compact_self tool, the generation's `onYield` (the summary turn, and
 * the hook "Remind to compact while waiting"), and the compaction's `beforeCompact` that supplies the summary Pi wrote.
 */
import type { Context } from "@earendil-works/chord";
import { obj, opt, str } from "@earendil-works/pi-schema";
import { CompactionTask, type Cursor, defineExtension, defineTool, GenerationTask, type HookApi, hook } from "@earendil-works/pi-durable";
import { GOAL_PREFIX } from "../goals.ts";
import type { PocketHost } from "../host.ts";
import { projectEntry } from "../projection.ts";
import { COMPACT_REMINDER_PREFIX, SELF_COMPACT_MARK, SUMMARY_PREFIX, type TurnInfo, type YieldDecision } from "../self-compact.ts";
import { REMINDER_PREFIX } from "../ui-reminder.ts";

/** The decision of one generation's `onYield`, kept so a restart applies it again instead of deciding anew. */
const DECISION_MEMO = "pocket.self-compact";
/** The app's follow-ups inside a run: they do not start a turn. */
const FOLLOW_UPS = [REMINDER_PREFIX, GOAL_PREFIX, COMPACT_REMINDER_PREFIX, SUMMARY_PREFIX];
/** Entries read back for a turn at most. */
const TURN_ENTRIES = 400;

/**
 * The newest user message, whether a compaction came after the message that started the turn, and what the answers
 * after the turn's compact_self call cost (the request its result took): a self-compaction's cost, with the summary's.
 */
async function turnInfo(api: HookApi, context: Context): Promise<TurnInfo> {
    let lastUser: string | undefined;
    let compacted = false;
    let cursor: Cursor | undefined;
    let read = 0;
    let since = 0;
    let afterCall: number | undefined;

    while (read < TURN_ENTRIES) {
        const page = await api.entries({ order: "descending" }, 100, cursor, context);

        for (const record of page.items) {
            read++;
            const entry = projectEntry(record);

            if (record.kind === "pi.assistant" && afterCall === undefined) {
                since += (record.model?.[0] as { usage?: { cost?: { total?: number } } } | undefined)?.usage?.cost?.total ?? 0;
            } else if (entry?.kind === "toolResult" && entry.name === "compact_self" && afterCall === undefined) {
                afterCall = since;
            } else if (entry?.kind === "compaction") {
                compacted = true;
            } else if (entry?.kind === "user") {
                lastUser ??= entry.text;

                if (!FOLLOW_UPS.some((prefix) => entry.text.startsWith(prefix))) {
                    return { lastUser, compacted, costAfterCall: afterCall ?? 0 };
                }
            }
        }

        if (page.next === undefined) {
            break;
        }

        cursor = page.next;
    }

    return { lastUser, compacted, costAfterCall: afterCall ?? 0 };
}

export default function createSelfCompact(host: PocketHost) {
    const compactSelf = defineTool({
        name: "compact_self",
        description:
            "Compact this session's context when your turn ends, while the prompt cache is warm: for a long wait (subagents, other sessions, CI, schedules) longer than the cache lasts. The app then asks you for the summary; write it, and the context is compacted after it. Not in a subagent.",
        parameters: obj({
            focus: opt(str({ description: "What the summary should keep, if anything in particular" })),
        }, { open: true }),
        // Safe to run again: it sets the same request.
        replay: "safe",
        execute: async (args, api) => {
            await host.selfCompact.queue(api.conversationId, args.focus?.trim() || undefined);

            return {
                output: [
                    {
                        type: "text" as const,
                        text: "Queued. End your turn now; the app then asks you for the summary, and compacts this session after your answer.",
                    },
                ],
            };
        },
    });

    return defineExtension({
        name: "pocket-self-compact",
        tools: [compactSelf],
        hooks: [
            hook(GenerationTask, {
                onYield: async (answer, api, context) => {
                    let stored = await api.memo<string>(DECISION_MEMO, context);

                    if (stored === undefined) {
                        const decision = await host.selfCompact.onYield(api.conversationId, answer, await turnInfo(api, context), host.hookOn("compactReminder"));

                        stored = await api.memo<string>(DECISION_MEMO, JSON.stringify(decision), context);
                    }

                    const decision = JSON.parse(stored) as YieldDecision;

                    await host.selfCompact.apply(api.conversationId, decision);

                    return decision.continue === undefined ? undefined : { continue: decision.continue };
                },
            }),
            hook(CompactionTask, {
                beforeCompact: async (compaction, api) => {
                    if (compaction.instructions !== SELF_COMPACT_MARK) {
                        return undefined;
                    }

                    const summary = await host.selfCompact.summaryFor(api.conversationId, compaction.messages);

                    return summary === undefined ? { decline: true as const } : { summary };
                },
            }),
        ],
    });
}
