// Google Antigravity's team accounts on the team server (PP-69 with PP-555, team-accounts.ts): the gateway makes an
// Antigravity runtime of its own at the first one, each team account an instance of its own; its Google sign-in goes
// through the relayed steps, its models come from its own list after the sign-in, its turns and quota go with its own
// token and project. Google is stood in for.
import { cleanUp, root } from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import type { AuthPrompt } from "@earendil-works/pi-ai";
import { type FlowStep, type TeamAccount, TeamAccounts, type TeamAccountRows } from "../src/gateway/team-accounts.ts";
import type { AgySend } from "../src/server/antigravity.ts";

after(() => cleanUp());

const CATALOG = {
    models: { "gemini-3.5-flash-lite": { displayName: "Gemini 3.5 Flash Lite", maxTokens: "1048576", maxOutputTokens: 65535, model: "MODEL_M1", modelProvider: "MODEL_PROVIDER_GOOGLE" } },
    agentModelSorts: [{ groups: [{ modelIds: ["gemini-3.5-flash-lite"] }] }],
};
const QUOTA = {
    groups: [{ displayName: "Gemini Models", buckets: [{ bucketId: "gemini-weekly", displayName: "Weekly Limit Remaining", window: "weekly", resetTime: "2026-11-30T10:00:00Z", remainingFraction: 0.6 }] }],
};
const TOKENS = JSON.stringify({ access_token: "ya29.team", expires_in: 3599, refresh_token: "1//team-refresh", token_type: "Bearer" });
const DONE = `data: ${JSON.stringify({ response: { candidates: [{ content: { role: "model", parts: [{ text: "hi from the team" }] }, finishReason: "STOP" }] } })}\r\n\r\n`;

test("a team account of Google Antigravity: added, signed in with Google through the relayed steps, its models listed, its turns and quota on its own token and project", async () => {
    const sent: { url: string; headers: Record<string, string>; body: string }[] = [];
    const send: AgySend = async (url, init) => {
        sent.push({ url, headers: init.headers, body: init.body ?? "" });
        const body = url.endsWith("/token")
            ? TOKENS
            : url.includes("loadCodeAssist")
              ? JSON.stringify({ cloudaicompanionProject: "team-project", currentTier: { id: "free-tier" } })
              : url.includes("fetchAvailableModels")
                ? JSON.stringify(CATALOG)
                : url.includes("retrieveUserQuotaSummary")
                  ? JSON.stringify(QUOTA)
                  : url.includes("streamGenerateContent")
                    ? DONE
                    : "{}";

        return { status: 200, headers: new Headers({ "content-type": "application/json" }), body: (async function* () { yield new TextEncoder().encode(body); })() };
    };
    const saved: TeamAccount[] = [];
    const rows: TeamAccountRows = {
        teamAccounts: () => [...saved],
        saveTeamAccount: (account) => void saved.splice(0, saved.length, ...saved.filter((each) => each.id !== account.id), account),
        deleteTeamAccount: (id) => void saved.splice(0, saved.length, ...saved.filter((each) => each.id !== id)),
        deviceId: () => "device-1",
    };
    const dir = join(root, "team-antigravity");

    mkdirSync(dir, { recursive: true });
    const team = new TeamAccounts(rows, dir, Date.now, undefined, { send, platform: { osType: "linux", arch: "amd64" } });

    await team.open();

    try {
        const account = team.add("google-antigravity", "Work", "owner");

        assert.equal(account.id, "google-antigravity~team-work");
        assert.deepEqual(
            team.list().map((each) => [each.providerName, each.signIn.oauth, each.configured]),
            [["Google Antigravity", "Sign in with Google", false]],
        );

        // Its Google sign-in, as a manager's Providers sheet drives it through the gateway.
        const flow = team.startLogin(account.id, "owner", "oauth");
        const steps: FlowStep[] = [];
        const next = async (until: (step: FlowStep) => boolean) => {
            while (!steps.some(until)) {
                steps.push(...(await team.wait(flow, "owner", steps.length, 5_000)).steps);
            }

            return steps.find(until)!;
        };
        const method = (await next((step) => step.step === "prompt")) as { promptId: string; prompt: Omit<AuthPrompt, "signal"> };

        assert.equal(method.prompt.type, "select", "how it signs in, agy's first question");
        team.answer(flow, "owner", method.promptId, "google");
        const prompt = (await next((step) => step.step === "prompt" && step.prompt.type === "manual_code")) as { promptId: string; prompt: Omit<AuthPrompt, "signal"> };
        team.answer(flow, "owner", prompt.promptId, "4/0Aean-team-code");
        const done = (await next((step) => step.step === "done")) as { ok: boolean; details?: string };

        assert.equal(done.ok, true, done.details ?? "");
        assert.deepEqual(team.models(account.id).map((model) => [model.id, model.provider]), [["gemini-3.5-flash-lite", account.id]], "its models, from its own list, after the sign-in");

        // A turn through the gateway: the team account's token and project.
        const message = await team
            .stream(account.id, "gemini-3.5-flash-lite", { messages: [{ role: "user", content: "hi", timestamp: Date.now() }] }, {}, new AbortController().signal)
            .result();

        assert.equal(message.stopReason, "stop", message.errorMessage ?? "");
        const turn = sent.find((each) => each.url.includes("streamGenerateContent"))!;

        assert.equal(turn.headers.Authorization, "Bearer ya29.team");
        assert.equal((JSON.parse(turn.body) as { project: string }).project, "team-project");

        // Its plan limits, as the team's pi-phones show them: what agy's reads keep, no call of its own.
        const [usage] = await team.usage([account.id], true);

        assert.ok(usage !== undefined && "windows" in usage, JSON.stringify(usage));
        assert.deepEqual(usage.windows.map((window) => Math.round(window.usedPercent)), [40]);

        await team.remove(account.id);
        assert.deepEqual(team.list(), []);
    } finally {
        team.close();
    }
});
