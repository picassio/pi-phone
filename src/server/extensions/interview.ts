/**
 * `interview`: a form of questions for the person, as pi-interview has it (its question format and its words back to
 * Pi, `interviews.ts`), shown in the app instead of a browser window. The call waits like an approval: its card in the
 * conversation has Answer, which opens the form; the phone tells the person; the session shows it waits for them. The
 * questions and the person's draft are in the conversation (`InterviewsDoc`), so a restart loses nothing: the call asks
 * again, or finds the answer given while it was away.
 *
 * With `async: true` the call returns at once with the interview's id and Pi keeps working: a durable background task
 * waits for the person instead, and when they submit, skip, or it times out, sends the conversation the same words as
 * a message starting "Interview <id> finished." (`deliver.ts`), which starts Pi's next turn when it is idle.
 */
import type { Context } from "@earendil-works/chord";
import { Type } from "@earendil-works/pi-ai";
import { type ConversationId, defineExtension, defineTask, defineTool, section, type TaskId } from "@earendil-works/pi-durable";
import { sendFollowUp } from "../deliver.ts";
import type { PocketHost } from "../host.ts";
import { type Interview, InterviewsDoc, outcomeText, parseQuestions, type QuestionsFile, validateQuestions } from "../interviews.ts";

const reply = (text: string, details?: Record<string, string>, isError = false) => ({
    output: [{ type: "text" as const, text }],
    ...(details === undefined ? {} : { details }),
    ...(isError ? { isError: true } : {}),
});

const DESCRIPTION =
    "Present a form of questions to the person, in the app: they answer when they can, and the call waits for them. " +
    "Use it when choosing between approaches, gathering requirements before building, or for a decision with several parts: better than back-and-forth chat for structured input. " +
    "Pass questions as inline JSON (preferred) or a path to a JSON file. " +
    'Format: { "title": "...", "description": "...", "questions": [{ "id": "q1", "type": "single|multi|text|image|info", "question": "...", "options": ["A", "B"], "context": "...", "content": { "source": "...", "lang": "ts" }, "media": { "type": "image|mermaid|table|html", ... } }] }. ' +
    "Options are strings or { label, content? }. single and multi questions also offer Other, with a text field. " +
    "Set recommended (with context explaining why): those options show a Recommended badge and are pre-selected. " +
    'conviction: "slight" when unsure (not pre-selected), "strong" when very sure. weight: "critical" for key decisions, "minor" for small ones. ' +
    "When there are recommendations, set description to guide the review (e.g. 'Review my suggestions and adjust as needed'). " +
    'content shows code or Markdown (lang "md") above the options; Markdown can hold ```mermaid diagrams. ' +
    'Media: { type: "image", src, alt, caption } (a file path or data: URL), { type: "table", table: { headers, rows, highlights } }, { type: "mermaid", mermaid: "flowchart LR..." } (for charts too: pie, xychart), { type: "html", html }. ' +
    "Types: single (one choice), multi (several), text (free text), image (photos the person takes or picks, returned as file paths: read them), info (context only, no answer). " +
    "async: true returns at once with the interview's id, so you keep working; the answers come later in a message starting \"Interview <id> finished.\", which starts a turn when you are idle.";

const TASK = "pocket.interview";
/** Sends of an async interview's answers before it gives up (see `deliver.ts`). */
const MAX_SENDS = 5;
const BACKGROUND = { ownership: { kind: "conversation" }, background: true } as const;

type AsyncInput = { callId: string; title: string; timeout?: number; deadline?: number };
type AsyncState = { phase: "ask" } | { phase: "report"; text: string; attempt: number };

/** The short id Pi and the person see for an async interview. */
const shortId = (callId: string) => callId.replace(/[^A-Za-z0-9]/g, "").slice(-8);

/** In every prompt while the module is on. */
export const ASKING = `Asking the person: when you need them to choose between options, or to answer several things at once (requirements, a decision with parts, which of several next steps), call interview instead of writing the questions in chat. Give your recommendation with each question. A single yes/no question, or one short question, stays in chat. Ask before acting, not after.`;

