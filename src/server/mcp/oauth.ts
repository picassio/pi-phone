/**
 * OAuth for MCP servers over HTTP (PP-530; the owner's choice: in v1), with pi-mcp's sign-in, after pocket-mcp's
 * oauth.ts (MIT): the owner signs in in a browser; the redirect comes back to a loopback callback on the phone (the
 * phone's own browser reaches it), or the owner pastes the address the browser ended on (a browser elsewhere). The
 * tokens, the registered client and the sign-in's state are kept like secrets: in `<data>/mcp/oauth.json`, mode 0600,
 * out of Pi's tools (`keyStoreRefusal`), never shown, and hidden from every output (`HiddenValues`). The connection's
 * auth provider sends the access token and refreshes it (once for many requests; a refresh token a server rotates is
 * saved before it is used again); when the owner must sign in again it says so, and no call runs.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AuthProvider } from "@earendil-works/pi-mcp";
import {
    completeMcpSignIn,
    createMcpAuthProvider,
    listenForLoopbackSignIn,
    type McpOAuthServerStore,
    type McpOAuthSettings,
    type McpOAuthState,
    type McpSignInRedirect,
    type OAuthCallbackServer,
    type OAuthChallenge,
    responseFromRedirectUrl,
    startMcpSignIn,
} from "@earendil-works/pi-mcp/oauth";
import type { HiddenValues } from "../hidden.ts";
import { fillPlaceholders, MCP_FOLDER, type McpHttpServer, type McpServers, secretsIn } from "./config.ts";

const FILE = "oauth.json";
/** How long a sign-in waits for the browser's redirect. */
export const SIGN_IN_MS = 10 * 60_000;
export const CLIENT_NAME = "pi-phone";

type Stored = Record<string, McpOAuthState>;

/** A sign-in waiting for the browser: its authorization URL, and how it ends. */
type Pending = { authorization: McpSignInRedirect; callback: OAuthCallbackServer; settings: McpOAuthSettings; done: Promise<void>; timer: NodeJS.Timeout };

export type McpOAuthHost = {
    dataDir: string;
    servers: McpServers;
    hidden: HiddenValues;
    /** The values of the secrets an entry's oauth names (a client secret), for the app's own requests. */
    secret: (name: string) => string | undefined;
    /** A sign-in ended (signed in, or failed): the owner's tabs read the servers again. */
    changed: () => void;
    log: (line: string) => void;
};

export class McpOAuth {
    readonly #file: string;
    readonly #host: McpOAuthHost;
    #stored: Stored = {};
    /** One refresh at a time per server, in this process (the only one using the file). */
    readonly #locks = new Map<string, Promise<unknown>>();
    readonly #pending = new Map<string, Pending>();
    readonly #challenges = new Map<string, OAuthChallenge>();
    readonly #unhide = new Map<string, (() => void)[]>();

