/**
 * Persistent background subagents, after Pi Durable's example 23. One `subagent` tool spawns named subagents,
 * messages them, stops them, and lists them. Each subagent is its own conversation, so a user can open it, watch it
 * work, and talk to it. Their answers go back to the parent at its next pause: after a tool call, or, when it is idle,
 * a moment after. Answers that arrive meanwhile wait together, and go as one message, so many subagents cost the
 * parent one extra turn at most rather than one each, and its queue holds one message of theirs at a time.
 *
 * Everything survives a restart: anchors, reporters, and the courier that delivers reports are durable tasks, and
 * request IDs keep a restarted task from delivering a message or a report twice.
 *
 * Models are a person's to choose: a subagent runs on its session's model, thinking no harder than the session, unless
 * the owner allowed other models for subagents (`subagentModels`), and then only on one of those. A subagent its model
 * or provider failed is reported as such, and Pi is told to stop and tell the user, never to try another model.
 */
import type { AssistantMessage, ModelThinkingLevel } from "@earendil-works/pi-ai";
import { clampThinkingLevel } from "@earendil-works/pi-ai";
import { arr, bool, obj, opt, str, union } from "@earendil-works/pi-schema";
import { literal } from "../tool-schema.ts";
import type { Context } from "@earendil-works/chord/context";
import {
    AgentDoc,
    AssistantEntry,
    type ConversationId,
    configure,
    defineExtension,
    defineTask,
    defineTool,
    type Extension,
    InboxDoc,
    LiveDoc,
    type ModelRef,
    section,
    type SubmissionId,
    type SubmissionRecord,
    type TaskRuntime,
    type ToolExecutionApi,
    type Tx,
} from "@earendil-works/pi-durable";
import { type PendingReport, REPORT_PREFIX, SubagentsDoc } from "../docs.ts";
import { describe } from "../errors.ts";
import type { PocketHost } from "../host.ts";
import type { ResolvedSubagentDefaults } from "../subagent-defaults.ts";
import { levelAtMost, sameModel, THINKING_LEVELS } from "../models.ts";
import { requestFor } from "../requests.ts";
import { diffLines, githubReview, parseReviewResult, prepareReview, quote, type ReviewTarget, reviewGuidelines, reviewPrompt } from "../review.ts";
import { whyUnanswered } from "../subagent-runs.ts";
import { BetterTask, BRIEF_MARK } from "../better.ts";

// Exclude Agent Teams by name even while it is off; enabling it later must not give nested agents delegation.
const AgentTeams = defineExtension({ name: "pocket-agent-teams" });

function textOf(message: AssistantMessage | undefined): string {
    return (message?.content ?? [])
        .flatMap((part) => (part.type === "text" ? [part.text] : []))
        .join("");
}

/** Why a report says its subagent went idle: its run ended without taking the message, and none will. */
const IDLE = "went idle without taking the message; send it again";

/**
 * A subagent's conversation is owned by an anchor: a background task that finishes at once. Background tasks are a
 * boundary, so the parent's Esc and idle waits do not reach the subagent, while `abort({ background: true })` still does.
 */
const Anchor = defineTask<null, { phase: "done" }, null>({
    name: "pocket.subagent-anchor",
    version: 1,
    initial: () => ({ phase: "done" }),
    phases: {
        done: (_anchor, runtime, context) =>
            runtime.commit(
                () => ({ status: "terminal", outcome: { status: "completed", result: null } }),
                context,
            ),
    },
    abort: (_anchor, runtime, context) =>
        runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context),
});

/** `requestedBy`: whom the parent worked for when it sent the message, whose work the subagent's then is. */
type ReporterInput = {
    name: string;
    conversationId: ConversationId;
    message: string;
    followUp: boolean;
    requestedBy?: string;
};
type ReporterState = { phase: "deliver" } | { phase: "report"; report?: string };

