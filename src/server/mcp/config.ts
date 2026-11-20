/**
 * The owner's MCP servers (PP-517, T1): the entries of `<data>/mcp/servers.json`, in the `mcpServers` shape MCP clients
 * share (so an entry from Claude, Cursor or Pi pastes in), with pi-phone's own fields: where a stdio server runs, the
 * folders it serves, how long it may sit idle, whether each call asks first, whether plan mode trusts its read-only
 * hints, and tools to hide.
 *
 * The file is the app's: only the app writes it (Settings › MCP servers, and Pi's tool that asks on a card), and Pi's
 * tools never read or write it (`keyStoreRefusal`: headers may hold tokens). Each entry is approved by its
 * fingerprint, a SHA-256 of everything but `enabled`: an entry whose fingerprint is not the approved one does not run
 * until the owner approves it again.
 *
 * Values of `env` and `headers` are text, or name the owner's secrets as `${NAME}` (Settings › Secrets): the values go in
 * when the server starts, where the secret may be used. Pi's `!command` values (a command run to make a value) are
 * refused: that would run a command outside bash's checks; `secret_save` keeps such a value instead.
 */
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { mcpNamespace, type McpOAuthConfig, validateMcpServerConfig } from "@earendil-works/pi-mcp";
import { SECRET_NAME } from "../secrets.ts";

/** The folder of the app's MCP files, under its data folder: Pi's tools stay out of it. */
export const MCP_FOLDER = "mcp";
const FILE = "servers.json";

/** A call's timeout and a start's, in seconds, when the entry gives none; and the most it may give. */
export const DEFAULT_TIMEOUT = 60;
export const DEFAULT_START_TIMEOUT = 60;
const MAX_TIMEOUT = 600;
/** How long a server may sit without a call before it stops, in minutes, when the entry gives none. */
export const DEFAULT_IDLE_MINUTES = 30;
const MAX_IDLE_MINUTES = 24 * 60;
const MAX_DESCRIPTION = 300;

/** Where a stdio server runs: where the session works (the phone or its machine), always the phone, or one machine. */
export type McpRuns = { where: "session" } | { where: "phone" } | { where: "machine"; machineId: string };

type Common = {
    name: string;
    description: string;
    enabled: boolean;
    /** A call's timeout, in seconds. */
    timeout: number;
    /** Folders it serves, and below them: phone paths or `machine:<id>:<path>`. Empty: every folder. */
    folders: string[];
    /** Minutes without a call before it stops. */
    idleMinutes: number;
    /** Each call waits for the owner on a card. */
    askEachCall: boolean;
    /** Plan mode lets through the tools the server marks read-only. */
    planMode: boolean;
    /** Tools left out, by name or a pattern with `*`. */
    hiddenTools: string[];
};

export type McpStdioServer = Common & {
    kind: "stdio";
    command: string;
    args: string[];
    env: Record<string, string>;
    /** Absolute, or the session's folder when unset. `~/` is the home of the computer it runs on. */
    cwd?: string;
    runs: McpRuns;
    /** How long it has to start and answer `initialize`, in seconds. */
    startTimeout: number;
};

export type McpHttpServer = Common & {
    kind: "http";
    url: string;
    headers: Record<string, string>;
    oauth?: McpOAuthConfig;
    /**
     * Where its URL is reached from (PP-529): the phone (the default), or a machine, whose `localhost` (or any host it
     * reaches) the app forwards to the phone over its ssh.
     */
    runs: { where: "phone" } | { where: "machine"; machineId: string };
};

export type McpServer = McpStdioServer | McpHttpServer;

/** A server as the app lists it: its entry, whether the owner approved this entry, and its fingerprint. */
export type McpServerInfo = McpServer & { fingerprint: string; approved: boolean };

const COMMON_KEYS = ["type", "description", "enabled", "timeout", "folders", "idleMinutes", "askEachCall", "planMode", "hiddenTools"];
const STDIO_KEYS = new Set([...COMMON_KEYS, "command", "args", "env", "cwd", "runs", "startTimeout"]);
const HTTP_KEYS = new Set([...COMMON_KEYS, "url", "headers", "oauth", "runs"]);

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** `${NAME}` in a value: a secret's name. */
const PLACEHOLDER = /\$\{([^}]*)\}/g;

