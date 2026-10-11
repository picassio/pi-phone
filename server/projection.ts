// Projection of pi-durable's ConversationView for the app: image parts lose their bytes, long text parts are clipped.
// Pure functions over JSON; tests in projection.test.ts.
import type { JsonObject, JsonValue } from "@earendil-works/chord";
import type { ConversationView, EntryRecord } from "@earendil-works/pi-durable";
import type { ClippedText, ImageRef, ProjectedEntry, ProjectedView } from "../contracts/transcripts.ts";

/** Text parts longer than this are clipped in the replica; `entry()` returns them whole. */
export const CLIP_CHARS = 8_000;

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Replace image parts in one content list and clip long text parts. Other parts pass through. */
export function projectContent(content: unknown): unknown {
	if (!Array.isArray(content)) return content;
	let imageIndex = 0;
	return content.map((part) => {
		if (!isObject(part)) return part;
		if (part.type === "image" && typeof part.data === "string") {
			const ref: ImageRef = { type: "image", index: imageIndex, mimeType: String(part.mimeType ?? "") };
			imageIndex += 1;
			return ref;
		}
		if (part.type === "text" && typeof part.text === "string" && part.text.length > CLIP_CHARS) {
			const clipped: ClippedText = {
				type: "text",
				text: part.text.slice(0, CLIP_CHARS),
				clipped: part.text.length - CLIP_CHARS,
			};
			return clipped;
		}
		return part;
	});
}

function projectMessage(message: unknown): unknown {
	if (!isObject(message)) return message;
	if (!("content" in message)) return message;
	return { ...message, content: projectContent(message.content) };
}

export function projectEntry(entry: EntryRecord): ProjectedEntry {
	return {
		id: entry.id,
		conversationId: entry.conversationId,
		kind: entry.kind,
		model: entry.model === undefined ? null : (entry.model.map(projectMessage) as JsonValue[]),
		data: entry.data === undefined ? null : entry.data,
		head: entry.head === undefined ? null : entry.head,
	};
}

/** `pi.live` holds the streamed partial message; project it like an entry's messages. */
function projectDocs(docs: Readonly<Record<string, JsonObject>>): Record<string, JsonObject> {
	const result: Record<string, JsonObject> = {};
	for (const [kind, doc] of Object.entries(docs)) {
		if (kind !== "pi.live") {
			result[kind] = doc;
			continue;
		}
		const generation = doc.generation;
		if (!isObject(generation) || !isObject(generation.message)) {
			result[kind] = doc;
			continue;
		}
		result[kind] = { ...doc, generation: { ...generation, message: projectMessage(generation.message) as JsonObject } };
	}
	return result;
}

export function projectView(view: ConversationView): ProjectedView {
	return {
		conversationId: view.conversation.id,
		parent:
			view.conversation.parent === undefined
				? null
				: { conversationId: view.conversation.parent.conversationId, at: view.conversation.parent.at },
		entries: view.entries.map(projectEntry),
		docs: projectDocs(view.docs),
	};
}

/** The `index`-th image part of an entry, across its messages. */
export function imageOf(entry: EntryRecord, index: number): { mimeType: string; data: string } | undefined {
	let seen = 0;
	for (const message of entry.model ?? []) {
		const content = (message as { content?: unknown }).content;
		if (!Array.isArray(content)) continue;
		for (const part of content) {
			if (!isObject(part) || part.type !== "image" || typeof part.data !== "string") continue;
			if (seen === index) return { mimeType: String(part.mimeType ?? ""), data: part.data };
			seen += 1;
		}
	}
	return undefined;
}
