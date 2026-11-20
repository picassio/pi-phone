/**
 * Pi's tools for the owner's MCP servers (PP-527), as Settings › MCP servers does them (a tool for everything):
 * `mcp_servers` lists them and how they run (it only reads), and `mcp_server_set` adds, changes, turns on or off, or
 * removes one, after the owner approves a card with the whole entry and, for a change, its diff. Nothing changes on a
 * Deny. Both wait for tool_search (`DEFERRED_TOOLS`), and only the owner's message may change a server.
 *
 * The list never shows a value that may be a key: an `env` or `headers` value whose name speaks of a key, a token, a
 * secret, a password or auth is shown as `(set)` unless it is only `${NAME}`s of the owner's secrets.
 */
import { generateUnifiedPatch } from "@earendil-works/pi-coding-agent";
import { defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import { map, obj, oneOf, opt, str, unknown } from "@earendil-works/pi-schema";
import { entryOf, type McpServer, type McpServerInfo, parseServer, secretNames } from "./config.ts";
import type { McpExtensionOptions } from "./tools.ts";

export const MCP_ADMIN_TOOLS = ["mcp_servers", "mcp_server_set"] as const;

/** What the owner's card shows (`ApprovalRequest.form`), and what Approve does. */
export type McpServerForm = {
    type: "mcp-server";
    action: "save" | "enable" | "disable" | "remove";
    name: string;
    /** The entry as it will be (for remove: as it is), whole, as JSON in the `mcpServers` shape. */
    entry: string;
    /** A change's diff from the entry now; absent for a new server. */
    diff?: string;
    /** Where it runs and which folders it serves, in words. */
    runs: string;
    folders: string[];
    /** The owner's secrets it uses, by name. */
    secrets: string[];
    /** A package run with npx, uvx and the like without a pinned version: it can change under the owner. */
    unpinned?: string;
};

const reply = (text: string, isError = false) => ({ output: [{ type: "text" as const, text }], ...(isError ? { isError: true } : {}) });
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** A package runner's package that names no version (`npx -y gopeak`, `uvx tool@latest`), if the server runs one. */
export function unpinnedPackage(server: McpServer): string | undefined {
    if (server.kind !== "stdio") {
        return undefined;
    }

    const argv = [server.command, ...server.args];
    const at = argv.findIndex((arg) => /(^|\/)(npx|bunx|pnpx|uvx|pipx)$/.test(arg));
    const runner = at === -1 ? undefined : argv[at]!.replace(/^.*\//, "");
    const rest = at === -1 ? [] : argv.slice(at + 1);
    // pipx runs `pipx run <package>`.
    const spec = rest.find((arg, index) => !arg.startsWith("-") && !(runner === "pipx" && index === 0 && arg === "run"));

    if (spec === undefined) {
        return undefined;
    }

    const version = spec.startsWith("@") ? spec.slice(1).split("@")[1] : spec.split(/@|==/)[1];

    return version === undefined || version === "" || version === "latest" ? spec : undefined;
}

const KEYISH = /key|token|secret|password|passwd|auth|cookie|credential/i;
const ONLY_SECRETS = /^(\$\{[A-Z_][A-Z0-9_]*\}\s*)+$|^[A-Za-z]+ \$\{[A-Z_][A-Z0-9_]*\}$/;

/** Values as the list shows them: a value that may be a key is `(set)`. */
function shown(values: Record<string, string>): string {
    return Object.entries(values)
        .map(([key, value]) => `${key}=${KEYISH.test(key) && !ONLY_SECRETS.test(value) ? "(set)" : value}`)
        .join(", ");
}

/** Where a server runs, in words. */
function runsWords(server: McpServer, machineName: (id: string) => string): string {
    if (server.kind === "http") {
        return `over HTTP at ${server.url}`;
    }

    return server.runs.where === "session" ? "where the session works" : server.runs.where === "phone" ? "on the phone" : `on ${machineName(server.runs.machineId)}`;
}

/** The entry as the file keeps it, with its name: what the card shows. */
const entryJson = (server: McpServer) => JSON.stringify({ [server.name]: entryOf(server) }, null, 4);

export function mcpAdminTools(options: McpExtensionOptions): ToolRegistration[] {
    const { servers, manager, cache, guard } = options;
    const line = (server: McpServerInfo) => {
        const command = server.kind === "stdio" ? `stdio: ${[server.command, ...server.args].join(" ")}` : `http: ${server.url}`;
        const values = server.kind === "stdio" ? server.env : server.headers;
        const tools = cache.tools(server.name);
        const running = manager
            .status()
            .filter((each) => each.server === server.name)
            .map((each) => `${each.machineId === undefined ? "phone" : options.machineName(each.machineId)}:${each.folder} ${each.state}${each.failed === undefined ? "" : ` (${each.failed})`}`);

        return [
            `- ${server.name}: ${server.enabled ? "on" : "off"}${server.approved ? "" : ", changed since the owner approved it (does not run)"}`,
            `  ${command}`,
            ...(Object.keys(values).length === 0 ? [] : [`  ${server.kind === "stdio" ? "env" : "headers"}: ${shown(values)}`]),
            `  runs ${runsWords(server, options.machineName)}; folders: ${server.folders.length === 0 ? "every folder" : server.folders.join(", ")}`,
            `  ${tools === undefined ? "tools not listed yet" : `${tools.length} tools`}; timeout ${server.timeout} s; idle stop after ${server.idleMinutes} min${server.askEachCall ? "; asks before each call" : ""}${server.planMode ? "; its read-only tools run in plan mode" : ""}`,
            ...(server.description === "" ? [] : [`  ${server.description}`]),
            ...(running.length === 0 ? [] : [`  running: ${running.join("; ")}`]),
        ].join("\n");
    };

    return [
        defineTool({
            name: "mcp_servers",
            description:
                "The owner's MCP servers (Settings › MCP servers): each one's command or URL, where it runs, the folders it serves, its tools' count, whether it is on, and its running instances. Only reads; mcp_server_set changes one.",
            parameters: obj({}, { open: true }),
            execute: async (_args, api) => {
                const refused = guard.refusal(Number(api.conversationId));

                if (refused !== undefined) {
                    return reply(refused, true);
                }

                const list = servers.list();
                const problems = servers.problems();

                return reply(
                    [
                        list.length === 0 ? "No MCP servers yet. Add one with mcp_server_set (the owner approves it on a card), or in Settings › MCP servers." : list.map(line).join("\n"),
                        ...problems.map((problem) => `- ${problem.name}: not valid, out of use: ${problem.error}`),
                    ].join("\n"),
                );
            },
        }) as unknown as ToolRegistration,
        defineTool({
            name: "mcp_server_set",
            description:
                "Add or change one of the owner's MCP servers, turn it on or off, or remove it, after the owner approves a card with the whole entry (and the diff for a change). The entry is the mcpServers shape (command, args, env, cwd; or url, headers, oauth) with pi-phone's fields: runs (session, phone or machine:<id>), folders, description, timeout, idleMinutes, askEachCall, planMode, hiddenTools. env and headers name the owner's secrets as ${NAME}. Pin package versions (gopeak@2.3.8, not @latest).",
            parameters: obj(
                {
                    action: oneOf(["save", "enable", "disable", "remove"] as const, { description: "save adds or replaces the entry; enable, disable and remove need only the name" }),
                    name: str({ description: "The server's name: letters, digits, _ and -; its tools are mcp__<name>__<tool>" }),
                    entry: opt(map(unknown(), { description: "save: the whole entry, as one server of an mcpServers block" })),
                },
                { open: true },
            ),
            execute: async (args, api, context) => {
                try {
                    const refused = guard.refusal(Number(api.conversationId)) ?? guard.notOwner(Number(api.conversationId));

                    if (refused !== undefined) {
                        throw new Error(refused);
                    }

                    const before = servers.get(args.name);
                    let after: McpServer;

                    if (args.action === "save") {
                        if (args.entry === undefined) {
                            throw new Error("save needs the entry.");
                        }

                        after = parseServer(args.name, args.entry);
                    } else if (before === undefined) {
                        throw new Error(`There is no MCP server ${args.name}.`);
                    } else {
                        after = { ...before, enabled: args.action === "enable" ? true : args.action === "disable" ? false : before.enabled };
                    }

                    const now = before === undefined ? undefined : entryJson(before);
                    const next = entryJson(after);
                    const diff = now === undefined || args.action === "remove" ? undefined : generateUnifiedPatch(`${args.name}.json`, now, next, 3);

                    if (args.action === "save" && now === next) {
                        return reply(`${args.name} is already this entry${before?.approved === true ? "" : "; enable it to approve it again"}.`);
                    }

                    const unpinned = unpinnedPackage(after);
                    const form: McpServerForm = {
                        type: "mcp-server",
                        action: args.action,
                        name: args.name,
                        entry: next,
                        ...(diff === undefined ? {} : { diff }),
                        runs: runsWords(after, options.machineName),
                        folders: after.folders,
                        secrets: secretNames(after),
                        ...(unpinned === undefined ? {} : { unpinned }),
                    };
                    const verb = { save: before === undefined ? "Add" : "Change", enable: "Turn on", disable: "Turn off", remove: "Remove" }[args.action];
                    const allowed = await guard.ask(api, { key: "server", tool: "mcp_server_set", subject: next, reason: `${verb} the MCP server ${args.name}`, form }, context);

                    if (!allowed) {
                        return reply(`The owner did not approve: the MCP server ${args.name} is as it was.`, true);
                    }

                    switch (args.action) {
                        case "remove":
                            servers.remove(args.name);
                            await manager.reconnect(args.name);

                            return reply(`Removed the MCP server ${args.name}.`);
                        case "disable":
                            servers.setEnabled(args.name, false);

                            return reply(`Turned off the MCP server ${args.name}; its running instances stopped.`);
                        default: {
                            // What the owner saw is what is approved: a save, and turning on an entry changed elsewhere.
                            const saved = servers.save(args.name, entryOf(after));

                            return reply(
                                `${verb === "Turn on" ? "Turned on" : before === undefined ? "Added" : "Changed"} the MCP server ${args.name} (${saved.kind}, runs ${runsWords(saved, options.machineName)}, ${saved.folders.length === 0 ? "every folder" : saved.folders.join(", ")}). Its tools are found with tool_search in sessions in those folders once it lists them.`,
                            );
                        }
                    }
                } catch (error) {
                    return reply(message(error), true);
                }
            },
        }) as unknown as ToolRegistration,
    ];
}

