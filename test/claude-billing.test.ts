import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Api, AssistantMessage, Message, Model } from "@earendil-works/pi-ai";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { installClaudeCodeBilling } from "../src/server/claude-billing.ts";
import {
    CLAUDE_CODE_VERSION,
    DEFAULT_SETTINGS,
    isBelowClaudeCodeVersion,
    parsePhoneSettings,
    PhoneSettingsFile,
} from "../src/server/phone-settings.ts";

type StreamSimple = ModelRuntime["streamSimple"];
type Options = NonNullable<Parameters<StreamSimple>[2]>;

const oauthPayload = () => ({
    model: "claude-opus-5-5",
    messages: [{ role: "user", content: "hello" }],
    system: [{ type: "text", text: "You are Claude Code, Anthropic's official CLI for Claude." }],
});

const model = { provider: "anthropic" } as Model<Api>;

/** A ModelRuntime stand-in whose stream runs the request's onPayload once and records what it returned. */
function fakeModels() {
    const seen: unknown[] = [];
    const models = {
        streamSimple: ((_model, _context, options?: Options) => {
            void Promise.resolve(options?.onPayload?.(oauthPayload(), model)).then((result) => seen.push(result));

            return undefined as unknown as ReturnType<StreamSimple>;
        }) as StreamSimple,
    };

    return { models, seen };
}

const settled = () => new Promise((resolve) => setTimeout(resolve, 10));

test("missing keys take defaults; unknown keys and wrong types are errors", () => {
    assert.deepEqual(parsePhoneSettings("{}"), DEFAULT_SETTINGS);
    assert.deepEqual(parsePhoneSettings('{"claudeCodeBilling":{"enabled":false}}').claudeCodeBilling, {
        enabled: false,
        version: DEFAULT_SETTINGS.claudeCodeBilling.version,
    });
    assert.throws(() => parsePhoneSettings('{"foo":1}'), /Unknown setting "foo"/);
    assert.throws(() => parsePhoneSettings('{"claudeCodeBilling":{"nope":1}}'), /claudeCodeBilling\.nope/);
    assert.throws(() => parsePhoneSettings('{"claudeCodeBilling":{"enabled":"yes"}}'), /boolean/);
});

test("the patch applies to every request and follows phone.json", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-phone-billing-"));
    const settings = new PhoneSettingsFile(dir);
    const { models, seen } = fakeModels();

    installClaudeCodeBilling(models, settings);

    models.streamSimple(model, { messages: [] });
    await settled();
    const patched = seen[0] as { system: { text: string }[] };

    assert.match(patched.system[0]!.text, new RegExp(`^x-anthropic-billing-header: cc_version=${CLAUDE_CODE_VERSION}\\.`));

    writeFileSync(settings.path, '{"claudeCodeBilling":{"enabled":false}}');
    utimesSync(settings.path, new Date(), new Date(Date.now() + 1000));
    models.streamSimple(model, { messages: [] });
    await settled();
    assert.equal(seen[1], undefined);
});

test("a phone.json from before Pi 1.5.2 (Claude Code 2.1.280) is raised when read; a newer version stays", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-phone-billing-"));
    const settings = new PhoneSettingsFile(dir);

    writeFileSync(settings.path, '{"claudeCodeBilling":{"enabled":true,"version":"2.1.280"}}');
    assert.equal(settings.current().claudeCodeBilling.version, "2.1.322");
    assert.equal(parsePhoneSettings('{"claudeCodeBilling":{"version":"2.1.290"}}').claudeCodeBilling.version, "2.1.322");
    assert.equal(parsePhoneSettings('{"claudeCodeBilling":{"version":"2.0.999"}}').claudeCodeBilling.version, "2.1.322");
    assert.equal(parsePhoneSettings('{"claudeCodeBilling":{"version":"2.1.400"}}').claudeCodeBilling.version, "2.1.400");
    assert.equal(parsePhoneSettings('{"claudeCodeBilling":{"version":"3.0.0"}}').claudeCodeBilling.version, "3.0.0");
    assert.equal(isBelowClaudeCodeVersion("2.1.321"), true);
    assert.equal(isBelowClaudeCodeVersion("2.1.322"), false);

    // The next change to the settings writes the raised version back.
    settings.update({ enabled: false });
    assert.deepEqual(parsePhoneSettings(readFileSync(settings.path, "utf8")).claudeCodeBilling, { enabled: false, version: "2.1.322" });
});