/** The secrets a value names, or why it may not be used. */
function placeholders(value: string, where: string): string[] {
    if (value.startsWith("!")) {
        throw new Error(`${where}: a value that starts with "!" (a command whose output is the value) is not supported. Keep the value as a secret (Settings › Secrets) and name it as \${NAME}.`);
    }

    return [...value.matchAll(PLACEHOLDER)].map((match) => {
        const name = match[1]!;

        if (!SECRET_NAME.test(name)) {
            throw new Error(`${where}: \${${name}} is not a secret's name (capital letters, digits and _, as NPM_TOKEN).`);
        }

        return name;
    });
}

function strings(value: unknown, what: string): string[] {
    if (value === undefined) {
        return [];
    }

    if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.trim() === "")) {
        throw new Error(`${what} is a list of non-empty texts.`);
    }

    return value as string[];
}

function flag(value: unknown, fallback: boolean, what: string): boolean {
    if (value === undefined) {
        return fallback;
    }

    if (typeof value !== "boolean") {
        throw new Error(`${what} is true or false.`);
    }

    return value;
}

function count(value: unknown, fallback: number, max: number, what: string): number {
    if (value === undefined) {
        return fallback;
    }

    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > max) {
        throw new Error(`${what} is a number above 0, at most ${max}.`);
    }

    return value;
}

function textMap(value: unknown, what: string, server: string): Record<string, string> {
    if (value === undefined) {
        return {};
    }

    if (!isRecord(value)) {
        throw new Error(`server "${server}": ${what} is an object of texts.`);
    }

    for (const [key, item] of Object.entries(value)) {
        if (typeof item !== "string") {
            throw new Error(`server "${server}": ${what}.${key} is text.`);
        }

        placeholders(item, `server "${server}": ${what}.${key}`);
    }

    return { ...(value as Record<string, string>) };
}

function runsOf(value: unknown, server: string): McpRuns {
    if (value === undefined || value === "session") {
        return { where: "session" };
    }

    if (value === "phone") {
        return { where: "phone" };
    }

    if (typeof value === "string" && /^machine:[^:\s]+$/.test(value)) {
        return { where: "machine", machineId: value.slice("machine:".length) };
    }

    throw new Error(`server "${server}": runs is "session", "phone" or "machine:<machine id>".`);
}

/** `runs` as the file keeps it. */
export function runsText(runs: McpRuns): string {
    return runs.where === "machine" ? `machine:${runs.machineId}` : runs.where;
}

/**
 * Check one entry of the `mcpServers` shape with pi-phone's fields, as given by the owner or read from the file: the
 * server as the app uses it, or an error that names what is wrong. Unknown fields are refused, as the file is a trust
 * boundary.
 */
