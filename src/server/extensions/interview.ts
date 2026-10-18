/**
 * `interview`: a form of questions for the person, as pi-interview has it (its question format and its words back to
 * Pi, `interviews.ts`), shown in the app instead of a browser window. The call waits like an approval: its card in the
 * conversation has Answer, which opens the form; the phone tells the person; the session shows it waits for them. The
 * questions and the person's draft are in the conversation (`InterviewsDoc`), so a restart loses nothing: the call asks
 * again, or finds the answer given while it was away.
 */
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
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
    "Types: single (one choice), multi (several), text (free text), image (photos the person takes or picks, returned as file paths: read them), info (context only, no answer).";

export default function createInterview(host: PocketHost) {
    const interview = defineTool({
        name: "interview",
        description: DESCRIPTION,
        parameters: Type.Object({
            questions: Type.String({ description: "Inline JSON with the questions, or a path to a JSON file" }),
            timeout: Type.Optional(
                Type.Number({ description: "Seconds before the form ends without the person; default: no limit" }),
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

            const id = `interview-${String(api.taskId)}-${callId}`;
            const title = questions.title ?? "Questions";
            let timer: ReturnType<typeof setTimeout> | undefined;
            let timedOut = false;

            if (args.timeout !== undefined && args.timeout > 0) {
                timer = setTimeout(() => {
                    timedOut = true;
                    host.approvals.answer(id, { allow: false, by: "timeout" });
                }, args.timeout * 1000);
            }

            try {
                await host.approvals.request(
                    {
                        id,
                        conversationId: api.conversationId,
                        taskId: api.taskId,
                        callId,
                        tool: "interview",
                        subject: title,
                        reason: questions.description ?? "",
                        form: { type: "interview", callId, title, count: questions.questions.filter((question) => question.type !== "info").length },
                        createdAt: Date.now(),
                    },
                    context,
                );
            } finally {
                clearTimeout(timer);
            }

            // Answered in its form, the status is set there; denied from its card or timed out, it is set here.
            const final = await api.commit(async (tx) => {
                const item = (await tx.doc(InterviewsDoc, api.conversationId)).items[callId]!;

                if (item.status === "waiting") {
                    item.status = timedOut ? "timeout" : "cancelled";
                    item.at = Date.now();
                }

                return JSON.parse(JSON.stringify(item)) as Interview;
            }, context);

            return ended(final);
        },
    });

    return defineExtension({ name: "pocket-interview", tools: [interview] });
}
