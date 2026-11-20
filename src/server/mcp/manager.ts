/**
 * Running MCP servers (PP-524, T2): one instance per (server, where it runs, folder), started on its first use and
 * shared by the sessions working there. A stdio server is a program that pi-env's daemon starts (`openProcess`): the
 * phone's own daemon, or a machine's over the app's ssh, the connection Pi's terminal and bash use there; its stdio is
 * MCP through pi-mcp's `PipeTransport`. One code path for both.
 *
 * - A call waits at most the server's `timeout` (60 s), which progress from the server extends, and never more than 10
 *   minutes. A call that times out is cancelled, and the answer says the tool may still run.
 * - A server that dies is started again on the next call, after 1, 5, then 30 s. Three deaths in 5 minutes mark it
 *   failed: the owner hears it, and it stays down until the owner reconnects it. A call in flight when it dies fails;
 *   no call is ever sent again.
 * - An instance with no call for the server's `idleMinutes` (30) stops: stdin closed, then the program and what it
 *   started killed (the daemon kills its process group).
 * - At most `maxInstances` (6) run; a new one stops the instance used longest ago that has no call running.
 * - An entry changed or turned off stops its instances.
 *
 * Its stderr stays here for the owner (`status`), never for the model: it can hold what the server was given.
 */
import { type Connection, openProcess } from "@earendil-works/pi-env";
import { type CallToolResult, McpAbortError, McpClient, McpConnectionClosedError, McpTimeoutError, PipeTransport, type ProgressNotification, type Tool } from "@earendil-works/pi-mcp";
import { parsePlace } from "../places.ts";
import type { Secrets } from "../secrets.ts";
import { fillPlaceholders, type McpServerInfo, type McpServers, type McpStdioServer, secretNames, serves } from "./config.ts";

/** Waits before starting a server that died again: after its first, second, and later deaths. */
export const BACKOFF_MS = [1_000, 5_000, 30_000] as const;
/** This many deaths within `DEATH_WINDOW_MS` mark a server failed. */
export const DEATHS_FOR_FAILED = 3;
export const DEATH_WINDOW_MS = 5 * 60_000;
/** No call waits longer, whatever progress the server reports. */
export const MAX_CALL_MS = 10 * 60_000;
export const DEFAULT_MAX_INSTANCES = 6;

/** A place a server runs on: its pi-env connection, the home folder there, and on the phone the app's PATH. */
export type McpWhere = { connection: Connection; home: string; path?: string };

export type McpManagerHost = {
    servers: McpServers;
    secrets: Pick<Secrets, "environment" | "get" | "used">;
    /**
     * The place a server runs on: the phone (`undefined`) or a machine. Throws, naming what is missing, when it cannot
     * run there (a machine not set up, or a Windows machine).
     */
    where(machineId: string | undefined): McpWhere;
    /** Tell the owner (a server failed). */
    notify(message: string): void;
    log(line: string): void;
    now?: () => number;
    maxInstances?: number;
};

export type McpInstanceState = "starting" | "ready" | "stopped" | "failed";

/** An instance as the owner's page shows it. */
export type McpInstanceStatus = {
    server: string;
    /** The machine's id, or undefined on the phone. */
    machineId: string | undefined;
    folder: string;
    state: McpInstanceState;
    pid?: number;
    startedAt?: number;
    lastUsedAt?: number;
    calls: number;
    deaths: number;
    failed?: string;
    /** The end of its stderr, for the owner alone. */
    stderr: string;
};

type Instance = {
    key: string;
    server: string;
    fingerprint: string;
    machineId: string | undefined;
    folder: string;
    client?: McpClient;
    transport?: PipeTransport;
    starting?: Promise<McpClient>;
    pid?: number;
    startedAt?: number;
    lastUsedAt?: number;
    tools?: Tool[];
    calls: number;
    inFlight: number;
    idle?: NodeJS.Timeout;
    deaths: number[];
    failed?: string;
    /** Set while the app itself closes it: not a death. */
    closing: boolean;
    stderr: string;
};

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** `~` and `~/…` at the start of a value: the home of the computer the server runs on. */
function expandHome(value: string, home: string): string {
    return value === "~" ? home : value.startsWith("~/") ? `${home}/${value.slice(2)}` : value;
}

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
    return new Promise((resolve, reject) => {
        if (signal?.aborted === true) {
            reject(new McpAbortError("cancelled"));

            return;
        }

        const timer = setTimeout(() => {
            signal?.removeEventListener("abort", stop);
            resolve();
        }, ms);
        const stop = () => {
            clearTimeout(timer);
            reject(new McpAbortError("cancelled"));
        };

        signal?.addEventListener("abort", stop, { once: true });
    });
}

