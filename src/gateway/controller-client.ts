/** The gateway's side of the controller (`src/controller/main.ts`): its Unix socket, with the shared secret. */
import { request as httpRequest } from "node:http";
import type { ControllerClient } from "./server.ts";

export class SocketController implements ControllerClient {
    readonly #socket: string;
    readonly #secret: string;

    constructor(socket: string, secret: string) {
        this.#socket = socket;
        this.#secret = secret;
    }

    async #call(method: string, path: string, body?: unknown): Promise<unknown> {
        return new Promise((resolve, reject) => {
            const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
            const sent = httpRequest(
                {
                    socketPath: this.#socket,
                    method,
                    path,
                    headers: { host: "controller", "x-controller-secret": this.#secret, ...(payload === undefined ? {} : { "content-type": "application/json", "content-length": payload.length }) },
                    timeout: 120_000,
                },
                (response) => {
                    const chunks: Buffer[] = [];

                    response.on("data", (chunk: Buffer) => chunks.push(chunk));
                    response.on("end", () => {
                        const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as { error?: string };

                        if ((response.statusCode ?? 500) >= 400) {
                            reject(new Error(`controller: ${parsed.error ?? response.statusCode}`));
                        } else {
                            resolve(parsed);
                        }
                    });
                },
            );

            sent.on("error", reject);
            sent.on("timeout", () => sent.destroy(new Error("controller: no answer in time")));
            sent.end(payload);
        });
    }

    async ensure(key: string, token: string, caps: { memoryMb: number; cpus: number }): Promise<{ host: string; port: number }> {
        return (await this.#call("POST", `/people/${key}/ensure`, { token, caps })) as { host: string; port: number };
    }

    async stop(key: string): Promise<void> {
        await this.#call("POST", `/people/${key}/stop`, {});
    }

    async remove(key: string, purge: boolean): Promise<void> {
        await this.#call("POST", `/people/${key}/remove`, { purge });
    }
}
