import assert from "node:assert/strict";
import { mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { installClaudeCodeBilling } from "../src/server/claude-billing.ts";
import { DEFAULT_SETTINGS, parsePhoneSettings, PhoneSettingsFile } from "../src/server/phone-settings.ts";

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

    assert.match(patched.system[0]!.text, /^x-anthropic-billing-header: cc_version=2\.1\.280/);

    writeFileSync(settings.path, '{"claudeCodeBilling":{"enabled":false}}');
    utimesSync(settings.path, new Date(), new Date(Date.now() + 1000));
    models.streamSimple(model, { messages: [] });
    await settled();
    assert.equal(seen[1], undefined);
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
