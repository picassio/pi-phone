/**
 * A background task's message to its conversation, sent once: the CI watch's report (`ci-watch.ts`), an async
 * interview's answers (`interview.ts`). It goes as a follow-up, so it starts Pi's next turn when the conversation is
 * idle and waits behind a run that is going. Its request id makes a send made before a restart found again, not made
 * twice.
 */
import type { Context } from "@earendil-works/chord";
import { LiveDoc, type TaskRuntime } from "@earendil-works/pi-durable";

const SEND_CHECK_MS = 2_000;

/**
 * Send `text` and wait until it is in the transcript: "delivered". A send can be withdrawn without reaching it (a run
 * aborted takes the follow-ups queued behind it, and a failed run leaves them queued for good, withdrawn here once the
 * conversation is idle twice in a row): "withdrawn", for the caller to send again under a new request id.
 */
export async function sendFollowUp<I, S, R, E extends object>(
    runtime: TaskRuntime<I, S, R, E>,
    text: string,
    requestId: string,
    context: Context,
): Promise<"delivered" | "withdrawn"> {
    const conversation = (await runtime.conversation(runtime.conversationId, context))!;
    const submission = await conversation.submit({ type: "input", content: text, whenBusy: "followUp", requestId }, context);
    let idleChecks = 0;

    for (;;) {
        const record = await submission.status(context);

        if (record.entry !== undefined) {
            return "delivered";
        }

        if (record.status === "unanswered") {
            return "withdrawn";
        }

        const live = await runtime.snapshot(LiveDoc, runtime.conversationId, context);

        idleChecks = live?.run === undefined ? idleChecks + 1 : 0;

        if (idleChecks >= 2 && (await submission.abort(context)) === "aborted") {
            return "withdrawn";
        }

        await new Promise((resolve) => setTimeout(resolve, SEND_CHECK_MS));
    }
}
