// Smoke test against a running pi-phone server: connect over WebSocket, create and attach a Session, stream the
// Transcript, send a prompt, print the answer. Reads the token from ~/.pi-phone/token.
//
//   node bin/run.mjs scripts/ws-smoke.ts [ws://127.0.0.1:7741/pi] [prompt] [provider/modelId]
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Client } from "@earendil-works/pi-client";
import { AgentController } from "pi-src/experimental/services/agent-controller.ts";
import { createServerServiceSource, createSessionServiceSource } from "pi-src/experimental/services/connection.ts";
import { Models } from "pi-src/experimental/services/models.ts";
import { SessionDirectory, SessionManagement } from "pi-src/experimental/services/sessions.ts";
import { Transcript } from "pi-src/experimental/services/transcript.ts";
import { createWebSocketTransportFactory } from "../client/ws-transport.ts";

const context = BACKGROUND_CONTEXT;
const url = process.argv[2] ?? "ws://127.0.0.1:7741/pi";
const prompt = process.argv[3] ?? "Reply with exactly: websocket ok";
const modelArg = process.argv[4];
const token = (await readFile(join(homedir(), ".pi-phone", "token"), "utf8")).trim();

const health = await fetch(`${url.replace(/^ws/, "http").replace(/\/pi$/, "")}/health?token=${token}`);
const info = (await health.json()) as { serverId: string; workerPids: number[] };
console.log(`health: server ${info.serverId}, workers ${JSON.stringify(info.workerPids)}`);

const client = await Client.connect({
	serverId: info.serverId,
	transportFactory: createWebSocketTransportFactory({ url, token }),
});
const server = createServerServiceSource(client);
const session = createSessionServiceSource(client);
const serverServices = server.open({ services: [SessionDirectory, SessionManagement], assertAccess() {}, onError() {} });
const sessionServices = session.open({ services: [AgentController, Transcript, Models], assertAccess() {}, onError() {} });
await Promise.all([serverServices.ready(context), sessionServices.ready(context)]);

const directory = serverServices.use(SessionDirectory);
const management = serverServices.use(SessionManagement);
const listed = await new Promise<number>((resolve) => {
	const stop = directory.state.subscribe((value) => {
		if (value === undefined) return;
		stop();
		resolve(value.sessions.length);
	});
});
console.log(`sessions: ${listed}`);

const created = await management.create({}, context);
await management.attach(created.sessionId, context);
await session.whenAttached(created.sessionId, context);
console.log(`attached: ${created.sessionId}`);

if (modelArg !== undefined) {
	const slash = modelArg.indexOf("/");
	if (slash === -1) throw new Error("model must be provider/modelId");
	await sessionServices.use(Models).select({ provider: modelArg.slice(0, slash), modelId: modelArg.slice(slash + 1) }, context);
	console.log(`model: ${modelArg}`);
}
const transcript = sessionServices.use(Transcript);
const agent = sessionServices.use(AgentController);
let lastPartial = "";
const unsubscribe = transcript.state.subscribe((view) => {
	const live = view.docs["pi.live"] as { generation?: { message?: { content?: { type: string; text?: string }[] } } };
	const text = live.generation?.message?.content?.map((part) => part.text ?? "").join("") ?? "";
	if (text !== lastPartial) {
		lastPartial = text;
		process.stdout.write(`\rpartial: ${text.slice(0, 60)}`);
	}
});

const sent = await agent.prompt({ message: prompt, images: null }, context);
if (!sent.accepted) throw new Error(`prompt rejected: ${sent.error.message}`);
const result = await agent.waitForPrompt(sent.operationId, context);
unsubscribe();
console.log(`\nanswer: ${result.status === "done" ? result.text : `unanswered (${result.reason})`}`);
console.log(`entries: ${transcript.state.value.entries.length}`);

await management.detach(context);
await session.dispose(context);
await server.dispose(context);
await client.dispose();
