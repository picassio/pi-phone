// Claude Code billing patch, ported from https://github.com/picassio/pi-cc-patch (MIT). For direct Anthropic OAuth
// requests only, it replaces pi's Claude Code identity block with the billing header block and neutralises "pi"
// wording in the system prompt, so Pro/Max subscription quota is billed. See DESIGN.md section 4.
//
// Pure: takes the provider payload pi-ai is about to send and returns the patched payload, or undefined when the
// request is not a direct Anthropic OAuth request (API key, Bedrock, OpenRouter, other providers).

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
	if (payload.metadata === undefined) {
		payload.metadata = { user_id: JSON.stringify({ device_id: "0", account_uuid: "", session_id: "0" }) };
	}
	return payload;
}
