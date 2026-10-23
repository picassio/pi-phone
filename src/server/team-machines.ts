/**
 * The team's machines in a person's pi-phone (PP-82, wiki: pi-phone-team-machines): the ones their role lets them use,
 * from the team server, each a machine of `Machines` (`team-<id>`) that every machine feature reaches as it reaches the
 * person's own, through `ssh -F` the app's config. Two sockets here stand in for what a machine of their own has in the
 * pi-phone, so the team's key never comes here:
 *
 * - the relay (`team-relay.sock`), which ssh's `ProxyCommand` (`bin/pi-team-relay`) connects to: it opens the connection
 *   to the machine through the gateway (`/internal/team-machines/<id>/connect`) and pipes it;
 * - the agent (`team-agent.sock`), ssh's `IdentityAgent` for team machines: it holds no key, lists each machine's public
 *   half, and has the gateway sign the sign-in (`sign`), which checks the person's role each time.
 *
 * The pi-phone's token stays in its server: whatever runs ssh (Pi's bash with `pi-ssh` too) reaches the machines it may,
 * never the token.
 */
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { createServer, type Server, type Socket } from "node:net";
import { rmSync } from "node:fs";
import { join } from "node:path";
import type { RemotePlatform } from "@earendil-works/pi-env";
import { HttpError } from "./errors.ts";

/** The relay's and the agent's sockets, in the app's `ssh` folder. */
export const TEAM_RELAY = "team-relay.sock";
export const TEAM_AGENT = "team-agent.sock";

/** A team machine as the team server lists it for this person (never its key). */
export type TeamMachineEntry = {
    id: string;
    name: string;
    host: string;
    user: string;
    port?: number;
    createdAt: number;
    createdBy: string;
    hostKey?: string;
    knownHosts?: string[];
    remote?: Pick<RemotePlatform, "platform" | "arch" | "home">;
    daemon?: string;
    connectedAt?: number;
    /** Its key's public half, as `authorized_keys` takes it. */
    publicKey: string;
    /** Whether this person's role lists it (someone who manages machines sees them all). */
    usable: boolean;
    /** The roles that list it, by name. */
    roles: string[];
    /** Where this person starts there, from the machine's home: `team/<name>`. */
    folder: string;
};

// ssh-agent's messages (draft-miller-ssh-agent): the two a client needs, and a failure for the rest.
const AGENT_FAILURE = 5;
const REQUEST_IDENTITIES = 11;
const IDENTITIES_ANSWER = 12;
const SIGN_REQUEST = 13;
const SIGN_RESPONSE = 14;

function sshString(value: Buffer | string): Buffer {
    const bytes = typeof value === "string" ? Buffer.from(value) : value;
    const length = Buffer.alloc(4);

    length.writeUInt32BE(bytes.length);

    return Buffer.concat([length, bytes]);
}

function frame(...parts: Buffer[]): Buffer {
    const body = Buffer.concat(parts);
    const length = Buffer.alloc(4);

    length.writeUInt32BE(body.length);

    return Buffer.concat([length, body]);
}

export class TeamMachinesClient {
    readonly #server: { url: string; token: string } | undefined;
    readonly #relaySocket: string;
    readonly #agentSocket: string;
    readonly #log: (line: string) => void;
    /** Told the machines after each sync: `Machines.setTeam`. */
    readonly #apply: (entries: TeamMachineEntry[], manage: boolean) => void;
    #entries: TeamMachineEntry[] = [];
    #servers: Server[] = [];
    /** Whether this person manages the team's machines (machines.manage), as last synced. */
    manage = false;

    constructor(
        server: { url: string; token: string } | undefined,
        sshDir: string,
        log: (line: string) => void,
        apply: (entries: TeamMachineEntry[], manage: boolean) => void,
    ) {
        this.#server = server;
        this.#relaySocket = join(sshDir, TEAM_RELAY);
        this.#agentSocket = join(sshDir, TEAM_AGENT);
        this.#log = log;
        this.#apply = apply;
    }

    /** Whether this pi-phone is a team server's (only then are there team machines). */
    get available(): boolean {
        return this.#server !== undefined;
    }

