// Claude Code billing patch, ported from https://github.com/picassio/pi-cc-patch (MIT). For direct Anthropic OAuth
// requests only, it replaces pi's Claude Code identity block with the billing header block and neutralises "pi"
// wording in the system prompt, so Pro/Max subscription quota is billed. See DESIGN.md section 4.
//
// Pure: takes the provider payload pi-ai is about to send and returns the patched payload, or undefined when the
// request is not a direct Anthropic OAuth request (API key, Bedrock, OpenRouter, other providers).

import { MCP_UNDERSCORE_NAME } from "./tool-names.ts";

export interface ClaudeCodeBillingOptions {
	/** Claude Code version advertised in the billing header; bump when Anthropic raises the minimum. */
	readonly version: string;
}

interface SystemBlock {
	type: string;
	text?: string;
	[key: string]: unknown;
}

interface AnthropicPayload {
	model?: unknown;
	messages?: unknown;
	system?: unknown;
	metadata?: { user_id?: unknown; [key: string]: unknown };
	[key: string]: unknown;
}

const IDENTITY_PREFIX = "You are Claude Code";
const IDENTITY_MARKER = "official CLI";
const BILLING_PREFIX = "x-anthropic-billing-header";

function isSystemBlock(value: unknown): value is SystemBlock {
	return typeof value === "object" && value !== null && typeof (value as { type?: unknown }).type === "string";
}

function isIdentityBlock(block: SystemBlock): boolean {
	return (
		block.type === "text" &&
		typeof block.text === "string" &&
		block.text.startsWith(IDENTITY_PREFIX) &&
		block.text.includes(IDENTITY_MARKER)
	);
}

/** pi adds the identity block only for direct Anthropic OAuth requests, so its presence identifies them. */
export function isDirectAnthropicOAuth(payload: unknown, provider: string | undefined): payload is AnthropicPayload {
	if (provider?.toLowerCase() !== "anthropic") return false;
	if (typeof payload !== "object" || payload === null) return false;
	const system = (payload as AnthropicPayload).system;
	return Array.isArray(system) && system.some((block) => isSystemBlock(block) && isIdentityBlock(block));
}

export function sanitizeSystemPrompt(text: string): string {
	return text
		.replace(/operating inside pi, a coding agent harness\./g, "operating as a coding assistant.")
		.replace(/Pi documentation/g, "Documentation")
		.replace(/pi itself,/g, "the tool itself,")
		.replace(/pi packages/g, "packages")
		.replace(/read pi \.md/g, "read .md")
		.replace(/pi-coding-agent/g, "coding-agent")
		.replace(/@mariozechner\/pi-ai/g, "@anthropic/ai")
		.replace(/@mariozechner\/pi-tui/g, "@anthropic/tui")
		.replace(/about pi\b/g, "about this tool")
		.replace(/pi update\b/g, "update")
		.replace(/Run pi update/g, "Run update")
		.replace(/\bpi\b([\s,.])/g, "the assistant$1");
}

export function billingHeaderBlock(version: string): SystemBlock {
	return { type: "text", text: `${BILLING_PREFIX}: cc_version=${version}.000; cc_entrypoint=cli;` };
}

/** The name a mid-conversation tool_addition or tool_removal block names, if it is one. */
function changedToolName(block: unknown): string | undefined {
	if (typeof block !== "object" || block === null) return undefined;
	const { type, tool } = block as { type?: unknown; tool?: { name?: unknown; definition?: { name?: unknown } } };
	if (type === "tool_removal" && typeof tool?.name === "string") return tool.name;
	if (type === "tool_addition" && typeof tool?.definition?.name === "string") return tool.definition.name;
	return undefined;
}

/**
 * The history without the additions and removals of tools named `mcp_` and one underscore (MCP_UNDERSCORE_NAME), which
 * make Anthropic bill the request as extra usage (PP-533). No tool of pi-phone's has such a name since build #512, but
 * a session that loaded one before keeps Pi Durable's `tool_addition` (and the later `tool_removal`) in its history,
 * and every request of it failed with "You're out of extra usage". Such a tool is offered no more, so the model loses
 * nothing it could call; a system message left empty goes too.
 */
function withoutExtraUsageTools(messages: unknown[]): unknown[] {
	return messages.flatMap((message) => {
		const { role, content } = message as { role?: unknown; content?: unknown };
		if (role !== "system" || !Array.isArray(content)) return [message];
		const kept = content.filter((block) => {
			const name = changedToolName(block);
			return name === undefined || !MCP_UNDERSCORE_NAME.test(name);
		});
		if (kept.length === content.length) return [message];
		return kept.length === 0 ? [] : [{ ...(message as object), content: kept }];
	});
}

/**
 * Patch one provider payload in place and return it, or return undefined to leave it unchanged. Matches pi-ai's
 * `onPayload` contract.
 */
export function patchClaudeCodePayload(
	payload: unknown,
	provider: string | undefined,
	options: ClaudeCodeBillingOptions,
): unknown | undefined {
	if (!isDirectAnthropicOAuth(payload, provider)) return undefined;
	if (!Array.isArray(payload.messages)) return undefined;
	if (!/^\d+\.\d+\.\d+$/.test(options.version)) {
		throw new Error(`Claude Code billing version must be x.y.z, got "${options.version}"`);
	}
	const system = payload.system as unknown[];
	const blocks: unknown[] = [billingHeaderBlock(options.version)];
	for (const block of system) {
		if (!isSystemBlock(block) || block.type !== "text" || typeof block.text !== "string") {
			blocks.push(block);
			continue;
		}
		if (block.text.startsWith(BILLING_PREFIX)) continue;
		if (isIdentityBlock(block)) continue;
		blocks.push({ ...block, text: sanitizeSystemPrompt(block.text) });
	}
	payload.system = blocks;
	payload.messages = withoutExtraUsageTools(payload.messages);
	if (payload.metadata === undefined) {
		payload.metadata = { user_id: JSON.stringify({ device_id: "0", account_uuid: "", session_id: "0" }) };
	}
	return payload;
}
