/**
 * The order of a batch's file and shell calls (PP-203). Pi Durable runs the calls of one answer at once unless a tool of
 * the round is `sequential`, and then runs the whole round one call at a time. So in a batch [edit X, bash `cat X`]
 * bash could run before the edit landed (seen on machine folders, where each call is a round trip over ssh).
 *
 * `edit`, `write` and `bash` run in the batch's order with each other: before it runs, each waits for the calls of
 * those three that come before it in the round (`LiveDoc.tools`, the round's calls in the model's order, each with its
 * tool task). Every other tool of the round stays parallel, and so do these with them. A nested call (code mode's
 * `executeTool`) is not in the round's slots: its script awaits it in its own order.
 */
import type { Context, JsonValue } from "@earendil-works/chord";
import { LiveDoc, type ToolExecutionApi, type ToolRegistration } from "@earendil-works/pi-durable";
import type { TSchema } from "@earendil-works/pi-ai";

/** The tools that run in the batch's order with each other. */
export const ORDERED_TOOLS: ReadonlySet<string> = new Set(["edit", "write", "bash"]);

/** Wait until every earlier `edit`, `write` or `bash` call of this call's round has settled. */
export async function earlierInBatch(api: Pick<ToolExecutionApi, "snapshot" | "conversationId" | "callId" | "waitForTask">, context: Context): Promise<void> {
    const slots = (await api.snapshot(LiveDoc, api.conversationId, context))?.tools ?? [];
    const index = slots.findIndex((slot) => slot.callId === api.callId);

    for (const slot of slots.slice(0, Math.max(0, index))) {
        if (ORDERED_TOOLS.has(slot.name) && slot.taskId !== undefined) {
            await api.waitForTask(slot.taskId, context);
        }
    }
}

/** The tool, run after the earlier `edit`, `write` and `bash` calls of its batch. */
export function inBatchOrder<P extends TSchema, D extends JsonValue>(tool: ToolRegistration<P, D>): ToolRegistration<P, D> {
    return {
        ...tool,
        execute: async (args, api, context) => {
            await earlierInBatch(api, context);

            return tool.execute(args, api, context);
        },
    };
}
