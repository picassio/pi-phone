/**
 * A request to a session's own model beside Pi's turns: a session's title (`titles.ts`), an interview's helpers
 * (`interview-helpers.ts`). Always the session's model, never another picked on the side, such as a cheaper one of the
 * same provider: nobody chose that one, and it may cost what nobody agreed to. What it costs counts as the session's
 * spend, like Pi's own requests, and a session whose spend is held back asks nothing.
 */
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Usage } from "@earendil-works/pi-ai";
import { type ConversationId, ProviderDoc, UsageDoc } from "@earendil-works/pi-durable";
import type { PocketApp } from "./app.ts";
import { HttpError } from "./errors.ts";

const context = BACKGROUND_CONTEXT;

/** Reasoning some servers send at the start of the reply's text, in tags, or up to a closing tag. */
const REASONING = /^\s*<(think|thinking|reasoning)>[\s\S]*?(<\/\1>|$)/i;
const REASONING_END = /^[\s\S]*?<\/(think|thinking|reasoning)>[^\S\n]*(\n|$)/i;

/**
 * Put a request made for a session elsewhere (a browser run's decisions by Jev, through OpenRouter) on its ledger, under
 * `key` ("openrouter/typesafe/jev-1.13"): it counts in the session's Spend like Pi's own requests.
 */
export async function chargeSession(app: PocketApp, id: ConversationId, key: string, usage: { input: number; output: number; cost: number }): Promise<void> {
    await app.harness.commit(async (tx) => {
        const ledger = await tx.doc(UsageDoc, id);

        ledger.models[key] ??= { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
        addUsage(ledger.models[key] as Usage, {
            input: usage.input,
            output: usage.output,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: usage.input + usage.output,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: usage.cost },
        } as Usage);
    }, context);
}

/** Add one response's usage to the session's ledger, as Pi Durable does for its own. */
function addUsage(total: Usage, usage: Usage): void {
    total.input += usage.input;
    total.output += usage.output;
    total.cacheRead += usage.cacheRead;
    total.cacheWrite += usage.cacheWrite;
    total.totalTokens += usage.totalTokens;

    for (const key of ["input", "output", "cacheRead", "cacheWrite", "total"] as const) {
        total.cost[key] += usage.cost[key];
    }
}

/**
 * Ask the session's model `prompt`, alone (no history, no tools): its reply's text, without reasoning a server put at
 * its start, and whether it ended by itself ("stop") or was cut off. Fails, saying why, when the session's spend is held
 * back or it has no model.
 */
export async function askSessionModel(
    app: PocketApp,
    id: ConversationId,
    prompt: string,
    { maxTokens }: { maxTokens: number },
): Promise<{ text: string; stopReason: string }> {
    const held = app.spend.heldBack(id);

    if (held !== undefined) {
        throw new HttpError(402, held);
    }

    const agent = await app.agentState(id);
    const model = agent?.model === undefined ? undefined : app.models.getModel(agent.model.provider, agent.model.modelId);

    if (model === undefined) {
        throw new HttpError(409, "This session has no model yet: pick one first.");
    }

    // The conversation's own identity with the provider, as Pi Durable sends with its summaries: some providers
    // (OpenCode Go) refuse a request without one. A conversation older than that identity gets one now.
    const sessionId =
        (await app.harness.snapshot(ProviderDoc, id, context))?.sessionId ??
        (await app.harness.commit(async (tx) => (await tx.doc(ProviderDoc, id)).sessionId, context));
    const reply = await app.models.completeSimple(
        model,
        { messages: [{ role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() }] },
        { maxTokens, cacheRetention: "none", sessionId },
    );

    await app.harness.commit(async (tx) => {
        const usage = await tx.doc(UsageDoc, id);
        const key = `${model.provider}/${model.id}`;

        usage.models[key] ??= {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        };
        addUsage(usage.models[key] as Usage, reply.usage);
    }, context);

    if (reply.stopReason === "error" || reply.stopReason === "aborted") {
        throw new HttpError(502, `The model did not answer: ${reply.errorMessage ?? reply.stopReason}`);
    }

    const text = reply.content
        .flatMap((part) => (part.type === "text" ? [part.text] : []))
        .join("")
        .replace(REASONING, "")
        .replace(REASONING_END, "")
        .trim();

    return { text, stopReason: reply.stopReason };
}
