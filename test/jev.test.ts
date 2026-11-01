// Jev as a judge of relevance (PP-312, `jev.ts`): one Noul question a text, 30 a request, the requests side by side,
// the scores read from answers.Pk.noul, the cost added up; a failure rejects with why. And OpenRouter's Jev models.
import assert from "node:assert/strict";
import { test } from "node:test";
import { JEV_BATCH, JevError, JevModels, jevRelevance } from "../src/server/jev.ts";

type Sent = { url: string; body: { model: string; state: { query: string }; questions: Record<string, { type: string; instructions: string; criteria: { true: string; false: string } }> }; auth: string };

/** A fake OpenRouter: each question's score is the number in its note ("note 7" → 0.07), or what `answer` says. */
function fakeJev(answer?: (sent: Sent) => Response | Promise<Response>) {
    const sent: Sent[] = [];
    let open = 0;
    let most = 0;
    const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
        const each: Sent = { url: String(url), body: JSON.parse(String(init?.body)), auth: new Headers(init?.headers).get("authorization") ?? "" };

        sent.push(each);
        open++;
        most = Math.max(most, open);
        await new Promise((resolve) => setTimeout(resolve, 20));
        open--;

        if (answer !== undefined) {
            return answer(each);
        }

        const answers = Object.fromEntries(
            Object.entries(each.body.questions).map(([name, question]) => [name, { noul: Number(/note (\d+)/.exec(question.instructions)?.[1] ?? 0) / 100 }]),
        );

        return Response.json({ answers, usage: { cost: 0.00001, input_tokens: 100 } });
    }) as typeof fetch;

    return { fetcher, sent, most: () => most };
}

test("Jev scores each text in its own question, 30 a request, the requests side by side, in the texts' order", async () => {
    const jev = fakeJev();
    const texts = Array.from({ length: 65 }, (_each, index) => `note ${index}`);
    const judged = await jevRelevance("sk-or-test", "typesafe/jev-1.14", "where is the office printer", texts, { fetch: jev.fetcher });

    assert.equal(jev.sent.length, 3, "65 texts: three requests");
    assert.deepEqual(jev.sent.map((each) => Object.keys(each.body.questions).length), [JEV_BATCH, JEV_BATCH, 5]);
    assert.equal(jev.most(), 3, "sent side by side");
    assert.deepEqual(judged.scores, texts.map((_each, index) => index / 100));
    assert.ok(Math.abs(judged.cost - 0.00003) < 1e-12, "the cost of every request");
    assert.equal(judged.tokens, 300);

    const first = jev.sent[0]!;

    assert.equal(first.url, "https://openrouter.ai/api/alpha/decisions");
    assert.equal(first.auth, "Bearer sk-or-test");
    assert.equal(first.body.model, "typesafe/jev-1.14");
    assert.deepEqual(first.body.state, { query: "where is the office printer" }, "the state holds the query alone");
    assert.equal(first.body.questions.P0!.type, "noul");
    assert.match(first.body.questions.P0!.instructions, /^Note:\n"""\nnote 0\n"""\nDoes this note contain information that helps answer or act on the query\?$/);
    assert.match(first.body.questions.P0!.criteria.true, /answers the query/);
    assert.match(first.body.questions.P0!.criteria.false, /related topic/);
});

test("nothing to judge asks nothing", async () => {
    const jev = fakeJev();

    assert.deepEqual(await jevRelevance("k", "typesafe/jev-1.14", "q", [], { fetch: jev.fetcher }), { scores: [], cost: 0, tokens: 0, ms: 0 });
    assert.equal(jev.sent.length, 0);
});

test("a failure rejects with why: an HTTP error, a missing or bad score, no answer in time, no connection", async () => {
    const cases: [string, (sent: Sent) => Response | Promise<Response>, RegExp][] = [
        ["402", () => Response.json({ error: { message: "Insufficient credits" } }, { status: 402 }), /OpenRouter answered 402: Insufficient credits/],
        ["missing", () => Response.json({ answers: {} }), /answer P0 is not a number from 0 to 1/],
        ["out of range", () => Response.json({ answers: { P0: { noul: 1.5 } } }), /answer P0 is not a number/],
    ];

    for (const [name, answer, why] of cases) {
        await assert.rejects(jevRelevance("k", "typesafe/jev-1.14", "q", ["a"], { fetch: fakeJev(answer).fetcher }), (error: unknown) => error instanceof JevError && why.test(error.message), name);
    }

    const slow = (async (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal!.reason)))) as typeof fetch;

    await assert.rejects(jevRelevance("k", "typesafe/jev-1.14", "q", ["a"], { fetch: slow, timeoutMs: 50 }), /no answer from OpenRouter in 0 s/);

    const down = (async () => {
        throw new TypeError("fetch failed");
    }) as typeof fetch;

    await assert.rejects(jevRelevance("k", "typesafe/jev-1.14", "q", ["a"], { fetch: down }), /OpenRouter could not be reached: fetch failed/);
});

test("OpenRouter's Jev models: TypeSafe's decision models, newest first and aliases last, kept an hour, a failed ask not kept", async () => {
    let asks = 0;
    let fail = true;
    const fetcher = (async (url: string | URL | Request) => {
        asks++;
        assert.equal(String(url), "https://openrouter.ai/api/v1/models?output_modalities=decisions");

        if (fail) {
            return new Response("down", { status: 503 });
        }

        return Response.json({
            data: [
                { id: "typesafe/jev-1.13", name: "TypeSafe: Jev 1.13", pricing: { prompt: "0.000000042" } },
                { id: "~typesafe/jev-latest", name: "TypeSafe: Jev Latest", pricing: { prompt: "0.000000042" } },
                { id: "liquid/d1", name: "LiquidAI: d1", pricing: { prompt: "0.00000002" } },
                { id: "typesafe/jev-1.14", name: "TypeSafe: Jev 1.14", pricing: { prompt: "0.000000042" } },
            ],
        });
    }) as typeof fetch;
    const models = new JevModels(fetcher);

    await assert.rejects(models.list(), /answered 503/);
    fail = false;

    const list = await models.list();

    assert.deepEqual(list.map((each) => each.id), ["typesafe/jev-1.14", "typesafe/jev-1.13", "~typesafe/jev-latest"]);
    assert.equal(list[0]!.name, "TypeSafe: Jev 1.14");
    assert.ok(Math.abs(list[0]!.pricePerMillion - 0.042) < 1e-9);
    await models.list();
    assert.equal(asks, 2, "the list is kept");
});