/** Delivers one message to a subagent, waits for the answer, and reports it to the parent, through `Courier`. */
function reporterFor(Courier: CourierTask, host: Pick<PocketHost, "notice">) {
    return defineTask<ReporterInput, ReporterState, null>({
        name: "pocket.subagent-reporter",
        version: 1,
        initial: () => ({ phase: "deliver" }),
        phases: {
            deliver: async (reporter, runtime, context) => {
                const { name, conversationId, message, followUp, requestedBy } = reporter.input;
                const subagent = (await runtime.conversation(conversationId, context))!;
                const request = {
                    type: "input",
                    content: message,
                    whenBusy: followUp ? "followUp" : "steer",
                } as const;
                const requestId =
                    requestedBy === undefined
                        ? `subagent:${reporter.id}`
                        : requestFor(requestedBy, `subagent-${reporter.id}`);
                const submission = await subagent.submit({ ...request, requestId }, context);
                // Pi Durable leaves a failed run's inbox alone, so a queued follow-up waits for a boundary that never
                // comes: once the subagent is idle with it still queued, withdraw it, which ends the wait below.
                const watch = await runtime.watchDoc(LiveDoc, conversationId, context);
                let withdrawn = false;
                // The withdrawal under way, if any. It settles the wait below before it can say it withdrew.
                let withdrawing: Promise<unknown> = Promise.resolve();
                let settled: Awaited<ReturnType<typeof submission.wait>>;

                try {
                    if (watch !== undefined) {
                        // Once withdrawn it stays so: a later call finds the submission settled, which changes nothing.
                        const strand = async (live: NonNullable<typeof watch>["value"]) => {
                            if (live !== null && live.run === undefined) {
                                const abort = submission.abort(context);

                                withdrawing = abort;

                                if ((await abort) === "aborted") {
                                    withdrawn = true;
                                }
                            }
                        };

                        // A listener is never called inline, so the value it started on is this one's to check.
                        await strand(watch.value);
                        watch.start(async (call) => {
                            if (call.kind === "value") {
                                await strand(call.value);
                            }
                        });
                    }

                    settled = await submission.wait(context);
                } finally {
                    // On every way out, so no watch outlives the phase.
                    await watch?.stop();
                    // Stopping leaves a call under way running. Its reaction to the withdrawal was added first, so it
                    // sets `withdrawn` before this goes on. A failed withdrawal surfaces where it was made.
                    await withdrawing.catch(() => {});
                }

                // A failure of its model or provider (a sign-in, a model that is gone, a quota): named, with the model.
                const modelFailed =
                    !withdrawn &&
                    settled.status === "unanswered" &&
                    modelFailure(settled.reason, settled.detail);
                const ran = modelFailed
                    ? (await runtime.snapshot(AgentDoc, conversationId, context))?.model
                    : undefined;
                const ranOn = ran === undefined ? "" : `${ran.provider}/${ran.modelId}: `;

                await runtime.commit(async (tx) => {
                    const next = (report?: string) =>
                        ({ status: "running", checkpoint: { phase: "report", report } }) as const;

                    const agent = (await tx.doc(SubagentsDoc, runtime.conversationId)).agents[name];

                    if (settled.status === "unanswered") {
                        const why = withdrawn
                            ? IDLE
                            : `${ranOn}${whyUnanswered(settled.reason, settled.detail)}`;

                        if (agent !== undefined) {
                            agent.answeredAt = Date.now();
                            agent.failed = true;
                            agent.error = why;
                        }

                        // Stopped too: Pi may be waiting for its answer, and is told none comes. One its model failed
                        // tells Pi to stop and tell its person, not to try again on another model.
                        return next(
                            `${REPORT_PREFIX}${name} failed: ${why}]${modelFailed ? ` ${MODEL_FAILED}` : ""}`,
                        );
                    }

                    if (settled.type !== "input") {
                        return next();
                    }

                    if (agent === undefined || agent.reported.includes(settled.answer)) {
                        return next();
                    }

                    agent.reported.push(settled.answer);
                    agent.answeredAt = Date.now();
                    agent.failed = false;
                    delete agent.error;
                    const answer = (await tx.entry(AssistantEntry, settled.answer))?.model?.[0] as
                        AssistantMessage | undefined;

                    return next(
                        `${REPORT_PREFIX}${name} answered, no reply needed] ${textOf(answer)}`,
                    );
                }, context);

                // The people in the session see it at once, as well as in its report.
                if (modelFailed && settled.status === "unanswered") {
                    host.notice(
                        "warning",
                        `Subagent ${name} failed: ${ranOn}${whyUnanswered(settled.reason, settled.detail)}. Pi was told to stop and tell you, not to switch models.`,
                        runtime.conversationId,
                    );
                }
            },
            // The report waits with the others for the courier, which this starts when none is at work. A batch still in the
            // parent's queue takes it too: it is taken back out, and goes again with this one, so the queue holds one
            // message of reports, with all of them.
            report: (reporter, runtime, context) =>
                runtime.commit(async (tx) => {
                    const report = reporter.state.checkpoint.report;

                    // Before 0.12 a reporter sent its report itself, under this request: one stopped by a restart (an
                    // upgrade) after sending it, and before it ended, has nothing left to send.
                    const sentBefore =
                        report !== undefined &&
                        (await tx.submissionByRequest(
                            runtime.conversationId,
                            `subagent-report:${reporter.id}`,
                        )) !== undefined;

                    if (report !== undefined && !sentBefore) {
                        const id = runtime.conversationId;
                        const state = await tx.doc(SubagentsDoc, id);
                        // Reads first: a commit reads the tables only before it writes one.
                        const queued = await queuedBatch(tx, id, state.sending?.request);
                        const idle = !(await working(tx, state.courier));
                        const taken = queued === undefined ? [] : (state.sending?.reports ?? []);

                        if (queued !== undefined) {
                            await unqueue(tx, id, queued);
                            delete state.sending;
                        }

                        // Assigned whole: a document keeps its own copy of what is assigned to it.
                        state.outbox = [
                            ...taken,
                            ...(state.outbox ?? []),
                            { name: reporter.input.name, text: report },
                        ];

                        if (idle) {
                            state.courier = await tx.createTask(Courier, null, BACKGROUND);
                        }
                    }

                    return { status: "terminal", outcome: { status: "completed", result: null } };
                }, context),
        },
        abort: (_reporter, runtime, context) =>
            runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context),
    });
}

/** Tasks of a conversation that run beside its work: its Esc and idle waits do not reach them. */
const BACKGROUND = { ownership: { kind: "conversation" }, background: true } as const;

/**
 * What a provider says when the model or its account is the problem (a sign-in, a model that is gone or refused, a
 * quota or rate limit, an overload), not the request: a context that will not fit, say, is Pi's to work around.
 */
const PROVIDER_TROUBLE =
    /oauth|sign.?in|auth|api.?key|unauthori[sz]ed|forbidden|permission|\b(401|402|403|404|429|503|529)\b|not found|does not exist|no such model|not available|not configured|unsupported model|quota|rate.?limit|insufficient|billing|credit|usage limit|overloaded/i;

/** Whether a run ended unanswered because of its model or provider: no model to use, or the provider's trouble. */
function modelFailure(reason: string, detail: unknown): boolean {
    return (
        reason === "no_model" ||
        (reason === "model_error" && typeof detail === "string" && PROVIDER_TROUBLE.test(detail))
    );
}

/** What a report of a subagent its model failed tells Pi, after why. */
export const MODEL_FAILED =
    "Its model or provider failed. Do not start it again on another model, and do not work around it: stop, and tell the user what failed and why. Only the user chooses models, and signs in again.";

/** The submission of the batch `request`, while it waits in `conversationId`'s queue; undefined once it has left. */
async function queuedBatch(
    tx: Tx,
    conversationId: ConversationId,
    request: string | undefined,
): Promise<SubmissionId | undefined> {
    if (request === undefined) {
        return undefined;
    }

    const record = await tx.submissionByRequest(conversationId, request);

    return record?.status === "queued" ? record.id : undefined;
}

/** Take a waiting batch back out of the queue, as withdrawing it does, to send its reports again with more. */
async function unqueue(tx: Tx, conversationId: ConversationId, id: SubmissionId): Promise<void> {
    const items = (await tx.doc(InboxDoc, conversationId)).items;
    const index = items.findIndex((item) => item.id === id);

    if (index !== -1) {
        items.splice(index, 1);
    }

    tx.settleSubmission(id, { status: "unanswered", reason: "merged" });
}

/** Whether a task is there and can still take reports. */
async function working(tx: Tx, task: number | undefined): Promise<boolean> {
    if (task === undefined) {
        return false;
    }

    const status = (await tx.task(task as never))?.state.status;

    // One completing has taken its last reports already.
    return status === "pending" || status === "running" || status === "waiting" || status === "sleeping";
}

