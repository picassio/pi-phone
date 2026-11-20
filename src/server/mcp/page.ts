/**
 * Settings › MCP servers (PP-528): what the owner's page shows and does, the same app methods Pi's tools and the
 * settings registry go through. The page is the owner's own hand, so its Save, Turn on and Import approve the entry as
 * shown (no card); Test connection starts the server for a folder the owner names and lists its tools.
 *
 * Nothing here shows a secret's value: entries keep `${NAME}`, and a server's stderr is redacted with the secrets.
 */
import { entryOf, type McpServerInfo, type McpServers, parseServer, runsText, secretNames } from "./config.ts";
import { unpinnedPackage } from "./admin.ts";
import type { McpInstanceStatus, McpManager } from "./manager.ts";
import type { McpToolCache } from "./tools.ts";

/** A server as the page shows it. */
export type McpServerView = {
    name: string;
    kind: "stdio" | "http";
    enabled: boolean;
    approved: boolean;
    description: string;
    /** The entry as the file keeps it, for the form. */
    entry: Record<string, unknown>;
    /** Its command line or URL, in one line. */
    command: string;
    runs: string;
    folders: string[];
    secrets: string[];
    tools?: number;
    toolNames?: string[];
    unpinned?: string;
    instances: McpInstanceStatus[];
};

export type McpView = { servers: McpServerView[]; problems: { name: string; error: string }[]; machines: { id: string; name: string }[] };

export type McpPageHost = {
    servers: McpServers;
    manager: McpManager;
    cache: McpToolCache;
    machines: () => { id: string; name: string }[];
    redact: (text: string) => string;
};

export function mcpView(host: McpPageHost): McpView {
    const status = host.manager.status();
    const view = (server: McpServerInfo): McpServerView => {
        const tools = host.cache.tools(server.name);
        const unpinned = unpinnedPackage(server);

        return {
            name: server.name,
            kind: server.kind,
            enabled: server.enabled,
            approved: server.approved,
            description: server.description,
            entry: entryOf(server),
            command: server.kind === "stdio" ? [server.command, ...server.args].join(" ") : server.url,
            runs: runsText(server.runs),
            folders: server.folders,
            secrets: secretNames(server),
            ...(tools === undefined ? {} : { tools: tools.length, toolNames: tools.map((tool) => tool.name) }),
            ...(unpinned === undefined ? {} : { unpinned }),
            instances: status.filter((each) => each.server === server.name).map((each) => ({ ...each, stderr: host.redact(each.stderr.slice(-4000)), ...(each.failed === undefined ? {} : { failed: host.redact(each.failed) }) })),
        };
    };

    return { servers: host.servers.list().map(view), problems: host.servers.problems(), machines: host.machines() };
}

/** Save an entry from the page: checked, and approved as the owner wrote it. */
export function mcpSave(host: McpPageHost, name: unknown, entry: unknown): McpServerInfo {
    if (typeof name !== "string" || name.trim() === "") {
        throw new Error("Give the server a name.");
    }

    return host.servers.save(name.trim(), entry);
}

/** Turn a server on or off from the page; turning on an entry changed elsewhere approves it as the page shows it. */
export function mcpEnable(host: McpPageHost, name: string, enabled: boolean): McpServerInfo {
    const server = host.servers.get(name);

    if (server === undefined) {
        throw new Error(`There is no MCP server ${name}.`);
    }

    return enabled ? host.servers.save(name, entryOf({ ...server, enabled: true })) : host.servers.setEnabled(name, false);
}

/**
 * An `mcpServers` block pasted from Claude, Cursor or Pi (or its inside, server by server): each valid server saved,
 * each other one said with why. A name already here is kept unless `replace`.
 */
export function mcpImport(host: McpPageHost, text: unknown, replace: boolean): { saved: string[]; errors: { name: string; error: string }[] } {
    if (typeof text !== "string" || text.trim() === "") {
        throw new Error("Paste an mcpServers block.");
    }

    let parsed: unknown;

    try {
        parsed = JSON.parse(text);
    } catch {
        throw new Error("That is not JSON: paste the mcpServers block as Claude, Cursor or Pi keep it.");
    }

    const block = typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) && "mcpServers" in parsed ? (parsed as { mcpServers: unknown }).mcpServers : parsed;

    if (typeof block !== "object" || block === null || Array.isArray(block) || Object.keys(block).length === 0) {
        throw new Error('No servers in it: an mcpServers block is {"mcpServers": {"name": {"command": …}}}.');
    }

    const saved: string[] = [];
    const errors: { name: string; error: string }[] = [];

    for (const [name, raw] of Object.entries(block as Record<string, unknown>)) {
        try {
            if (host.servers.get(name) !== undefined && !replace) {
                throw new Error(`${name} is set up already: tick Replace to take the pasted one.`);
            }

            // Checked as a whole before anything is saved for it.
            parseServer(name, raw);
            host.servers.save(name, raw);
            saved.push(name);
        } catch (error) {
            errors.push({ name, error: error instanceof Error ? error.message : String(error) });
        }
    }

    return { saved, errors };
}

/** Test connection: start the server for `folder` (a session's folder) and list its tools, with the time it took. */
export async function mcpTest(host: McpPageHost, name: string, folder: unknown): Promise<{ ok: true; tools: string[]; ms: number } | { ok: false; error: string; ms: number }> {
    if (typeof folder !== "string" || folder.trim() === "") {
        throw new Error("Give a folder to test it in: a session's folder, on the phone or machine:<id>:<path>.");
    }

    const started = Date.now();

    try {
        // The owner pressed Test: a secret that asks first is allowed for this start.
        const tools = await host.manager.tools(name, folder.trim(), { askSecrets: async () => true });

        return { ok: true, tools: tools.map((tool) => tool.name), ms: Date.now() - started };
    } catch (error) {
        return { ok: false, error: host.redact(error instanceof Error ? error.message : String(error)), ms: Date.now() - started };
    }
}