export function parseServer(name: string, raw: unknown): McpServer {
    const checked = validateMcpServerConfig(name, raw);

    if (checked.kind === "invalid") {
        throw new Error(checked.error);
    }

    const entry = checked.config as Record<string, unknown>;
    const known = checked.kind === "stdio" ? STDIO_KEYS : HTTP_KEYS;
    const unknown = Object.keys(entry).filter((key) => !known.has(key));

    if (unknown.length > 0) {
        throw new Error(`server "${name}": ${unknown.join(", ")} ${unknown.length === 1 ? "is" : "are"} not a field of a ${checked.kind} server here.`);
    }

    const description = entry.description ?? "";

    if (typeof description !== "string" || description.length > MAX_DESCRIPTION) {
        throw new Error(`server "${name}": description is text of at most ${MAX_DESCRIPTION} characters.`);
    }

    const folders = strings(entry.folders, `server "${name}": folders`).map((folder) => folder.trim().replace(/\/+$/, "") || "/");
    const common: Common = {
        name,
        description: description.trim(),
        enabled: flag(entry.enabled, true, `server "${name}": enabled`),
        timeout: count(entry.timeout, DEFAULT_TIMEOUT, MAX_TIMEOUT, `server "${name}": timeout (seconds)`),
        folders: [...new Set(folders)],
        idleMinutes: count(entry.idleMinutes, DEFAULT_IDLE_MINUTES, MAX_IDLE_MINUTES, `server "${name}": idleMinutes`),
        askEachCall: flag(entry.askEachCall, false, `server "${name}": askEachCall`),
        planMode: flag(entry.planMode, false, `server "${name}": planMode`),
        hiddenTools: strings(entry.hiddenTools, `server "${name}": hiddenTools`),
    };

    for (const folder of common.folders) {
        if (!folder.startsWith("/") && !/^machine:[^:]+:\//.test(folder)) {
            throw new Error(`server "${name}": the folder ${folder} is not an absolute path on the phone or machine:<id>:/<path>.`);
        }
    }

    if (checked.kind === "stdio") {
        const config = checked.config;
        const args = config.args ?? [];

        if (config.cwd !== undefined && !config.cwd.startsWith("/") && !config.cwd.startsWith("~/") && config.cwd !== "~") {
            throw new Error(`server "${name}": cwd is an absolute path or starts with ~/ (unset: the session's folder).`);
        }

        return {
            ...common,
            kind: "stdio",
            command: config.command,
            args: [...args],
            env: textMap(config.env, "env", name),
            ...(config.cwd === undefined ? {} : { cwd: config.cwd }),
            runs: runsOf(entry.runs, name),
            startTimeout: count(entry.startTimeout, DEFAULT_START_TIMEOUT, MAX_TIMEOUT, `server "${name}": startTimeout (seconds)`),
        };
    }

    const config = checked.config;

    if (config.oauth !== undefined && config.headers?.Authorization !== undefined) {
        throw new Error(`server "${name}": give either oauth or an Authorization header, not both.`);
    }

    return {
        ...common,
        kind: "http",
        url: config.url,
        headers: textMap(config.headers, "headers", name),
        ...(config.oauth === undefined ? {} : { oauth: config.oauth }),
        runs: httpRuns(entry.runs, name),
    };
}

/** Where an HTTP server's URL is reached from: the phone, or a machine (its localhost forwarded). */
function httpRuns(value: unknown, server: string): McpHttpServer["runs"] {
    const runs = value === undefined ? ({ where: "phone" } as const) : runsOf(value, server);

    if (runs.where === "session") {
        throw new Error(`server "${server}": an HTTP server's runs is "phone" (its URL reached from the phone) or "machine:<machine id>" (from that machine).`);
    }

    return runs;
}

/** The entry as the file keeps it: the shared shape, with pi-phone's fields only where they differ from the defaults. */
export function entryOf(server: McpServer): Record<string, unknown> {
    const common = {
        ...(server.description === "" ? {} : { description: server.description }),
        ...(server.enabled ? {} : { enabled: false }),
        ...(server.timeout === DEFAULT_TIMEOUT ? {} : { timeout: server.timeout }),
        ...(server.folders.length === 0 ? {} : { folders: server.folders }),
        ...(server.idleMinutes === DEFAULT_IDLE_MINUTES ? {} : { idleMinutes: server.idleMinutes }),
        ...(server.askEachCall ? { askEachCall: true } : {}),
        ...(server.planMode ? { planMode: true } : {}),
        ...(server.hiddenTools.length === 0 ? {} : { hiddenTools: server.hiddenTools }),
    };

    if (server.kind === "stdio") {
        return {
            command: server.command,
            ...(server.args.length === 0 ? {} : { args: server.args }),
            ...(Object.keys(server.env).length === 0 ? {} : { env: server.env }),
            ...(server.cwd === undefined ? {} : { cwd: server.cwd }),
            ...(server.runs.where === "session" ? {} : { runs: runsText(server.runs) }),
            ...(server.startTimeout === DEFAULT_START_TIMEOUT ? {} : { startTimeout: server.startTimeout }),
            ...common,
        };
    }

    return {
        type: "http",
        url: server.url,
        ...(Object.keys(server.headers).length === 0 ? {} : { headers: server.headers }),
        ...(server.oauth === undefined ? {} : { oauth: server.oauth }),
        ...(server.runs.where === "phone" ? {} : { runs: runsText(server.runs) }),
        ...common,
    };
}

