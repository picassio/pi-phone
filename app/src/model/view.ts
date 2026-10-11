// Pure readers over the Transcript replica (ConversationView): what the screens show, with no React or RN imports,
// so they are testable in Node. This is the seed of the turns layer described in UI.md section 1.
import type { ConversationView, EntryRecord } from "@earendil-works/pi-durable";

export interface Row {
	id: number;
	kind: "user" | "assistant" | "tool" | "system" | "other";
	title: string;
	text: string;
}

interface ContentPart {
	type: string;
	text?: string;
	name?: string;
	arguments?: unknown;
	content?: unknown;
	isError?: boolean;
}

function partsText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return (content as ContentPart[])
		.map((part) => {
			if (part.type === "text") return part.text ?? "";
			if (part.type === "thinking") return `[thinking] ${part.text ?? ""}`;
			if (part.type === "toolCall") return `[call ${part.name}] ${JSON.stringify(part.arguments)}`;
			if (part.type === "image") return "[image]";
			return `[${part.type}]`;
		})
		.join("\n");
}

export function rowOf(entry: EntryRecord): Row {
	const message = entry.model?.[0] as { role?: string; content?: unknown; toolName?: string } | undefined;
	switch (entry.kind) {
		case "pi.user":
			return { id: entry.id, kind: "user", title: "You", text: partsText(message?.content) };
		case "pi.assistant":
			return { id: entry.id, kind: "assistant", title: "Pi", text: partsText(message?.content) };
		case "pi.tool-result":
			return {
				id: entry.id,
				kind: "tool",
				title: `${message?.toolName ?? "tool"} result`,
				text: partsText(message?.content),
			};
		case "pi.system":
			return { id: entry.id, kind: "system", title: "System prompt updated", text: "" };
		default:
			return { id: entry.id, kind: "other", title: entry.kind, text: "" };
	}
}

export interface Live {
	busy: boolean;
	partial: string;
	tools: { name: string; status: string; output: string }[];
	retry: string | null;
}

export function liveOf(view: ConversationView): Live {
	const live = view.docs["pi.live"] as
		| {
				run?: unknown;
				generation?: { message?: { content?: unknown }; retry?: { at: number; error: string } };
				tools?: { name: string; status: string; output?: string }[];
		  }
		| undefined;
	return {
		busy: live?.run !== undefined,
		partial: partsText(live?.generation?.message?.content),
		tools: (live?.tools ?? []).map((tool) => ({ name: tool.name, status: tool.status, output: tool.output ?? "" })),
		retry: live?.generation?.retry?.error ?? null,
	};
}

export function modelLabel(view: ConversationView): string {
	const agent = view.docs["pi.agent"] as { model?: { provider: string; modelId: string }; thinkingLevel?: string } | undefined;
	if (agent?.model === undefined) return "no model";
	return `${agent.model.provider}/${agent.model.modelId}${agent.thinkingLevel ? ` · ${agent.thinkingLevel}` : ""}`;
}
