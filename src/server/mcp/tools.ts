/**
 * MCP tools as Pi's tools (PP-525): each tool of a running, approved server is a tool of its own, `mcp__<server>__<tool>`
 * (pi-mcp's `createMcpToolName`, as Pi's terminal and the coding agent name them), deferred: no request carries it until
 * `tool_search` loads it, and codemode scripts call it any time. They live in the extension `pocket-mcp`, which the app installs
 * again whenever the servers or their tools change.
 *
 * The tools come from a cache (`<data>/mcp/tools-cache.json`), kept per server with the fingerprint of the entry they
 * were listed for: after a restart the tools are found without starting any server, and a changed entry drops them.
 * The manager fills it each time it lists a server's tools (as it starts, and on `tools/list_changed`).
 *
 * A tool's description and schema are the server's text, so they are cleaned: invisible characters out, no closing
 * tag, 1000 characters at most, after "MCP server <name>"; the descriptions and titles inside its schema too
 * (`cleanSchema`); a schema over 8000 characters is offered as any object.
 * `replay` is unsafe (a restart in a call answers "interrupted", never runs it again). The server's `readOnlyHint`
 * reaches plan mode only when the owner trusts the server's hints (`planMode`).
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Extension, ToolRegistration } from "@earendil-works/pi-durable";
import { defineExtension } from "@earendil-works/pi-durable";
import { createToolSearchTool, TOOL_SEARCH_TOOL_NAME } from "@earendil-works/pi-durable/tool-search";
import { createMcpToolName, McpError, type McpOutputSaver, normalizeMcpInputSchema, type Tool } from "@earendil-works/pi-mcp";
import { clip, defang, fencedMcp, INVISIBLE_CLASS } from "../fence.ts";
import { hiddenTool, MCP_FOLDER, type McpServerInfo, type McpServers } from "./config.ts";
import { mcpAdminTools, type McpServerForm } from "./admin.ts";
import type { McpManager, McpStartOptions } from "./manager.ts";
import type { Context } from "@earendil-works/chord/context";
import { formatResult } from "./result.ts";

/** Of the names the app keeps (`RESERVED_EXTENSIONS`): a drop-in named `mcp` (the gallery's pocket-mcp) cannot replace it. */
export const MCP_EXTENSION = "pocket-mcp";
const CACHE_FILE = "tools-cache.json";
const MAX_DESCRIPTION = 1000;
const MAX_SCHEMA = 8000;
const MAX_ERROR = 2000;

/** A tool as the cache keeps it: what Pi's tool is made of. */
export type CachedTool = { name: string; description?: string; inputSchema: Record<string, unknown>; annotations?: { readOnlyHint?: boolean } };

type Cache = Record<string, { fingerprint: string; tools: CachedTool[] }>;

const INVISIBLE = new RegExp(`[${INVISIBLE_CLASS}]`, "gu");

/** The server's text made fit for a tool's declaration: one paragraph of visible text, no closing tag, cut. */
export function cleanText(text: string, max: number): string {
    return clip(defang(text.replace(INVISIBLE, "").replace(/\s+/g, " ")), max);
}

/** A schema with every `description` and `title` in it, at any depth, cleaned as a tool's description is. */
export function cleanSchema(value: unknown): unknown {
    if (Array.isArray(value)) {
        return value.map(cleanSchema);
    }

    if (typeof value !== "object" || value === null) {
        return value;
    }

    return Object.fromEntries(
        Object.entries(value).map(([key, each]) => [key, (key === "description" || key === "title") && typeof each === "string" ? cleanText(each, MAX_DESCRIPTION) : cleanSchema(each)]),
    );
}

export class McpToolCache {
    readonly #file: string;
    readonly #servers: McpServers;
    readonly #log: (line: string) => void;
    #cache: Cache = {};
    readonly #listeners = new Set<() => void>();

