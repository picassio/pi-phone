// Google Antigravity (PP-555, antigravity.ts): signing in is agy's own sign-in on a machine with no browser (Google's
// consent page with agy's client, PKCE, its scopes and redirect; the code its page shows pasted back and traded for
// tokens), then the account's project, set up with onboardUser for an account with none; the token is renewed as agy
// renews it; the models are agy's list, one per family with its efforts as thinking levels; a request is agy's (its
// headers, envelope and thinking per model), and text, thinking, tool calls and pictures go and come back. Google is
// stood in for.
import { type App, cleanUp, fakeTab, modelTexts, newSession, openApp, owner, root, say, scriptedModel, until } from "./helpers.ts";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { after, test } from "node:test";
import { type Api, type AssistantMessage, type AuthEvent, type AuthPrompt, type Context, type Model, normalizeContext, type OAuthCredential, type ProviderAuthInteraction } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { accountProvider } from "../src/server/accounts.ts";
import { AGY_START } from "../src/server/agy-wire.ts";
import { AGY_PROVIDER, type AgyCatalog, type AgySend, antigravity, antigravityProvider, catalogModels } from "../src/server/antigravity.ts";
import { appSettings } from "../src/server/settings-registry.ts";
import { HttpError } from "../src/server/errors.ts";

const UA = "antigravity/cli/1.5.15 (aidev_client; os_type=linux; arch=amd64; cl=1027820220; auth_method=consumer)";
const NOW = Date.parse("2026-11-23T08:00:00Z");

const level = (suffix: string) => ({ thinkingSuffix: suffix, thinkingDisplayName: suffix });
const CATALOG: AgyCatalog = {
    models: {
        "gemini-3.8-flash-low": { displayName: "Gemini 3.8 Flash (Low)", supportsImages: true, supportsThinking: true, thinkingLevel: 1, maxTokens: "1048576", maxOutputTokens: 65536, model: "MODEL_PLACEHOLDER_M320", modelProvider: "MODEL_PROVIDER_GOOGLE" },
        "gemini-3.8-flash-high": { displayName: "Gemini 3.8 Flash (High)", supportsImages: true, supportsThinking: true, thinkingLevel: 3, maxTokens: "1048576", maxOutputTokens: 65536, model: "MODEL_PLACEHOLDER_M318", modelProvider: "MODEL_PROVIDER_GOOGLE" },
        "gemini-4-hydrogen-high": { displayName: "Gemini 4 Hydrogen (High)", supportsImages: true, supportsThinking: true, thinkingLevel: 3, maxTokens: "1048576", maxOutputTokens: 262144, model: "MODEL_PLACEHOLDER_M525", modelProvider: "MODEL_PROVIDER_GOOGLE" },
        "gemini-4-hydrogen-xhigh": { displayName: "Gemini 4 Hydrogen (XHigh)", supportsImages: true, supportsThinking: true, thinkingLevel: 100, maxTokens: "1048576", maxOutputTokens: 262144, model: "MODEL_PLACEHOLDER_M528", modelProvider: "MODEL_PROVIDER_GOOGLE" },
        "claude-sonnet-5-5-low": { displayName: "Claude Sonnet 5.5 (Low)", supportsImages: true, supportsThinking: true, thinkingLevel: 1, maxTokens: "200000", maxOutputTokens: 128000, model: "MODEL_PLACEHOLDER_M403", modelProvider: "MODEL_PROVIDER_ANTHROPIC" },
        "gpt-oss-120b-medium": { displayName: "GPT-OSS 120B (Medium)", supportsThinking: true, thinkingBudget: 8192, maxTokens: "131072", maxOutputTokens: 32768, model: "MODEL_OPENAI_GPT_OSS_120B_MEDIUM", modelProvider: "MODEL_PROVIDER_OPENAI" },
        "gemini-4-carbon-disabled": { displayName: "Gemini 4 Carbon", disabled: true, maxTokens: "1048576", maxOutputTokens: 262144 },
        "gemini-3.5-flash-lite": { displayName: "Gemini 3.5 Flash Lite", maxTokens: "1048576", maxOutputTokens: 65535 },
    },
    agentModelSorts: [
        {
            groups: [
                { modelIds: ["gemini-4-hydrogen-high", "gemini-4-hydrogen-xhigh", "gemini-3.8-flash-high", "gemini-3.8-flash-low", "claude-sonnet-5-5-low", "gpt-oss-120b-medium", "gemini-4-carbon-disabled"] },
            ],
        },
    ],
    groupedModels: {
        "gemini-4-hydrogen": { displayName: "Gemini 4 Hydrogen", supportedThinkingLevels: [level("high"), level("xhigh")] },
        "gemini-3.8-flash": { displayName: "Gemini 3.8 Flash", supportedThinkingLevels: [level("low"), level("high")] },
        "claude-sonnet-5-5": { displayName: "Claude Sonnet 5.5", supportedThinkingLevels: [level("low")] },
    },
};

type Sent = { url: string; method: string; headers: Record<string, string>; body: string };

/** Google, as these tests answer for it: each request kept, each URL answered by `answer`. */
function google(answer: (sent: Sent) => { status?: number; body: string; headers?: Record<string, string> }) {
    const sent: Sent[] = [];
    const send: AgySend = async (url, init) => {
        const request = { url, method: init.method ?? "POST", headers: init.headers, body: init.body ?? "" };

        sent.push(request);
        const reply = answer(request);

        return {
            status: reply.status ?? 200,
            headers: new Headers(reply.headers ?? { "content-type": "application/json" }),
            body: (async function* () {
                yield new TextEncoder().encode(reply.body);
            })(),
        };
    };

    return { sent, send };
}

/** retrieveUserQuotaSummary's answer, as Google gave it on 2026-11-23 (its texts cut). */
const QUOTA = {
    groups: [
        {
            buckets: [
                { bucketId: "gemini-weekly", displayName: "Weekly Limit Remaining", window: "weekly", resetTime: "2026-11-28T10:39:15Z", remainingFraction: 0.42826134 },
                { bucketId: "gemini-5h", displayName: "Five Hour Limit Remaining", window: "5h", resetTime: "2026-11-23T13:12:05Z", remainingFraction: 1 },
            ],
            displayName: "Gemini Models",
        },
        {
            buckets: [
                { bucketId: "3p-weekly", displayName: "Weekly Limit Remaining", window: "weekly", resetTime: "2026-11-29T06:07:33Z", remainingFraction: 0.9431948 },
                { bucketId: "3p-5h", displayName: "Five Hour Limit Remaining", window: "5h", resetTime: "2026-11-23T13:12:05Z" },
            ],
            displayName: "Claude and GPT models",
        },
    ],
};

