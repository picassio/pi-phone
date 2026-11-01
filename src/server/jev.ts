/**
 * Jev (TypeSafe's decision model, through OpenRouter's decisions route) as a judge of relevance (PP-312): how much each
 * text helps with a query, as XuShi Visa ranks its memory (`apps/api/src/ai/jev.ts`, measured there: 94% right page
 * first, 0.13 pages off the point a question) and HSE PVPower reranks LightRAG's passages. Each text is a Noul question
 * of its own, the state holds only the query, 30 questions a request, the requests side by side: many texts in one
 * shared state, asked by position, measured clearly worse there.
 *
 * A failure (no answer, an HTTP error, a missing score, the timeout) rejects with why: the caller keeps its own order
 * and says so (the owner's rule, PP-312); nothing here is silently skipped.
 *
 * And the Jev models OpenRouter offers, for the app's dropdowns (Menu › Wiki, Menu › Pi's browser): its decision models
 * (`output_modalities=decisions`) from TypeSafe.
 */

/** The Jev model the wiki's search ranks with unless the owner picks another (owner's decision, PP-312). */
export const JEV_RERANK_DEFAULT = "typesafe/jev-1.14";
/** A Jev model's OpenRouter id: TypeSafe's, or an alias of one (`~typesafe/jev-latest`). */
export const JEV_ID = /^~?typesafe\/[a-z0-9][a-z0-9.\-]*$/i;

const DECISIONS_URL = "https://openrouter.ai/api/alpha/decisions";
const MODELS_URL = "https://openrouter.ai/api/v1/models?output_modalities=decisions";
/** Questions in one request (XuShi Visa's and HSE's measure). */
export const JEV_BATCH = 30;
const TIMEOUT_MS = 20_000;
/** How long OpenRouter's list is kept before it is asked again. */
const MODELS_MS = 60 * 60_000;

const ASK = (text: string) => `Note:\n"""\n${text}\n"""\nDoes this note contain information that helps answer or act on the query?`;
const CRITERIA = {
    true: "The note answers the query or holds information needed to answer or act on it.",
    false: "The note is only on a related topic or does not help with the query.",
};

export class JevError extends Error {}

/** What Jev said: P(relevant) for each text, in order; what it cost, its input tokens, and how long it took. */
export type JevScores = { scores: number[]; cost: number; tokens: number; ms: number };

/** P(relevant) of each text to `query`, from `model` with the OpenRouter key `key`. Rejects with why it could not. */
export async function jevRelevance(
    key: string,
    model: string,
    query: string,
    texts: readonly string[],
    options: { timeoutMs?: number; fetch?: typeof fetch } = {},
): Promise<JevScores> {
    const started = Date.now();

    if (texts.length === 0) {
        return { scores: [], cost: 0, tokens: 0, ms: 0 };
    }

    const call = options.fetch ?? fetch;
    const batches: { start: number; texts: readonly string[] }[] = [];

    for (let start = 0; start < texts.length; start += JEV_BATCH) {
        batches.push({ start, texts: texts.slice(start, start + JEV_BATCH) });
    }

    const answered = await Promise.all(
        batches.map(async (batch) => {
            let response: Response;

            try {
                response = await call(DECISIONS_URL, {
                    method: "POST",
                    headers: { authorization: `Bearer ${key}`, "content-type": "application/json", "x-title": "pi-phone" },
                    body: JSON.stringify({
                        model,
                        state: { query },
                        questions: Object.fromEntries(batch.texts.map((text, index) => [`P${index}`, { type: "noul", instructions: ASK(text), criteria: CRITERIA }])),
                    }),
                    signal: AbortSignal.timeout(options.timeoutMs ?? TIMEOUT_MS),
                });
            } catch (error) {
                throw new JevError(
                    error instanceof Error && error.name === "TimeoutError"
                        ? `no answer from OpenRouter in ${Math.round((options.timeoutMs ?? TIMEOUT_MS) / 1000)} s`
                        : `OpenRouter could not be reached: ${error instanceof Error ? error.message : String(error)}`,
                );
            }

            const body = (await response.json().catch(() => ({}))) as {
                answers?: Record<string, { noul?: unknown } | undefined>;
                usage?: { cost?: unknown; input_tokens?: unknown };
                error?: { message?: string };
            };

            if (!response.ok) {
                throw new JevError(`OpenRouter answered ${response.status}${body.error?.message ? `: ${body.error.message}` : ""}`);
            }

            const values = batch.texts.map((_text, index) => {
                const value = body.answers?.[`P${index}`]?.noul;

                if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
                    throw new JevError(`Jev's answer P${index} is not a number from 0 to 1`);
                }

                return value;
            });

            return {
                start: batch.start,
                values,
                cost: typeof body.usage?.cost === "number" ? body.usage.cost : 0,
                tokens: typeof body.usage?.input_tokens === "number" ? body.usage.input_tokens : 0,
            };
        }),
    );
    const scores = new Array<number>(texts.length).fill(0);
    let cost = 0;
    let tokens = 0;

    for (const each of answered) {
        each.values.forEach((value, index) => {
            scores[each.start + index] = value;
        });
        cost += each.cost;
        tokens += each.tokens;
    }

    return { scores, cost, tokens, ms: Date.now() - started };
}

/** A Jev model as the dropdowns list it. */
export type JevModel = { id: string; name: string; pricePerMillion: number };

/** OpenRouter's Jev models (TypeSafe's decision models), by name; asked again after an hour, a failed ask not kept. */
export class JevModels {
    readonly #fetch: typeof fetch;
    #list: { at: number; list: Promise<JevModel[]> } | undefined;

    constructor(fetcher: typeof fetch = fetch) {
        this.#fetch = fetcher;
    }

    list(): Promise<JevModel[]> {
        if (this.#list !== undefined && Date.now() - this.#list.at < MODELS_MS) {
            return this.#list.list;
        }

        const list = (async () => {
            const response = await this.#fetch(MODELS_URL, { signal: AbortSignal.timeout(TIMEOUT_MS) });

            if (!response.ok) {
                throw new Error(`OpenRouter's list of decision models answered ${response.status}.`);
            }

            const data = (await response.json()) as { data?: { id?: unknown; name?: unknown; pricing?: { prompt?: unknown } }[] };

            return (data.data ?? [])
                .flatMap((each) =>
                    typeof each.id === "string" && JEV_ID.test(each.id)
                        ? [{ id: each.id, name: typeof each.name === "string" ? each.name : each.id, pricePerMillion: Number(each.pricing?.prompt ?? 0) * 1_000_000 }]
                        : [],
                )
                .sort((a, b) => a.id.startsWith("~") === b.id.startsWith("~") ? b.id.localeCompare(a.id, undefined, { numeric: true }) : a.id.startsWith("~") ? 1 : -1);
        })();
        const entry = { at: Date.now(), list };

        this.#list = entry;
        list.catch(() => this.#list === entry && (this.#list = undefined));

        return list;
    }
}