export class McpManager {
    readonly #host: McpManagerHost;
    readonly #now: () => number;
    readonly #max: number;
    readonly #instances = new Map<string, Instance>();
    readonly #toolsChanged = new Set<(server: string) => void>();
    readonly #unsubscribe: () => void;

    constructor(host: McpManagerHost) {
        this.#host = host;
        this.#now = host.now ?? Date.now;
        this.#max = host.maxInstances ?? DEFAULT_MAX_INSTANCES;
        // An entry changed (a new fingerprint), turned off or removed: its instances stop.
        this.#unsubscribe = host.servers.onChange(() => {
            for (const instance of [...this.#instances.values()]) {
                const server = host.servers.get(instance.server);

                if (server === undefined || !host.servers.runnable(instance.server) || server.fingerprint !== instance.fingerprint) {
                    void this.#close(instance, true);
                }
            }
        });
    }

    /** `listener(server)` when a running server says its tools changed (`notifications/tools/list_changed`). */
    onToolsChanged(listener: (server: string) => void): () => void {
        this.#toolsChanged.add(listener);

        return () => this.#toolsChanged.delete(listener);
    }

    /**
     * Where a session in `cwd` runs the server, or why it may not use it: the machine (`undefined` for the phone) and the
     * folder the program starts in.
     */
    place(name: string, cwd: string): { server: McpServerInfo & McpStdioServer; machineId: string | undefined; folder: string } {
        const server = this.#host.servers.get(name);

        if (server === undefined) {
            throw new Error(`There is no MCP server ${name}.`);
        }

        if (!server.enabled) {
            throw new Error(`The MCP server ${name} is off (Settings › MCP servers).`);
        }

        if (!server.approved) {
            throw new Error(`The MCP server ${name} changed since the owner approved it: it runs again once approved (Settings › MCP servers).`);
        }

        if (!serves(server, cwd)) {
            throw new Error(`The MCP server ${name} does not serve this session's folder (${cwd}).`);
        }

        if (server.kind !== "stdio") {
            throw new Error(`The MCP server ${name} is reached over HTTP, which comes with PP-529.`);
        }

        const here = parsePlace(cwd);
        const machineId = server.runs.where === "session" ? here.machineId : server.runs.where === "machine" ? server.runs.machineId : undefined;
        const sameComputer = here.machineId === machineId;
        const where = this.#host.where(machineId);
        const folder = server.cwd === undefined ? (sameComputer ? here.path : where.home) : expandHome(server.cwd, where.home);

        return { server, machineId, folder };
    }

    #instance(name: string, cwd: string): { instance: Instance; server: McpServerInfo & McpStdioServer } {
        const { server, machineId, folder } = this.place(name, cwd);
        const key = JSON.stringify([name, machineId ?? null, folder]);
        let instance = this.#instances.get(key);

        if (instance !== undefined && instance.fingerprint !== server.fingerprint) {
            void this.#close(instance, true);
            instance = undefined;
        }

        if (instance === undefined) {
            instance = { key, server: name, fingerprint: server.fingerprint, machineId, folder, calls: 0, inFlight: 0, deaths: [], closing: false, stderr: "" };
            this.#instances.set(key, instance);
        }

        return { instance, server };
    }

    /** The server's tools, as a session in `cwd` reaches it; starts it if it is not running. */
    async tools(name: string, cwd: string, signal?: AbortSignal): Promise<Tool[]> {
        const { instance, server } = this.#instance(name, cwd);

        instance.inFlight += 1;

        try {
            const client = await this.#client(instance, server, cwd, signal);

            instance.tools ??= await client.listTools({ timeoutMs: server.timeout * 1000, ...(signal === undefined ? {} : { signal }) });

            return instance.tools;
        } finally {
            this.#done(instance, server);
        }
    }

    /**
     * Call a tool of the server for a session in `cwd`: started if it is not running. A timeout, a death in flight, or a
     * failed server throws an error that says what happened; a call is never sent twice.
     */
    async call(
        name: string,
        cwd: string,
        tool: string,
        args: Record<string, unknown>,
        options: { signal?: AbortSignal; onProgress?: (progress: ProgressNotification) => void } = {},
    ): Promise<CallToolResult> {
        const { instance, server } = this.#instance(name, cwd);

        instance.inFlight += 1;

        const cap = new AbortController();
        const capTimer = setTimeout(() => cap.abort(new McpTimeoutError(MAX_CALL_MS)), MAX_CALL_MS);
        const signal = options.signal === undefined ? cap.signal : AbortSignal.any([options.signal, cap.signal]);

        try {
            const client = await this.#client(instance, server, cwd, options.signal);

            instance.calls += 1;

            return await client.callTool(tool, args, {
                timeoutMs: server.timeout * 1000,
                signal,
                ...(options.onProgress === undefined ? {} : { onProgress: options.onProgress }),
            });
        } catch (error) {
            if (error instanceof McpTimeoutError || cap.signal.aborted) {
                const seconds = cap.signal.aborted ? MAX_CALL_MS / 1000 : server.timeout;

                throw new Error(`The MCP tool ${tool} of ${name} did not answer in ${seconds} s. The call was cancelled, but the tool may still run on the server.`);
            }

            if (error instanceof McpConnectionClosedError) {
                throw new Error(`The MCP server ${name} stopped while ${tool} ran: the tool may have run. The call is not sent again.`);
            }

            throw error;
        } finally {
            clearTimeout(capTimer);
            this.#done(instance, server);
        }
    }

    /** A call or a listing ended: the idle clock starts again once none runs. */
    #done(instance: Instance, server: McpServerInfo): void {
        instance.inFlight -= 1;
        instance.lastUsedAt = this.#now();
        clearTimeout(instance.idle);

        if (instance.inFlight === 0 && instance.client !== undefined) {
            instance.idle = setTimeout(() => {
                if (instance.inFlight === 0) {
                    this.#host.log(`mcp: ${instance.server} stopped after ${server.idleMinutes} minutes without a call`);
                    void this.#close(instance, false);
                }
            }, server.idleMinutes * 60_000);
            instance.idle.unref();
        }
    }

    async #client(instance: Instance, server: McpServerInfo & McpStdioServer, cwd: string, signal: AbortSignal | undefined): Promise<McpClient> {
        if (instance.failed !== undefined) {
            throw new Error(`The MCP server ${instance.server} failed: ${instance.failed} It stays down until the owner reconnects it (Settings › MCP servers).`);
        }

        if (instance.client !== undefined && instance.client.connectionState === "connected") {
            return instance.client;
        }

        if (instance.starting === undefined) {
            const recent = instance.deaths.filter((at) => at > this.#now() - DEATH_WINDOW_MS);

            if (recent.length > 0) {
                const wait = recent.at(-1)! + BACKOFF_MS[Math.min(recent.length, BACKOFF_MS.length) - 1]! - this.#now();

                if (wait > 0) {
                    await sleep(wait, signal);
                }
            }

            if (instance.starting === undefined && instance.client === undefined) {
                instance.starting = this.#start(instance, server, cwd).finally(() => {
                    instance.starting = undefined;
                });
            }
        }

        return instance.client?.connectionState === "connected" ? instance.client : await instance.starting!;
    }

    async #start(instance: Instance, server: McpServerInfo & McpStdioServer, cwd: string): Promise<McpClient> {
        await this.#makeRoom(instance);

        const where = this.#host.where(instance.machineId);
        const env = this.#environment(server, cwd, where);
        const argv = [expandHome(server.command, where.home), ...server.args.map((arg) => expandHome(arg, where.home))];
        const transport = new PipeTransport({
            open: async (handlers) => {
                const program = await openProcess(where.connection, { cwd: instance.folder, argv, env, onStdout: handlers.onStdout, onStderr: handlers.onStderr });

                instance.pid = program.pid;

                return program;
            },
        });
        const client = new McpClient({ name: "pi-phone", version: "1", requestTimeoutMs: server.startTimeout * 1000 });

        instance.closing = false;
        instance.tools = undefined;
        instance.transport = transport;

        let timer: NodeJS.Timeout | undefined;

        try {
            await Promise.race([
                client.connect(transport),
                new Promise((_resolve, reject) => {
                    timer = setTimeout(() => reject(new Error(`it did not start in ${server.startTimeout} s`)), server.startTimeout * 1000);
                }),
            ]);
        } catch (error) {
            instance.stderr = transport.stderr;
            await client.close().catch(() => undefined);
            await transport.close().catch(() => undefined);
            this.#died(instance, `it did not start: ${message(error)}`);

            throw new Error(`The MCP server ${instance.server} did not start: ${message(error)}`);
        } finally {
            clearTimeout(timer);
        }

        instance.client = client;
        instance.startedAt = this.#now();
        client.onNotification("notifications/tools/list_changed", () => {
            instance.tools = undefined;

            for (const listener of [...this.#toolsChanged]) {
                listener(instance.server);
            }
        });
        client.onClose(() => {
            instance.stderr = transport.stderr;

            if (instance.client !== client) {
                return;
            }

            instance.client = undefined;
            instance.transport = undefined;
            clearTimeout(instance.idle);

            if (!instance.closing) {
                this.#died(instance, "it stopped by itself.");
            }
        });
        this.#host.log(`mcp: ${instance.server} started (pid ${instance.pid ?? "?"}) ${instance.machineId === undefined ? "on the phone" : `on machine ${instance.machineId}`} in ${instance.folder}`);

        return client;
    }

    /** The program's environment: the entry's, its secrets filled in where the session may use them, the app's PATH on the phone. */
    #environment(server: McpStdioServer, cwd: string, where: McpWhere): Record<string, string> {
        const names = secretNames(server);
        const refused = names.filter((name) => this.#host.secrets.get(name) === undefined || this.#host.secrets.environment([name], cwd)[name] === undefined);

        if (refused.length > 0) {
            throw new Error(`The MCP server ${server.name} needs the secret${refused.length === 1 ? "" : "s"} ${refused.join(", ")}, which ${refused.length === 1 ? "is" : "are"} not set or may not be used in this folder (Settings › Secrets).`);
        }

        // A secret that asks first gets its card with PP-527; until then such a server does not start.
        const asking = names.filter((name) => this.#host.secrets.get(name)!.ask);

        if (asking.length > 0) {
            throw new Error(`The MCP server ${server.name} needs ${asking.join(", ")}, which ${asking.length === 1 ? "asks" : "ask"} before each use: MCP servers cannot ask yet (PP-527).`);
        }

        const values = this.#host.secrets.environment(names, cwd);

        this.#host.secrets.used(names);

        return {
            ...(where.path === undefined ? {} : { PATH: where.path }),
            ...Object.fromEntries(Object.entries(server.env).map(([key, value]) => [key, expandHome(fillPlaceholders(value, values), where.home)])),
        };
    }

    #died(instance: Instance, why: string): void {
        const now = this.#now();

        instance.deaths = [...instance.deaths.filter((at) => at > now - DEATH_WINDOW_MS), now];
        this.#host.log(`mcp: ${instance.server} died (${instance.deaths.length} in 5 minutes): ${why}`);

        if (instance.deaths.length >= DEATHS_FOR_FAILED) {
            instance.failed = `it died ${instance.deaths.length} times in 5 minutes; the last time ${why}`;
            this.#host.notify(`The MCP server ${instance.server} failed: ${instance.failed} It stays down until you reconnect it in Settings › MCP servers.`);
        }
    }

    /** Below the cap, by stopping the instance used longest ago with no call running; refused when all are busy. */
    async #makeRoom(starting: Instance): Promise<void> {
        const running = [...this.#instances.values()].filter((each) => each !== starting && (each.client !== undefined || each.starting !== undefined));

        if (running.length < this.#max) {
            return;
        }

        const quiet = running.filter((each) => each.inFlight === 0 && each.starting === undefined).sort((a, b) => (a.lastUsedAt ?? 0) - (b.lastUsedAt ?? 0));

        if (quiet.length === 0) {
            throw new Error(`${this.#max} MCP servers are running with calls in flight: ${starting.server} cannot start now.`);
        }

        this.#host.log(`mcp: stopped ${quiet[0]!.server} to start ${starting.server} (at most ${this.#max} run at once)`);
        await this.#close(quiet[0]!, false);
    }

    /** Stop an instance: not a death. `forget` drops it with its deaths. */
    async #close(instance: Instance, forget: boolean): Promise<void> {
        clearTimeout(instance.idle);
        instance.closing = true;

        const client = instance.client;
        const transport = instance.transport;

        instance.client = undefined;
        instance.transport = undefined;
        instance.tools = undefined;

        if (forget) {
            this.#instances.delete(instance.key);
        }

        await client?.close().catch(() => undefined);
        await transport?.close().catch(() => undefined);

        if (transport !== undefined) {
            instance.stderr = transport.stderr;
        }
    }

    /** Stop the server's instances (the owner's Stop). */
    async stop(name: string): Promise<void> {
        await Promise.all([...this.#instances.values()].filter((each) => each.server === name).map((each) => this.#close(each, false)));
    }

    /** Stop the server's instances and forget their deaths and failure (the owner's Reconnect); the next call starts it. */
    async reconnect(name: string): Promise<void> {
        await Promise.all([...this.#instances.values()].filter((each) => each.server === name).map((each) => this.#close(each, true)));
    }

    status(): McpInstanceStatus[] {
        return [...this.#instances.values()].map((each) => ({
            server: each.server,
            machineId: each.machineId,
            folder: each.folder,
            state: each.failed !== undefined ? "failed" : each.starting !== undefined ? "starting" : each.client !== undefined ? "ready" : "stopped",
            ...(each.client === undefined || each.pid === undefined ? {} : { pid: each.pid }),
            ...(each.startedAt === undefined ? {} : { startedAt: each.startedAt }),
            ...(each.lastUsedAt === undefined ? {} : { lastUsedAt: each.lastUsedAt }),
            calls: each.calls,
            deaths: each.deaths.length,
            ...(each.failed === undefined ? {} : { failed: each.failed }),
            stderr: each.transport?.stderr ?? each.stderr,
        }));
    }

    async close(): Promise<void> {
        this.#unsubscribe();
        await Promise.all([...this.#instances.values()].map((each) => this.#close(each, true)));
    }
}