const sse = (...chunks: unknown[]) => chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\r\n\r\n`).join("");

const CODE = "4/0AeanS0-pasted-code";
const PLATFORM = { osType: "linux", arch: "amd64" };
const jwt = (claims: Record<string, unknown>) => `e30.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.c2ln`;
const TOKENS = JSON.stringify({ access_token: "ya29.new-access", expires_in: 3599, refresh_token: "1//new-refresh", scope: "openid", token_type: "Bearer", id_token: jwt({ email: "owner@example.com" }) });

/**
 * A sign-in's card, as these tests answer it: each event kept, the code prompt answered by `paste` (from the consent
 * page's address), a text prompt (a Workspace account's Google Cloud project) by `typed`.
 */
function card(paste: (url: URL) => string = () => CODE, typed?: string) {
    const events: AuthEvent[] = [];
    const prompts: AuthPrompt[] = [];
    const interaction: ProviderAuthInteraction = {
        signal: new AbortController().signal,
        prompt: async (prompt) => {
            prompts.push(prompt);

            if (prompt.type === "text") {
                assert.ok(typed !== undefined, `nothing to type for "${prompt.message}"`);

                return typed;
            }

            const shown = events.find((event) => event.type === "auth_url");

            assert.ok(shown?.type === "auth_url", "the consent page comes before the code is asked for");

            return paste(new URL(shown.url));
        },
        notify: (event) => events.push(event),
    };

    return { events, prompts, interaction };
}

const credential: OAuthCredential = {
    type: "oauth",
    access: "ya29.live",
    refresh: "1//kept-refresh",
    expires: NOW + 3_000_000,
    projectId: "aicode-consumers",
    osType: "linux",
    arch: "amd64",
    authMethod: "consumer",
};

test("signing in is agy's: Google's consent page with agy's client, PKCE S256 and scopes; the pasted code traded as agy trades it; then the project", async () => {
    const { sent, send } = google((request) =>
        request.url.endsWith("/token") ? { body: TOKENS } : { body: JSON.stringify({ currentTier: { id: "free-tier" }, cloudaicompanionProject: "aicode-consumers" }) },
    );
    const { events, prompts, interaction } = card();
    const signedIn = await antigravityProvider({ send, now: () => NOW, platform: PLATFORM }).auth.oauth!.login(interaction);

    // The risk first, then the consent page, then the code.
    const risk = events[0]!;

    assert.equal(risk.type, "info");
    assert.match(risk.type === "info" ? risk.message : "", /terms forbid third-party clients.*suspended.*Gemini CLI and Code Assist.*one appeal/);
    const shown = events[1]!;

    assert.ok(shown.type === "auth_url");
    assert.match(shown.instructions ?? "", /shows a code: copy it and paste it/);
    const url = new URL(shown.url);

    assert.equal(`${url.origin}${url.pathname}`, "https://accounts.google.com/o/oauth2/auth");
    // Go's url.Values: by name.
    assert.deepEqual([...url.searchParams.keys()], ["access_type", "client_id", "code_challenge", "code_challenge_method", "prompt", "redirect_uri", "response_type", "scope", "state"]);
    assert.equal(url.searchParams.get("access_type"), "offline");
    assert.equal(url.searchParams.get("client_id"), "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com");
    assert.equal(url.searchParams.get("code_challenge_method"), "S256");
    assert.equal(url.searchParams.get("prompt"), "consent");
    assert.equal(url.searchParams.get("redirect_uri"), "https://antigravity.google/oauth-callback");
    assert.equal(url.searchParams.get("response_type"), "code");
    assert.equal(
        url.searchParams.get("scope"),
        "https://www.googleapis.com/auth/cloud-platform https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/userinfo.profile https://www.googleapis.com/auth/cclog https://www.googleapis.com/auth/experimentsandconfigs https://www.googleapis.com/auth/aicode openid",
    );
    assert.match(shown.url, /&scope=https%3A%2F%2Fwww\.googleapis\.com%2Fauth%2Fcloud-platform\+https%3A/, "spaces as +, as Go writes them");
    assert.match(url.searchParams.get("state")!, /^[\w-]{22}$/);
    assert.equal(prompts.length, 1);
    assert.equal(prompts[0]!.type, "manual_code");

    // The code traded at Google's token endpoint as agy's Go client trades it: the form by name, with the verifier, and
    // Go's headers in Go's order (PP-558).
    assert.equal(sent[0]!.url, "https://oauth2.googleapis.com/token");
    assert.deepEqual(Object.entries(sent[0]!.headers), [
        ["Host", "oauth2.googleapis.com"],
        ["User-Agent", "Go-http-client/1.1"],
        ["Content-Length", String(sent[0]!.body.length)],
        ["Content-Type", "application/x-www-form-urlencoded"],
        ["Accept-Encoding", "gzip"],
    ]);
    const form = new URLSearchParams(sent[0]!.body);

    assert.deepEqual([...form.keys()], ["client_id", "client_secret", "code", "code_verifier", "grant_type", "redirect_uri"]);
    assert.equal(form.get("client_id"), url.searchParams.get("client_id"));
    assert.equal(form.get("client_secret")!.length, 35);
    assert.equal(form.get("code"), CODE);
    assert.equal(form.get("grant_type"), "authorization_code");
    assert.equal(form.get("redirect_uri"), "https://antigravity.google/oauth-callback");
    assert.match(form.get("code_verifier")!, /^[\w-]{43}$/);
    assert.equal(createHash("sha256").update(form.get("code_verifier")!).digest("base64url"), url.searchParams.get("code_challenge"), "the challenge is the verifier's S256");

    // Then the project, as agy asks for it, with agy's headers in Go's order.
    assert.equal(sent.length, 2);
    assert.equal(sent[1]!.url, "https://daily-cloudcode-pa.googleapis.com/v1internal:loadCodeAssist");
    assert.deepEqual(Object.entries(sent[1]!.headers), [
        ["Host", "daily-cloudcode-pa.googleapis.com"],
        ["User-Agent", UA],
        ["Content-Length", "38"],
        ["Authorization", "Bearer ya29.new-access"],
        ["Content-Type", "application/json"],
        ["Accept-Encoding", "gzip"],
    ]);
    assert.equal(sent[1]!.body, '{"metadata":{"ideType":"ANTIGRAVITY"}}');
    assert.deepEqual(
        { ...signedIn },
        {
            type: "oauth",
            access: "ya29.new-access",
            refresh: "1//new-refresh",
            expires: NOW + 3599_000 - 300_000,
            projectId: "aicode-consumers",
            osType: "linux",
            arch: "amd64",
            authMethod: "consumer",
            email: "owner@example.com",
        },
    );
    // Nothing secret in what the card shows.
    assert.doesNotMatch(JSON.stringify(events), /pasted-code|new-access|new-refresh|code_verifier/);

    // The page's whole address works too, when its state is this sign-in's.
    const whole = card((page) => `https://antigravity.google/oauth-callback?state=${page.searchParams.get("state")}&code=${encodeURIComponent(CODE)}&scope=openid`);
    const again = google((request) => (request.url.endsWith("/token") ? { body: TOKENS } : { body: JSON.stringify({ cloudaicompanionProject: { id: "aicode-consumers" } }) }));

    assert.equal((await antigravityProvider({ send: again.send, platform: PLATFORM }).auth.oauth!.login(whole.interaction)).projectId, "aicode-consumers");
    assert.equal(new URLSearchParams(again.sent[0]!.body).get("code"), CODE);
});

test("a sign-in says what went wrong, never with the code: another sign-in's page, Google's refusal, no code, no refresh token", async () => {
    const none = google(() => ({ body: "{}" }));
    const provider = antigravityProvider({ send: none.send, platform: PLATFORM });

    await assert.rejects(provider.auth.oauth!.login(card(() => `https://antigravity.google/oauth-callback?state=other&code=${CODE}`).interaction), /another sign-in: start again/);
    await assert.rejects(provider.auth.oauth!.login(card(() => "https://antigravity.google/oauth-callback?error=access_denied").interaction), /Google did not sign in: access_denied/);
    await assert.rejects(provider.auth.oauth!.login(card(() => "  ").interaction), /No code was pasted/);
    assert.equal(none.sent.length, 0, "nothing sent without a code of this sign-in");

    const refused = google(() => ({ status: 400, body: JSON.stringify({ error: "invalid_grant", error_description: "Malformed auth code." }) }));

    await assert.rejects(
        antigravityProvider({ send: refused.send, platform: PLATFORM }).auth.oauth!.login(card().interaction),
        (error: Error) => /Google did not accept the code: .*\(400\).*invalid_grant/.test(error.message) && !error.message.includes(CODE),
    );

    const noRefresh = google(() => ({ body: JSON.stringify({ access_token: "ya29.x", expires_in: 3599 }) }));

    await assert.rejects(antigravityProvider({ send: noRefresh.send, platform: PLATFORM }).auth.oauth!.login(card().interaction), /no refresh token/);
});