/** Wait until the submission `id` has left `conversationId`'s queue: placed, withdrawn, or aborted. */
async function leftQueue(
    runtime: TaskRuntime<null, CourierState, null, object>,
    conversationId: ConversationId,
    id: SubmissionId,
    context: Context,
): Promise<void> {
    const queued = (value: { items?: readonly { id: SubmissionId }[] } | null) =>
        (value?.items ?? []).some((item) => item.id === id);
    const watch = await runtime.watchDoc(InboxDoc, conversationId, context);

    if (watch === undefined || !queued(watch.value)) {
        await watch?.stop();

        return;
    }

    try {
        await new Promise<void>((resolve, reject) => {
            watch.start(async (call) => {
                if (call.kind === "value" && !queued(call.value)) {
                    resolve();
                }
            });
            // The watch ends with the invocation (a restart, say): the phase runs again then.
            void watch.closed.then(() => reject(new Error("The queue's watch ended")), reject);
        });
    } finally {
        await watch.stop();
    }
}

/**
 * `batch` and `text`: where an earlier build kept the batch, for a courier it left in "send". "hold": a spend limit
 * holds the reports back.
 */
type CourierState =
    | { phase: "gather" }
    | { phase: "next" }
    | { phase: "hold" }
    | { phase: "send"; batch?: number; text?: string };

/** What the courier asks Pi Pocket about spend limits. */
type Limits = Pick<PocketHost, "heldBack" | "onLimitsChanged" | "notice">;

type CourierTask = ReturnType<typeof courierFor>;

/**
 * How long reports a limit holds back wait before the courier looks again, at most: a changed limit wakes it at once,
 * and this catches the rest (someone else, with spend left, now pays there).
 */
const HOLD_MS = 30_000;

/** How long a courier that met something unexpected waits before it tries again. */
const RETRY_MS = 5_000;

/**
 * What became of the batch a courier took (`state.sending`), from its submission, settled in `state`: kept while it is
 * still to send or waits in the parent's queue; gone once Pi has it. Taken out of the queue before Pi had it, it is
 * gone if a person did that (the queue's ×, or Stop, which mark it `discarded`), and otherwise (a spend limit's stop, a
 * new context) its reports wait again, first.
 */
function settleBatch(
    state: { outbox?: PendingReport[]; sending?: { reports: PendingReport[]; discarded?: true } },
    record: SubmissionRecord | undefined,
): void {
    const sending = state.sending;

    if (sending === undefined || record === undefined || record.status === "queued") {
        return;
    }

    if (
        record.status === "unanswered" &&
        record.entry === undefined &&
        sending.discarded !== true
    ) {
        state.outbox = [...sending.reports, ...(state.outbox ?? [])];
    }

    delete state.sending;
}

/** How long a courier waits, for a parent that is idle, for more reports to go with the first. */
const GATHER_MS = 2_000;

/** Wait `ms`, or until `signal` ends the wait, as Pi Durable's own waits do. */
function pause(ms: number, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();

    return new Promise((resolve, reject) => {
        const stop = () => {
            clearTimeout(timer);
            reject(signal.reason);
        };

        const timer = setTimeout(() => {
            signal.removeEventListener("abort", stop);
            resolve();
        }, ms);

        signal.addEventListener("abort", stop, { once: true });
    });
}

/**
 * Takes all the reports waiting and sends them to the parent as one message, to steer it at its next pause, or to wake
 * it when it is idle, after a moment for others. It sends the next ones only once that message has left the parent's
 * queue, so the queue holds one at a time; reports that arrive meanwhile join it there, or go in the next. It ends
 * when none are waiting. The batch it took stays in `sending` until it has left the queue, so a courier that stops
 * early loses none: the next sends it, once. While the parent's session, or whoever pays there, is past a spend limit,
 * the reports wait (saying why, in `held`) rather than start a turn nobody may pay for, and go once the limit is raised.
 */
