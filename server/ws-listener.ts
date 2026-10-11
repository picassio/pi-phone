// WebSocket transport for pi-server: each accepted socket is one ordered byte connection handed to
// `Server.accept()`. One pi-protocol frame per binary message; text messages are a protocol error. The upgrade
// request must carry the token (`?token=` or `Authorization: Bearer`).
import type { IncomingMessage, Server as HttpServer } from "node:http";
import type { Duplex } from "node:stream";
import type { ByteConnection, ByteConnectionHandler, Server } from "@earendil-works/pi-server";
import { WebSocket, WebSocketServer } from "ws";
import { tokenMatches } from "./token.ts";

export const WS_PATH = "/pi";
const PROTOCOL_ERROR_CLOSE_CODE = 4000;
const TRANSPORT_ERROR_CLOSE_CODE = 4001;

class WebSocketByteConnection implements ByteConnection {
	readonly #socket: WebSocket;
	#closed = false;

	constructor(socket: WebSocket) {
		this.#socket = socket;
	}

	get closed(): boolean {
		return this.#closed;
	}

	send(chunk: Uint8Array): Promise<void> {
		if (this.#closed) return Promise.reject(new Error("WebSocket connection is closed"));
		return new Promise((resolve, reject) => {
			this.#socket.send(chunk, { binary: true }, (error) => (error ? reject(error) : resolve()));
		});
	}

	async close(finalChunk?: Uint8Array): Promise<void> {
		if (this.#closed) return;
		if (finalChunk !== undefined) await this.send(finalChunk);
		this.#closed = true;
		this.#socket.close(1000, "pi server closed");
	}

	markClosed(): void {
		this.#closed = true;
	}
}

export function presentedToken(request: IncomingMessage): string | null {
	const url = new URL(request.url ?? "/", "http://localhost");
	const query = url.searchParams.get("token");
	if (query !== null) return query;
	const header = request.headers.authorization;
	if (header?.startsWith("Bearer ")) return header.slice("Bearer ".length);
	return null;
}

/** Attach the WebSocket upgrade handling to an HTTP server and route accepted sockets into the pi server. */
export function attachWebSocketListener(http: HttpServer, server: Server, token: string): () => Promise<void> {
	const wss = new WebSocketServer({ noServer: true });
	const connections = new Set<WebSocket>();

	const reject = (socket: Duplex, status: number, reason: string): void => {
		socket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\n\r\n`);
		socket.destroy();
	};

	http.on("upgrade", (request, socket, head) => {
		const url = new URL(request.url ?? "/", "http://localhost");
		if (url.pathname !== WS_PATH) {
			reject(socket, 404, "Not Found");
			return;
		}
		if (!tokenMatches(token, presentedToken(request))) {
			reject(socket, 401, "Unauthorized");
			return;
		}
		wss.handleUpgrade(request, socket, head, (ws) => {
			connections.add(ws);
			const connection = new WebSocketByteConnection(ws);
			const handler: ByteConnectionHandler = server.accept(connection);
			ws.on("message", (data, isBinary) => {
				if (!isBinary) {
					handler.onError(new Error("pi WebSocket transport received a text message"));
					ws.close(PROTOCOL_ERROR_CLOSE_CODE, "binary frames only");
					return;
				}
				const chunk = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer | Buffer);
				handler.onData(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
			});
			ws.on("error", (error) => {
				connection.markClosed();
				handler.onError(error);
				ws.close(TRANSPORT_ERROR_CLOSE_CODE, "transport error");
			});
			ws.on("close", () => {
				connections.delete(ws);
				if (!connection.closed) {
					connection.markClosed();
					handler.onClose();
				}
			});
		});
	});

	return async () => {
		for (const ws of connections) ws.close(1001, "server shutting down");
		await new Promise<void>((resolve, rejectClose) => wss.close((error) => (error ? rejectClose(error) : resolve())));
	};
}
