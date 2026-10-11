import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ByteConnection, ByteConnectionHandler, Server } from "@earendil-works/pi-server";
import { createWebSocketTransportFactory } from "../client/ws-transport.ts";
import { loadToken } from "./token.ts";
import { attachWebSocketListener, WS_PATH } from "./ws-listener.ts";

/** A pi server stand-in that echoes every chunk back and records closes. */
function echoServer(): { server: Pick<Server, "accept">; closed: () => number } {
	let closes = 0;
	return {
		server: {
			accept(connection: ByteConnection): ByteConnectionHandler {
				return {
					onData: (chunk) => void connection.send(chunk),
					onClose: () => {
						closes += 1;
					},
					onError: () => {},
				};
			},
		},
		closed: () => closes,
	};
}

async function listen(token: string) {
	const echo = echoServer();
	const http = createServer((_request, response) => response.end());
	const closeSockets = attachWebSocketListener(http, echo.server as Server, token);
	await new Promise<void>((done) => http.listen(0, "127.0.0.1", done));
	const address = http.address();
	if (address === null || typeof address === "string") throw new Error("no address");
	return {
		url: `ws://127.0.0.1:${address.port}${WS_PATH}`,
		echo,
		async close() {
			await closeSockets();
			await new Promise<void>((done) => http.close(() => done()));
		},
	};
}

test("token is created once and reused", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-phone-token-"));
	try {
		const first = await loadToken(dir);
		assert.match(first, /^[a-f0-9]{64}$/);
		assert.equal(await loadToken(dir), first);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("binary frames round-trip through the listener and the client transport", async () => {
	const token = "a".repeat(64);
	const listener = await listen(token);
	try {
		const received: Uint8Array[] = [];
		const transport = await createWebSocketTransportFactory({ url: listener.url, token })({
			onData: (chunk) => received.push(chunk),
			// A close the client asks for is not reported back to it (same contract as the Radius transport).
			onClose: () => assert.fail("onClose after a local close"),
			onError: (error) => assert.fail(error.message),
		});
		await transport.send(new Uint8Array([1, 2, 3]));
		await transport.send(new Uint8Array([4]));
		await new Promise<void>((done) => {
			const poll = (): void => (received.length === 2 ? done() : void setTimeout(poll, 5));
			poll();
		});
		assert.deepEqual([...received[0]!], [1, 2, 3]);
		assert.deepEqual([...received[1]!], [4]);
		transport.close();
		await new Promise<void>((done) => {
			const poll = (): void => (listener.echo.closed() === 1 ? done() : void setTimeout(poll, 5));
			poll();
		});
	} finally {
		await listener.close();
	}
});

test("a wrong token is rejected at upgrade", async () => {
	const listener = await listen("b".repeat(64));
	try {
		await assert.rejects(
			createWebSocketTransportFactory({ url: listener.url, token: "c".repeat(64) })({
				onData: () => {},
				onClose: () => {},
				onError: () => {},
			}),
			/failed/,
		);
	} finally {
		await listener.close();
	}
});