function courierFor(limits: Limits) {
    // A server older than this module has neither: extension modules reload into the running server, while the
    // server's own part waits for a restart. Then nothing is held back, as before limits held reports.
    const { heldBack, onLimitsChanged } = limits as Partial<Limits>;
    const heldFor = (id: ConversationId) =>
        typeof heldBack === "function" ? heldBack(id) : undefined;

    const whenLimitsChange = (listener: () => void) =>
        typeof onLimitsChanged === "function" ? onLimitsChanged(listener) : () => {};

    // Couriers that said so already: a courier that keeps meeting a problem says it once.
    const told = new Set<string>();

    /**
     * Run a phase; if it meets something unexpected, say so once, wait, and start over from "gather" rather than end with the
     * reports left waiting (the next courier starts only with the next report). A fixed module reloads into the running
     * server, and the courier carries on with it.
     */
    const orRetry = async (
        courier: { id: string | number },
        runtime: TaskRuntime<null, CourierState, null, object>,
        context: Context,
        phase: () => Promise<void>,
    ) => {
        const signals = [runtime.signal, context.abortSignal].filter(
            (signal): signal is AbortSignal => signal !== undefined,
        );

        try {
            await phase();
        } catch (error) {
            if (signals.some((signal) => signal.aborted)) {
                throw error;
            }

            if (!told.has(String(courier.id))) {
                told.add(String(courier.id));
                limits.notice?.("warning", `Subagents' reports wait: ${describe(error)}`);
            }

            await pause(RETRY_MS, AbortSignal.any(signals));
            // From "gather", not the phase that failed: committing the same step again is no progress, which faults.
            await runtime.commit(
                () => ({ status: "running", checkpoint: { phase: "gather" } }),
                context,
            );
        }
    };

    return defineTask<null, CourierState, null>({
        name: "pocket.subagent-courier",
        version: 1,
        initial: () => ({ phase: "gather" }),
        phases: {
            // A parent that is idle would start a turn for the first report alone: subagents started together often finish
            // a moment apart, so it waits that moment for theirs. A busy parent takes the batch at its next pause, and
            // reports that come meanwhile join it in its queue.
            gather: async (_courier, runtime, context) => {
                const live = await runtime.snapshot(LiveDoc, runtime.conversationId, context);

                if (live?.run === undefined) {
                    // Ended by the invocation's signal, or the phase's own, as Pi Durable's waits are.
                    const signals = [runtime.signal, context.abortSignal].filter(
                        (signal): signal is AbortSignal => signal !== undefined,
                    );

                    await pause(GATHER_MS, AbortSignal.any(signals));
                }

                await runtime.commit(
                    () => ({ status: "running", checkpoint: { phase: "next" } }),
                    context,
                );
            },
            next: (courier, runtime, context) =>
                orRetry(courier, runtime, context, async () => {
                    await runtime.commit(async (tx) => {
                        const state = await tx.doc(SubagentsDoc, runtime.conversationId);
                        // Reads first: a commit reads the tables only before it writes one.
                        const record =
                            state.sending === undefined
                                ? undefined
                                : await tx.submissionByRequest(
                                      runtime.conversationId,
                                      state.sending.request,
                                  );

                        delete state.delivering;

                        // A batch an earlier courier sent that still waits in Pi's queue: see it leave first. It is
                        // Pi's already, whatever the limits say now.
                        if (record?.status === "queued") {
                            return { status: "running", checkpoint: { phase: "send" } };
                        }

                        settleBatch(state, record);

                        if (state.sending === undefined && (state.outbox ?? []).length === 0) {
                            delete state.courier;
                            delete state.held;

                            return {
                                status: "terminal",
                                outcome: { status: "completed", result: null },
                            };
                        }

                        // Past a spend limit, the parent may start no turn for them: they wait, and say why.
                        const held = heldFor(runtime.conversationId);

                        if (held !== undefined) {
                            if (state.held !== held) {
                                state.held = held;
                            }

                            return { status: "running", checkpoint: { phase: "hold" } };
                        }

                        delete state.held;

                        // A batch taken and not sent yet goes first, under its own id.
                        if (state.sending === undefined) {
                            const reports = state.outbox ?? [];
                            const batch = (state.batches ?? 0) + 1;

                            state.batches = batch;
                            state.outbox = [];
                            state.sending = {
                                request: `subagent-reports:${courier.id}:${batch}`,
                                reports,
                            };
                        }

                        return { status: "running", checkpoint: { phase: "send" } };
                    }, context);
                }),
            // Until a limit changes (the owner raised it) or a while passes, then look again.
            hold: async (_courier, runtime, context) => {
                const signals = [runtime.signal, context.abortSignal].filter(
                    (signal): signal is AbortSignal => signal !== undefined,
                );
                const changed = new AbortController();
                const stop = whenLimitsChange(() => changed.abort());

                try {
                    await pause(HOLD_MS, AbortSignal.any([...signals, changed.signal]));
                } catch (error) {
                    // A changed limit ends the wait early; anything else (the task stopping) is the task's to handle.
                    if (!changed.signal.aborted) {
                        throw error;
                    }
                } finally {
                    stop();
                }

                await runtime.commit(
                    () => ({ status: "running", checkpoint: { phase: "next" } }),
                    context,
                );
            },
            send: (courier, runtime, context) =>
                orRetry(courier, runtime, context, async () => {
                    const checkpoint = courier.state.checkpoint as Extract<
                        CourierState,
                        { phase: "send" }
                    >;
                    const parentId = runtime.conversationId;
                    const sending =
                        checkpoint.text === undefined
                            ? (await runtime.snapshot(SubagentsDoc, parentId, context))?.sending
                            : {
                                  request: `subagent-reports:${courier.id}:${checkpoint.batch}`,
                                  reports: [{ name: "", text: checkpoint.text }],
                              };

                    if (sending !== undefined) {
                        const parent = (await runtime.conversation(parentId, context))!;
                        // Under its own id: a batch sent before is not sent again, and its submission is what it was.
                        const submission = await parent.submit(
                            {
                                type: "input",
                                content: sending.reports.map((report) => report.text).join("\n\n"),
                                whenBusy: "steer",
                                requestId: sending.request,
                            },
                            context,
                        );

                        await leftQueue(runtime, parentId, submission.id, context);
                    }

                    await runtime.commit(async (tx) => {
                        const state = await tx.doc(SubagentsDoc, parentId);
                        // Reads first: a commit reads the tables only before it writes one.
                        const record =
                            sending === undefined
                                ? undefined
                                : await tx.submissionByRequest(parentId, sending.request);

                        if (
                            state.sending !== undefined &&
                            state.sending.request === sending?.request
                        ) {
                            settleBatch(state, record);
                        }

                        delete state.delivering;

                        return { status: "running", checkpoint: { phase: "next" } };
                    }, context);
                }),
        },
        // Stopped with its conversation: what waits, and the batch it took, stay for the next courier.
        abort: (_courier, runtime, context) =>
            runtime.commit(async (tx) => {
                delete (await tx.doc(SubagentsDoc, runtime.conversationId)).courier;

                return { status: "terminal", outcome: { status: "aborted" } };
            }, context),
    });
}

const GUIDE = `You can delegate to background subagents with the subagent tool. A subagent is a separate agent with its own transcript that works while you keep talking to the user; its answer comes back to you at your next pause (after a tool call, or when you are done) as a message starting with "${REPORT_PREFIX}<name> answered". Answers that arrive together come in one message. Use them for independent, self-contained work (research, long builds, test runs, a second opinion). Give each message everything the subagent needs: it does not see this conversation. Write it in the language of the person you work for, and ask for the report in that language. Do not poll: wait for the report. The user can open a subagent and talk to it directly.
A subagent runs on the subagents' model and thinking level the owner set (Menu › Subagents, or a session's own in its menu), or on your model and level when none is set. Models are the user's to choose: pass model or thinking on a spawn only when the person asks for one in the chat, and never pick one on your own. The models tool shows which models are ready, their plan limits, and which are allowed for subagents; another model the person asks for waits for the owner's card. If a subagent fails because of its model or provider (a sign-in, a missing model, a quota), stop and tell the user what failed; never start it again on another model.`;

/** The models the owner allows subagents besides their session's own; none on a server older than the choice. */
function allowedModels(host: PocketHost): readonly string[] {
    return typeof host.subagentModels === "function" ? host.subagentModels() : [];
}

const keyOf = (ref: ModelRef) => `${ref.provider}/${ref.modelId}`;

