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
import {
    type AuthProvider,
    type CallToolResult,
    McpAbortError,
    McpAuthRequiredError,
    McpClient,
    McpConnectionClosedError,
    McpHttpError,
    McpSessionExpiredError,
    McpTimeoutError,
    type McpTransport,
    PipeTransport,
    type ProgressNotification,
    StreamableHttpTransport,
    type Tool,
} from "@earendil-works/pi-mcp";
import { McpOAuthAuthorizationRequiredError } from "@earendil-works/pi-mcp/oauth";
import { parsePlace } from "../places.ts";
import type { Secrets } from "../secrets.ts";
import { DEFAULT_START_TIMEOUT, fillPlaceholders, type McpHttpServer, type McpServerInfo, type McpServers, type McpStdioServer, secretNames, serves } from "./config.ts";

/** Waits before an HTTP server's connect is tried again (PP-529): twice. */
export const HTTP_CONNECT_RETRY_MS = [500, 1_500] as const;

/** Whether a failed connect may be tried again: the network, a timeout, or a 408, 429 or 5xx; never a sign-in's 401. */
function retryable(error: unknown): boolean {
    if (error instanceof McpAuthRequiredError || error instanceof McpSessionExpiredError) {
        return false;
    }

    if (error instanceof McpHttpError) {
        return error.status === 408 || error.status === 429 || error.status >= 500;
    }

    // fetch says a network failure (refused, reset, DNS) as a TypeError.
    return error instanceof TypeError || error instanceof McpTimeoutError;
}

/** What a server that needs the owner's sign-in says. */
function signInWords(name: string, server: McpServerInfo): string {
    return server.kind === "http" && server.oauth !== undefined
        ? `The MCP server ${name} needs the owner to sign in: Settings › MCP servers › Sign in (or app_action mcp.signIn, whose address the owner opens).`
        : `The MCP server ${name} refused its credentials (HTTP 401): its headers' token, or an oauth entry to sign in with (Settings › MCP servers).`;
}

/** A program's stderr (the last 64 KB); an HTTP server has none. */
const stderrOf = (transport: McpTransport): string => (transport instanceof PipeTransport ? transport.stderr : "");

/** Waits before starting a server that died again: after its first, second, and later deaths. */
export const BACKOFF_MS = [1_000, 5_000, 30_000] as const;
/** This many deaths within `DEATH_WINDOW_MS` mark a server failed. */
export const DEATHS_FOR_FAILED = 3;
export const DEATH_WINDOW_MS = 5 * 60_000;
/** No call waits longer, whatever progress the server reports. */
export const MAX_CALL_MS = 10 * 60_000;
export const DEFAULT_MAX_INSTANCES = 6;

/** A place a server runs on: its pi-env connection, the home folder there, and on the phone the app's PATH. */
/**
 * A place a server runs on, as bash runs in a session there: its pi-env connection, the home folder, and on the phone
 * the app's PATH; on a machine, what bash gets there (`machine-tools.ts`): `pathFirst` before the daemon's PATH (the
 * tools pi-phone installed) and `sessionEnv` (their variables), which the entry's own `env` overrides.
 */
export type McpWhere = { connection: Connection; home: string; path?: string; pathFirst?: string; sessionEnv?: Readonly<Record<string, string>> };

/**
 * The program as the daemon starts it. With `pathFirst`, a POSIX shell puts it before the daemon's PATH, as bash's
 * prefix does, then `exec`s the program with its arguments untouched: a wrapper such as `xvfb-run -a -s "-screen 0
 * 1280x800x24" npx -y gopeak` keeps its arguments as given, and its pid is the program's.
 */
export function launchArgv(argv: readonly string[], where: Pick<McpWhere, "pathFirst">): string[] {
    return where.pathFirst === undefined ? [...argv] : ["/bin/sh", "-c", `PATH="${where.pathFirst}:$PATH"; export PATH; exec "$@"`, "mcp-server", ...argv];
}

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
    /** A machine's host and port forwarded to the phone, for an HTTP server reached through it (`forwards.ts`). */
    forward?(machineId: string, host: string, port: number): Promise<{ port: number; close: () => void }>;
    /** An HTTP server's OAuth sign-in (PP-530), for an entry with `oauth`. */
    authProvider?(server: McpHttpServer): AuthProvider;
    now?: () => number;
    maxInstances?: number;
};

