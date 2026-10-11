// Exercise PhoneTranscripts/PhoneTranscript/PhoneAgent: open the root conversation as a keyed instance, ask the model to
// read a PNG, check the replica carries an image reference without bytes, fetch the bytes, page older entries.
//
//   node bin/run.mjs scripts/transcripts-smoke.ts [provider/modelId]
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Client } from "@earendil-works/pi-client";
import { createServerServiceSource, createSessionServiceSource } from "pi-src/experimental/services/connection.ts";
import { Models } from "pi-src/experimental/services/models.ts";
import { SessionManagement } from "pi-src/experimental/services/sessions.ts";
import { createWebSocketTransportFactory } from "../client/ws-transport.ts";
import { PhoneAgent, PhoneTranscript, PhoneTranscripts, type ProjectedView } from "../contracts/transcripts.ts";

const context = BACKGROUND_CONTEXT;
const url = "ws://127.0.0.1:7741/pi";
const modelArg = process.argv[2] ?? "anthropic/claude-haiku-4-5";
const token = (await readFile(join(homedir(), ".pi-phone", "token"), "utf8")).trim();
const health = (await (await fetch(`http://127.0.0.1:7741/health?token=${token}`)).json()) as { serverId: string };
const image = resolve("scripts/fixtures/red.png");

const client = await Client.connect({ serverId: health.serverId, transportFactory: createWebSocketTransportFactory({ url, token }) });
const server = createServerServiceSource(client);
const session = createSessionServiceSource(client);
const serverServices = server.open({ services: [SessionManagement], assertAccess() {}, onError() {} });
const sessionServices = session.open({ services: [PhoneTranscripts, PhoneTranscript, PhoneAgent, Models], assertAccess() {}, onError() {} });
await Promise.all([serverServices.ready(context), sessionServices.ready(context)]);
const management = serverServices.use(SessionManagement);
const created = await management.create({}, context);
await management.attach(created.sessionId, context);
await session.whenAttached(created.sessionId, context);

const slash = modelArg.indexOf("/");
await sessionServices.use(Models).select({ provider: modelArg.slice(0, slash), modelId: modelArg.slice(slash + 1) }, context);

const transcripts = sessionServices.use(PhoneTranscripts);
const agent = sessionServices.use(PhoneAgent);

// Keyed instances arrive through observe(); keep the one for the root (conversation 1).
let root: PhoneTranscript | undefined;
const rootReady = new Promise<void>((resolve) => {
	sessionServices.observe(PhoneTranscript, (instance) => {
		// subscribe() delivers the current value synchronously; never call the unsubscribe from inside that first call.
		let seen = false;
		const stop = instance.state.subscribe((value) => {
			if (value === undefined || seen) return;
			seen = true;
			queueMicrotask(() => stop());
			if (value.conversationId === 1 && root === undefined) {
				root = instance;
				resolve();
			}
		});
	});
});
await transcripts.open({ conversationId: 1 }, context);
await rootReady;
console.log(`open instances: ${JSON.stringify(transcripts.state.value?.open)}`);

const latest = (): ProjectedView => {
	const value = root!.state.value;
	if (value === undefined) throw new Error("no view");
	return value;
};
const sent = await agent.prompt(
	{ conversationId: 1, message: `Use the read tool on ${image} and then reply with exactly: image seen`, images: null, requestId: randomUUID() },
	context,
);
if (!sent.accepted) throw new Error(sent.error.message);
await new Promise<void>((resolve) => {
	const stop = root!.state.subscribe((value) => {
		const live = value?.docs["pi.live"] as { run?: unknown } | undefined;
		const answered = value?.entries.some((entry) => entry.kind === "pi.assistant" && JSON.stringify(entry.model).includes("image seen"));
		if (value !== undefined && live?.run === undefined && answered) {
			stop();
			resolve();
		}
	});
});

const view = latest();
const toolResult = view.entries.find((entry) => entry.kind === "pi.tool-result");
if (toolResult === undefined) throw new Error("no tool result entry");
const parts = (toolResult.model![0] as { content: { type: string; index?: number; data?: string; mimeType?: string }[] }).content;
const ref = parts.find((part) => part.type === "image");
console.log(`tool result image part: ${JSON.stringify(ref)}`);
if (ref === undefined || ref.data !== undefined) throw new Error("expected an image reference without data");
console.log(`replica bytes: ${JSON.stringify(view).length}`);
const bytes = await root!.image({ entryId: toolResult.id, index: ref.index! }, context);
console.log(`image(): ${bytes.mimeType}, ${bytes.data.length} base64 chars`);
const full = await root!.entry({ entryId: toolResult.id }, context);
console.log(`entry(): has data: ${JSON.stringify(full).includes('"data":"iVBOR')}`);
const newest = view.entries.at(-1)!.id;
const page = await root!.before({ before: newest, limit: 2 }, context);
console.log(`before(${newest}, 2): ${page.entries.map((entry) => `${entry.id}:${entry.kind}`).join(", ")} more=${page.more}`);

await transcripts.close({ conversationId: 1 }, context);
console.log(`after close: ${JSON.stringify(transcripts.state.value?.open)}`);
await management.detach(context);
await management.remove(created.sessionId, context);
await session.dispose(context);
await server.dispose(context);
await client.dispose();