    get relaySocket(): string {
        return this.#relaySocket;
    }

    get agentSocket(): string {
        return this.#agentSocket;
    }

    /** One call to the team server's team machines, as this pi-phone's person; its refusal as an HttpError. */
    async call<T>(body: Record<string, unknown>): Promise<T> {
        const server = this.#server;

        if (server === undefined) {
            throw new HttpError(404, "Team machines are on a team server only.");
        }

        const response = await fetch(`${server.url}/internal/team-machines`, {
            method: "POST",
            headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" },
            body: JSON.stringify(body),
        });
        const answer = (await response.json().catch(() => ({}))) as { value?: T; error?: string };

        if (!response.ok) {
            throw new HttpError(response.status, answer.error ?? `The team server answered ${response.status}.`);
        }

        return answer.value as T;
    }

    /** The machines this person may use (all, for someone who manages them), from the team server, into `Machines`. */
    async sync(): Promise<TeamMachineEntry[]> {
        if (this.#server === undefined) {
            return [];
        }

        const listed = await this.call<{ manage: boolean; machines: TeamMachineEntry[] }>({ action: "list" });

        this.#entries = listed.machines;
        this.manage = listed.manage;
        this.#apply(listed.machines, listed.manage);

        return listed.machines;
    }

    list(): TeamMachineEntry[] {
        return this.#entries;
    }

