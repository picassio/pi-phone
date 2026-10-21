/**
 * Embeddings from OpenRouter (PP-49), for search by meaning: never a local model. One request embeds a batch of
 * passages; its tokens, and its cost when OpenRouter says it, come back for Spend.
 */

export type Embedded = { vectors: number[][]; tokens: number; cost?: number };

/** What embeds passages for a store: the model's id, and how to embed with it. */
export type Embedder = { model: string; embed(texts: string[]): Promise<Embedded> };

const URL = "https://openrouter.ai/api/v1/embeddings";

/** An embedder on OpenRouter with this key and model. */
export function openRouterEmbedder(key: string, model: string, send: typeof fetch = fetch): Embedder {
    return {
        model,
        async embed(texts) {
            const response = await send(URL, {
                method: "POST",
                headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
                body: JSON.stringify({ model, input: texts }),
                signal: AbortSignal.timeout(60_000),
            });
            const body = (await response.json().catch(() => ({}))) as { data?: { embedding: number[]; index?: number }[]; usage?: { prompt_tokens?: number; total_tokens?: number; cost?: number }; error?: { message?: string } };

            if (!response.ok || body.data === undefined) {
                throw new Error(`OpenRouter embeddings: ${body.error?.message ?? response.status}`);
            }

            const vectors = [...body.data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0)).map((each) => each.embedding);

            if (vectors.length !== texts.length) {
                throw new Error(`OpenRouter embeddings: ${vectors.length} vectors for ${texts.length} passages.`);
            }

            return { vectors, tokens: body.usage?.prompt_tokens ?? body.usage?.total_tokens ?? 0, ...(body.usage?.cost === undefined ? {} : { cost: body.usage.cost }) };
        },
    };
}

/** How alike two vectors are (cosine), from -1 to 1. */
export function cosine(a: Float32Array, b: Float32Array): number {
    let dot = 0;
    let na = 0;
    let nb = 0;

    for (let i = 0; i < a.length && i < b.length; i++) {
        dot += a[i]! * b[i]!;
        na += a[i]! * a[i]!;
        nb += b[i]! * b[i]!;
    }

    return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb);
}

/** A page's passages for embedding: split by heading, then by paragraph, about 800 tokens (3200 characters) at most, each with the page's title and folder in front. */
export function passages(title: string, path: string[], body: string, max = 3200): string[] {
    const head = `${title}${path.length === 0 ? "" : ` (${path.join(" › ")})`}\n`;
    const sections: string[] = [];
    let current = "";

    for (const line of body.split("\n")) {
        if (/^#{1,6}\s/.test(line) && current.trim() !== "") {
            sections.push(current);
            current = "";
        }

        current += `${line}\n`;
    }

    if (current.trim() !== "" || sections.length === 0) {
        sections.push(current);
    }

    const out: string[] = [];

    for (const section of sections) {
        if (section.length <= max) {
            out.push(section);
            continue;
        }

        let part = "";

        for (const paragraph of section.split(/\n\s*\n/)) {
            if (part.length + paragraph.length > max && part !== "") {
                out.push(part);
                part = "";
            }

            // One paragraph longer than the most: cut where it must be.
            for (let at = 0; at < paragraph.length; at += max) {
                const piece = paragraph.slice(at, at + max);

                if (part.length + piece.length > max && part !== "") {
                    out.push(part);
                    part = "";
                }

                part += `${piece}\n\n`;
            }
        }

        if (part.trim() !== "") {
            out.push(part);
        }
    }

    return out.map((text) => `${head}${text.trim()}`);
}
