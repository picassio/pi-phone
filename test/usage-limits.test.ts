// Plan limits (usage-limits.ts): each provider's answer read as its app shows it, an answer of another shape is
// "usage unavailable", figures are kept a minute, and each is asked with the account's own sign-in.
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { accountProvider } from "../src/server/accounts.ts";
import { type AccountUsage, parseClaudeUsage, parseCodexUsage, parseCopilotUsage, UsageLimits } from "../src/server/usage-limits.ts";

test("Claude's answer: the 5-hour and weekly windows, and per-model ones only where the plan has them", () => {
    assert.deepEqual(
        parseClaudeUsage({
            five_hour: { utilization: 19, resets_at: "2026-10-19T14:00:00+00:00" },
            seven_day: { utilization: 7.5, resets_at: "2026-10-23T21:00:00+00:00" },
            seven_day_oauth_apps: { utilization: 0, resets_at: null },
            seven_day_opus: null,
        }),
        [
            { label: "5-hour", usedPercent: 19, resetsAt: Date.parse("2026-10-19T14:00:00Z") },
            { label: "Weekly", usedPercent: 7.5, resetsAt: Date.parse("2026-10-23T21:00:00Z") },
        ],
    );
    assert.throws(() => parseClaudeUsage({ credits: 10 }), /no 5-hour or weekly window/);
    assert.throws(() => parseClaudeUsage({ five_hour: { utilization: "lots" } }), /not a number/);
});

test("Codex's answer: its windows named by their length, and the plan", () => {
    assert.deepEqual(
        parseCodexUsage({
            plan_type: "plus",
            rate_limit: {
                primary_window: { used_percent: 6, reset_at: 1_792_400_000, limit_window_seconds: 18_000 },
                secondary_window: { used_percent: 24, reset_at: 1_792_900_000, limit_window_seconds: 604_800 },
            },
        }),
        {
            plan: "plus",
            windows: [
                { label: "5-hour", usedPercent: 6, resetsAt: 1_792_400_000_000 },
                { label: "Weekly", usedPercent: 24, resetsAt: 1_792_900_000_000 },
            ],
        },
    );
    assert.throws(() => parseCodexUsage({ plan_type: "plus" }), /no rate limit windows/);
});

test("Copilot's answer: the month's premium requests, or unlimited", () => {
    assert.deepEqual(
        parseCopilotUsage({
            copilot_plan: "pro",
            quota_reset_date: "2026-11-01T00:00:00Z",
            quota_snapshots: { premium_interactions: { percent_remaining: 80, entitlement: 300, remaining: 240 } },
        }),
        {
            plan: "pro",
            windows: [{ label: "Premium requests", usedPercent: 20, resetsAt: Date.parse("2026-11-01T00:00:00Z"), detail: "240 of 300 left" }],
        },
    );
    assert.equal(
        parseCopilotUsage({ quota_snapshots: { premium_interactions: { unlimited: true } } }).windows[0]!.detail,
        "unlimited",
    );
    assert.throws(() => parseCopilotUsage({ limited_user_quotas: {} }), /no premium requests/);
});

test("an account's figures are asked with its own sign-in, kept a minute, and told; a strange answer is unavailable", async () => {
    const folder = mkdtempSync(join(tmpdir(), "pi-phone-usage-"));
    const authPath = join(folder, "auth.json");
    const later = Date.now() + 3_600_000;

    writeFileSync(
        authPath,
        JSON.stringify({
            anthropic: { type: "oauth", access: "default-token", refresh: "r1", expires: later },
            "anthropic~work": { type: "oauth", access: "work-token", refresh: "r2", expires: later },
        }),
    );
    const models = await ModelRuntime.create({ authPath, modelsPath: null, refreshOnCreate: false });

    models.registerNativeProvider(accountProvider(anthropicProvider() as never, "anthropic~work", "Work"));
    const asked: { url: string; headers: Record<string, string> }[] = [];
    let answer: unknown = { five_hour: { utilization: 42, resets_at: "2026-10-19T14:00:00Z" }, seven_day: { utilization: 61, resets_at: null } };
    const told: AccountUsage[] = [];
    let now = 1_000_000;
    const limits = new UsageLimits({
        models: () => models,
        claudeVersion: () => "2.1.280",
        publish: (usage) => told.push(usage),
        now: () => now,
        fetch: (async (url: string, init: { headers: Record<string, string> }) => {
            asked.push({ url, headers: init.headers });

            return new Response(JSON.stringify(answer), { status: 200 });
        }) as never,
    });

    assert.equal(await limits.limited("anthropic~work"), true);
    assert.equal(await limits.limited("openrouter"), false, "only subscription providers have plan limits");

    const work = await limits.get("anthropic~work");

    assert.deepEqual("windows" in work! ? work.windows.map((each) => each.usedPercent) : work, [42, 61]);
    assert.equal(asked[0]!.url, "https://api.anthropic.com/api/oauth/usage");
    assert.equal(asked[0]!.headers.authorization, "Bearer work-token", "the account's own sign-in");
    assert.equal(asked[0]!.headers["anthropic-beta"], "oauth-2025-04-20");
    assert.equal(asked[0]!.headers["user-agent"], "claude-code/2.1.280");
    assert.equal(told.length, 1, "every tab is told");

    await limits.get("anthropic~work");
    assert.equal(asked.length, 1, "kept a minute");
    now += 61_000;
    answer = { credits: 5 };
    const strange = await limits.get("anthropic~work");

    assert.equal(asked.length, 2);
    assert.match("error" in strange! ? strange.error : "", /^usage unavailable: no 5-hour or weekly window/);
    assert.deepEqual(
        (await limits.all(true)).map((each) => each.provider).sort(),
        ["anthropic", "anthropic~work"],
        "every signed-in subscription account",
    );
    assert.equal(asked.find((each) => each.headers.authorization === "Bearer default-token") !== undefined, true);
});