    /** The relay and the agent, listening (on a team server only). */
    async start(): Promise<void> {
        if (this.#server === undefined || this.#servers.length > 0) {
            return;
        }

        for (const [path, handle] of [
            [this.#relaySocket, (socket: Socket) => this.#relay(socket)],
            [this.#agentSocket, (socket: Socket) => this.#agent(socket)],
        ] as const) {
            rmSync(path, { force: true });

            const server = createServer(handle);

            await new Promise<void>((resolve, reject) => {
                server.once("error", reject);
                server.listen(path, () => resolve());
            });
            this.#servers.push(server);
        }
    }

    async close(): Promise<void> {
        await Promise.all(this.#servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
        this.#servers = [];
    }

    /**
     * One connection from `pi-team-relay`: it says the machine (`<id>\n`), and hears `OK\n` then the machine's bytes, or
     * `ERR <reason>\n` (the gateway's refusal, which ssh shows).
     */
    #relay(socket: Socket): void {
        const server = this.#server!;
        let asked = Buffer.alloc(0);

        socket.on("error", () => socket.destroy());

        const onData = (chunk: Buffer) => {
            asked = Buffer.concat([asked, chunk]);

            const end = asked.indexOf(10);

            if (end < 0) {
                if (asked.length > 64) {
                    socket.end("ERR Not a team machine.\n");
                }

                return;
            }

            socket.off("data", onData);
            socket.pause();

            const id = asked.subarray(0, end).toString().trim();
            const rest = asked.subarray(end + 1);

            if (!/^[a-z0-9]{12}$/.test(id)) {
                socket.end("ERR Not a team machine.\n");

                return;
            }

            const url = new URL(`${server.url}/internal/team-machines/${id}/connect`);
            const request = (url.protocol === "https:" ? httpsRequest : httpRequest)(url, {
                method: "GET",
                headers: { authorization: `Bearer ${server.token}`, connection: "Upgrade", upgrade: "pi-team-tcp" },
            });

            request.on("upgrade", (_response, upstream, head) => {
                socket.write("OK\n");

                if (head.length > 0) {
                    socket.write(head);
                }

                if (rest.length > 0) {
                    upstream.write(rest);
                }

                upstream.on("error", () => socket.destroy());
                upstream.on("close", () => socket.destroy());
                socket.on("close", () => upstream.destroy());
                socket.pipe(upstream);
                upstream.pipe(socket);
                socket.resume();
            });
            request.on("response", (response) => {
                let said = "";

                response.setEncoding("utf8");
                response.on("data", (text: string) => (said += text));
                response.on("end", () => socket.end(`ERR ${said.replace(/\s+/g, " ").trim() || `The team server answered ${response.statusCode}.`}\n`));
            });
            request.on("error", (error) => socket.end(`ERR Could not reach the team server: ${error.message}\n`));
            request.end();
        };

        socket.on("data", onData);
    }

    /** One ssh client of the agent: its requests, answered one after another. */
    #agent(socket: Socket): void {
        let buffer = Buffer.alloc(0);
        let queue = Promise.resolve();

        socket.on("error", () => socket.destroy());
        socket.on("data", (chunk: Buffer) => {
            buffer = Buffer.concat([buffer, chunk]);

            while (buffer.length >= 4 && buffer.length >= 4 + buffer.readUInt32BE(0)) {
                const message = buffer.subarray(4, 4 + buffer.readUInt32BE(0));

                buffer = buffer.subarray(4 + message.length);
                queue = queue.then(async () => {
                    const answer = await this.#answer(message).catch((error: unknown) => {
                        this.#log(`team machines agent: ${error instanceof Error ? error.message : String(error)}`);

                        return frame(Buffer.from([AGENT_FAILURE]));
                    });

                    if (!socket.destroyed) {
                        socket.write(answer);
                    }
                });
            }
        });
    }

    /** The public halves of the machines this person may reach, as SSH blobs, by machine id. */
    #blobs(): Map<string, Buffer> {
        const blobs = new Map<string, Buffer>();

        for (const entry of this.#entries) {
            const base64 = entry.publicKey.split(" ")[1];

            if (base64 !== undefined) {
                blobs.set(entry.id, Buffer.from(base64, "base64"));
            }
        }

        return blobs;
    }

    async #answer(message: Buffer): Promise<Buffer> {
        const type = message[0];

        if (type === REQUEST_IDENTITIES) {
            const blobs = [...this.#blobs()];
            const count = Buffer.alloc(4);

            count.writeUInt32BE(blobs.length);

            return frame(Buffer.from([IDENTITIES_ANSWER]), count, ...blobs.flatMap(([id, blob]) => [sshString(blob), sshString(`pi-phone team ${id}`)]));
        }

        if (type === SIGN_REQUEST) {
            let at = 1;
            const field = () => {
                const length = message.readUInt32BE(at);
                const value = message.subarray(at + 4, at + 4 + length);

                at += 4 + length;

                return value;
            };
            const blob = field();
            const data = field();
            const id = [...this.#blobs()].find(([, each]) => each.equals(blob))?.[0];

            if (id === undefined) {
                return frame(Buffer.from([AGENT_FAILURE]));
            }

            const signed = await this.call<{ signature: string }>({ action: "sign", id, data: data.toString("base64") });

            return frame(Buffer.from([SIGN_RESPONSE]), sshString(Buffer.from(signed.signature, "base64")));
        }

        return frame(Buffer.from([AGENT_FAILURE]));
    }
}

/** `pi-team-relay`, ssh's `ProxyCommand` for a team machine: the relay's socket, then the machine's bytes both ways. */
export function relayScript(node: string): string {
    return `#!${node}
// pi-phone: a team machine's connection, through the app's relay (team-machines.ts). Arguments: the socket, the machine.
"use strict";
const net = require("node:net");
const [socketPath, id] = process.argv.slice(2);
const relay = net.connect(socketPath, () => relay.write(id + "\\n"));
let head = Buffer.alloc(0);
const onData = (chunk) => {
    head = Buffer.concat([head, chunk]);
    const end = head.indexOf(10);
    if (end < 0) return;
    relay.off("data", onData);
    const line = head.subarray(0, end).toString();
    const rest = head.subarray(end + 1);
    if (line !== "OK") {
        process.stderr.write(line.replace(/^ERR /, "") + "\\n");
        process.exit(1);
    }
    if (rest.length > 0) process.stdout.write(rest);
    relay.pipe(process.stdout);
    process.stdin.pipe(relay);
};
relay.on("data", onData);
relay.on("error", (error) => {
    process.stderr.write("pi-phone: the team machine relay: " + error.message + "\\n");
    process.exit(1);
});
relay.on("close", () => process.exit(0));
`;
}