const same = (a: ModelRef | undefined, b: ModelRef | undefined) =>
    a !== undefined && b !== undefined && keyOf(a) === keyOf(b);

/** Why Pi may not use a model now (its sign-in, say), or undefined; nothing to say on a server older than the check. */
async function problemOf(host: PocketHost, ref: ModelRef, fresh: boolean) {
    return typeof host.modelProblem === "function" ? host.modelProblem(ref, fresh) : undefined;
}

/** The subagents' model and thinking a conversation's setting gives (PP-281); none on a server older than the setting. */
function defaultsOf(host: PocketHost, conversationId: ConversationId): ResolvedSubagentDefaults {
    return typeof host.subagentDefaults === "function"
        ? host.subagentDefaults(conversationId)
        : { from: { model: "session", thinking: "session" } };
}

/** A model by its name, or an Error that tells Pi to go to the user, never to pick another. */
function resolved(host: PocketHost, spec: string, what: string): ModelRef {
    try {
        return host.resolveModel(spec);
    } catch (error) {
        throw new Error(`${what}: ${describe(error)} Do not pick another model: stop and tell the user.`);
    }
}

/** Refused when its sign-in does not work now (asked afresh), with what to tell the user. */
async function usable(host: PocketHost, ref: ModelRef): Promise<void> {
    const problem = await problemOf(host, ref, true);

    if (problem !== undefined) {
        throw new Error(`${keyOf(ref)} cannot be used now: ${problem}. Stop and tell the user; do not use another model instead.`);
    }
}

/**
 * The model a new subagent runs on (PP-281): undefined for this session's own. Without one asked for, the subagents'
 * setting (`setting`, its session's or every session's). One asked for (the person asked in the chat) runs when it is
 * the setting's or one the owner allows for subagents; another, only after the owner allows it on a card (`approve`),
 * for this subagent. Its sign-in must work now. What is refused says so, and tells Pi to go to the user.
 */
async function chosenModel(
    host: PocketHost,
    asked: unknown,
    own: ModelRef | undefined,
    setting: string | undefined,
    approve: (ref: ModelRef) => Promise<boolean>,
): Promise<{ ref?: ModelRef; approved?: true }> {
    if (asked === undefined) {
        if (setting === undefined || sameModel(setting, own)) {
            return {};
        }

        const ref = resolved(host, setting, `The subagents' model ${setting} (Menu › Subagents)`);

        await usable(host, ref);

        return { ref };
    }

    if (typeof asked !== "string") {
        throw new Error("model is provider/modelId.");
    }

    if (sameModel(asked, own)) {
        return {};
    }

    const ref = resolved(host, asked, asked);
    const key = keyOf(ref);

    if (key !== setting && !allowedModels(host).includes(key)) {
        if (!(await approve(ref))) {
            throw new Error(`The owner did not allow ${key} for this subagent. Do not pick another model on your own: leave model out for the subagents' setting, or ask the user.`);
        }

        await usable(host, ref);

        return { ref, approved: true };
    }

    await usable(host, ref);

    return { ref };
}

/**
 * A subagent's message marked `/better` (PP-506), as pi-better checks pi-subagents' briefs: a read-only helper (a copy
 * of this session, `better.ts`) reads the brief as the subagent would, checks it against the repository with brief.md,
 * and fixes only what would trip the subagent up. The subagent gets the checked brief, or nothing: a failure, a Stop or
 * the 20-minute limit keeps it from starting.
 */
async function checkedBrief(message: string, api: ToolExecutionApi, context: Context): Promise<string> {
    const brief = message.replace(BRIEF_MARK, "").trim();

    if (brief === "") {
        throw new Error("A /better subagent brief needs the brief after /better.");
    }

    // The call's own: stopping the call stops the check.
    const task = await api.createTask(BetterTask, { kind: "brief", brief }, { ownership: { kind: "task", taskId: api.taskId } }, context);
    const outcome = (await api.waitForTask(task, context)).state.outcome;

    if (outcome.status === "aborted") {
        throw new Error("/better was cancelled, so the subagent didn't start.");
    }

    const why =
        outcome.status !== "completed" ? ("error" in outcome && outcome.error !== undefined ? outcome.error.message : outcome.status) : outcome.result.ok ? undefined : outcome.result.detail;

    if (outcome.status !== "completed" || !outcome.result.ok) {
        throw new Error(`/better couldn't check this subagent brief, so the subagent didn't start: ${why ?? "no reason given"}`);
    }

    return outcome.result.improved;
}

/** Where a level stands among the thinking levels, lowest first. */
const rank = (level: ModelThinkingLevel) => THINKING_LEVELS.indexOf(level);