/** JSON with keys in order, so the same entry always gives the same text. */
function canonical(value: unknown): string {
    if (Array.isArray(value)) {
        return `[${value.map(canonical).join(",")}]`;
    }

    if (isRecord(value)) {
        return `{${Object.keys(value)
            .sort()
            .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
            .join(",")}}`;
    }

    return JSON.stringify(value);
}

/** What the owner approves: a SHA-256 of the whole entry and its name, all but `enabled`. */
export function fingerprint(server: McpServer): string {
    const { enabled: _enabled, ...entry } = server;

    return createHash("sha256").update(canonical(entry)).digest("hex");
}

/** The secrets an entry names in its `env`, or its `headers` and OAuth client secret, each once. */
export function secretNames(server: McpServer): string[] {
    const values = Object.entries(server.kind === "stdio" ? server.env : { ...server.headers, ...(server.oauth?.clientSecret === undefined ? {} : { "oauth.clientSecret": server.oauth.clientSecret }) });

    return [...new Set(values.flatMap(([key, value]) => placeholders(value, `server "${server.name}": ${key}`)))];
}

/** The secrets one value names as `${NAME}`. */
export const secretsIn = (value: string, where: string): string[] => placeholders(value, where);

/** A value with its `${NAME}`s replaced by the secrets' values; every one must be in `values`. */
export function fillPlaceholders(value: string, values: Readonly<Record<string, string>>): string {
    return value.replace(PLACEHOLDER, (_whole, name: string) => {
        const found = values[name];

        if (found === undefined) {
            throw new Error(`The secret ${name} is not given.`);
        }

        return found;
    });
}

/** Whether `cwd` is `folder` or below it. */
function within(cwd: string, folder: string): boolean {
    return folder === "/" ? cwd.startsWith("/") : cwd === folder || cwd.startsWith(`${folder}/`);
}

/** Whether a session working in `cwd` is in the server's folders. */
export function serves(server: McpServer, cwd: string): boolean {
    return server.folders.length === 0 || server.folders.some((folder) => within(cwd, folder));
}

/** Whether a tool of the server is hidden by `hiddenTools` (a name, or a pattern with `*`). */
export function hiddenTool(server: McpServer, tool: string): boolean {
    return server.hiddenTools.some((pattern) => new RegExp(`^${pattern.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`).test(tool));
}

type Stored = { mcpServers: Record<string, unknown>; approved: Record<string, string> };

/**
 * The servers file. A file that cannot be read (not JSON, no `mcpServers` object) is moved aside and said in the log, as
 * the secrets' file is; an entry in it that is not valid stays in the file, out of use, and `problems()` says why.
 */
export class McpServers {
    readonly #file: string;
    readonly #log: (line: string) => void;
    #stored: Stored = { mcpServers: {}, approved: {} };
    #servers = new Map<string, McpServer>();
    #problems: { name: string; error: string }[] = [];
    readonly #listeners = new Set<() => void>();

