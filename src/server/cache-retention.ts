/**
 * How long the prompt cache lasts (PP-475, story PP-472; measured in PP-474, wiki resources/anthropic-prompt-cache-1h):
 * `short`, the provider's default (Anthropic's 5 minutes), or `long` (Anthropic's 1 hour), for sessions that wait on
 * work longer than 5 minutes: a wake-up within the hour reads the cache instead of writing the whole context again. A
 * 1-hour write costs twice the input price, against 1.25 times for 5 minutes, so it is off unless the owner turns it on:
 * for every session (`ConfigStore.cacheRetention`), or for one (`SessionMeta.cacheRetention`), which comes first. A
 * subagent follows its session.
 *
 * Pi Durable's stream options are the harness's, the same for every conversation, so the app sets pi-ai's
 * `cacheRetention` on each request of a session (`installCacheRetention`), found by the provider session id Pi Durable
 * sends with it. A request that sets its own keeps it: Pi Durable's summarizer and the side model send "none".
 */
import {
    type Api,
    type AssistantMessage,
    type AssistantMessageEventStream,
    type Context,
    createAssistantMessageEventStream,
    type Model,
    type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { HttpError } from "./errors.ts";

export const CACHE_RETENTIONS = ["short", "long"] as const;
export type CacheRetentionChoice = (typeof CACHE_RETENTIONS)[number];

/** A retention as a person or Pi gives it; `inherit` (a session's: the setting for every session) where it may be. */
export function checkCacheRetention(value: unknown, inherit: false): CacheRetentionChoice;
export function checkCacheRetention(value: unknown, inherit: true): CacheRetentionChoice | "inherit";
export function checkCacheRetention(value: unknown, inherit: boolean): CacheRetentionChoice | "inherit" {
    const given = typeof value === "string" ? value.trim().toLowerCase() : value;

    if (given === "short" || given === "long" || (inherit && given === "inherit")) {
        return given;
    }

    throw new HttpError(400, inherit ? "The prompt cache is short (5 minutes), long (1 hour), or inherit." : "The prompt cache is short (5 minutes) or long (1 hour).");
}

/**
 * How long a session's cache lasts, and how long before its end compacting before expiry starts (`self-compact.ts`):
 * at 4.5 of 5 minutes, or at 55 of 60.
 */
export const cacheTiming = (retention: CacheRetentionChoice): { ttlMs: number; leadMs: number } =>
    retention === "long" ? { ttlMs: 3_600_000, leadMs: 300_000 } : { ttlMs: 300_000, leadMs: 30_000 };

type StreamSimple = (model: Model<Api>, context: Context, options?: SimpleStreamOptions) => AssistantMessageEventStream;

/**
 * Wrap the runtime's `streamSimple` in place: a request with a provider session id and no `cacheRetention` of its own
 * gets its session's (`retentionOf`; undefined: not a session's request, which goes as it came). A lookup that fails
 * fails the request, with the reason.
 */
export function installCacheRetention(models: { streamSimple: StreamSimple }, retentionOf: (sessionId: string) => Promise<CacheRetentionChoice | undefined>): void {
    const underlying = models.streamSimple.bind(models);

    models.streamSimple = (model, context, options) => {
        const sessionId = options?.sessionId;

        if (sessionId === undefined || options?.cacheRetention !== undefined) {
            return underlying(model, context, options);
        }

        const out = createAssistantMessageEventStream();

        void (async () => {
            const retention = await retentionOf(sessionId);
            const stream = underlying(model, context, retention === undefined ? options : { ...options, cacheRetention: retention });

            for await (const event of stream) {
                out.push(event);
            }

            out.end(await stream.result());
        })().catch((error: unknown) => {
            const message: AssistantMessage = {
                role: "assistant",
                content: [],
                api: model.api,
                provider: model.provider,
                model: model.id,
                usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
                stopReason: "error",
                errorMessage: `The session's prompt cache setting could not be read: ${error instanceof Error ? error.message : String(error)}`,
                timestamp: Date.now(),
            };

            out.push({ type: "error", reason: "error", error: message });
            out.end(message);
        });

        return out;
    };
}