    constructor(dataDir: string, servers: McpServers, manager: McpManager, log: (line: string) => void = () => {}) {
        this.#file = join(dataDir, MCP_FOLDER, CACHE_FILE);
        this.#servers = servers;
        this.#log = log;

        if (existsSync(this.#file)) {
            try {
                this.#cache = JSON.parse(readFileSync(this.#file, "utf8")) as Cache;
            } catch {
                // Only a cache: the servers list their tools again when they next run.
                log(`mcp: ${this.#file} is not valid JSON; the servers' tools are listed again as they run`);
            }
        }

        manager.onTools((server, tools, fingerprint) => this.#store(server, tools, fingerprint));
    }

    /** The cached tools of a server, for its current entry; undefined when they were never listed for it. */
    tools(name: string): CachedTool[] | undefined {
        const server = this.#servers.get(name);
        const cached = this.#cache[name];

        return server === undefined || cached === undefined || cached.fingerprint !== server.fingerprint ? undefined : cached.tools;
    }

    onChange(listener: () => void): () => void {
        this.#listeners.add(listener);

        return () => this.#listeners.delete(listener);
    }

    /** Keep the tools listed for the entry whose fingerprint is `fingerprint`; a listing of an entry since changed is not kept. */
    #store(name: string, tools: readonly Tool[], fingerprint: string): void {
        const server = this.#servers.get(name);

        if (server === undefined || server.fingerprint !== fingerprint) {
            return;
        }

        const kept: CachedTool[] = tools.map((tool) => ({
            name: tool.name,
            ...(tool.description === undefined ? {} : { description: tool.description }),
            inputSchema: tool.inputSchema as Record<string, unknown>,
            ...(tool.annotations?.readOnlyHint === undefined ? {} : { annotations: { readOnlyHint: tool.annotations.readOnlyHint } }),
        }));
        const before = this.#cache[name];

        if (before !== undefined && before.fingerprint === server.fingerprint && JSON.stringify(before.tools) === JSON.stringify(kept)) {
            return;
        }

        this.#cache = { ...this.#cache, [name]: { fingerprint: server.fingerprint, tools: kept } };
        mkdirSync(join(this.#file, ".."), { recursive: true, mode: 0o700 });
        writeFileSync(`${this.#file}.tmp`, JSON.stringify(this.#cache), { mode: 0o600 });
        chmodSync(`${this.#file}.tmp`, 0o600);
        renameSync(`${this.#file}.tmp`, this.#file);
        this.#log(`mcp: ${name} has ${kept.length} tools`);

        for (const listener of [...this.#listeners]) {
            listener();
        }
    }
}

export type McpToolDetails = { server: string; tool: string; images: number };

/** The server's tools as Pi's: name, cleaned description and schema, and the call through the manager. */
function registrations(server: McpServerInfo, tools: readonly CachedTool[], options: McpExtensionOptions, taken: Set<string>): ToolRegistration[] {
    const { manager, defaultCwd, guard } = options;

    return tools
        .filter((tool) => !hiddenTool(server, tool.name))
        .map((tool) => {
            const name = createMcpToolName(server.name, tool.name, (candidate) => taken.has(candidate));

            taken.add(name);

            const normalized = cleanSchema(normalizeMcpInputSchema(tool.inputSchema)) as Record<string, unknown>;
            const tooBig = JSON.stringify(normalized).length > MAX_SCHEMA;
            const about = server.description === "" ? "" : ` (${cleanText(server.description, 200)})`;
            const description = `MCP server ${server.name}${about}: ${cleanText(tool.description ?? tool.name, MAX_DESCRIPTION)}${tooBig ? " Its parameters' schema is too large to show: give the arguments its description names." : ""}`;
            const trusted = server.planMode && tool.annotations?.readOnlyHint === true;

            return {
                name,
                description,
                parameters: tooBig ? { type: "object", additionalProperties: true } : normalized,
                deferred: true as const,
                replay: "unsafe" as const,
                ...(trusted ? { annotations: { readOnlyHint: true } } : {}),
                async execute(args: Record<string, unknown>, api, context) {
                    const refused = guard.refusal(Number(api.conversationId));

                    if (refused !== undefined) {
                        throw new Error(refused);
                    }

                    const cwd = (await api.agent(context)).cwd ?? defaultCwd();

                    // The owner asked to see each call of this server first (`askEachCall`).
                    if (server.askEachCall && !(await guard.ask(api, { key: "call", tool: name, subject: JSON.stringify(args, null, 2), reason: `The MCP server ${server.name} asks before each call` }, context))) {
                        throw new Error(`This call of ${name} was not allowed.`);
                    }

                    let result;

                    try {
                        result = await manager.call(server.name, cwd, tool.name, args, startOptions(options, server.name, api, context));
                    } catch (error) {
                        // The server's own words (a JSON-RPC error) are data too.
                        if (error instanceof McpError) {
                            return { output: [{ type: "text" as const, text: fencedMcp(name, clip(error.message, MAX_ERROR), "mcp_error") }], isError: true, details: { server: server.name, tool: tool.name, images: 0 } };
                        }

                        throw error;
                    }

                    // A long answer's whole text, where the session's own tools read it (on the phone or its machine).
                    const save: McpOutputSaver | undefined =
                        api.env === undefined
                            ? undefined
                            : async (data, extension) => {
                                  const folder = await api.env!.createTempDir("mcp-output-", context);

                                  if (!folder.ok) {
                                      throw new Error(`The whole answer of ${name} could not be saved: ${folder.error.message}`);
                                  }

                                  const file = `${folder.value}/answer${extension}`;
                                  const written = await api.env!.writeFile(file, data, context);

                                  if (!written.ok) {
                                      throw new Error(`The whole answer of ${name} could not be saved: ${written.error.message}`);
                                  }

                                  return file;
                              };
                    const formatted = await formatResult(name, result, save);
                    const details: McpToolDetails = { server: server.name, tool: tool.name, images: formatted.images };

                    return { output: formatted.output, isError: formatted.isError, details };
                },
            } as ToolRegistration;
        });
}

/**
 * The `mcp` extension as the servers and the cache are now: every cached tool of each server that is on and approved.
 * Which session may call which (the folders) is checked at each call (the manager), and narrowed in `tool_search`
 * (PP-526): with a server that may run, the extension brings its own `tool_search`, Pi Durable's with the same
 * declaration, which searches only the MCP tools of the servers serving the session's folder, and first lists the tools
 * of those it has none of yet. Installed after `deferred-tools`, it is the one sessions use, also those whose tools are
 * all (no `deferred-tools` there). The section `mcp_servers` names the servers serving the folder, one line each, and is
 * left out when none does: a session without MCP servers has the prompt it had.
 */
export function mcpExtension(options: McpExtensionOptions): Extension {
    const tools = mcpTools(options);
    const runnable = options.servers.list().some((server) => server.enabled && server.approved);

    return defineExtension({
        name: MCP_EXTENSION,
        tools: [...tools.map((each) => each.tool), ...(runnable ? [scopedToolSearch(options)] : []), ...mcpAdminTools(options)],
        sections: [
            {
                key: MCP_SECTION,
                render: ({ agent, conversationId }) =>
                    options.guard.refusal(Number(conversationId)) === undefined ? serversSection(options, agent.cwd ?? options.defaultCwd(), agent.tools.some((tool) => tool.name === TOOL_SEARCH_TOOL_NAME)) : undefined,
            },
        ],
    });
}

/** The ids of the call that asks, as a tool's `api` has them. */
export type McpCaller = { conversationId: unknown; taskId: unknown; callId?: string };

/** Who may use MCP servers here, and the cards that ask a person first (PP-527). */
export type McpGuard = {
    /** Why Pi may not use MCP servers for what was asked in this session (a guest's or a teammate's message), or undefined. */
    refusal(conversationId: number): string | undefined;
    /** Why Pi may not change the MCP servers for what was asked here (only the owner's message may), or undefined. */
    notOwner(conversationId: number): string | undefined;
    /** Ask on a card in the session, as the call's own: whether it was allowed. A `form`'s card is the owner's to approve. */
    ask(caller: McpCaller, card: { key: string; tool: string; subject: string; reason: string; form?: McpServerForm }, context: Context): Promise<boolean>;
};

/** A start's options for a call: its cancel signal, and a card for the secrets that ask first. */
function startOptions(options: McpExtensionOptions, name: string, caller: McpCaller, context: Context): McpStartOptions {
    const server = options.servers.get(name);
    const command = server?.kind === "stdio" ? [server.command, ...server.args].join(" ") : (server?.kind === "http" ? server.url : name);

    return {
        ...(context.abortSignal === undefined ? {} : { signal: context.abortSignal }),
        // A yes to a secret that asks first is this session's.
        who: `session ${String(caller.conversationId)}`,
        askSecrets: (names) =>
            options.guard.ask(caller, { key: `start-${name}`, tool: `mcp server ${name}`, subject: command, reason: `Starts the MCP server ${name} with ${names.map((each) => `$${each}`).join(", ")}` }, context),
    };
}

export type McpExtensionOptions = {
    guard: McpGuard;
    servers: McpServers;
    cache: McpToolCache;
    manager: McpManager;
    defaultCwd: () => string;
    /** A machine's name, for the section. */
    machineName: (machineId: string) => string;
};

export const MCP_SECTION = "mcp_servers";
/** How long tool_search waits for the servers in scope to list their tools the first time. */
export const LIST_WAIT_MS = 20_000;

/** Every cached tool of each server that is on and approved, with its server. */
function mcpTools(options: McpExtensionOptions): { server: string; tool: ToolRegistration }[] {
    const taken = new Set<string>();

    return options.servers
        .list()
        .filter((server) => server.enabled && server.approved)
        .flatMap((server) => registrations(server, options.cache.tools(server.name) ?? [], options, taken).map((tool) => ({ server: server.name, tool })));
}

/**
 * The servers serving a folder, for the prompt: one line each with its description, its tools' count and where it
 * runs. `search`: the model has tool_search; in codemode's Only mode it does not, and scripts find tools with
 * `searchTools`.
 */
export function serversSection(options: McpExtensionOptions, cwd: string, search: boolean): string | undefined {
    const serving = options.servers.servingIn(cwd);

    if (serving.length === 0) {
        return undefined;
    }

    const lines = serving.map((server) => {
        const count = options.cache.tools(server.name)?.filter((tool) => !hiddenTool(server, tool.name)).length;
        const runs = server.kind === "http" ? (server.runs.where === "machine" ? `over HTTP from ${options.machineName(server.runs.machineId)}` : "over HTTP") : server.runs.where === "phone" ? "on the phone" : server.runs.where === "machine" ? `on ${options.machineName(server.runs.machineId)}` : "where this session works";
        const about = server.description === "" ? "" : `: ${cleanText(server.description, 120)}`;

        return `- ${server.name}${about} (${count === undefined ? "tools listed on first use" : `${count} tools`}, ${runs})`;
    });
    const find = search ? "Find their tools with tool_search (what you need, or the server's name)" : "Find their tools in a codemode script with searchTools(query)";

    return [`MCP servers for this folder. ${find}; they are named mcp__<server>__<tool>.`, ...lines].join("\n");
}

/** Pi Durable's tool_search over the MCP tools of the servers serving the session's folder, and the other deferred tools. */
function scopedToolSearch(options: McpExtensionOptions): ToolRegistration {
    const base = createToolSearchTool() as unknown as ToolRegistration;

    return {
        ...base,
        async execute(args, api, context) {
            const agent = await api.agent(context);
            const cwd = agent.cwd ?? options.defaultCwd();
            // A guest's or a teammate's message finds no MCP tool (`guard.refusal`).
            const serving = options.guard.refusal(Number(api.conversationId)) === undefined ? options.servers.servingIn(cwd).map((server) => server.name) : [];
            const notes = await listFirst(options, serving.filter((name) => options.cache.tools(name) === undefined), cwd, api, context);
            const all = mcpTools(options);
            const ours = new Set(all.map((each) => each.tool.name));
            const offered = new Set(agent.tools.map((tool) => tool.name));
            const inScope = all.filter((each) => serving.includes(each.server) && !offered.has(each.tool.name)).map((each) => each.tool);
            // The MCP tools as they are now (listed just now, too), only those of the servers in scope.
            const deferred = [...agent.deferred.filter((tool) => !ours.has(tool.name) && !tool.name.startsWith("mcp__")), ...inScope];
            const result = await base.execute(args, { ...api, agent: async () => ({ ...agent, deferred }) }, context);

            return notes.length === 0 ? result : { ...result, output: [...(result.output ?? []), { type: "text" as const, text: notes.join("\n") }] };
        },
    };
}

/**
 * List the tools of the servers in scope that never listed them, at most `LIST_WAIT_MS`: they start for it. What did not
 * come is said, for the search to be made again.
 */
async function listFirst(options: McpExtensionOptions, names: readonly string[], cwd: string, caller: McpCaller, context: Context): Promise<string[]> {
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<"late">((resolve) => {
        timer = setTimeout(() => resolve("late"), LIST_WAIT_MS);
    });

    try {
        const listed = await Promise.all(
            names.map((name) =>
                Promise.race([options.manager.tools(name, cwd, startOptions(options, name, caller, context)).then(() => undefined), late]).then(
                    (outcome) => (outcome === "late" ? `The MCP server ${name} is still starting: search again in a moment to find its tools.` : undefined),
                    (error: unknown) => `The MCP server ${name} could not list its tools: ${defang(error instanceof Error ? error.message : String(error))}`,
                ),
            ),
        );

        return listed.filter((note): note is string => note !== undefined);
    } finally {
        clearTimeout(timer);
    }
}