test("an account with no project yet is set up as agy does: onboardUser on its default tier, asked again until Google is done; a Workspace tier is refused", async () => {
    let polls = 0;
    const { sent, send } = google((request) => {
        if (request.url.endsWith("/token")) {
            return { body: TOKENS };
        }

        if (request.url.endsWith(":loadCodeAssist")) {
            return { body: JSON.stringify({ allowedTiers: [{ id: "standard-tier" }, { id: "free-tier", isDefault: true }] }) };
        }

        if (request.url.endsWith(":onboardUser")) {
            return { body: JSON.stringify({ name: "operations/onboard-1", done: false }) };
        }

        polls += 1;

        return { body: JSON.stringify(polls < 2 ? { name: "operations/onboard-1", done: false } : { name: "operations/onboard-1", done: true, response: { cloudaicompanionProject: { id: "bright-river-123", name: "bright-river-123" } } }) };
    });
    const waits: number[] = [];
    const { events, prompts, interaction } = card();
    const signedIn = await antigravityProvider({ send, platform: PLATFORM, sleep: async (ms) => void waits.push(ms) }).auth.oauth!.login(interaction);

    assert.deepEqual(prompts.map((prompt) => prompt.type), ["manual_code"], "a free account is asked for no project");

    assert.deepEqual(
        sent.map((request) => `${request.method} ${request.url.replace("https://daily-cloudcode-pa.googleapis.com", "")}`),
        ["POST https://oauth2.googleapis.com/token", "POST /v1internal:loadCodeAssist", "POST /v1internal:onboardUser", "GET /v1internal/operations/onboard-1", "GET /v1internal/operations/onboard-1"],
    );
    assert.equal(sent[2]!.body, '{"tierId":"free-tier","metadata":{"ideType":"ANTIGRAVITY"}}');
    assert.deepEqual(Object.keys(sent[2]!.headers), ["Host", "User-Agent", "Content-Length", "Authorization", "Content-Type", "Accept-Encoding"]);
    // A GET as Go sends it: no body, so no Content-Length nor Content-Type.
    assert.deepEqual(Object.entries(sent[3]!.headers), [
        ["Host", "daily-cloudcode-pa.googleapis.com"],
        ["User-Agent", UA],
        ["Authorization", "Bearer ya29.new-access"],
        ["Accept-Encoding", "gzip"],
    ]);
    assert.equal(sent[3]!.body, "");
    assert.deepEqual(waits, [5000, 5000]);
    assert.equal(signedIn.projectId, "bright-river-123");
    assert.ok(events.some((event) => event.type === "progress" && /Setting up Antigravity/.test(event.message)));

    // Google never finishing: said so, after its tries.
    const slow = google((request) =>
        request.url.endsWith("/token") ? { body: TOKENS } : request.url.endsWith(":loadCodeAssist") ? { body: "{}" } : { body: JSON.stringify({ name: "operations/slow", done: false }) },
    );

    await assert.rejects(antigravityProvider({ send: slow.send, platform: PLATFORM, sleep: async () => {} }).auth.oauth!.login(card().interaction), /has not finished setting up Antigravity/);
    assert.equal(slow.sent.filter((request) => request.method === "GET").length, 23);
});

/** loadCodeAssist without a project, for a Workspace account: its default tier needs one of the person's own. */
const WORKSPACE = { allowedTiers: [{ id: "standard-tier", name: "Gemini Code Assist Standard", isDefault: true, userDefinedCloudaicompanionProject: true }] };
const googleSaid = (status: number, code: string, message: string) => ({ status, body: JSON.stringify({ error: { code: status, message, status: code } }) });

test("a Workspace account (standard-tier) is asked for its Google Cloud project, as gemini-cli's GOOGLE_CLOUD_PROJECT: loadCodeAssist with it as cloudaicompanionProject and duetProject, onboarded on its tier when Google has none yet; signing in again takes the saved one", async () => {
    // Google knows the account's tier with that project.
    const known = google((request) =>
        request.url.endsWith("/token")
            ? { body: TOKENS }
            : request.body.includes("corp-gemini-1")
              ? { body: JSON.stringify({ currentTier: { id: "standard-tier" }, cloudaicompanionProject: "corp-gemini-1" }) }
              : { body: JSON.stringify(WORKSPACE) },
    );
    const first = card(undefined, " corp-gemini-1 ");
    const signedIn = await antigravityProvider({ send: known.send, platform: PLATFORM }).auth.oauth!.login(first.interaction);

    assert.equal(signedIn.projectId, "corp-gemini-1");
    assert.deepEqual(
        first.prompts.map((prompt) => [prompt.type, prompt.message]),
        [
            ["manual_code", "The code from Google Antigravity's page"],
            ["text", "Google Cloud project ID"],
        ],
    );
    const help = first.events.find((event) => event.type === "info" && event.message.includes("GOOGLE_CLOUD_PROJECT"));

    assert.ok(help?.type === "info");
    assert.match(help.message, /\(standard-tier\) needs a Google Cloud project of its own.*cloudaicompanion\.googleapis\.com.*Gemini Code Assist.*not its number/);
    assert.ok(help.links?.some((link) => link.url.includes("cloudaicompanion.googleapis.com")));
    const loads = known.sent.filter((request) => request.url.endsWith(":loadCodeAssist"));

    assert.deepEqual(
        loads.map((request) => JSON.parse(request.body) as unknown),
        [{ metadata: { ideType: "ANTIGRAVITY" } }, { cloudaicompanionProject: "corp-gemini-1", metadata: { ideType: "ANTIGRAVITY", duetProject: "corp-gemini-1" } }],
    );
    assert.equal(known.sent.some((request) => request.url.includes("onboardUser")), false, "its tier is there: no onboarding");

    // Google has no tier for it yet: onboarded on its default tier with the project, as gemini-cli does.
    const fresh = google((request) =>
        request.url.endsWith("/token")
            ? { body: TOKENS }
            : request.url.endsWith(":onboardUser")
              ? { body: JSON.stringify({ name: "operations/ws-1", done: true, response: { cloudaicompanionProject: { id: "corp-gemini-1" } } }) }
              : { body: JSON.stringify(WORKSPACE) },
    );
    const onboarded = await antigravityProvider({ send: fresh.send, platform: PLATFORM, sleep: async () => {} }).auth.oauth!.login(card(undefined, "corp-gemini-1").interaction);

    assert.equal(onboarded.projectId, "corp-gemini-1");
    assert.deepEqual(JSON.parse(fresh.sent.find((request) => request.url.endsWith(":onboardUser"))!.body), {
        tierId: "standard-tier",
        cloudaicompanionProject: "corp-gemini-1",
        metadata: { ideType: "ANTIGRAVITY", duetProject: "corp-gemini-1" },
    });

    // Signing in again: the project its sign-in has, without asking.
    const saved = JSON.stringify({ token: "ya29.before", project: "corp-gemini-1", userAgent: UA });
    const again = card();
    const resigned = await antigravityProvider({ send: known.send, platform: PLATFORM, auth: async () => saved }).auth.oauth!.login(again.interaction);

    assert.equal(resigned.projectId, "corp-gemini-1");
    assert.deepEqual(again.prompts.map((prompt) => prompt.type), ["manual_code"], "no project asked for");
    assert.ok(again.events.some((event) => event.type === "info" && /Using the Google Cloud project corp-gemini-1/.test(event.message)));

    // A saved project Google refuses now: said, and another asked for.
    const moved = google((request) =>
        request.url.endsWith("/token")
            ? { body: TOKENS }
            : request.body.includes("old-project")
              ? googleSaid(403, "PERMISSION_DENIED", "The caller does not have permission")
              : request.body.includes("corp-gemini-1")
                ? { body: JSON.stringify({ currentTier: { id: "standard-tier" } }) }
                : { body: JSON.stringify(WORKSPACE) },
    );
    const asked = card(undefined, "corp-gemini-1");
    const switched = await antigravityProvider({ send: moved.send, platform: PLATFORM, auth: async () => JSON.stringify({ token: "t", project: "old-project", userAgent: UA }) }).auth.oauth!.login(
        asked.interaction,
    );

    assert.equal(switched.projectId, "corp-gemini-1", "Google's tier with no project of its own: the one typed");
    assert.ok(asked.events.some((event) => event.type === "info" && /^Google refused the project old-project.*needs a Google Cloud project of its own/.test(event.message)));
});