    constructor(dataDir: string, log: (line: string) => void = () => {}, now: () => number = Date.now) {
        this.#file = join(dataDir, MCP_FOLDER, FILE);
        this.#log = log;

        if (existsSync(this.#file)) {
            const read = this.#read();

            if (typeof read === "string") {
                const aside = `${this.#file}.broken-${now()}`;

                renameSync(this.#file, aside);
                log(`mcp: ${read}; moved it to ${aside} and started with no MCP servers`);
            } else {
                this.#stored = read;
            }
        }

        this.#index();
    }

    get file(): string {
        return this.#file;
    }

    #read(): Stored | string {
        let parsed: unknown;

        try {
            parsed = JSON.parse(readFileSync(this.#file, "utf8"));
        } catch {
            // Not the parser's message: it can quote the file, and so a header's token, into the log.
            return `${this.#file} is not valid JSON`;
        }

        if (!isRecord(parsed) || !isRecord(parsed.mcpServers)) {
            return `${this.#file} has no "mcpServers" object`;
        }

        const approved = isRecord(parsed.approved) ? parsed.approved : {};

        return {
            mcpServers: parsed.mcpServers,
            approved: Object.fromEntries(Object.entries(approved).filter((entry): entry is [string, string] => typeof entry[1] === "string")),
        };
    }

    #index(): void {
        const servers = new Map<string, McpServer>();
        const problems: { name: string; error: string }[] = [];
        const namespaces = new Map<string, string>();

        for (const [name, raw] of Object.entries(this.#stored.mcpServers)) {
            try {
                const server = parseServer(name, raw);
                const other = namespaces.get(mcpNamespace(name));

                if (other !== undefined) {
                    throw new Error(`server "${name}": its tools would be named as those of "${other}" (- and _ are the same in tool names).`);
                }

                namespaces.set(mcpNamespace(name), name);
                servers.set(name, server);
            } catch (error) {
                problems.push({ name, error: error instanceof Error ? error.message : String(error) });
            }
        }

        this.#servers = servers;
        this.#problems = problems;
    }

    /** Every valid server, by name, with whether its entry is the approved one. */
    list(): McpServerInfo[] {
        return [...this.#servers.values()].sort((a, b) => a.name.localeCompare(b.name)).map((server) => this.#info(server));
    }

    get(name: string): McpServerInfo | undefined {
        const server = this.#servers.get(name);

        return server === undefined ? undefined : this.#info(server);
    }

    #info(server: McpServer): McpServerInfo {
        const print = fingerprint(server);

        return { ...server, fingerprint: print, approved: this.#stored.approved[server.name] === print };
    }

    /** Entries in the file that are not valid, and why. */
    problems(): { name: string; error: string }[] {
        return [...this.#problems];
    }

    /** Whether the server may run: on, and its entry the one the owner approved. */
    runnable(name: string): boolean {
        const server = this.get(name);

        return server !== undefined && server.enabled && server.approved;
    }

    /** The runnable servers a session in `cwd` may use. */
    servingIn(cwd: string): McpServerInfo[] {
        return this.list().filter((server) => server.enabled && server.approved && serves(server, cwd));
    }

    /**
     * Add a server or replace one, as the owner approved it (the approval is the caller's: a card, or the owner's own
     * page): the entry is checked, written, and its fingerprint kept as approved. Answers the server.
     */
    save(name: string, raw: unknown): McpServerInfo {
        const server = parseServer(name, raw);
        const other = [...this.#servers.keys()].find((each) => each !== name && mcpNamespace(each) === mcpNamespace(name));

        if (other !== undefined) {
            throw new Error(`server "${name}": its tools would be named as those of "${other}" (- and _ are the same in tool names).`);
        }

        this.#write({
            mcpServers: { ...this.#stored.mcpServers, [name]: entryOf(server) },
            approved: { ...this.#stored.approved, [name]: fingerprint(server) },
        });

        return this.get(name)!;
    }

    /** Turn a server on or off; the approval stays with the entry. */
    setEnabled(name: string, enabled: boolean): McpServerInfo {
        const server = this.#servers.get(name);

        if (server === undefined) {
            throw new Error(`There is no MCP server ${name}.`);
        }

        const entry = { ...entryOf({ ...server, enabled }) };

        this.#write({ mcpServers: { ...this.#stored.mcpServers, [name]: entry }, approved: this.#stored.approved });

        return this.get(name)!;
    }

    remove(name: string): boolean {
        if (!(name in this.#stored.mcpServers)) {
            return false;
        }

        const { [name]: _gone, ...rest } = this.#stored.mcpServers;
        const { [name]: _print, ...approved } = this.#stored.approved;

        this.#write({ mcpServers: rest, approved });

        return true;
    }

    onChange(listener: () => void): () => void {
        this.#listeners.add(listener);

        return () => this.#listeners.delete(listener);
    }

    /** The file first, readable by the app alone, then the servers: a write that fails changes nothing. */
    #write(next: Stored): void {
        mkdirSync(join(this.#file, ".."), { recursive: true, mode: 0o700 });
        const temporary = `${this.#file}.tmp`;

        writeFileSync(temporary, `${JSON.stringify(next, null, 4)}\n`, { mode: 0o600 });
        chmodSync(temporary, 0o600);
        renameSync(temporary, this.#file);
        this.#stored = next;
        this.#index();

        for (const listener of [...this.#listeners]) {
            try {
                listener();
            } catch (error) {
                this.#log(`mcp: a listener failed: ${error instanceof Error ? error.message : String(error)}`);
            }
        }
    }
}
