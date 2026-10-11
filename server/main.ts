// pi-phone server: pi's experimental server (coordinator, session workers, services) plus a WebSocket transport
// and a small HTTP API, both token protected.
//
//   node bin/pi-phone-server.mjs [--listen host:port] [--data-dir dir] [--session-dir dir]
import { createServer } from "node:http";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { startForegroundServer } from "pi-src/experimental/server.ts";
import { createHttpHandler } from "./http.ts";
import { loadToken } from "./token.ts";
import { attachWebSocketListener, WS_PATH } from "./ws-listener.ts";

const DEFAULT_LISTEN = "127.0.0.1:7741";

function parseListen(value: string): { host: string; port: number } {
	const separator = value.lastIndexOf(":");
	if (separator === -1) throw new Error(`--listen must be host:port, got "${value}"`);
	const host = value.slice(0, separator);
	const port = Number(value.slice(separator + 1));
	if (host === "" || !Number.isInteger(port) || port < 1 || port > 65535) {
		throw new Error(`--listen must be host:port, got "${value}"`);
	}
	return { host, port };
}

async function main(): Promise<void> {
	const { values } = parseArgs({
		options: {
			listen: { type: "string", default: DEFAULT_LISTEN },
			"data-dir": { type: "string", default: resolve(homedir(), ".pi-phone") },
			"session-dir": { type: "string" },
		},
	});
	const listen = parseListen(values.listen);
	const dataDir = resolve(values["data-dir"]);
	const token = await loadToken(dataDir);
	const startedAt = Date.now();

	const runtime = await startForegroundServer({
		...(values["session-dir"] === undefined ? {} : { sessionDir: resolve(values["session-dir"]) }),
		workerEntryUrl: new URL("./worker.ts", import.meta.url),
		onRelayStatus(status) {
			console.log(`radius: ${status.status}`);
		},
	});

	let stopping: Promise<void> | undefined;
	const stop = (): Promise<void> => {
		stopping ??= (async () => {
			await closeWebSockets();
			await new Promise<void>((done) => http.close(() => done()));
			await runtime.close();
		})();
		return stopping;
	};

	const http = createServer(
		createHttpHandler({
			token,
			serverId: runtime.serverId,
			startedAt,
			workerPids: () => Object.fromEntries(runtime.workerPids),
			shutdown: () => void stop(),
		}),
	);
	const closeWebSockets = attachWebSocketListener(http, runtime.server, token);
	await new Promise<void>((done, fail) => {
		http.once("error", fail);
		http.listen(listen.port, listen.host, done);
	});

	console.log(`server:   ${runtime.serverId}`);
	console.log(`socket:   ${runtime.socketPath}`);
	console.log(`sessions: ${runtime.sessionDir}`);
	console.log(`ws:       ws://${listen.host}:${listen.port}${WS_PATH}?token=<${dataDir}/token>`);
	console.log(`worker:   ${fileURLToPath(new URL("./worker.ts", import.meta.url))}`);

	process.once("SIGINT", () => void stop());
	process.once("SIGTERM", () => void stop());
	await runtime.closed;
	await stop();
}

main().catch((error: unknown) => {
	console.error(error instanceof Error ? error.stack ?? error.message : String(error));
	process.exit(1);
});
