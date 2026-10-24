// The limit classifier (`limits.ts`), ported from pi-pocket 0.21.0's vital tests, with the windows' names pi-phone
// shows (PP-135). The named Claude and ChatGPT windows were checked against real limits in pi-pocket #128 by @piromagnus.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { checkedFacts, classify, factsOf, longWindow, responseFacts, windowLabel, withFacts } from "../src/server/limits.ts";

const now = Date.parse("2026-10-23T12:00:00Z");
const ask = (message: string, status?: number, headers: Record<string, string> = {}, provider = "p") =>
    classify({ provider, message, now, ...(status === undefined ? {} : { facts: { status, headers } }) });

test("what clears with time waits, for the account or the model, until the time the provider gave", () => {
    assert.deepEqual(ask("429 rate_limit_error", 429), { type: "limit", scope: "model", backoff: true, reason: "429 rate_limit_error" });
    assert.equal((ask("429", 429, { "retry-after": "120" }) as { resetAt: number }).resetAt, now + 120_000);

    // A Claude window and a ChatGPT usage limit are the account's.
    const claude = ask("429", 429, {
        "anthropic-ratelimit-unified-status": "rejected",
        "anthropic-ratelimit-unified-reset": String(now / 1000 + 3600),
    });
    const chatgpt = ask("You have hit your ChatGPT usage limit. Try again in ~95 min.", undefined, {}, "openai-codex");

    assert.deepEqual(
        [claude, chatgpt].map((each) => each.type === "limit" && each.scope),
        ["account", "account"],
    );
    assert.equal((chatgpt as { resetAt: number }).resetAt, now + 95 * 60_000);

    // Named windows: a rejected 5-hour window waits for its reset; a rejected 7-day window, or a Codex window of over
    // 300 minutes at 100 percent, is days away and does not wait. Each says which window it is.
    const five = ask("429", 429, {
        "anthropic-ratelimit-unified-5h-status": "rejected",
        "anthropic-ratelimit-unified-5h-reset": String(now / 1000 + 4 * 3600),
    });
    const seven = ask("429", 429, {
        "anthropic-ratelimit-unified-7d-status": "rejected",
        "anthropic-ratelimit-unified-7d-reset": String(now / 1000 + 3 * 86400),
    });
    const weekly = ask("429", 429, {
        "x-codex-secondary-used-percent": "100",
        "x-codex-secondary-window-minutes": "10080",
        "x-codex-secondary-reset-after-seconds": "86400",
    });
    const codex5 = ask("429", 429, {
        "x-codex-primary-used-percent": "100",
        "x-codex-primary-window-minutes": "300",
        "x-codex-primary-reset-after-seconds": "600",
    });

    assert.equal((five as { resetAt: number }).resetAt, now + 4 * 3_600_000);
    assert.deepEqual(
        [five, seven, weekly, codex5].map((each) => each.type === "limit" && [each.window, each.long === true]),
        [
            ["5-hour", false],
            ["Weekly", true],
            ["Weekly", true],
            ["5-hour", false],
        ],
    );
});

test("a person's problem, a refused request, or a plan limit with no time never waits", () => {
    for (const [text, status] of [
        ["insufficient_quota: you exceeded your current quota", undefined],
        ["OAuth refresh failed for anthropic", undefined],
        ["Monthly usage limit reached. Enable available balance.", undefined],
        // A permanent 4xx never waits, whatever its text says.
        ["400 invalid_request_error: unsupported parameter 'rate_limit'", 400],
        ["401 authentication_error: invalid x-api-key", 401],
        // A plain 409 does not wait.
        ["409 Conflict: resource already exists", 409],
        // With no status (Google), a refusal whose text holds a number that looks like a 5xx.
        ["400 INVALID_ARGUMENT: contents exceed 500 tokens", undefined],
    ] as const) {
        assert.equal(ask(text, status).type, "other", text);
    }

    // A plan's usage limit with no time says so: the gate may find the time in the account's usage bars.
    assert.deepEqual(ask("Monthly usage limit reached.", undefined), { type: "other", why: "usage limit, reset unknown", usage: true });
    // A 409 waits only when a header gives the time.
    assert.equal(ask("409 Conflict", 409, { "retry-after": "5" }).type, "limit");
});

test("a ChatGPT Business admin cap never waits, even with a retry time", () => {
    const message = "subscription_sharing_workplace_individual_usage_limit_exceeded";

    for (const status of [undefined, 429]) {
        assert.equal(ask(message, status, { "retry-after": "60" }).type, "other");
        assert.equal(ask(`${message}: ChatGPT workspace's usage limit`, status, { "retry-after": "60" }).type, "other");
    }
});

test("only limit headers are kept from a response, never a key or a token, and facts sent along are checked", () => {
    const kept = responseFacts(429, new Headers({ authorization: "Bearer secret", "x-api-key": "secret", "Retry-After": "30" }));

    assert.deepEqual(kept, { status: 429, headers: { "retry-after": "30" } });
    // As the team server sends them: anything but a status and the limit headers is dropped.
    assert.deepEqual(checkedFacts({ status: 429, headers: { "retry-after": "30", authorization: "Bearer x", n: 5 } }), kept);
    assert.equal(checkedFacts({ status: "429", headers: {} }), undefined);
    assert.equal(checkedFacts(null), undefined);

    // A failed message carries them to the gate, through spreads as streams copy it.
    const message = { role: "assistant", content: [], stopReason: "error" } as unknown as AssistantMessage;

    withFacts(message, kept);
    assert.deepEqual(factsOf({ ...message }), kept);
});

test("windows by length, and which are days long", () => {
    assert.deepEqual([windowLabel(300), windowLabel(10080), windowLabel(60)], ["5-hour", "Weekly", "1-hour"]);
    assert.deepEqual(
        ["5-hour", "Weekly", "Weekly Opus", "Premium requests", "Window"].map(longWindow),
        [false, true, true, true, true],
    );
});
