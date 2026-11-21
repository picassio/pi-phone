// Ported from pi-cc-patch's tests/provider-targeting.test.mjs.
import assert from "node:assert/strict";
import { test } from "node:test";
import { patchClaudeCodePayload } from "../src/server/cc-patch.ts";

const VERSION = "2.1.322";
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

test("a session that once loaded a tool named mcp_ (one underscore) sends its history without that tool's addition and removal (PP-533)", () => {
	const definition = (name: string) => ({ name, description: "d", input_schema: { type: "object", properties: {} } });
	const payload = {
		model: "claude-opus-5-5",
		system: [oauthIdentity],
		messages: [
			{ role: "user", content: "find the MCP tools" },
			{
				role: "system",
				content: [
					{ type: "tool_addition", tool: { type: "tool_definition", definition: definition("mcp_server_set") } },
					{ type: "tool_addition", tool: { type: "tool_definition", definition: definition("machine_add") } },
				],
			},
			{ role: "assistant", content: "ok" },
			{ role: "system", content: [{ type: "tool_removal", tool: { type: "tool_reference", name: "mcp_servers" } }] },
			{
				role: "system",
				content: [{ type: "tool_addition", tool: { type: "tool_definition", definition: definition("mcp__gopeak__scene_nodes") } }],
			},
			{ role: "user", content: "Say OK." },
		],
	};
	patchClaudeCodePayload(payload, "anthropic", options);
	const wire = JSON.stringify(payload.messages);
	assert.doesNotMatch(wire, /"mcp_(?!_)/, "no mcp_ name with one underscore is left");
	assert.match(wire, /machine_add/, "other additions in the same message stay");
	assert.match(wire, /mcp__gopeak__scene_nodes/, "Claude Code's own mcp__server__tool form stays");
	assert.equal(payload.messages.length, 5, "the removal's message, left empty, goes");
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
