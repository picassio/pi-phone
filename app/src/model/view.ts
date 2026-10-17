// Pure readers over the projected transcript replica (ProjectedView): what the screens show, with no React or RN
// imports, so they are testable in Node. This is the seed of the turns layer described in UI.md section 1.
import type { ProjectedEntry, ProjectedView } from "../../../contracts/transcripts.ts";

export interface Row {
	id: number;
	kind: "user" | "assistant" | "tool" | "system" | "other";
	title: string;
	text: string;
	/** Image references in this row, for thumbnails. */
	images: { index: number; mimeType: string }[];
}

interface ContentPart {
	type: string;
	text?: string;
	clipped?: number;
	name?: string;
	arguments?: unknown;
	index?: number;
	mimeType?: string;
}

function parts(content: unknown): ContentPart[] {
	if (typeof content === "string") return [{ type: "text", text: content }];
	return Array.isArray(content) ? (content as ContentPart[]) : [];
}

export function partsText(content: unknown): string {
	return parts(content)
		.map((part) => {
			if (part.type === "text") return `${part.text ?? ""}${part.clipped ? `\n… (${part.clipped} more characters)` : ""}`;
			if (part.type === "thinking") return `[thinking] ${part.text ?? ""}`;
			if (part.type === "toolCall") return `[call ${part.name}] ${JSON.stringify(part.arguments)}`;
			if (part.type === "image") return "";
			return `[${part.type}]`;
		})
		.filter((text) => text !== "")
		.join("\n");
}

function imagesOf(content: unknown): Row["images"] {
	return parts(content)
		.filter((part) => part.type === "image" && typeof part.index === "number")
		.map((part) => ({ index: part.index!, mimeType: part.mimeType ?? "" }));
}

export function rowOf(entry: ProjectedEntry): Row {
	const message = entry.model?.[0] as { role?: string; content?: unknown; toolName?: string } | undefined;
	const content = message?.content;
	switch (entry.kind) {
		case "pi.user":
			return { id: entry.id, kind: "user", title: "You", text: partsText(content), images: imagesOf(content) };
		case "pi.assistant":
			return { id: entry.id, kind: "assistant", title: "Pi", text: partsText(content), images: [] };
		case "pi.tool-result":
			return {
				id: entry.id,
				kind: "tool",
				title: `${message?.toolName ?? "tool"} result`,
				text: partsText(content),
				images: imagesOf(content),
			};
		case "pi.system":
			return { id: entry.id, kind: "system", title: "System prompt updated", text: "", images: [] };
		case "pi.reset":
			return { id: entry.id, kind: "system", title: "New context", text: partsText(content), images: [] };
		case "pi.compaction":
			return { id: entry.id, kind: "system", title: "Compacted", text: partsText(content), images: [] };
		default:
			return { id: entry.id, kind: "other", title: entry.kind, text: "", images: [] };
	}
}

export interface Live {
	busy: boolean;
	partial: string;
	tools: { name: string; status: string; output: string }[];
	retry: string | null;
	queued: number;
}

export function liveOf(view: ProjectedView): Live {
	const live = view.docs["pi.live"] as
		| {
				run?: unknown;
				generation?: { message?: { content?: unknown }; retry?: { at: number; error: string } };
				tools?: { name: string; status: string; output?: string }[];
		  }
		| undefined;
	const inbox = view.docs["pi.inbox"] as { items?: unknown[] } | undefined;
	return {
		busy: live?.run !== undefined,
		partial: partsText(live?.generation?.message?.content),
		tools: (live?.tools ?? []).map((tool) => ({ name: tool.name, status: tool.status, output: tool.output ?? "" })),
		retry: live?.generation?.retry?.error ?? null,
		queued: inbox?.items?.length ?? 0,
	};
}

export function modelLabel(view: ProjectedView): string {
	const agent = view.docs["pi.agent"] as { model?: { provider: string; modelId: string }; thinkingLevel?: string } | undefined;
	if (agent?.model === undefined) return "no model";
	return `${agent.model.provider}/${agent.model.modelId}${agent.thinkingLevel ? ` · ${agent.thinkingLevel}` : ""}`;
}
