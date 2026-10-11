// A pi-client ByteTransportFactory over the browser-style WebSocket API (Node 22+, React Native, browsers): one
// pi-protocol frame per binary message, matching server/ws-listener.ts. No Node imports, so the app shares it.
import type { ByteTransport, ByteTransportFactory, ByteTransportHandlers } from "@earendil-works/pi-client";

export interface WebSocketTransportOptions {
	/** `ws://host:port/pi` or `wss://...`; the token is appended as a query parameter. */
	readonly url: string;
	readonly token: string;
	/** The WebSocket constructor; defaults to the global one. */
	readonly WebSocket?: typeof WebSocket;
}

const CLIENT_CLOSED_CODE = 1000;

class WebSocketByteTransport implements ByteTransport {
	readonly #socket: WebSocket;
	readonly #handlers: ByteTransportHandlers;
	#closed = false;

	constructor(socket: WebSocket, handlers: ByteTransportHandlers) {
		this.#socket = socket;
		this.#handlers = handlers;
		socket.addEventListener("message", (event: MessageEvent) => {
			if (this.#closed) return;
			if (!(event.data instanceof ArrayBuffer)) {
				this.#fail(new Error("pi WebSocket transport received a non-binary message"));
				return;
			}
			handlers.onData(new Uint8Array(event.data));
		});
		socket.addEventListener("close", () => {
			if (this.#markClosed()) handlers.onClose();
		});
		socket.addEventListener("error", () => this.#fail(new Error("pi WebSocket transport error")));
	}

	send(chunk: Uint8Array): Promise<void> {
		if (this.#closed) return Promise.reject(new Error("pi WebSocket transport is closed"));
		// Copy so the caller may reuse its buffer; the API accepts the ArrayBuffer view directly.
		this.#socket.send(chunk.slice().buffer);
		return Promise.resolve();
	}

	close(): void {
		if (!this.#markClosed()) return;
		this.#socket.close(CLIENT_CLOSED_CODE, "pi client closed");
	}

	#markClosed(): boolean {
		if (this.#closed) return false;
		this.#closed = true;
		return true;
	}

	#fail(error: Error): void {
		if (!this.#markClosed()) return;
		this.#handlers.onError(error);
		this.#socket.close(CLIENT_CLOSED_CODE, error.message);
	}
}

export function createWebSocketTransportFactory(options: WebSocketTransportOptions): ByteTransportFactory {
	const Constructor = options.WebSocket ?? globalThis.WebSocket;
	if (Constructor === undefined) throw new Error("No WebSocket implementation available");
	return async (handlers) => {
		const url = new URL(options.url);
		url.searchParams.set("token", options.token);
		const socket = new Constructor(url.toString());
		socket.binaryType = "arraybuffer";
		await new Promise<void>((resolve, reject) => {
			const onOpen = (): void => {
				socket.removeEventListener("error", onError);
				resolve();
			};
			const onError = (): void => {
				socket.removeEventListener("open", onOpen);
				reject(new Error(`WebSocket connection to ${options.url} failed`));
			};
			socket.addEventListener("open", onOpen, { once: true });
			socket.addEventListener("error", onError, { once: true });
		});
		return new WebSocketByteTransport(socket, handlers);
	};
}