/**
 * What a call or a listing brings for a start: its cancel signal, and how to ask a person for the secrets set to ask
 * first (a card in the session that starts the server; answers whether they allowed it).
 */
export type McpStartOptions = { signal?: AbortSignal; askSecrets?: (names: readonly string[]) => Promise<boolean> };

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
    transport?: McpTransport;
    /** What an HTTP server through a machine holds open: its forward, closed with the instance. */
    release?: () => void;
    starting?: Promise<McpClient>;
    pid?: number;
    startedAt?: number;
    lastUsedAt?: number;
    tools?: Tool[];
    listing?: Promise<Tool[]>;
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
    readonly #listeners = new Set<(server: string, tools: readonly Tool[]) => void>();
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

    /**
     * `listener(server, tools)` whenever a server's tools are listed afresh: once it starts, and again when it says they
     * changed (`notifications/tools/list_changed`).
     */
    onTools(listener: (server: string, tools: readonly Tool[]) => void): () => void {
        this.#listeners.add(listener);

        return () => this.#listeners.delete(listener);
    }

    /** List the tools of a running instance, once at a time, and tell the listeners. */
    #list(instance: Instance, client: McpClient, server: McpServerInfo): Promise<Tool[]> {
        instance.listing ??= client
            .listTools({ timeoutMs: server.timeout * 1000 })
            .then((tools) => {
                if (instance.client === client) {
                    instance.tools = tools;
                }

                for (const listener of [...this.#listeners]) {
                    listener(instance.server, tools);
                }

                return tools;
            })
            .finally(() => {
                instance.listing = undefined;
            });

        return instance.listing;
    }

    /**
     * Where a session in `cwd` runs the server, or why it may not use it: the machine (`undefined` for the phone) and the
     * folder the program starts in.
     */
    place(name: string, cwd: string): { server: McpServerInfo; machineId: string | undefined; folder: string } {
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

        // An HTTP server: one instance, reached from the phone or through its machine (PP-529).
        if (server.kind === "http") {
            return { server, machineId: server.runs.where === "machine" ? server.runs.machineId : undefined, folder: "" };
        }

        const here = parsePlace(cwd);
        const machineId = server.runs.where === "session" ? here.machineId : server.runs.where === "machine" ? server.runs.machineId : undefined;
        const sameComputer = here.machineId === machineId;
        const where = this.#host.where(machineId);
        const folder = server.cwd === undefined ? (sameComputer ? here.path : where.home) : expandHome(server.cwd, where.home);

        return { server, machineId, folder };
    }

    #instance(name: string, cwd: string): { instance: Instance; server: McpServerInfo } {
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
    async tools(name: string, cwd: string, options: McpStartOptions = {}): Promise<Tool[]> {
        const { instance, server } = this.#instance(name, cwd);

        instance.inFlight += 1;

        try {
            const client = await this.#client(instance, server, cwd, options);

            return instance.tools ?? (await this.#list(instance, client, server));
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
        options: McpStartOptions & { onProgress?: (progress: ProgressNotification) => void } = {},
    ): Promise<CallToolResult> {
        const { instance, server } = this.#instance(name, cwd);

        instance.inFlight += 1;

        const cap = new AbortController();
        const capTimer = setTimeout(() => cap.abort(new McpTimeoutError(MAX_CALL_MS)), MAX_CALL_MS);
        const signal = options.signal === undefined ? cap.signal : AbortSignal.any([options.signal, cap.signal]);

        const send = async () => {
            const client = await this.#client(instance, server, cwd, options);

            instance.calls += 1;

            return await client.callTool(tool, args, {
                timeoutMs: server.timeout * 1000,
                signal,
                ...(options.onProgress === undefined ? {} : { onProgress: options.onProgress }),
            });
        };

        try {
            try {
                return await send();
            } catch (error) {
                // An HTTP server that forgot its session refused the call unread (404): a new session, and the call once more.
                if (!(error instanceof McpSessionExpiredError)) {
                    throw error;
                }

                this.#host.log(`mcp: ${name}'s session expired: a new one, and ${tool} sent again once`);
                await this.#close(instance, false);

                return await send();
            }
        } catch (error) {
            if (error instanceof McpSessionExpiredError) {
                throw new Error(`The MCP server ${name} forgot its session twice: ${tool} was not run. Reconnect it (Settings › MCP servers).`);
            }

            // Its token was refused and could not be refreshed: the request was not sent.
            if (error instanceof McpOAuthAuthorizationRequiredError || error instanceof McpAuthRequiredError) {
                throw new Error(`${signInWords(name, server)} ${tool} was not run.`);
            }

            // Its status only: an error page's body is the server's text.
            if (error instanceof McpHttpError) {
                throw new Error(`The MCP server ${name} answered HTTP ${error.status} to ${tool}: the tool may have run. The call is not sent again.`);
            }

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

    async #client(instance: Instance, server: McpServerInfo, cwd: string, options: McpStartOptions): Promise<McpClient> {
        const signal = options.signal;

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
                instance.starting = this.#start(instance, server, cwd, options).finally(() => {
                    instance.starting = undefined;
                });
            }
        }

        return instance.client?.connectionState === "connected" ? instance.client : await instance.starting!;
    }

    async #start(instance: Instance, server: McpServerInfo, cwd: string, options: McpStartOptions): Promise<McpClient> {
        const values = await this.#secretValues(server, cwd, options);

        await this.#makeRoom(instance);

        const startTimeout = server.kind === "stdio" ? server.startTimeout : DEFAULT_START_TIMEOUT;
        // An HTTP server's connect is tried again on a network error, a timeout or a 408, 429 or 5xx; never a call.
        const tries = server.kind === "http" ? HTTP_CONNECT_RETRY_MS.length + 1 : 1;
        let failure: unknown;

        for (let attempt = 1; attempt <= tries; attempt++) {
            const transport = server.kind === "stdio" ? this.#pipe(instance, server, values) : await this.#http(instance, server, values);
            const client = new McpClient({ name: "pi-phone", version: "1", requestTimeoutMs: startTimeout * 1000 });

            instance.closing = false;
            instance.tools = undefined;
            instance.transport = transport;

            let timer: NodeJS.Timeout | undefined;

            try {
                await Promise.race([
                    client.connect(transport),
                    new Promise((_resolve, reject) => {
                        timer = setTimeout(() => reject(new Error(`it did not start in ${startTimeout} s`)), startTimeout * 1000);
                    }),
                ]);

                return this.#ready(instance, server, client, transport);
            } catch (error) {
                failure = error;
                instance.stderr = stderrOf(transport);
                await client.close().catch(() => undefined);
                await transport.close().catch(() => undefined);
                instance.release?.();
                instance.release = undefined;

                if (attempt === tries || !retryable(error)) {
                    break;
                }

                this.#host.log(`mcp: ${instance.server} did not connect (${message(error)}): trying again`);
                await sleep(HTTP_CONNECT_RETRY_MS[attempt - 1]!, options.signal);
            } finally {
                clearTimeout(timer);
            }
        }

        // A server that wants the owner to sign in is not dying: it waits for the sign-in (PP-530).
        if (failure instanceof McpOAuthAuthorizationRequiredError || failure instanceof McpAuthRequiredError) {
            throw new Error(signInWords(instance.server, server));
        }

        this.#died(instance, `it did not start: ${message(failure)}`);

        throw new Error(`The MCP server ${instance.server} did not start: ${message(failure)}`);
    }

    /** A stdio server's program, started by the daemon where it runs, with its environment. */
    #pipe(instance: Instance, server: McpStdioServer, values: Record<string, string>): PipeTransport {
        const where = this.#host.where(instance.machineId);
        const env = {
            ...(where.path === undefined ? {} : { PATH: where.path }),
            ...where.sessionEnv,
            ...Object.fromEntries(Object.entries(server.env).map(([key, value]) => [key, expandHome(fillPlaceholders(value, values), where.home)])),
        };
        const argv = launchArgv([expandHome(server.command, where.home), ...server.args.map((arg) => expandHome(arg, where.home))], where);

        return new PipeTransport({
            open: async (handlers) => {
                const program = await openProcess(where.connection, { cwd: instance.folder, argv, env, onStdout: handlers.onStdout, onStderr: handlers.onStderr });

                instance.pid = program.pid;

                return program;
            },
        });
    }

    /**
     * An HTTP server's transport, its headers' secrets filled in. Reached through a machine, its URL's host and port are
     * forwarded to the phone first, over the app's ssh, for as long as the instance runs.
     */
    async #http(instance: Instance, server: McpHttpServer, values: Record<string, string>): Promise<StreamableHttpTransport> {
        const url = new URL(server.url);

        if (server.runs.where === "machine") {
            if (this.#host.forward === undefined) {
                throw new Error(`The MCP server ${server.name} is reached through a machine, and no forward can be opened here.`);
            }

            const port = url.port === "" ? (url.protocol === "https:" ? 443 : 80) : Number(url.port);
            const forward = await this.#host.forward(server.runs.machineId, url.hostname, port);

            instance.release = forward.close;
            url.hostname = "127.0.0.1";
            url.port = String(forward.port);
        }

        return new StreamableHttpTransport({
            url,
            headers: Object.fromEntries(Object.entries(server.headers).map(([key, value]) => [key, fillPlaceholders(value, values)])),
            ...(this.#host.authProvider === undefined || server.oauth === undefined ? {} : { authProvider: this.#host.authProvider(server) }),
        });
    }

    /** A connected client: kept, heard when it closes or its tools change, and its tools listed. */
    #ready(instance: Instance, server: McpServerInfo, client: McpClient, transport: McpTransport): McpClient {
        instance.client = client;
        instance.startedAt = this.#now();
        const listed = (error: unknown) => this.#host.log(`mcp: listing ${instance.server}'s tools failed: ${message(error)}`);

        client.onNotification("notifications/tools/list_changed", () => {
            instance.tools = undefined;
            void this.#list(instance, client, server).catch(listed);
        });
        client.onClose(() => {
            instance.stderr = stderrOf(transport);

            if (instance.client !== client) {
                return;
            }

            instance.client = undefined;
            instance.transport = undefined;
            instance.release?.();
            instance.release = undefined;
            clearTimeout(instance.idle);

            if (!instance.closing) {
                this.#died(instance, "it stopped by itself.");
            }
        });
        this.#host.log(
            server.kind === "http"
                ? `mcp: ${instance.server} connected over HTTP${instance.machineId === undefined ? "" : ` through machine ${instance.machineId}`}`
                : `mcp: ${instance.server} started (pid ${instance.pid ?? "?"}) ${instance.machineId === undefined ? "on the phone" : `on machine ${instance.machineId}`} in ${instance.folder}`,
        );
        // Its tools, for the cache that offers them (`tools.ts`), from its first start on.
        void this.#list(instance, client, server).catch(listed);

        return client;
    }

    /** The values of the secrets the entry names (its env or headers), where the session may use them; asked for when set to ask. */
    async #secretValues(server: McpServerInfo, cwd: string, options: McpStartOptions): Promise<Record<string, string>> {
        const names = secretNames(server);
        const refused = names.filter((name) => this.#host.secrets.get(name) === undefined || this.#host.secrets.environment([name], cwd)[name] === undefined);

        if (refused.length > 0) {
            throw new Error(`The MCP server ${server.name} needs the secret${refused.length === 1 ? "" : "s"} ${refused.join(", ")}, which ${refused.length === 1 ? "is" : "are"} not set or may not be used in this folder (Settings › Secrets).`);
        }

        // A secret that asks first is asked for as the server starts, on a card in the session that starts it.
        const asking = names.filter((name) => this.#host.secrets.get(name)!.ask);

        if (asking.length > 0) {
            if (options.askSecrets === undefined) {
                throw new Error(`The MCP server ${server.name} needs ${asking.join(", ")}, which ${asking.length === 1 ? "asks" : "ask"} before each use, and nobody can be asked here.`);
            }

            if (!(await options.askSecrets(asking))) {
                throw new Error(`The MCP server ${server.name} did not start: its use of ${asking.map((name) => `$${name}`).join(", ")} was not allowed.`);
            }
        }

        const values = this.#host.secrets.environment(names, cwd);

        this.#host.secrets.used(names);

        return values;
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
        instance.release?.();
        instance.release = undefined;

        if (transport !== undefined) {
            instance.stderr = stderrOf(transport);
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
            stderr: each.transport === undefined ? each.stderr : stderrOf(each.transport),
        }));
    }

    async close(): Promise<void> {
        this.#unsubscribe();
        await Promise.all([...this.#instances.values()].map((each) => this.#close(each, true)));
    }
}
