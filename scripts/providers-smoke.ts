// Exercise the Providers facet: list providers, start an OAuth login, print its auth URL, cancel it.
//
//   node bin/run.mjs scripts/providers-smoke.ts [providerId]
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Client } from "@earendil-works/pi-client";
import { createServerServiceSource, createSessionServiceSource } from "pi-src/experimental/services/connection.ts";
import { SessionManagement } from "pi-src/experimental/services/sessions.ts";
import { createWebSocketTransportFactory } from "../client/ws-transport.ts";
import { type LoginFlow, Providers } from "../contracts/providers.ts";

const context = BACKGROUND_CONTEXT;
const url = "ws://127.0.0.1:7741/pi";
const providerId = process.argv[2] ?? "anthropic";
const token = (await readFile(join(homedir(), ".pi-phone", "token"), "utf8")).trim();
const health = (await (await fetch(`http://127.0.0.1:7741/health?token=${token}`)).json()) as { serverId: string };

const client = await Client.connect({ serverId: health.serverId, transportFactory: createWebSocketTransportFactory({ url, token }) });
const server = createServerServiceSource(client);
const session = createSessionServiceSource(client);
const serverServices = server.open({ services: [SessionManagement], assertAccess() {}, onError() {} });
const sessionServices = session.open({ services: [Providers], assertAccess() {}, onError() {} });
await Promise.all([serverServices.ready(context), sessionServices.ready(context)]);
const management = serverServices.use(SessionManagement);
const created = await management.create({}, context);
await management.attach(created.sessionId, context);
await session.whenAttached(created.sessionId, context);

const providers = sessionServices.use(Providers);
const first = await new Promise<Providers["state"]["value"]>((resolve) => {
	const stop = providers.state.subscribe((value) => {
		if (value === undefined) return;
		stop();
		resolve(value);
	});
});
for (const provider of first!.providers.filter((each) => each.configured || each.oauth !== null)) {
	console.log(
		`${provider.configured ? "signed in " : "          "} ${provider.id.padEnd(16)} ${provider.models} models` +
			`${provider.oauth === null ? "" : `  oauth: ${provider.oauth}`}${provider.subscription ? " (subscription)" : ""}`,
	);
}

const { flowId } = await providers.startLogin({ providerId, authType: "oauth" }, context);
const waitFor = (ready: (flow: LoginFlow) => boolean): Promise<LoginFlow> =>
	new Promise((resolve) => {
		const stop = providers.state.subscribe((value) => {
			const current = value?.flows[flowId];
			if (current === undefined || !ready(current)) return;
			stop();
			resolve(current);
		});
	});
let flow = await waitFor((f) => f.prompt !== null || f.events.some((e) => e.type === "auth_url") || f.status !== "running");
// Answer a select prompt (login variant) with its first option, then wait for the URL.
if (flow.prompt?.type === "select") {
	console.log(`select: ${flow.prompt.message} -> ${flow.prompt.options[0]!.label}`);
	await providers.answer({ flowId, promptId: flow.prompt.id, value: flow.prompt.options[0]!.id }, context);
	flow = await waitFor((f) => f.events.some((e) => e.type === "auth_url") || f.status !== "running");
}
console.log(`flow ${flowId}: ${flow.status}`);
for (const event of flow.events) console.log(`  ${event.type}: ${"url" in event ? event.url.slice(0, 80) + "..." : "message" in event ? event.message : ""}`);
if (flow.prompt !== null) console.log(`  prompt: ${flow.prompt.type} "${flow.prompt.message}"`);
if (flow.status === "running") {
	await providers.cancel({ flowId }, context);
	const ended = await new Promise<LoginFlow>((resolve) => {
		const stop = providers.state.subscribe((value) => {
			const current = value?.flows[flowId];
			if (current === undefined || current.status === "running") return;
			stop();
			resolve(current);
		});
	});
	console.log(`after cancel: ${ended.status} ${ended.error ?? ""}`);
}

await management.detach(context);
await management.remove(created.sessionId, context);
await session.dispose(context);
await server.dispose(context);
await client.dispose();
