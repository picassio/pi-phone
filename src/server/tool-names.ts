/**
 * Tool names Pi may not be offered (PP-533). Anthropic bills a subscription request (OAuth, with Claude Code's billing
 * line) that offers a tool whose name starts with `mcp_` and anything but a second `_` as extra usage: with none left,
 * every request of the session fails with 400 "You're out of extra usage". The name alone does it, not the description
 * or the schema (the probe `~/work/pp328/probe-billing.ts`, 2026-11-21). Claude Code's own MCP form,
 * `mcp__<server>__<tool>`, passes, and so do names such as `set_mcp_server`.
 *
 * The app's own tools keep to it (`test/tool-names.test.ts`), and a drop-in with such a tool is refused whole
 * (`Refusal` kind `extra-usage` in `reload.ts`; `checkMade` for one Pi makes).
 */

/** A tool name Anthropic bills as extra usage: `mcp_` not followed by a second `_`. */
export const MCP_UNDERSCORE_NAME = /^mcp_(?!_)/;

/** Why such a name is refused, in the words the refusals use. */
export const EXTRA_USAGE_REASON = "Anthropic bills a request offering such a tool as extra usage";

/** The names among these that Anthropic bills as extra usage, each once, in their order. */
export function extraUsageNames(names: readonly string[]): string[] {
    return [...new Set(names.filter((name) => MCP_UNDERSCORE_NAME.test(name)))];
}
