import assert from "node:assert/strict";
import { test } from "node:test";
import type { ProjectedEntry, ProjectedView } from "../../../contracts/transcripts.ts";
import { liveOf, modelLabel, partsText, rowOf } from "./view.ts";

const entry = (partial: Partial<ProjectedEntry> & { id: number; kind: string }): ProjectedEntry => ({
	conversationId: 1,
	model: null,
	data: null,
	head: null,
	...partial,
});

test("partsText renders text, clipped markers, thinking, and tool calls; images are separate", () => {
	assert.equal(partsText("plain"), "plain");
	assert.equal(
		partsText([
			{ type: "text", text: "a", clipped: 12 },
			{ type: "thinking", text: "hm" },
			{ type: "toolCall", name: "bash", arguments: { command: "ls" } },
			{ type: "image", index: 0, mimeType: "image/png" },
		]),
		'a\n… (12 more characters)\n[thinking] hm\n[call bash] {"command":"ls"}',
	);
});

test("rows by kind", () => {
	const user = rowOf(
		entry({
			id: 1,
			kind: "pi.user",
			model: [{ role: "user", content: [{ type: "text", text: "hi" }, { type: "image", index: 0, mimeType: "image/png" }] }],
		}),
	);
	assert.deepEqual(user, { id: 1, kind: "user", title: "You", text: "hi", images: [{ index: 0, mimeType: "image/png" }] });
	const tool = rowOf(entry({ id: 2, kind: "pi.tool-result", model: [{ role: "toolResult", toolName: "read", content: "x" }] }));
	assert.equal(tool.title, "read result");
	assert.equal(rowOf(entry({ id: 3, kind: "pi.system" })).kind, "system");
	assert.equal(rowOf(entry({ id: 4, kind: "app.note" })).kind, "other");
});

test("live state and model label", () => {
	const view: ProjectedView = {
		conversationId: 1,
		parent: null,
		entries: [],
		docs: {
			"pi.live": {
				run: { taskId: 9, inputs: [1] },
				generation: { attempt: 2, message: { content: [{ type: "text", text: "partial" }] }, retry: { at: 1, error: "429" } },
				tools: [{ callId: "c", name: "bash", status: "running", output: "ls\n" }],
			},
			"pi.inbox": { items: [{}, {}] },
			"pi.agent": { model: { provider: "anthropic", modelId: "claude-haiku-4-5" }, thinkingLevel: "low" },
		},
	};
	assert.deepEqual(liveOf(view), {
		busy: true,
		partial: "partial",
		tools: [{ name: "bash", status: "running", output: "ls\n" }],
		retry: "429",
		queued: 2,
	});
	assert.equal(modelLabel(view), "anthropic/claude-haiku-4-5 · low");
	assert.equal(liveOf({ ...view, docs: {} }).busy, false);
});