/** An x.y.z version as numbers, to compare. */
function parts(version: string): number[] {
    return version.split(".").map(Number);
}

function atLeast(version: string, floor: string): boolean {
    const [a, b] = [parts(version), parts(floor)];

    for (const [index, part] of a.entries()) {
        if (part !== b[index]) {
            return part > (b[index] ?? 0);
        }
    }

    return true;
}

// Anthropic gates newer models on the Claude Code version a Claude sign-in's request reports (400
// claude_code_version_too_old below 2.1.290, 2026-11): pi-ai's `claude-cli/<version>` user-agent and the billing
// header's `cc_version`. The request is the one pi-ai builds and sends, caught by a stub fetch: nothing leaves the machine.
test("a Claude sign-in's requests report Claude Code 2.1.290 or newer, in the user-agent and the billing header, every turn", async () => {
    const provider = anthropicProvider();
    const model = (await provider.getModels()).find((each) => each.id.startsWith("claude-"))!;
    const events = [
        { type: "message_start", message: { id: "msg_1", model: model.id, usage: { input_tokens: 1, output_tokens: 0 } } },
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hello" } },
        { type: "content_block_stop", index: 0 },
        { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
        { type: "message_stop" },
    ];
    const sse = events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
    const sent: { userAgent: string; body: { system?: { text?: string }[]; thread?: { type: string } } }[] = [];
    const fetch = async (_url: string | URL | Request, init?: RequestInit) => {
        sent.push({ userAgent: new Headers(init?.headers).get("user-agent") ?? "", body: JSON.parse(String(init?.body)) });

        return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
    };
    const models = { streamSimple: provider.streamSimple.bind(provider) as StreamSimple };

    installClaudeCodeBilling(models, new PhoneSettingsFile(mkdtempSync(join(tmpdir(), "pi-phone-billing-"))));

    const turn = async (messages: Message[]): Promise<AssistantMessage> => {
        const stream = models.streamSimple(model, normalizeContext({ messages }), {
            apiKey: "sk-ant-oat01-test",
            sessionId: "session-1",
            fetch,
        });

        for await (const event of stream) {
            if (event.type === "done") {
                return event.message;
            }

            if (event.type === "error") {
                throw new Error(event.error.errorMessage);
            }
        }

        throw new Error("the stream ended without done");
    };
    const first: Message = { role: "user", content: "hi", timestamp: 1 };
    const reply = await turn([first]);

    // The second turn builds on the first: with pi-ai's message threads it would be sent as a continuation, without
    // the system blocks that carry the billing header.
    await turn([first, reply, { role: "user", content: "and again", timestamp: 2 }]);
    assert.equal(sent.length, 2);

    for (const [index, request] of sent.entries()) {
        const agent = /^claude-cli\/(\d+\.\d+\.\d+)$/.exec(request.userAgent)?.[1];
        const header = /^x-anthropic-billing-header: cc_version=(\d+\.\d+\.\d+)\.000;/.exec(request.body.system?.[0]?.text ?? "")?.[1];

        assert.ok(agent !== undefined, `request ${index}: user-agent ${request.userAgent}`);
        assert.ok(header !== undefined, `request ${index}: no billing header in ${JSON.stringify(request.body.system)}`);
        assert.ok(atLeast(agent, "2.1.290"), `request ${index}: user-agent reports Claude Code ${agent}`);
        assert.equal(header, agent, `request ${index}: the billing header names the user-agent's version`);
        assert.notEqual(request.body.thread?.type, "continue", `request ${index} is sent whole`);
    }
});

test("a caller's own onPayload runs first and the patch sees its result", async () => {
    const settings = new PhoneSettingsFile(mkdtempSync(join(tmpdir(), "pi-phone-billing-")));
    const { models, seen } = fakeModels();
    let called = false;

    installClaudeCodeBilling(models, settings);
    models.streamSimple(
        model,
        { messages: [] },
        {
            onPayload: (payload) => {
                called = true;

                return { ...(payload as object), marker: true };
            },
        },
    );
    await settled();
    assert.equal(called, true);
    assert.equal((seen[0] as { marker?: boolean }).marker, true);
});

// pi-ai builds the request; the patch finds what it replaces in it. When a pi-ai update changes the request, this
// fails, on the build, before a phone sends a request the patch no longer bills to the subscription.
test("the patch still applies to the request pi-ai's own Anthropic provider builds for a Claude sign-in", async () => {
    const { anthropicProvider } = await import("@earendil-works/pi-ai/providers/anthropic");
    const { patchClaudeCodePayload } = await import("../src/server/cc-patch.ts");
    const { normalizeContext } = await import("@earendil-works/pi-ai/utils/transcript");
    const provider = anthropicProvider();
    const model = (await provider.getModels()).find((each) => each.id.startsWith("claude-"))!;
    let built: unknown;
    const stream = provider.streamSimple(
        model,
        normalizeContext({ messages: [{ role: "user", content: "hi", timestamp: 1 }] }),
        {
            apiKey: "sk-ant-oat01-test",
            // Nothing leaves the machine: the request fails once it is built.
            fetch: async () => {
                throw new Error("no network in this test");
            },
            onPayload: (payload) => {
                built = payload;

                return undefined;
            },
        },
    );

    for await (const event of stream) {
        if (event.type === "error" || event.type === "done") {
            break;
        }
    }

    const patched = patchClaudeCodePayload(built, model.provider, { version: DEFAULT_SETTINGS.claudeCodeBilling.version }) as
        | { system: { text?: string }[] }
        | undefined;

    assert.ok(patched, "the patch found pi-ai's Claude Code request");
    assert.match(patched.system[0]!.text!, /^x-anthropic-billing-header: cc_version=/);
    assert.ok(!JSON.stringify(patched.system).includes("You are Claude Code"), JSON.stringify(patched.system));
});

// An account of Anthropic (accounts.ts) is a new Anthropic provider under its own id: the request it builds is still a
// Claude sign-in's (pi-ai checks the model's provider), and the patch still bills it to the subscription.
test("an account of Anthropic builds the same Claude sign-in request, and the patch applies to it", async () => {
    const { anthropicProvider } = await import("@earendil-works/pi-ai/providers/anthropic");
    const { normalizeContext } = await import("@earendil-works/pi-ai/utils/transcript");
    const { accountProvider } = await import("../src/server/accounts.ts");
    const { createBillingTransform } = await import("../src/server/claude-billing.ts");
    const account = accountProvider(anthropicProvider() as never, "anthropic~work", "Work");
    const model = (await account.getModels()).find((each) => each.id.startsWith("claude-"))!;
    const settings = new PhoneSettingsFile(mkdtempSync(join(tmpdir(), "pi-phone-billing-")));
    let built: unknown;
    let builtFor: string | undefined;

    assert.equal(model.provider, "anthropic~work", "its models carry the account's id");

    const stream = account.streamSimple(
        model,
        normalizeContext({ messages: [{ role: "user", content: "hi", timestamp: 1 }] }),
        {
            apiKey: "sk-ant-oat01-test",
            fetch: async () => {
                throw new Error("no network in this test");
            },
            onPayload: (payload, requestModel) => {
                built = payload;
                builtFor = requestModel.provider;

                return undefined;
            },
        },
    );

    for await (const event of stream) {
        if (event.type === "error" || event.type === "done") {
            break;
        }
    }

    assert.equal(builtFor, "anthropic", "the provider's own code sees its own id");
    assert.ok(JSON.stringify(built).includes("You are Claude Code"), "a Claude sign-in's request");

    const patched = createBillingTransform(settings)(built, { ...model } as Model<Api>) as { system: { text?: string }[] } | undefined;

    assert.match(patched!.system[0]!.text!, /^x-anthropic-billing-header: cc_version=/, "billed as the account's id too");
});