    constructor(host: McpOAuthHost) {
        this.#host = host;
        this.#file = join(host.dataDir, MCP_FOLDER, FILE);

        if (existsSync(this.#file)) {
            try {
                this.#stored = JSON.parse(readFileSync(this.#file, "utf8")) as Stored;
            } catch {
                // Not the parser's message: it can quote a token.
                host.log(`mcp: ${this.#file} is not valid JSON: the MCP servers that sign in sign in again`);
            }
        }

        for (const [name, state] of Object.entries(this.#stored)) {
            this.#hide(name, state);
        }
    }

    /** Whether the server has tokens (it may still need a sign-in again if the server refuses them). */
    signedIn(name: string): boolean {
        return this.#stored[name]?.tokens !== undefined;
    }

    /** A sign-in waiting for its redirect: the URL to open. */
    waiting(name: string): string | undefined {
        return this.#pending.get(name)?.authorization.authorizationUrl;
    }

    /** The client settings of an entry's `oauth`, its `${NAME}`s filled in. */
    settings(server: McpHttpServer): McpOAuthSettings {
        const oauth = server.oauth ?? {};
        const values = Object.fromEntries(secretsIn(oauth.clientSecret ?? "", `server "${server.name}": oauth.clientSecret`).flatMap((name) => {
            const value = this.#host.secret(name);

            if (value === undefined) {
                throw new Error(`The MCP server ${server.name}'s client secret names ${name}, which is not set (Settings › Secrets).`);
            }

            return [[name, value] as const];
        }));

        return {
            ...(oauth.clientId === undefined ? {} : { clientId: oauth.clientId }),
            ...(oauth.clientSecret === undefined ? {} : { clientSecret: fillPlaceholders(oauth.clientSecret, values) }),
            ...(oauth.callbackPort === undefined ? {} : { callbackPort: oauth.callbackPort }),
            ...(oauth.callbackUrl === undefined ? {} : { callbackUrl: oauth.callbackUrl }),
            ...(oauth.scope === undefined ? {} : { scope: oauth.scope }),
            ...(oauth.clientName === undefined ? {} : { clientName: oauth.clientName }),
            ...(oauth.clientRegistration === undefined ? {} : { clientRegistration: oauth.clientRegistration }),
            ...(oauth.authServerMetadataUrl === undefined ? {} : { authServerMetadataUrl: new URL(oauth.authServerMetadataUrl) }),
        };
    }

    /** The server's state store, with its refresh lock. */
    store(name: string): McpOAuthServerStore {
        return {
            load: () => this.#stored[name],
            save: (state) => this.#save(name, state),
            withRefreshLock: async <T>(fn: () => Promise<T>): Promise<T> => {
                const before = this.#locks.get(name) ?? Promise.resolve();
                const run = before.then(fn, fn);

                this.#locks.set(
                    name,
                    run.catch(() => undefined),
                );

                return run;
            },
        };
    }

    /** The auth provider of a connection to the server: the stored token, refreshed; a sign-in it never starts. */
    authProvider(server: McpHttpServer): AuthProvider {
        return createMcpAuthProvider({
            serverUrl: server.url,
            store: this.store(server.name),
            settings: () => this.settings(server),
            clientName: CLIENT_NAME,
            onChallenge: (challenge) => this.#challenges.set(server.name, challenge),
        });
    }

    /**
     * Start the owner's sign-in: refreshed at once when the stored tokens allow (`authorized`), or the authorization URL
     * to open, while a loopback callback on the phone waits for the browser's redirect (10 minutes).
     */
    async start(name: string): Promise<{ kind: "authorized" } | { kind: "redirect"; authorizationUrl: string }> {
        const server = this.#http(name);
        const settings = this.settings(server);

        await this.cancel(name);

        const store = this.store(name);
        const loopback = await listenForLoopbackSignIn({ serverUrl: server.url, store, settings });
        const challenge = this.#challenges.get(name);
        const options = { serverUrl: server.url, store, settings, clientName: CLIENT_NAME, redirectUrl: loopback.redirectUrl, ...(challenge === undefined ? {} : { challenge }) };
        let started;

        try {
            started = await startMcpSignIn(options);
        } catch (error) {
            await loopback.callback.close();

            throw error;
        }

        if (started.kind === "authorized") {
            await loopback.callback.close();
            this.#host.changed();

            return started;
        }

        const authorization = started;
        const finish = async (response: Awaited<ReturnType<OAuthCallbackServer["waitForCallback"]>>) => {
            await completeMcpSignIn({ ...options, authorization, response });
            this.#host.log(`mcp: signed in to ${name}`);
        };
        const pending: Pending = {
            authorization,
            callback: loopback.callback,
            settings,
            done: loopback.callback
                .waitForCallback(authorization.state, new URL(authorization.redirectUrl).pathname)
                .then(finish)
                .catch((error: unknown) => this.#host.log(`mcp: the sign-in to ${name} ended: ${error instanceof Error ? error.message : String(error)}`))
                .finally(() => this.#end(name, pending)),
            timer: setTimeout(() => void this.cancel(name), SIGN_IN_MS),
        };

        pending.timer.unref();
        this.#pending.set(name, pending);

        return { kind: "redirect", authorizationUrl: authorization.authorizationUrl };
    }

    /** The address the browser ended on, pasted by the owner: the sign-in completed with its code. */
    async complete(name: string, pasted: unknown): Promise<void> {
        const pending = this.#pending.get(name);

        if (pending === undefined) {
            throw new Error(`No sign-in to ${name} is waiting: start one first.`);
        }

        if (typeof pasted !== "string" || pasted.trim() === "") {
            throw new Error("Paste the whole address the browser ended on.");
        }

        const server = this.#http(name);
        const response = responseFromRedirectUrl(pasted.trim(), pending.authorization);

        await completeMcpSignIn({
            serverUrl: server.url,
            store: this.store(name),
            settings: pending.settings,
            clientName: CLIENT_NAME,
            redirectUrl: pending.authorization.redirectUrl,
            authorization: pending.authorization,
            response,
        });
        this.#host.log(`mcp: signed in to ${name} with a pasted address`);
        await this.#end(name, pending);
    }

    /** Wait for a sign-in started here to end (tests, and Test connection after a sign-in). */
    async settled(name: string): Promise<void> {
        await this.#pending.get(name)?.done;
    }

    async cancel(name: string): Promise<void> {
        const pending = this.#pending.get(name);

        if (pending !== undefined) {
            await this.#end(name, pending);
        }
    }

    /** Forget the server's tokens and client: it signs in again next time. */
    signOut(name: string): void {
        const { [name]: _gone, ...rest } = this.#stored;

        this.#write(rest);
        this.#hide(name, undefined);
        this.#host.changed();
    }

    async close(): Promise<void> {
        await Promise.all([...this.#pending.keys()].map((name) => this.cancel(name)));
    }

    async #end(name: string, pending: Pending): Promise<void> {
        clearTimeout(pending.timer);

        if (this.#pending.get(name) === pending) {
            this.#pending.delete(name);
        }

        await pending.callback.close().catch(() => undefined);
        this.#host.changed();
    }

    #http(name: string): McpHttpServer {
        const server = this.#host.servers.get(name);

        if (server === undefined || server.kind !== "http") {
            throw new Error(`There is no MCP server ${name} over HTTP.`);
        }

        if (server.oauth === undefined) {
            throw new Error(`The MCP server ${name} has no oauth in its entry: it signs in with a header, if any.`);
        }

        return server;
    }

    #save(name: string, state: McpOAuthState): void {
        this.#write({ ...this.#stored, [name]: state });
        this.#hide(name, state);
    }

    /** Its tokens hidden from every output, as the secrets are. */
    #hide(name: string, state: McpOAuthState | undefined): void {
        for (const unhide of this.#unhide.get(name) ?? []) {
            unhide();
        }

        const values = [state?.tokens?.access_token, state?.tokens?.refresh_token, state?.clientInformation !== undefined && "client_secret" in state.clientInformation ? state.clientInformation.client_secret : undefined];

        this.#unhide.set(
            name,
            values.filter((value): value is string => typeof value === "string" && value.length >= 8 && value.length <= 4096).map((value) => this.#host.hidden.add({ value, label: `mcp oauth ${name}` })),
        );
    }

    #write(next: Stored): void {
        mkdirSync(join(this.#file, ".."), { recursive: true, mode: 0o700 });
        writeFileSync(`${this.#file}.tmp`, JSON.stringify(next), { mode: 0o600 });
        chmodSync(`${this.#file}.tmp`, 0o600);
        renameSync(`${this.#file}.tmp`, this.#file);
        this.#stored = next;
    }
}