export default function createSubagents(host: PocketHost) {
    const Courier = courierFor(host);
    const Reporter = reporterFor(Courier, host);
    const parameters = obj({
        action: union([
            literal("spawn"),
            literal("send"),
            literal("stop"),
            literal("status"),
        ]),
        name: opt(str({ description: "Short kebab-case name, for example test-runner." })),
        message: opt(str()),
        followUp: opt(bool()),
        thinking: opt(union(THINKING_LEVELS.map((level) => literal(level)), {
                    description:
                        "spawn only, and only when the person asks for a level: its thinking level. Leave it out for the subagents' setting. One its model lacks becomes the nearest lower one it has.",
                })),
        tools: opt(arr(str(), {
                description: "spawn only: the tool names it may use. Default: your tools.",
            })),
        model: opt(str({
                description:
                    "spawn only, and only when the person asks for a model: provider/modelId. Leave it out for the subagents' setting. One the owner does not allow for subagents asks the owner on a card first.",
            })),
    }, { open: true });

    const subagent = defineTool({
        name: "subagent",
        description:
            "Manage persistent background subagents. Actions: spawn (name, message; it runs on the subagents' model and " +
            "thinking level the owner set, or yours; model and thinking only when the person asks for them; tools to " +
            "allow), send (name, message; followUp: true queues it after the current answer instead of steering), stop " +
            "(name: aborts its current work), status (one name, or all). Answers come back to you as messages at your " +
            "next pause; those that arrive together come in one.",
        parameters,
        // Not rerun after a crash: repeating stop could stop newer work. The model sees the interruption and can check
        // with status.
        replay: "unsafe",
        execute: async (args, api, context) => {
            const { action, name, message, followUp } = args;
            // A spawn's details say what it runs on and why (PP-281): the transcript's line shows them.
            let runsOn: { model?: string; thinking?: string; why: "asked" | "approved" | "own" | "all" | "session" } | undefined;
            const reply = (text: string, conversationId?: ConversationId) => ({
                output: [{ type: "text" as const, text }],
                ...(conversationId === undefined || name === undefined
                    ? {}
                    : {
                          details: {
                              action,
                              name,
                              conversationId,
                              ...(message === undefined ? {} : { message }),
                              ...(runsOn === undefined ? {} : runsOn),
                          },
                      }),
            });
            const registry = (await api.snapshot(SubagentsDoc, api.conversationId, context)) ?? {
                agents: {},
                reporters: {},
            };

            if (action === "status") {
                // "all", as the tool's description offers, as well as no name (pi-pocket 0.21.0, PP-132).
                const names = name === undefined || name === "all" ? Object.keys(registry.agents) : [name];
                const lines: string[] = [];

                for (const each of names) {
                    const found = Object.hasOwn(registry.agents, each)
                        ? registry.agents[each]
                        : undefined;

                    if (found === undefined) {
                        continue;
                    }

                    const busy =
                        (await api.snapshot(LiveDoc, found.conversationId, context))?.run !==
                        undefined;

                    lines.push(`${each}: ${busy ? "working" : "idle"}`);
                }

                return reply(lines.length === 0 ? "No subagents." : lines.join("\n"));
            }

            if (name === undefined || name.trim() === "") {
                return reply(`${action} needs a name.`);
            }

            const agent = Object.hasOwn(registry.agents, name) ? registry.agents[name] : undefined;

            if (action !== "spawn" && agent === undefined) {
                return reply(`No subagent named ${name}.`);
            }

            if (action === "stop") {
                await (await api.conversation(agent!.conversationId, context))!.abort(context);

                return reply(`Stopped ${name}.`, agent!.conversationId);
            }

            if (message === undefined || message.trim() === "") {
                return reply(`${action} needs a message.`);
            }

            // A message that starts with /better (PP-506): pi-better's check of a brief, against the repository, first.
            const sent = BRIEF_MARK.test(message) ? await checkedBrief(message, api, context) : message;

            const parent = await api.agent(context);
            // The subagents' model and thinking the owner set (PP-281): this session's own, or every session's.
            const defaults = defaultsOf(host, api.conversationId);
            // The session's own level is the most a subagent may think, unless the owner set the subagents' level.
            const own = parent.thinkingLevel ?? "off";
            const cap = defaults.thinking === undefined ? own : undefined;

            // Work goes to a subagent only on this session's model, the subagents' setting, one the owner allows, or the
            // one the owner allowed for it on a card: one started on a model the owner no longer allows gets none. A model
            // a person set there is the owner's to allow too.
            // A subagent started before thinking was capped, or one a person raised, thinks no harder than the session
            // for this work (unless the owner set the subagents' level): lowered (never raised) as the work is sent.
            let lowered: ModelThinkingLevel | undefined;

            if (action === "send") {
                const child = await api.snapshot(AgentDoc, agent!.conversationId, context);
                const runs = child?.model;
                const level = child?.thinkingLevel;
                const found =
                    runs === undefined
                        ? undefined
                        : api.models.getModel(runs.provider, runs.modelId);

                if (cap !== undefined && level !== undefined && rank(level) > rank(cap)) {
                    lowered = (found === undefined ? undefined : levelAtMost(found, cap)) ?? cap;
                }

                if (runs !== undefined && !same(runs, parent.model)) {
                    const key = keyOf(runs);

                    if (!allowedModels(host).includes(key) && key !== defaults.model && key !== agent!.approvedModel) {
                        throw new Error(
                            `${name} runs on ${key}, which is neither this session's model, the subagents' model, nor one the user allows for subagents. Do not send it work: start a new subagent, which runs on the subagents' setting, or ask the user.`,
                        );
                    }

                    const problem = await problemOf(host, runs, true);

                    if (problem !== undefined) {
                        throw new Error(
                            `${name} runs on ${keyOf(runs)}, which cannot be used now: ${problem}. Stop and tell the user; do not use another model instead.`,
                        );
                    }
                }
            }

            // Resolve spawn options before the commit, so a refused model fails without side effects. A model the owner
            // does not allow for subagents, which the person asked for, waits for the owner's card.
            const named = (args as { model?: unknown }).model;
            const approve = async (ref: ModelRef) =>
                (
                    await host.approvals.request(
                        {
                            id: `subagent-model-${String(api.conversationId)}-${String(api.callId)}`,
                            conversationId: api.conversationId as never,
                            taskId: api.taskId as never,
                            ...(api.callId === undefined ? {} : { callId: api.callId }),
                            tool: "subagent",
                            subject: `Start the subagent ${name} on ${keyOf(ref)}`,
                            reason: "It is not one of the models allowed for subagents (Menu › Subagents). Allow runs this subagent on it; the list stays as it is.",
                            createdAt: Date.now(),
                        },
                        context as never,
                    )
                ).allow;
            const chosen =
                action === "spawn" ? await chosenModel(host, named, parent.model, defaults.model, approve) : {};
            const model = chosen.ref;
            // Tools that only scripts call (codemode's Only mode, PP-379) can be given too: the subagent gets codemode with them.
            const parentTools =
                action === "spawn" && args.tools !== undefined
                    ? [...new Map([...parent.tools, ...parent.callable].map((tool) => [tool.name, tool])).values()]
                    : [];
            const tools =
                args.tools === undefined
                    ? undefined
                    : args.tools.map((tool) => {
                          const found = parentTools.find((each) => each.name === tool);

                          if (found === undefined) {
                              throw new Error(
                                  `Unknown tool ${tool}. Available: ${parentTools.map((each) => each.name).join(", ")}`,
                              );
                          }

                          return found;
                      });
            const codemode = parentTools.find((tool) => tool.name === "codemode");

            // Without codemode, a subagent given only tools that scripts call could call none of them.
            if (codemode !== undefined && tools?.some((tool) => tool.callers?.includes("model") === false) === true && !tools.includes(codemode)) {
                tools.push(codemode);
            }

            // TypeBox infers no type from a union built from a list; the schema itself checks the value.
            const asked = args.thinking as ModelThinkingLevel | undefined;
            // The level asked for, else the subagents' setting, else the session's own; never above the cap.
            const base = asked ?? defaults.thinking ?? own;
            const wanted = cap !== undefined && rank(base) > rank(cap) ? cap : base;
            const most = wanted;
            const notes: string[] = [];
            let thinking: ModelThinkingLevel | undefined;

            if (wanted !== base) {
                notes.push(`no higher than this session's ${own}`);
            }

            // As the model picker does, but never up: the level wanted, and when its model lacks that level, the nearest
            // lower one it has. On this session's own model, the level the session itself gets when even its lowest is
            // above that; on another model, a refusal.
            if (action === "spawn" && (asked !== undefined || defaults.thinking !== undefined || model !== undefined)) {
                const ref = model ?? parent.model;
                const found =
                    ref === undefined ? undefined : api.models.getModel(ref.provider, ref.modelId);
                const lower = found === undefined ? wanted : levelAtMost(found, wanted);

                if (lower === undefined && model !== undefined) {
                    throw new Error(
                        `${keyOf(model)} cannot think as little as this session (${most}). Leave model out, or ask the user.`,
                    );
                }

                thinking =
                    lower ?? (found === undefined ? wanted : clampThinkingLevel(found, wanted));

                if (thinking !== wanted) {
                    notes.push(`its model has no ${wanted}`);
                }
            }

            const result = await api.commit(async (tx) => {
                const state = await tx.doc(SubagentsDoc, api.conversationId);

                if (action === "spawn") {
                    if (Object.hasOwn(state.agents, name)) {
                        return `${name} already exists; use send.`;
                    }

                    const anchor = await tx.createTask(Anchor, null, BACKGROUND);
                    // Owned by a task of this conversation, so it starts as a copy of this agent.
                    const child = await tx.createConversation({
                        ownership: { kind: "task", taskId: anchor },
                    });

                    await configure(tx, child.id, {
                        extensions: { remove: [SubagentTools, AgentTeams] },
                        instructions: `You are the subagent "${name}". You work for another agent, not directly for a person, although a person may open your conversation and talk to you. Answer requests completely but concisely: your final answer is what gets reported back.`,
                        ...(model === undefined ? {} : { model }),
                        ...(thinking === undefined ? {} : { thinkingLevel: thinking }),
                        ...(tools === undefined ? {} : { tools }),
                    });
                    state.agents[name] = {
                        conversationId: child.id,
                        reported: [],
                        ...(chosen.approved === true && model !== undefined ? { approvedModel: keyOf(model) } : {}),
                    };
                }

                const record = state.agents[name]!;
                const conversationId = record.conversationId;
                const requestedBy = host.requesterOf(api.conversationId);

                if (lowered !== undefined) {
                    await configure(tx, conversationId, { thinkingLevel: lowered });
                }

                // For the subagents bar: what it works on now, and since when.
                record.asked = sent.trim().slice(0, 300);
                record.askedAt = Date.now();
                const input = {
                    name,
                    conversationId,
                    message: sent,
                    followUp: action === "send" && followUp === true,
                    ...(requestedBy === undefined ? {} : { requestedBy }),
                };

                state.reporters[api.taskId] = await tx.createTask(Reporter, input, BACKGROUND);

                if (action === "send") {
                    return lowered === undefined
                        ? `Sent to ${name}.`
                        : `Sent to ${name}, thinking at ${lowered} now: no higher than this session's.`;
                }

                const runs = model ?? parent.model;
                const on = runs === undefined ? "" : ` on ${keyOf(runs)}`;
                const level = thinking ?? own;

                runsOn = {
                    ...(runs === undefined ? {} : { model: keyOf(runs) }),
                    thinking: level,
                    why: chosen.approved === true
                        ? "approved"
                        : named !== undefined || asked !== undefined
                          ? "asked"
                          : defaults.from.model === "own" || defaults.from.thinking === "own"
                            ? "own"
                            : defaults.from.model === "all" || defaults.from.thinking === "all"
                              ? "all"
                              : "session",
                };

                return notes.length === 0
                    ? `Started ${name}${on}, thinking ${level}.`
                    : `Started ${name}${on}, thinking at ${level}: ${notes.join(", and ")}.`;
            }, context);
            const current = (await api.snapshot(SubagentsDoc, api.conversationId, context))?.agents[
                name
            ];

            return reply(result, current?.conversationId);
        },
    });

    // Code review by a subagent (PP-357): `start` looks the target up where the session works and starts a reviewer with
    // pi-review's rubric and the read-only tools; its answer comes back as a report the app draws as a card. `post` puts
    // a pull request's review on GitHub, after the person allows it on a card.
    const review = defineTool({
        name: "review",
        description:
            "Code review by a subagent with a fresh context (it answers later, as a subagent report the app shows as a card). " +
            "action start: target changes (the folder's uncommitted changes, the default), branch (ref: the base branch), commit (ref: a sha), " +
            "pr (ref: a GitHub pull request's number or link; read without checking it out), or folders (paths); extra: a focus. " +
            "action post: name (the reviewer, review-…): post its pull request review to GitHub, after the person approves on a card. " +
            "When the report comes, do not repeat its findings: the person sees them on the card.",
        parameters: obj({
            action: union([literal("start"), literal("post")]),
            target: opt(union([literal("changes"), literal("branch"), literal("commit"), literal("pr"), literal("folders")])),
            ref: opt(str({ description: "branch: the base; commit: the sha; pr: the number or link" })),
            paths: opt(arr(str(), { description: "folders: the paths" })),
            extra: opt(str({ description: "What to focus on, in the person's words" })),
            name: opt(str({ description: "post: the reviewer's name" })),
        }, { open: true }),
        // Not rerun after a crash: it may have started a reviewer or posted already.
        replay: "unsafe",
        execute: async (args, api, context) => {
            const text = (value: string) => ({ output: [{ type: "text" as const, text: value }] });
            const cwd = host.cwdOf(api.conversationId);
            const run = (command: string) => host.run(cwd, command, 120);

            if (args.action === "post") {
                const registry = await api.snapshot(SubagentsDoc, api.conversationId, context);
                const record = args.name === undefined ? undefined : registry?.agents[args.name];
                const pr = record?.review?.pr;

                if (record === undefined || pr === undefined) {
                    return text(`${args.name ?? "(no name)"} is not a review of a pull request here.`);
                }

                const answered = record.reported.at(-1);
                const answer =
                    answered === undefined
                        ? undefined
                        : await api.commit(async (tx) => (await tx.entry(AssistantEntry, answered))?.model?.[0] as AssistantMessage | undefined, context);
                const result = parseReviewResult(textOf(answer));

                if (result === undefined) {
                    return text(`${args.name} has no finished review to post (its answer has no review-result block).`);
                }

                const shown = diffLines((await run(`git diff ${quote(pr.mergeBase)} ${quote(pr.headSha)}`)).stdout);
                const posted = githubReview(result, shown);
                const allowed = await host.approvals.request(
                    {
                        id: `review-post-${String(api.conversationId)}-${String(api.callId)}`,
                        conversationId: api.conversationId as never,
                        taskId: api.taskId as never,
                        ...(api.callId === undefined ? {} : { callId: api.callId }),
                        tool: "review",
                        subject: `Post this review to PR #${pr.number}?`,
                        reason: `${pr.repo} · as you (gh) · ${posted.event === "REQUEST_CHANGES" ? "Request changes" : "Comment"} · ${posted.comments.length} line comment${posted.comments.length === 1 ? "" : "s"} and a summary with the verdict${result.callouts.length === 0 ? "" : " and the callouts"}.`,
                        createdAt: Date.now(),
                    },
                    context as never,
                );

                if (!allowed.allow) {
                    return text("The person did not allow posting it; nothing went to GitHub.");
                }

                const fence = `PI_REVIEW_${Date.now()}`;
                const sent = await run(
                    `gh api --method POST ${quote(`repos/${pr.repo}/pulls/${pr.number}/reviews`)} --input - <<'${fence}'\n${JSON.stringify({ commit_id: pr.headSha, ...posted })}\n${fence}`,
                );

                if (sent.code !== 0) {
                    return text(`GitHub did not take the review: ${(sent.stderr.trim() || sent.stdout.trim()).slice(0, 600)}`);
                }

                const url = (JSON.parse(sent.stdout) as { html_url?: string }).html_url ?? pr.url;

                return text(`Posted to PR #${pr.number} (${posted.event === "REQUEST_CHANGES" ? "Request changes" : "Comment"}, ${posted.comments.length} line comments): ${url}`);
            }

            const target: ReviewTarget =
                args.target === undefined || args.target === "changes"
                    ? { kind: "changes" }
                    : args.target === "folders"
                      ? { kind: "folders", paths: args.paths ?? (args.ref === undefined ? [] : [args.ref]) }
                      : args.ref === undefined || args.ref.trim() === ""
                        ? (() => {
                              throw new Error(`${args.target} needs ref.`);
                          })()
                        : args.target === "branch"
                          ? { kind: "branch", base: args.ref }
                          : args.target === "commit"
                            ? { kind: "commit", sha: args.ref }
                            : { kind: "pr", pr: args.ref.replace(/^#/, "") };

            if (target.kind === "folders" && target.paths.length === 0) {
                throw new Error("folders needs paths.");
            }

            const { meta, instructions } = await prepareReview(run, target);
            const prompt = reviewPrompt(instructions, await reviewGuidelines(run), args.extra?.trim() || undefined);
            const registry = await api.snapshot(SubagentsDoc, api.conversationId, context);
            const slug = (meta.pr === undefined ? meta.kind : `pr-${meta.pr.number}`).replace(/[^a-z0-9-]/g, "");
            let name = `review-${slug}`;

            for (let n = 2; registry !== null && registry !== undefined && Object.hasOwn(registry.agents, name); n += 1) {
                name = `review-${slug}-${n}`;
            }

            // Read only: it looks with git and reads files; it has no edit or write.
            const parent = await api.agent(context);
            // In codemode's Only mode (PP-379) they are the session's for scripts only: callable, not offered.
            const tools = ["read", "bash", "grep", "find", "ls"].filter((tool) => [...parent.tools, ...parent.callable].some((each) => each.name === tool));
            const started = await subagent.execute({ action: "spawn", name, message: prompt, tools }, api, context);

            await api.commit(async (tx) => {
                const state = await tx.doc(SubagentsDoc, api.conversationId);

                const record = state.agents[name];

                if (record !== undefined) {
                    record.review = meta;
                }
            }, context);

            const said = (started.output ?? []).map((part) => (part.type === "text" ? part.text : "")).join("");

            return {
                output: [{ type: "text" as const, text: `Reviewing ${meta.label}${meta.files === undefined ? "" : ` (${meta.files} files)`} in the subagent ${name}. ${said} Its findings come back as a card the person sees: when its report comes, do not repeat them; say in a line what you will do next, if anything.` }],
                ...(started.details === undefined ? {} : { details: started.details }),
            };
        },
    });

    // Which models Pi may use, with their limits (PP-281): read only, for picking one the person asks for.
    const models = defineTool({
        name: "models",
        description:
            "The models Pi may use, by provider with its plan windows (5-hour, weekly, premium requests: how much is used and when it resets): each model's whether it is ready now, its context, highest thinking level, price, whether subagents run on it or may, and whether your person starred it as a favorite. query: words of its provider, id or name (opus, codex); available: only those ready now; favorites: only your person's favorites. Read only.",
        parameters: obj({
            query: opt(str({ description: "Words to match, such as opus or openai-codex" })),
            available: opt(bool({ description: "Only the models ready now" })),
            favorites: opt(bool({ description: "Only the models your person starred as favorites" })),
        }, { open: true }),
        replay: "safe",
        execute: async (args, api) => ({
            output: [
                {
                    type: "text" as const,
                    text:
                        typeof host.modelsReport === "function"
                            ? await host.modelsReport(args.query, args.available === true, { caller: api.conversationId, favorites: args.favorites === true })
                            : "This server cannot list its models.",
                },
            ],
        }),
    });

    const SubagentTools: Extension = defineExtension({
        name: "pocket-subagents",
        tasks: [Anchor, Reporter, Courier],
        tools: [subagent, models, review],
        // Fixed: the settings and the allowed models change without sending it again (the models tool reads them).
        sections: [section("subagents", () => GUIDE)],
    });

    return SubagentTools;
}