export default function createInterview(host: PocketHost) {
    /**
     * Wait for the person: the interview's card asks them (an approval with the form), the phone tells them. Answered
     * in its form, its status is set there; denied from its card, or timed out at `deadline` (ms), `settle` marks it
     * so (`ending`) and gives the interview as it ended.
     */
    const waitForPerson = async (
        where: { conversationId: ConversationId; taskId: TaskId; callId: string },
        item: Interview,
        deadline: number | undefined,
        settle: (ending: (items: Record<string, Interview>) => Interview) => Promise<Interview>,
        context: Context,
    ): Promise<Interview> => {
        const { questions } = item;
        const id = `interview-${String(where.taskId)}-${where.callId}`;
        const title = questions.title ?? "Questions";
        let timer: ReturnType<typeof setTimeout> | undefined;
        let timedOut = false;

        if (deadline !== undefined) {
            timer = setTimeout(() => {
                timedOut = true;
                host.approvals.answer(id, { allow: false, by: "timeout" });
            }, Math.max(0, deadline - Date.now()));
        }

        try {
            await host.approvals.request(
                {
                    id,
                    conversationId: where.conversationId,
                    taskId: where.taskId,
                    callId: where.callId,
                    tool: "interview",
                    subject: title,
                    reason: questions.description ?? "",
                    form: { type: "interview", callId: where.callId, title, count: questions.questions.filter((question) => question.type !== "info").length },
                    createdAt: Date.now(),
                },
                context,
            );
        } finally {
            clearTimeout(timer);
        }

        return settle((items) => {
            const ended = items[where.callId]!;

            if (ended.status === "waiting") {
                ended.status = timedOut ? "timeout" : "cancelled";
                ended.at = Date.now();
            }

            return JSON.parse(JSON.stringify(ended)) as Interview;
        });
    };

    const finishedText = (callId: string, item: Interview, timeout: number | undefined) =>
        `Interview ${shortId(callId)} finished.\n\n${outcomeText(item, timeout)}`;

    /** An async interview: waits for the person in the background, then tells Pi, once. */
    const AsyncInterview = defineTask<AsyncInput, AsyncState, null>({
        name: TASK,
        version: 1,
        initial: () => ({ phase: "ask" }),
        phases: {
            ask: async (task, runtime, context) => {
                const { callId, timeout, deadline } = task.input;
                const item = (await runtime.snapshot(InterviewsDoc, runtime.conversationId, context))?.items[callId];

                if (item === undefined) {
                    return runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: null } }), context);
                }

                // Answered while the app was away, or now.
                const final =
                    item.status === "waiting"
                        ? await waitForPerson(
                              { conversationId: runtime.conversationId, taskId: runtime.taskId, callId },
                              item,
                              deadline,
                              async (ending) => {
                                  let ended: Interview | undefined;

                                  // The task's state stays as it is (undefined); the interview's is marked.
                                  await runtime.commit(async (tx) => {
                                      ended = ending((await tx.doc(InterviewsDoc, runtime.conversationId)).items);

                                      return undefined;
                                  }, context);

                                  return ended!;
                              },
                              context,
                          )
                        : item;

                await runtime.commit(
                    () => ({ status: "running", checkpoint: { phase: "report", text: finishedText(callId, final, timeout), attempt: 0 } }),
                    context,
                );
            },
            report: async (task, runtime, context) => {
                const state = task.state.checkpoint as Extract<AsyncState, { phase: "report" }>;

                if (state.attempt >= MAX_SENDS) {
                    host.notice("warning", `Pi could not be told the answers of "${task.input.title}": ${MAX_SENDS} sends were withdrawn.`, runtime.conversationId);

                    return runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: null } }), context);
                }

                const sent = await sendFollowUp(
                    runtime,
                    state.text,
                    `interview:${String(runtime.taskId)}${state.attempt === 0 ? "" : `:${state.attempt}`}`,
                    context,
                );

                await runtime.commit(
                    () =>
                        sent === "delivered"
                            ? { status: "terminal", outcome: { status: "completed", result: null } }
                            : { status: "running", checkpoint: { phase: "report", text: state.text, attempt: state.attempt + 1 } },
                    context,
                );
            },
        },
        abort: (_task, runtime, context) => runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }) as const, context),
    });

    const interview = defineTool({
        name: "interview",
        description: DESCRIPTION,
        parameters: Type.Object({
            questions: Type.String({ description: "Inline JSON with the questions, or a path to a JSON file" }),
            timeout: Type.Optional(
                Type.Number({ description: "Seconds before the form ends without the person; default: no limit" }),
            ),
            async: Type.Optional(
                Type.Boolean({ description: "Return at once; the answers come later as a message starting \"Interview <id> finished.\"" }),
            ),
        }),
        // Waiting for a person: after a restart, it asks again, or takes the answer given meanwhile.
        replay: "safe",
        execute: async (args, api, context) => {
            const cwd = (await api.agent(context)).cwd ?? "";
            let source = args.questions.trim();

            if (!source.startsWith("{") && !source.startsWith("`")) {
                const read = await host.envOf(cwd).readTextFile(source, context);

                if (!read.ok) {
                    return reply(`Could not read the questions file ${source}: ${read.error.message}`, undefined, true);
                }

                source = read.value;
            }

            let questions: QuestionsFile;

            try {
                questions = validateQuestions(parseQuestions(source));
            } catch (error) {
                return reply(error instanceof Error ? error.message : String(error), undefined, true);
            }

            const callId = api.callId;
            // The draft starts with what Pi recommends, pre-selected, unless it is unsure.
            const prefill = questions.questions.flatMap((question) =>
                question.recommended === undefined || question.conviction === "slight"
                    ? []
                    : [
                          {
                              id: question.id,
                              value: Array.isArray(question.recommended)
                                  ? question.recommended.map((option) => ({ option }))
                                  : { option: question.recommended },
                          },
                      ],
            );
            const timeout = args.timeout !== undefined && args.timeout > 0 ? args.timeout : undefined;

            if (args.async === true) {
                // Once per call: after a restart, the task made the first time goes on.
                await api.commit(async (tx) => {
                    const items = (await tx.doc(InterviewsDoc, api.conversationId)).items;

                    if (items[callId] === undefined) {
                        items[callId] = { questions, draft: prefill, status: "waiting", createdAt: Date.now() };
                        await tx.createTask(
                            AsyncInterview,
                            {
                                callId,
                                title: questions.title ?? "Questions",
                                ...(timeout === undefined ? {} : { timeout, deadline: Date.now() + timeout * 1000 }),
                            },
                            BACKGROUND,
                        );
                    }
                }, context);

                return reply(
                    `Interview ${shortId(callId)} is open in the app for the person to answer. Keep working, or end your turn: the answers come in a message starting "Interview ${shortId(callId)} finished."`,
                    { status: "async", id: shortId(callId), title: questions.title ?? "" },
                );
            }

            const start = await api.commit(async (tx) => {
                const items = (await tx.doc(InterviewsDoc, api.conversationId)).items;

                items[callId] ??= { questions, draft: prefill, status: "waiting", createdAt: Date.now() };

                return JSON.parse(JSON.stringify(items[callId])) as Interview;
            }, context);
            const ended = (item: Interview) =>
                reply(outcomeText(item, args.timeout), { status: item.status, title: item.questions.title ?? "" });

            if (start.status !== "waiting") {
                return ended(start);
            }

            return ended(
                await waitForPerson(
                    { conversationId: api.conversationId, taskId: api.taskId, callId },
                    start,
                    timeout === undefined ? undefined : Date.now() + timeout * 1000,
                    (ending) => api.commit(async (tx) => ending((await tx.doc(InterviewsDoc, api.conversationId)).items), context),
                    context,
                ),
            );
        },
    });

    return defineExtension({
        name: "pocket-interview",
        tools: [interview],
        tasks: [AsyncInterview],
        // A rule, not only the tool's description: the habit of asking in chat is stronger than a description.
        sections: [section("asking", () => ASKING)],
    });
}
