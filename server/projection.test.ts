import assert from "node:assert/strict";
import { test } from "node:test";
import type { ConversationView, EntryRecord } from "@earendil-works/pi-durable";
import { CLIP_CHARS, imageOf, projectContent, projectEntry, projectView } from "./projection.ts";

const png = "iVBORw0KGgo=";

function entry(partial: Partial<EntryRecord> & { id: number }): EntryRecord {
	return { conversationId: 1, kind: "pi.user", ...partial } as EntryRecord;
}

test("image parts lose their data and get indexes; other parts pass through", () => {
	const content = [
		{ type: "text", text: "see" },
		{ type: "image", data: png, mimeType: "image/png" },
		{ type: "toolCall", id: "c1", name: "read", arguments: { path: "a.png" } },
		{ type: "image", data: png, mimeType: "image/jpeg" },
	];
	assert.deepEqual(projectContent(content), [
		{ type: "text", text: "see" },
		{ type: "image", index: 0, mimeType: "image/png" },
		{ type: "toolCall", id: "c1", name: "read", arguments: { path: "a.png" } },
		{ type: "image", index: 1, mimeType: "image/jpeg" },
	]);
});

test("long text is clipped with the removed count", () => {
	const text = "x".repeat(CLIP_CHARS + 5);
	assert.deepEqual(projectContent([{ type: "text", text }]), [
		{ type: "text", text: "x".repeat(CLIP_CHARS), clipped: 5 },
	]);
	assert.deepEqual(projectContent([{ type: "text", text: "short" }]), [{ type: "text", text: "short" }]);
});

test("entries keep ids, kinds, data, and heads; absent fields become null", () => {
	const record = entry({
		id: 7,
		kind: "pi.tool-result",
		head: 3,
		data: { diagnostics: [] },
		model: [{ role: "toolResult", toolName: "read", content: [{ type: "image", data: png, mimeType: "image/png" }] }],
	});
	assert.deepEqual(projectEntry(record), {
		id: 7,
		conversationId: 1,
		kind: "pi.tool-result",
		head: 3,
		data: { diagnostics: [] },
		model: [{ role: "toolResult", toolName: "read", content: [{ type: "image", index: 0, mimeType: "image/png" }] }],
	});
	assert.deepEqual(projectEntry(entry({ id: 8, kind: "pi.reset" })), {
		id: 8,
		conversationId: 1,
		kind: "pi.reset",
		head: null,
		data: null,
		model: null,
	});
});

test("the view projects entries and the live partial, keeps other docs, and carries the parent", () => {
	const view = {
		conversation: { id: 2, parent: { conversationId: 1, at: 5 } },
		entries: [entry({ id: 6, model: [{ role: "user", content: [{ type: "image", data: png, mimeType: "image/png" }] }] })],
		docs: {
			"pi.agent": { model: { provider: "anthropic", modelId: "x" } },
			"pi.live": { generation: { attempt: 1, message: { role: "assistant", content: [{ type: "text", text: "hi" }] } } },
		},
	} as unknown as ConversationView;
	const projected = projectView(view);
	assert.equal(projected.conversationId, 2);
	assert.deepEqual(projected.parent, { conversationId: 1, at: 5 });
	assert.deepEqual(projected.entries[0]!.model, [
		{ role: "user", content: [{ type: "image", index: 0, mimeType: "image/png" }] },
	]);
	assert.deepEqual(projected.docs["pi.agent"], { model: { provider: "anthropic", modelId: "x" } });
	assert.deepEqual(projected.docs["pi.live"], {
		generation: { attempt: 1, message: { role: "assistant", content: [{ type: "text", text: "hi" }] } },
	});
});

test("imageOf finds the n-th image across messages", () => {
	const record = entry({
		id: 1,
		model: [
			{ role: "user", content: [{ type: "image", data: "a", mimeType: "image/png" }] },
			{ role: "user", content: [{ type: "text", text: "t" }, { type: "image", data: "b", mimeType: "image/jpeg" }] },
		],
	});
	assert.deepEqual(imageOf(record, 1), { mimeType: "image/jpeg", data: "b" });
	assert.equal(imageOf(record, 2), undefined);
});
