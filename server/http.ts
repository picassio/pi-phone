// Plain HTTP next to the WebSocket: health for the app's foreground service, shutdown for the Diagnostics sheet.
// Images and files are added here later (DESIGN.md section 5).
import type { IncomingMessage, ServerResponse } from "node:http";
import { presentedToken } from "./ws-listener.ts";
import { tokenMatches } from "./token.ts";

export interface HttpHandlerOptions {
	readonly token: string;
	readonly serverId: string;
	readonly startedAt: number;
	workerPids(): Readonly<Record<string, number>>;
	shutdown(): void;
}

function json(response: ServerResponse, status: number, body: unknown): void {
	const text = JSON.stringify(body);
	response.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
	response.end(text);
}

export function createHttpHandler(options: HttpHandlerOptions) {
	return (request: IncomingMessage, response: ServerResponse): void => {
		const url = new URL(request.url ?? "/", "http://localhost");
		if (!tokenMatches(options.token, presentedToken(request))) {
			json(response, 401, { error: "unauthorized" });
			return;
		}
		if (request.method === "GET" && url.pathname === "/health") {
			json(response, 200, {
				serverId: options.serverId,
				uptimeMs: Date.now() - options.startedAt,
				workerPids: options.workerPids(),
			});
			return;
		}
		if (request.method === "POST" && url.pathname === "/admin/shutdown") {
			json(response, 202, { ok: true });
			options.shutdown();
			return;
		}
		json(response, 404, { error: "not found" });
	};
}
