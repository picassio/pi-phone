// Ported from pi-cc-patch's tests/provider-targeting.test.mjs.
import assert from "node:assert/strict";
import { test } from "node:test";
import { patchClaudeCodePayload } from "../src/server/cc-patch.ts";

const VERSION = "2.1.280";
const options = { version: VERSION };

const oauthIdentity = {
	type: "text",
	text: "You are Claude Code, Anthropic's official CLI for Claude.",
	cache_control: { type: "ephemeral" },
};

test("rewrites OAuth payloads with the billing header and neutral wording", () => {
	const payload = {
		model: "claude-fable-5-1",
		messages: [{ role: "user", content: "hello" }],
		system: [oauthIdentity, { type: "text", text: "You are operating inside pi, a coding agent harness." }],
	};
	const result = patchClaudeCodePayload(payload, "anthropic", options);
	assert.equal(result, payload);
	const system = payload.system as { type: string; text: string }[];
	assert.equal(system[0]!.text, `x-anthropic-billing-header: cc_version=${VERSION}.000; cc_entrypoint=cli;`);
	assert.equal(
		system.some((block) => block.text.includes("official CLI")),
		false,
	);
	assert.equal(system[1]!.text, "You are operating as a coding assistant.");
	assert.equal(typeof (payload as { metadata?: { user_id?: unknown } }).metadata?.user_id, "string");
});

test("replaces an older billing block and keeps metadata and cache control", () => {
	const payload = {
		model: "claude-opus-5-5",
		messages: [{ role: "user", content: "hello" }],
		system: [
			oauthIdentity,
			{ type: "text", text: "x-anthropic-billing-header: cc_version=2.1.261.000; cc_entrypoint=cli;" },
			{
				type: "text",
				text: "You are operating inside pi, a coding agent harness.",
				cache_control: { type: "ephemeral" },
			},
		],
		metadata: { user_id: "existing-user-id" },
	};
	const before = structuredClone(payload);
	const result = patchClaudeCodePayload(payload, "anthropic", options);
	assert.equal(result, payload);
	assert.deepEqual(payload.system, [
		{ type: "text", text: `x-anthropic-billing-header: cc_version=${VERSION}.000; cc_entrypoint=cli;` },
		{ type: "text", text: "You are operating as a coding assistant.", cache_control: { type: "ephemeral" } },
	]);
	assert.equal(payload.model, before.model);
	assert.deepEqual(payload.messages, before.messages);
	assert.deepEqual(payload.metadata, before.metadata);
});

test("leaves direct Anthropic API-key payloads unchanged", () => {
	const payload = {
		model: "claude-opus-5",
		messages: [{ role: "user", content: "hello" }],
		system: [{ type: "text", text: "You are operating inside pi, a coding agent harness." }],
	};
	const before = structuredClone(payload);
	assert.equal(patchClaudeCodePayload(payload, "anthropic", options), undefined);
	assert.deepEqual(payload, before);
});

test("leaves Amazon Bedrock Claude payloads unchanged", () => {
	const payload = {
		modelId: "global.anthropic.claude-opus-5",
		messages: [{ role: "user", content: [{ text: "hello" }] }],
		system: [{ text: "normal bedrock prompt" }],
		inferenceConfig: { maxTokens: 128000 },
	};
	const before = structuredClone(payload);
	assert.equal(patchClaudeCodePayload(payload, "amazon-bedrock", options), undefined);
	assert.deepEqual(payload, before);
});

test("leaves OpenRouter Claude payloads unchanged", () => {
	const payload = {
		model: "anthropic/claude-opus-5",
		messages: [{ role: "user", content: "hello" }],
		system: [oauthIdentity, { type: "text", text: "You are operating inside pi, a coding agent harness." }],
	};
	const before = structuredClone(payload);
	assert.equal(patchClaudeCodePayload(payload, "openrouter", options), undefined);
	assert.deepEqual(payload, before);
});

test("rejects a malformed version", () => {
	const payload = { messages: [], system: [oauthIdentity] };
	assert.throws(() => patchClaudeCodePayload(payload, "anthropic", { version: "latest" }), /x\.y\.z/);
});