test("a project Google refuses says why and what to do in Google Cloud: the API off, no access or license, no such project; a project number or nothing typed is refused before Google is asked", async () => {
    const refusing = (answer: { status: number; body: string }) =>
        google((request) => (request.url.endsWith("/token") ? { body: TOKENS } : request.body.includes("corp-x") ? answer : { body: JSON.stringify(WORKSPACE) }));
    const login = (send: AgySend, typed: string) => antigravityProvider({ send, platform: PLATFORM }).auth.oauth!.login(card(undefined, typed).interaction);
    const cases: [{ status: number; body: string }, RegExp][] = [
        [
            googleSaid(403, "PERMISSION_DENIED", "Gemini for Google Cloud API has not been used in project corp-x before or it is disabled. Enable it by visiting https://console.developers.google.com/apis/api/cloudaicompanion.googleapis.com/overview?project=corp-x then retry."),
            /^The Gemini for Google Cloud API is off in the project corp-x: turn on cloudaicompanion\.googleapis\.com in Google Cloud console › APIs & Services › Library for that project, wait a few minutes, then sign in again\. Google said: PERMISSION_DENIED: Gemini for Google Cloud API has not been used/,
        ],
        [
            googleSaid(403, "PERMISSION_DENIED", "The caller does not have permission"),
            /^Google refused the project corp-x for this account: the account needs a role there that may use Gemini Code Assist \(such as Gemini for Google Cloud User\) and a Gemini Code Assist Standard or Enterprise license from your Workspace admin\. Then sign in again\. Google said: PERMISSION_DENIED: The caller does not have permission$/,
        ],
        [googleSaid(404, "NOT_FOUND", "Project corp-x not found"), /^Google knows no project corp-x this account may use: check the project ID \(not its number\)/],
        [{ status: 200, body: JSON.stringify({ ineligibleTiers: [{ reasonCode: "INELIGIBLE_ACCOUNT", reasonMessage: "Your account is not licensed for Gemini Code Assist" }] }) }, /no Gemini Code Assist plan with the project corp-x \(Your account is not licensed for Gemini Code Assist\): ask your Google Workspace admin/],
    ];

    for (const [answer, said] of cases) {
        const refused = refusing(answer);

        await assert.rejects(login(refused.send, "corp-x"), (error: Error) => error instanceof HttpError && said.test(error.message));
        assert.equal(refused.sent.some((request) => request.url.endsWith(":onboardUser")), false, "nothing onboarded on a refused project");
    }

    const none = refusing({ status: 500, body: "{}" });

    await assert.rejects(login(none.send, "123456789012"), /123456789012 is a project number: type the project's ID/);
    await assert.rejects(login(none.send, "  "), /No Google Cloud project ID was given/);
    await assert.rejects(login(none.send, "My_Project"), /My_Project is not a Google Cloud project ID/);
    assert.equal(none.sent.filter((request) => request.url.endsWith(":loadCodeAssist")).length, 3, "only the first loadCodeAssist of each sign-in");
});

test("the token is renewed as agy's Go client renews it, the refresh token kept; a refused renewal says invalid_grant and never the token", async () => {
    const { sent, send } = google(() => ({ body: JSON.stringify({ access_token: "ya29.renewed", expires_in: 3599, token_type: "Bearer" }) }));
    const renewed = await antigravityProvider({ send, now: () => NOW }).auth.oauth!.refresh(credential, new AbortController().signal);

    assert.equal(sent[0]!.url, "https://oauth2.googleapis.com/token");
    assert.deepEqual(Object.keys(sent[0]!.headers), ["Host", "User-Agent", "Content-Length", "Content-Type", "Accept-Encoding"]);
    const form = new URLSearchParams(sent[0]!.body);

    assert.deepEqual([...form.keys()], ["client_id", "client_secret", "grant_type", "refresh_token"]);
    assert.equal(form.get("refresh_token"), "1//kept-refresh");
    assert.equal(renewed.access, "ya29.renewed");
    assert.equal(renewed.refresh, "1//kept-refresh");
    assert.equal(renewed.expires, NOW + 3599_000 - 300_000);
    assert.equal(renewed.projectId, "aicode-consumers");

    const refused = google(() => ({ status: 400, body: JSON.stringify({ error: "invalid_grant", error_description: "Token has been expired or revoked." }) }));

    await assert.rejects(
        antigravityProvider({ send: refused.send }).auth.oauth!.refresh(credential, new AbortController().signal),
        (error: Error) => /Google token refresh failed: .*invalid_grant/.test(error.message) && !error.message.includes("1//kept-refresh"),
    );
});

test("the models are agy's list: one per family with agy's efforts as thinking levels, the rest as they are, disabled ones left out", async () => {
    const models = catalogModels(CATALOG);

    assert.deepEqual(
        models.map((model) => [model.id, model.name, model.reasoning]),
        [
            ["gemini-4-hydrogen", "Gemini 4 Hydrogen", true],
            ["gemini-3.8-flash", "Gemini 3.8 Flash", true],
            ["claude-sonnet-5-5", "Claude Sonnet 5.5", true],
            ["gpt-oss-120b-medium", "GPT-OSS 120B (Medium)", false],
        ],
    );
    const flash = models[1]!;

    assert.deepEqual(flash.thinkingLevelMap, { off: null, minimal: null, low: "low", medium: null, high: "high" });
    assert.deepEqual(models[0]!.thinkingLevelMap, { off: null, minimal: null, low: null, medium: null, high: "high", xhigh: "xhigh" });
    assert.equal(flash.contextWindow, 1048576);
    assert.equal(flash.maxTokens, 65536);
    assert.deepEqual(flash.input, ["text", "image"]);
    assert.deepEqual(models[3]!.input, ["text"]);
    assert.equal(flash.provider, AGY_PROVIDER);

    // Through Pi's model refresh: agy's own call, with the account's project.
    const { sent, send } = google(() => ({ body: JSON.stringify(CATALOG) }));
    const provider = antigravityProvider({ send });

    await provider.refreshModels!({ credential, allowNetwork: true, signal: new AbortController().signal, publish: async (publication) => (publication.update?.(), true) });
    assert.equal(sent[0]!.url, "https://daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels");
    assert.equal(sent[0]!.body, '{"project":"aicode-consumers"}');
    assert.equal(sent[0]!.headers["User-Agent"], UA);
    assert.deepEqual(provider.getModels().map((model) => model.id), ["gemini-4-hydrogen", "gemini-3.8-flash", "claude-sonnet-5-5", "gpt-oss-120b-medium"]);
});

type SentPart = {
    text?: string;
    inlineData?: { mimeType: string; data: string };
    functionCall?: { name: string; args: Record<string, unknown>; id?: string };
    functionResponse?: { name: string; response: unknown; id?: string; parts?: unknown };
    thoughtSignature?: string;
};

/** agy's request body, as these tests read it. */
type Body = {
    project: string;
    requestId: string;
    model: string;
    userAgent: string;
    requestType: string;
    request: {
        contents: { role: string; parts: SentPart[] }[];
        systemInstruction?: unknown;
        tools: { functionDeclarations: { name: string; parameters?: unknown; parametersJsonSchema?: unknown }[] }[];
        labels: Record<string, string>;
        generationConfig: unknown;
        sessionId: string;
    };
};

/** A provider that knows the catalog, and the request it sends for `context` on `modelId` at `reasoning`. */
async function turn(modelId: string, context: Context, reasoning: "low" | "high" | "xhigh" | undefined, reply: string, sessionId?: string) {
    const { sent, send } = google((request) => (request.url.includes("fetchAvailableModels") ? { body: JSON.stringify(CATALOG) } : { body: reply, headers: { "content-type": "text/event-stream" } }));
    const provider = antigravityProvider({ send });
    const model = catalogModels(CATALOG).find((each) => each.id === modelId)! as Model<Api>;
    const auth = await provider.auth.oauth!.toAuth(credential);
    const stream = provider.streamSimple(model, normalizeContext(context), { apiKey: auth.apiKey, ...(reasoning === undefined ? {} : { reasoning }), ...(sessionId === undefined ? {} : { sessionId }) });
    const message: AssistantMessage = await stream.result();
    const request = sent.find((each) => each.url.includes("streamGenerateContent"));

    return { message, request, body: request === undefined ? undefined : (JSON.parse(request.body) as Body), sent };
}

const READ_TOOL = { name: "read", description: "Read a file", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } };

