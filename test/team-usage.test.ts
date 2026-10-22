// A team subscription's plan limits (PP-69, S4): asked on the team server with the sign-in kept there, kept a minute,
// and asked again after an answer on it; an account without plan limits (an API key) has none.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { GatewayStore } from "../src/gateway/store.ts";
import { TeamAccounts } from "../src/gateway/team-accounts.ts";

test("a team Claude subscription's figures are asked with its own sign-in on the team server, and kept a minute", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-phone-team-usage-"));
    const authPath = join(dir, "team-providers", "auth.json");
    const later = Date.now() + 3_600_000;

    mkdirSync(join(dir, "team-providers"));
    writeFileSync(authPath, JSON.stringify({ "anthropic~team-max": { type: "oauth", access: "team-token", refresh: "r", expires: later }, "openrouter~team-work": { type: "api_key", key: "k" } }));

    const store = new GatewayStore(new DatabaseSync(":memory:"));
    const asked: { url: string; headers: Record<string, string> }[] = [];
    let now = 1_000_000;
    const accounts = new TeamAccounts(store, dir, () => now, (async (url: string, init: { headers: Record<string, string> }) => {
        asked.push({ url, headers: init.headers });

        return new Response(JSON.stringify({ five_hour: { utilization: 33, resets_at: null }, seven_day: { utilization: 70, resets_at: null } }), { status: 200 });
    }) as never);

    await accounts.open(await ModelRuntime.create({ authPath, modelsPath: null, refreshOnCreate: false }));
    accounts.add("anthropic", "Max", "owner-id");
    accounts.add("openrouter", "Work", "owner-id");

    const found = await accounts.usage(["anthropic~team-max", "openrouter~team-work"], false);

    assert.deepEqual(
        found.map((each) => ({ provider: each.provider, used: "windows" in each ? each.windows.map((window) => window.usedPercent) : each.error })),
        [{ provider: "anthropic~team-max", used: [33, 70] }],
        "only the subscription has plan limits",
    );
    assert.equal(asked[0]!.url, "https://api.anthropic.com/api/oauth/usage");
    assert.equal(asked[0]!.headers.authorization, "Bearer team-token", "the team's sign-in, on the team server");

    await accounts.usage(["anthropic~team-max"], false);
    assert.equal(asked.length, 1, "kept a minute");

    // An answer on it: asked again once the minute is up.
    now += 61_000;
    accounts.answered("anthropic~team-max");
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(asked.length, 2, "asked again after an answer");
});
