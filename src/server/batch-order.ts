/**
 * The order of a batch's file and shell calls (PP-203), and of its browser calls (PP-469). Pi Durable runs the calls of
 * one answer at once unless a tool of the round is `sequential`, and then runs the whole round one call at a time. So in
 * a batch [edit X, bash `cat X`] bash could run before the edit landed (seen on machine folders, where each call is a
 * round trip over ssh); and in a batch [browser_type a comment, browser_click Approve] the click could come first.
 *
 * `edit`, `write` and `bash` run in the batch's order with each other, and Pi's browser's tools with each other: before
 * it runs, each waits for the calls of its group that come before it in the round (`LiveDoc.tools`, the round's calls in
 * the model's order, each with its tool task). Every other tool of the round stays parallel, and so do the groups with
 * each other. A nested call (code mode's `executeTool`) is not in the round's slots: its script awaits it in its own
 * order.
 */
import type { Context, JsonValue } from "@earendil-works/chord";
import { LiveDoc, type ToolExecutionApi, type ToolRegistration } from "@earendil-works/pi-durable";

/** The file and shell tools, which run in the batch's order with each other. */
export const ORDERED_TOOLS: ReadonlySet<string> = new Set(["edit", "write", "bash"]);

/** The group a tool runs in the batch's order with: the file and shell tools, Pi's browser's tools, or none. */
function groupOf(name: string): string | undefined {
    return ORDERED_TOOLS.has(name) ? "files" : name.startsWith("browser_") ? "browser" : undefined;
}

/** Wait until every earlier call of this call's group in its round has settled. */
export async function earlierInBatch(api: Pick<ToolExecutionApi, "snapshot" | "conversationId" | "callId" | "waitForTask">, context: Context): Promise<void> {
    const slots = (await api.snapshot(LiveDoc, api.conversationId, context))?.tools ?? [];
    const index = slots.findIndex((slot) => slot.callId === api.callId);
    const group = index < 0 ? undefined : groupOf(slots[index]!.name);

    if (group === undefined) {
        return;
    }

    for (const slot of slots.slice(0, index)) {
        if (groupOf(slot.name) === group && slot.taskId !== undefined) {
            await api.waitForTask(slot.taskId, context);
        }
    }
}

/** The tool, run after the earlier calls of its group in its batch. */
export function inBatchOrder<P extends object, D extends JsonValue>(tool: ToolRegistration<P, D>): ToolRegistration<P, D> {
    return {
        ...tool,
        execute: async (args, api, context) => {
            await earlierInBatch(api, context);

            return tool.execute(args, api, context);
        },
    };
}