test("a request is agy's: its headers, envelope, the effort's model and thinking; thinking, text and a tool call come back", async () => {
    const reply = sse(
        { response: { candidates: [{ content: { role: "model", parts: [{ thought: true, text: "Looking at it." }] } }], modelVersion: "gemini-3.8-flash-n", responseId: "r-1" }, traceId: "t" },
        { response: { candidates: [{ content: { role: "model", parts: [{ text: "I will read it." }] } }] } },
        { response: { candidates: [{ content: { role: "model", parts: [{ thoughtSignature: "EpgBCpUBAWkU", functionCall: { name: "read", args: { path: "/a.txt" }, id: "call_42" } }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 120, candidatesTokenCount: 9, thoughtsTokenCount: 4, totalTokenCount: 133, cachedContentTokenCount: 100 } } },
    );
    const context: Context = { systemPrompt: "You are Pi.", messages: [{ role: "user", content: "Read /a.txt", timestamp: NOW }], tools: [READ_TOOL as never] };
    const { message, request, body } = await turn("gemini-3.8-flash", context, "high", reply, "session-7");

    assert.equal(request!.url, "https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse");
    assert.deepEqual(Object.entries(request!.headers), [
        ["Host", "daily-cloudcode-pa.googleapis.com"],
        ["User-Agent", UA],
        ["Content-Length", String(Buffer.byteLength(request!.body))],
        ["Authorization", "Bearer ya29.live"],
        ["Content-Type", "application/json"],
        ["Accept-Encoding", "gzip"],
    ]);
    assert.deepEqual(Object.keys(body!), ["project", "requestId", "request", "model", "userAgent", "requestType"]);
    assert.equal(body!.project, "aicode-consumers");
    assert.equal(body!.model, "gemini-3.8-flash-high");
    assert.equal(body!.userAgent, "antigravity");
    assert.equal(body!.requestType, "agent");
    assert.match(body!.requestId, /^agent\/[0-9a-f-]{36}\/\d{13}\/[0-9a-f-]{36}\/1$/);
    const inner = body!.request;

    assert.deepEqual(Object.keys(inner), ["contents", "systemInstruction", "tools", "labels", "generationConfig", "sessionId"]);
    assert.deepEqual(inner.systemInstruction, { role: "user", parts: [{ text: "You are Pi." }] });
    assert.deepEqual(inner.generationConfig, { maxOutputTokens: 65536, thinkingConfig: { includeThoughts: true, thinkingLevel: "HIGH" } });
    assert.equal(inner.labels.model_enum, "MODEL_PLACEHOLDER_M318");
    assert.equal(inner.labels.last_step_index, "0");
    assert.equal(inner.labels.used_claude, "false");
    assert.equal(inner.labels.used_non_gemini_model, "false");
    assert.equal(inner.labels.cascade_id, body!.requestId.split("/")[1]);
    assert.equal(inner.labels.request_id, `${inner.labels.trajectory_id}-0`);
    assert.match(inner.sessionId, /^\d{1,19}$/);
    assert.equal(inner.tools[0]!.functionDeclarations[0]!.name, "read");
    assert.ok(inner.tools[0]!.functionDeclarations[0]!.parametersJsonSchema, "Gemini gets the JSON schema");
    assert.deepEqual(inner.contents, [{ role: "user", parts: [{ text: "Read /a.txt" }] }]);

    assert.deepEqual(
        message.content.map((block) => block.type),
        ["thinking", "text", "toolCall"],
    );
    assert.equal(message.content[0]!.type === "thinking" && message.content[0]!.thinking, "Looking at it.");
    const call = message.content[2]!;

    assert.ok(call.type === "toolCall");
    assert.equal(call.id, "call_42");
    assert.deepEqual(call.arguments, { path: "/a.txt" });
    assert.equal(call.thoughtSignature, "EpgBCpUBAWkU");
    assert.equal(message.stopReason, "toolUse");
    assert.equal(message.providerThinkingLevel, "high");
    assert.deepEqual([message.usage.input, message.usage.cacheRead, message.usage.output], [20, 100, 13]);

    // The same session's next turn keeps its cascade; the tool's answer goes back with its id, the call with its signature.
    const next = await turn(
        "gemini-3.8-flash",
        { ...context, messages: [...context.messages, message, { role: "toolResult", toolCallId: "call_42", toolName: "read", content: [{ type: "text", text: "hello" }], isError: false, timestamp: NOW }] },
        "high",
        sse({ response: { candidates: [{ content: { role: "model", parts: [{ text: "It says hello." }] }, finishReason: "STOP" }] } }),
        "session-7",
    );
    const contents = next.body!.request.contents;

    assert.equal(next.body!.request.labels.cascade_id, inner.labels.cascade_id);
    assert.equal(next.body!.request.labels.trajectory_id, inner.labels.trajectory_id);
    assert.equal(next.body!.request.labels.last_step_index, "2");
    assert.equal(next.body!.request.labels.request_id, `${inner.labels.trajectory_id}-1`);
    assert.match(next.body!.requestId, /\/3$/);
    assert.deepEqual(contents[1]!.parts.at(-1), { functionCall: { name: "read", args: { path: "/a.txt" }, id: "call_42" }, thoughtSignature: "EpgBCpUBAWkU" });
    assert.deepEqual(contents[2]!.parts[0]!.functionResponse, { name: "read", response: { output: "hello" }, id: "call_42" });
    assert.equal(next.message.stopReason, "stop");
    assert.equal(next.message.content[0]!.type === "text" && next.message.content[0]!.text, "It says hello.");
});

test("each model's thinking as agy sends it: xhigh as its number, GPT-OSS its budget, Claude low with the legacy schema; pictures go inline", async () => {
    const done = sse({ response: { candidates: [{ content: { role: "model", parts: [{ text: "ok" }] }, finishReason: "STOP" }] } });
    const picture = { type: "image" as const, mimeType: "image/png", data: "iVBORw0KGgo=" };

    const xhigh = await turn("gemini-4-hydrogen", { messages: [{ role: "user", content: [{ type: "text", text: "What is this?" }, picture], timestamp: NOW }] }, "xhigh", done);

    assert.equal(xhigh.body!.model, "gemini-4-hydrogen-xhigh");
    assert.deepEqual(xhigh.body!.request.generationConfig, { maxOutputTokens: 262144, thinkingConfig: { includeThoughts: true, thinkingLevel: 100 } });
    assert.deepEqual(xhigh.body!.request.contents[0]!.parts[1], { inlineData: { mimeType: "image/png", data: "iVBORw0KGgo=" } });
    assert.equal(xhigh.body!.request.systemInstruction, undefined, "no system prompt, none sent");

    // Thinking off is not agy's: its lowest effort.
    const off = await turn("gemini-4-hydrogen", { messages: [{ role: "user", content: "hi", timestamp: NOW }] }, undefined, done);

    assert.equal(off.body!.model, "gemini-4-hydrogen-high");

    const oss = await turn("gpt-oss-120b-medium", { messages: [{ role: "user", content: "hi", timestamp: NOW }] }, "high", done);

    assert.equal(oss.body!.model, "gpt-oss-120b-medium");
    assert.deepEqual(oss.body!.request.generationConfig, { maxOutputTokens: 32768, thinkingConfig: { includeThoughts: true, thinkingBudget: 8192 } });
    assert.equal(oss.body!.request.labels.used_non_gemini_model, "true");
    assert.equal(oss.body!.request.labels.used_claude, "false");

    const claude = await turn("claude-sonnet-5-5", { systemPrompt: "You are Pi.", messages: [{ role: "user", content: "hi", timestamp: NOW }], tools: [READ_TOOL as never] }, "high", done);

    assert.equal(claude.body!.model, "claude-sonnet-5-5-low");
    assert.deepEqual(claude.body!.request.generationConfig, { maxOutputTokens: 128000, thinkingConfig: { includeThoughts: true, thinkingLevel: "LOW" } });
    assert.equal(claude.body!.request.labels.used_claude, "true");
    assert.ok(claude.body!.request.tools[0]!.functionDeclarations[0]!.parameters, "Claude gets the legacy parameters");

    // A tool's picture goes inside its function response on Gemini 4, as agy sends a file it read.
    const toolPicture = await turn(
        "gemini-4-hydrogen",
        {
            messages: [
                { role: "user", content: "Look at pic.png", timestamp: NOW },
                { role: "assistant", content: [{ type: "toolCall", id: "call_1", name: "read", arguments: { path: "pic.png" } }], api: "google-antigravity", provider: AGY_PROVIDER, model: "gemini-4-hydrogen", usage: xhigh.message.usage, stopReason: "toolUse", timestamp: NOW },
                { role: "toolResult", toolCallId: "call_1", toolName: "read", content: [picture], isError: false, timestamp: NOW },
            ],
            tools: [READ_TOOL as never],
        },
        "high",
        done,
    );

    assert.deepEqual(toolPicture.body!.request.contents[2]!.parts[0]!.functionResponse!.parts, [{ inlineData: { mimeType: "image/png", data: "iVBORw0KGgo=" } }]);
});

test("Google's errors come back with their status, and a model agy no longer offers says to refresh", async () => {
    const limited = google((request) =>
        request.url.includes("fetchAvailableModels")
            ? { body: JSON.stringify(CATALOG) }
            : { status: 429, body: JSON.stringify({ error: { code: 429, message: "You have exhausted your capacity on this model.", status: "RESOURCE_EXHAUSTED" } }) },
    );
    const provider = antigravityProvider({ send: limited.send });
    const auth = await provider.auth.oauth!.toAuth(credential);
    const model = catalogModels(CATALOG)[1]! as Model<Api>;
    const failed = await provider.streamSimple(model, normalizeContext({ messages: [{ role: "user", content: "hi", timestamp: NOW }] }), { apiKey: auth.apiKey, maxRetries: 0 }).result();

    assert.equal(failed.stopReason, "error");
    assert.match(failed.errorMessage!, /\(429\): RESOURCE_EXHAUSTED: You have exhausted your capacity/);

    const gone = await provider.streamSimple({ ...model, id: "gemini-9-gone", thinkingLevelMap: { off: null, minimal: null, low: "low" } }, normalizeContext({ messages: [{ role: "user", content: "hi", timestamp: NOW }] }), { apiKey: auth.apiKey }).result();

    assert.match(gone.errorMessage!, /does not offer gemini-9-gone-low now: refresh the models/);
});

let app: App | undefined;

after(async () => {
    await app?.close();
    cleanUp();
});

test("in the app: listed in Providers off until signed in; Sign in with Google shows the page and takes the pasted code on its card, then its models are there; the code and tokens reach no log", async () => {
    const { sent, send } = google((request) =>
        request.url.includes("fetchAvailableModels")
            ? { body: JSON.stringify(CATALOG) }
            : request.url.endsWith("/token")
              ? { body: TOKENS }
              : request.url.includes("loadCodeAssist")
                ? { body: JSON.stringify({ cloudaicompanionProject: "aicode-consumers", currentTier: { id: "free-tier", name: "Antigravity" }, paidTier: { id: "g1-pro-tier", name: "Google AI Pro" } }) }
                : request.url.includes("retrieveUserQuotaSummary")
                  ? { body: JSON.stringify(QUOTA) }
                  : { body: "{}" },
    );
    const logged: string[] = [];

    app = await openApp(
        scriptedModel(() => fauxAssistantMessage([fauxText("ok")])),
        join(root, "antigravity-data"),
        undefined,
        { antigravity: { send, platform: PLATFORM }, log: (line: string) => void logged.push(line) },
    );
    const listed = () => app!.providers.list(true).find((each) => each.id === AGY_PROVIDER);

    assert.deepEqual(
        { name: listed()?.name, oauth: listed()?.oauth, configured: listed()?.configured, models: listed()?.models },
        { name: "Google Antigravity", oauth: "Sign in with Google", configured: false, models: 0 },
    );
    assert.equal((await app.modelList()).some((model) => model.provider === AGY_PROVIDER), false, "nothing to pick before it is signed in");
    assert.equal(
        appSettings(app).actions.some((each) => each.id.startsWith("providers.agy")),
        false,
        "no sign-in through another machine's agy, nor on Pi's card: signing in is the owner's",
    );

    // The Providers sign-in card, as the sheet drives it.
    const user = owner(app);
    const tab = fakeTab(undefined, user);

    app.attach(tab.client);
    const flowId = app.providers.startLogin(user, AGY_PROVIDER, "oauth");

    await until(() => tab.last("auth")?.step === "prompt", "the code prompt");
    const shown = tab.events.filter((each) => each.event === "auth").map((each) => each.data);

    assert.ok(shown.some((each) => (each.event as AuthEvent | undefined)?.type === "auth_url" && String((each.event as { url: string }).url).startsWith("https://accounts.google.com/o/oauth2/auth?")));
    assert.equal((tab.last("auth")!.prompt as AuthPrompt).type, "manual_code");
    app.providers.answerLogin(user, flowId, tab.last("auth")!.promptId as string, CODE);
    await until(() => tab.last("auth")?.step === "done", "the sign-in to finish");
    assert.equal(tab.last("auth")?.ok, true);
    assert.equal(listed()?.configured, true);
    assert.doesNotMatch(JSON.stringify([logged, tab.events]), /pasted-code|new-access|new-refresh/);
    assert.deepEqual(
        (await app.modelList()).filter((model) => model.provider === AGY_PROVIDER).map((model) => [model.id, model.levels]),
        [
            ["gemini-4-hydrogen", ["high", "xhigh"]],
            ["gemini-3.8-flash", ["low", "high"]],
            ["claude-sonnet-5-5", ["low"]],
            ["gpt-oss-120b-medium", ["off"]],
        ],
    );

    // Its usage bars: the quota agy's start read (PP-558), per group of models, with the plan; no call of their own.
    const usage = await app.usageLimits.get(AGY_PROVIDER, true);

    assert.ok(usage !== undefined && "windows" in usage, JSON.stringify(usage));
    assert.equal(usage.plan, "Google AI Pro");
    assert.deepEqual(
        usage.windows.map((window) => [window.group, window.label, Math.round(window.usedPercent), window.resetsAt]),
        [
            ["Gemini Models", "Weekly", 57, Date.parse("2026-11-28T10:39:15Z")],
            ["Gemini Models", "5-hour", 0, Date.parse("2026-11-23T13:12:05Z")],
            ["Claude and GPT models", "Weekly", 6, Date.parse("2026-11-29T06:07:33Z")],
            ["Claude and GPT models", "5-hour", 0, Date.parse("2026-11-23T13:12:05Z")],
        ],
    );
    const quotaCalls = sent.filter((request) => request.url.endsWith(":retrieveUserQuotaSummary")).length;

    assert.equal(quotaCalls, AGY_START.filter((read) => read === "retrieveUserQuotaSummary").length, "only agy's start read it");
    await app.usageLimits.get(AGY_PROVIDER, true);
    assert.equal(sent.filter((request) => request.url.endsWith(":retrieveUserQuotaSummary")).length, quotaCalls, "asking again reads what agy last read");
    assert.equal(tab.last("usage")?.provider, AGY_PROVIDER, "the tabs are told");

    await app.providers.logout(AGY_PROVIDER);
    assert.equal(listed()?.configured, false);
    assert.equal((await app.modelList()).some((model) => model.provider === AGY_PROVIDER), false);
});

// More accounts (accounts.ts): `google-antigravity~work` beside the original, each on its own sign-in.
const WORK = `${AGY_PROVIDER}~work`;
/** The work account's quota: other figures than the original's, to tell them apart. */
const WORK_QUOTA = {
    groups: [
        {
            buckets: [
                { bucketId: "gemini-weekly", displayName: "Weekly Limit Remaining", window: "weekly", resetTime: "2026-11-30T10:00:00Z", remainingFraction: 0.1 },
                { bucketId: "gemini-5h", displayName: "Five Hour Limit Remaining", window: "5h", resetTime: "2026-11-23T12:00:00Z", remainingFraction: 0.75 },
            ],
            displayName: "Gemini Models",
        },
    ],
};
const IMAGE_CATALOG: AgyCatalog = {
    ...CATALOG,
    models: { ...CATALOG.models, "gemini-3.1-flash-image": { displayName: "Gemini 3.1 Flash Image" } },
    imageGenerationModelIds: ["gemini-3.1-flash-image"],
};
const DONE = sse({ response: { candidates: [{ content: { role: "model", parts: [{ text: "hi from work" }] }, finishReason: "STOP" }] } });

test("each account of the runtime is its own: its turns, catalog, background reads and telemetry on its own sign-in, the original's untouched", async () => {
    const keys: Record<string, string> = {
        [AGY_PROVIDER]: JSON.stringify({ token: "ya29.default", project: "default-project", userAgent: UA }),
        [WORK]: JSON.stringify({ token: "ya29.work", project: "work-project", userAgent: UA }),
    };
    const workCatalog: AgyCatalog = { ...CATALOG, imageGenerationModelIds: ["work-only-image"] };
    const { sent, send } = google((request) => {
        const work = request.headers.Authorization === "Bearer ya29.work";

        return request.url.includes("fetchAvailableModels")
            ? { body: JSON.stringify(work ? workCatalog : CATALOG) }
            : request.url.includes("streamGenerateContent")
              ? { body: DONE, headers: { "content-type": "text/event-stream" } }
              : request.url.includes("retrieveUserQuotaSummary")
                ? { body: JSON.stringify(work ? WORK_QUOTA : QUOTA) }
                : { body: "{}" };
    });
    const runtime = antigravity({ send, auth: async (provider) => keys[provider], now: () => NOW, platform: PLATFORM });

    try {
        assert.throws(() => runtime.accountProvider(AGY_PROVIDER), /not an account of google-antigravity/, "the original is not made again");
        // Under the account's id, as accounts.ts registers it; its models carry that id.
        const work = accountProvider(runtime.accountProvider(WORK), WORK, "Work");
        const model = { ...(catalogModels(CATALOG).find((each) => each.id === "gemini-3.8-flash")! as Model<Api>), provider: WORK };
        const message = await work.streamSimple(model, normalizeContext({ messages: [{ role: "user", content: "hi", timestamp: NOW }] }), { apiKey: keys[WORK]!, reasoning: "high", sessionId: "s-work" }).result();

        assert.equal(message.stopReason, "stop", message.errorMessage ?? "");
        const turns = sent.filter((each) => each.url.includes("streamGenerateContent"));

        assert.equal(turns.length, 1);
        assert.equal(turns[0]!.headers.Authorization, "Bearer ya29.work");
        assert.equal((JSON.parse(turns[0]!.body) as Body).project, "work-project");
        assert.equal(sent.some((each) => each.headers.Authorization === "Bearer ya29.default"), false, "nothing on the original's token");
        assert.equal(runtime.background.running(WORK), true, "agy runs for the account");
        assert.equal(runtime.background.running(AGY_PROVIDER), false, "and not for the original");
        assert.deepEqual(
            (await runtime.background.usage(WORK)).windows.map((window) => Math.round(window.usedPercent)),
            [90, 25],
            "the account's quota, read on its token",
        );

        // Each account's catalog is its own.
        assert.deepEqual((await runtime.catalog(WORK, JSON.parse(keys[WORK]!))).imageGenerationModelIds, ["work-only-image"]);
        assert.equal((await runtime.catalog(AGY_PROVIDER, JSON.parse(keys[AGY_PROVIDER]!))).imageGenerationModelIds, undefined);

        // Telemetry on the account's own token.
        assert.equal(runtime.clearcutFor(AGY_PROVIDER), runtime.clearcut);
        await runtime.clearcutFor(WORK).sendSessionStart();
        const logged = sent.filter((each) => each.url === "https://play.googleapis.com/log");

        assert.equal(logged.length, 1);
        assert.equal(logged[0]!.headers.Authorization, "Bearer ya29.work");
    } finally {
        runtime.close();
    }
});

test("in the app: Add account for Google Antigravity; it signs in with its own Google account and project, and its models, turns, quota and images use its token; the original stays as it was", async () => {
    await app?.close();
    const WORK_CODE = "4/0AeanS0-work-code";
    const WORK_TOKENS = JSON.stringify({ access_token: "ya29.work-access", expires_in: 3599, refresh_token: "1//work-refresh", token_type: "Bearer", id_token: jwt({ email: "work@example.com" }) });
    const { sent, send } = google((request) => {
        const work = request.headers.Authorization === "Bearer ya29.work-access";

        return request.url.endsWith("/token")
            ? { body: new URLSearchParams(request.body).get("code") === WORK_CODE ? WORK_TOKENS : TOKENS }
            : request.url.includes("fetchAvailableModels")
              ? { body: JSON.stringify(IMAGE_CATALOG) }
              : request.url.includes("loadCodeAssist")
                ? { body: JSON.stringify({ cloudaicompanionProject: work ? "work-project" : "aicode-consumers", currentTier: { id: "free-tier" } }) }
                : request.url.includes("retrieveUserQuotaSummary")
                  ? { body: JSON.stringify(work ? WORK_QUOTA : QUOTA) }
                  : request.url.includes("streamGenerateContent")
                    ? { body: DONE, headers: { "content-type": "text/event-stream" } }
                    : request.url.endsWith(":generateContent")
                      ? {
                            body: JSON.stringify({
                                response: { candidates: [{ content: { role: "model", parts: [{ inlineData: { mimeType: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAwS2OUAAAAABJRU5ErkJggg==" } }] }, finishReason: "STOP" }] },
                            }),
                        }
                      : { body: "{}" };
    });

    app = await openApp(scriptedModel(() => fauxAssistantMessage([fauxText("ok")])), join(root, "antigravity-accounts-data"), undefined, { antigravity: { send, platform: PLATFORM } });
    const user = owner(app);
    const tab = fakeTab(undefined, user);

    app.attach(tab.client);
    const signIn = async (provider: string, code: string) => {
        const before = tab.events.length;
        const flowId = app!.providers.startLogin(user, provider, "oauth");
        const last = () => tab.events.slice(before).findLast((each) => each.event === "auth")?.data;

        await until(() => last()?.step === "prompt", `${provider}'s code prompt`);
        app!.providers.answerLogin(user, flowId, last()!.promptId as string, code);
        await until(() => last()?.step === "done", `${provider}'s sign-in`);
        assert.equal(last()?.ok, true, JSON.stringify(last()));
    };
    const listed = (id: string) => app!.providers.list(true).find((each) => each.id === id);
    const keyOf = async (id: string) => JSON.parse((await app!.models.getAuth(id))!.auth.apiKey!) as { token: string; project: string };

    await signIn(AGY_PROVIDER, CODE);
    assert.equal(listed(AGY_PROVIDER)?.accounts, true, "Providers offers Add account for it");

    // Add account, as the Providers sheet does; then its own Sign in with Google.
    assert.equal(app.accounts.add(AGY_PROVIDER, "Work").id, WORK);
    assert.deepEqual(
        { name: listed(WORK)?.name, account: listed(WORK)?.account, oauth: listed(WORK)?.oauth, configured: listed(WORK)?.configured },
        { name: "Google Antigravity · Work", account: { name: "Work", of: AGY_PROVIDER }, oauth: "Sign in with Google", configured: false },
    );
    await signIn(WORK, WORK_CODE);
    assert.equal(listed(WORK)?.configured, true);
    assert.deepEqual(await keyOf(WORK), { token: "ya29.work-access", project: "work-project", userAgent: UA }, "its own tokens and project");
    assert.deepEqual(await keyOf(AGY_PROVIDER), { token: "ya29.new-access", project: "aicode-consumers", userAgent: UA }, "the original's are untouched");
    assert.ok(
        (await app.modelList()).some((model) => model.provider === WORK && model.id === "gemini-3.8-flash" && model.account === "Work"),
        "its models carry its id",
    );
    // Renamed: the same instance under the new name, its model list kept.
    app.accounts.rename(WORK, "Office");
    assert.ok(
        (await app.modelList()).some((model) => model.provider === WORK && model.id === "gemini-3.8-flash" && model.account === "Office"),
        "a rename keeps the models Google listed",
    );
    app.accounts.rename(WORK, "Work");

    // A session on the account's model: its turns go with the account's token and project.
    const id = await newSession(app);

    await app.commands.configure(id, user, { model: { provider: WORK, modelId: "gemini-3.8-flash" }, thinkingLevel: "high" });
    const from = sent.length;

    await say(app, id, "hello from work");
    assert.match(JSON.stringify(await modelTexts(app, id)), /hi from work/);
    const turns = sent.slice(from).filter((each) => each.url.includes("streamGenerateContent"));

    assert.ok(turns.length > 0);

    for (const each of turns) {
        assert.equal(each.headers.Authorization, "Bearer ya29.work-access");
        assert.equal((JSON.parse(each.body) as Body).project, "work-project");
    }

    // Its usage bars: its own quota.
    const usage = await app.usageLimits.get(WORK, true);

    assert.ok(usage !== undefined && "windows" in usage, JSON.stringify(usage));
    assert.deepEqual(usage.windows.map((window) => Math.round(window.usedPercent)), [90, 25]);

    // Images: each account's models under its id, made on its sign-in.
    const { models } = await app.images.models();

    assert.deepEqual(
        models.filter((each) => each.provider.startsWith(AGY_PROVIDER)).map((each) => [each.id, each.account]),
        [
            [`${AGY_PROVIDER}/gemini-3.1-flash-image`, undefined],
            [`${WORK}/gemini-3.1-flash-image`, "Work"],
        ],
    );
    const before = sent.length;
    const made = await app.images.generate(await app.images.resolve(`${WORK}/gemini-3.1-flash-image`), { prompt: "a cat", inputs: [], count: 1 });

    assert.equal(made.images.length, 1);
    const image = sent.slice(before).find((each) => each.url.endsWith(":generateContent"))!;

    assert.equal(image.headers.Authorization, "Bearer ya29.work-access");
    assert.equal((JSON.parse(image.body) as { project: string }).project, "work-project");

    // Menu › Audio and Menu › Dictation pick it: its transcription by its id, its dictation as voice.agyAccount.
    assert.ok((await app.audio.transcribeModels()).includes(WORK));
    await app.setAudioChoice(user, "transcribeModel", WORK);
    assert.deepEqual(app.audio.transcribeModel(), { model: "antigravity", account: WORK, agy: true });
    await app.setAudioChoice(user, "transcribeModel", null);
    await assert.rejects(app.setVoice(user, { engine: "antigravity", agyAccount: `${AGY_PROVIDER}~nope` }), /There is no account google-antigravity~nope/);
    await app.setVoice(user, { engine: "antigravity", agyAccount: WORK });
    assert.deepEqual([app.config.voice.engine, app.config.voice.agyAccount], ["antigravity", WORK]);
    // The tabs learn it is signed in, and the accounts to pick from.
    const voice = ((await app.hello(user)) as unknown as { server: { voice: { antigravity: boolean; accounts: unknown } } }).server.voice;

    assert.deepEqual([voice.antigravity, voice.accounts], [true, { codex: [], agy: [{ id: AGY_PROVIDER }, { id: WORK, name: "Work" }] }]);
    await app.setVoice(user, { engine: "android", agyAccount: AGY_PROVIDER });

    // Removed: signed out and gone; the original still signed in.
    await app.accounts.remove(WORK);
    assert.equal(app.models.getProvider(WORK), undefined);
    assert.equal(listed(AGY_PROVIDER)?.configured, true);
});

test("in the app: a Workspace account's sign-in asks for its project on the card, and Google's refusal shows on it as it is, with what to do; signed in with a project Google takes, it is kept in the sign-in", async () => {
    await app?.close();
    let apiOn = false;
    const { send } = google((request) =>
        request.url.endsWith("/token")
            ? { body: TOKENS }
            : request.url.endsWith(":loadCodeAssist") && request.body.includes("corp-gemini-1")
              ? apiOn
                  ? { body: JSON.stringify({ currentTier: { id: "standard-tier" }, cloudaicompanionProject: "corp-gemini-1" }) }
                  : googleSaid(403, "PERMISSION_DENIED", "Gemini for Google Cloud API has not been used in project corp-gemini-1 before or it is disabled.")
              : request.url.endsWith(":loadCodeAssist")
                ? { body: JSON.stringify(WORKSPACE) }
                : request.url.includes("fetchAvailableModels")
                  ? { body: JSON.stringify(CATALOG) }
                  : { body: "{}" },
    );

    app = await openApp(scriptedModel(() => fauxAssistantMessage([fauxText("ok")])), join(root, "antigravity-workspace-data"), undefined, { antigravity: { send, platform: PLATFORM } });
    const user = owner(app);
    const tab = fakeTab(undefined, user);

    app.attach(tab.client);
    const account = app.accounts.add(AGY_PROVIDER, "tuanlh ent");
    const signIn = async () => {
        const before = tab.events.length;
        const flowId = app!.providers.startLogin(user, account.id, "oauth");
        const last = () => tab.events.slice(before).findLast((each) => each.event === "auth")?.data;

        await until(() => last()?.step === "prompt" && (last()!.prompt as AuthPrompt).type === "manual_code", "the code prompt");
        app!.providers.answerLogin(user, flowId, last()!.promptId as string, CODE);
        await until(() => last()?.step === "prompt" && (last()!.prompt as AuthPrompt).type === "text", "the project prompt");
        app!.providers.answerLogin(user, flowId, last()!.promptId as string, "corp-gemini-1");
        await until(() => last()?.step === "done", "the sign-in to end");

        return last()!;
    };
    const refused = await signIn();

    assert.equal(refused.ok, false);
    assert.match(String(refused.error), /^The Gemini for Google Cloud API is off in the project corp-gemini-1: turn on cloudaicompanion\.googleapis\.com/, "Google's refusal and what to do, as the card shows it");
    assert.equal(refused.details, undefined, "no second copy under Details");
    assert.equal(app.models.hasConfiguredAuth(account.id), false);

    // The API turned on: signed in, the project kept in its sign-in.
    apiOn = true;
    const done = await signIn();

    assert.equal(done.ok, true, JSON.stringify(done));
    assert.equal((JSON.parse((await app.models.getAuth(account.id))!.auth.apiKey!) as { project: string }).project, "corp-gemini-1");
    await app.accounts.remove(account.id);
});
