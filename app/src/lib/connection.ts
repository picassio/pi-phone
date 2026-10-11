// The connection to one pi-phone server: pi-client over WebSocket, the server-scoped and Session-scoped service
// sources, and the typed service handles the screens use. One connection carries one attached Session at a time.
import AsyncStorage from "@react-native-async-storage/async-storage";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Client } from "@earendil-works/pi-client";
import { AgentController } from "pi-src/experimental/services/agent-controller.ts";
import {
	createServerServiceSource,
	createSessionServiceSource,
	type ServerServiceSource,
	type SessionServiceSource,
} from "pi-src/experimental/services/connection.ts";
import { Models } from "pi-src/experimental/services/models.ts";
import { SessionDirectory, SessionManagement } from "pi-src/experimental/services/sessions.ts";
import { Transcript } from "pi-src/experimental/services/transcript.ts";
import { createWebSocketTransportFactory } from "../../../client/ws-transport.ts";
import { Providers } from "../../../contracts/providers.ts";
import { createStore } from "./store.ts";

export const context = BACKGROUND_CONTEXT;

export interface ServerSettings {
	/** `ws://host:port/pi` */
	url: string;
	token: string;
}

const SETTINGS_KEY = "pi-phone.server";
export const DEFAULT_URL = "ws://127.0.0.1:7741/pi";

export async function loadSettings(): Promise<ServerSettings> {
	const stored = await AsyncStorage.getItem(SETTINGS_KEY);
	// Development prefill: EXPO_PUBLIC_PI_TOKEN in app/.env (gitignored) stands in until settings are saved.
	if (stored === null) return { url: DEFAULT_URL, token: process.env.EXPO_PUBLIC_PI_TOKEN ?? "" };
	const parsed: unknown = JSON.parse(stored);
	if (
		typeof parsed !== "object" ||
		parsed === null ||
		typeof (parsed as ServerSettings).url !== "string" ||
		typeof (parsed as ServerSettings).token !== "string"
	) {
		throw new Error("Stored server settings are invalid");
	}
	return parsed as ServerSettings;
}

export function saveSettings(settings: ServerSettings): Promise<void> {
	return AsyncStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}

export interface Connection {
	readonly serverId: string;
	readonly client: Client;
	readonly server: ServerServiceSource;
	readonly session: SessionServiceSource;
	readonly directory: SessionDirectory;
	readonly management: SessionManagement;
	readonly models: Models;
	readonly agent: AgentController;
	readonly transcript: Transcript;
	readonly providers: Providers;
	attach(sessionId: string): Promise<void>;
	detach(): Promise<void>;
	dispose(): Promise<void>;
}

export type ConnectionState =
	| { status: "disconnected"; error: string | null }
	| { status: "connecting" }
	| { status: "connected"; connection: Connection };

export const connectionStore = createStore<ConnectionState>({ status: "disconnected", error: null });
connectionStore.subscribe(() => {
	const state = connectionStore.get();
	console.log(`connection: ${state.status}${state.status === "disconnected" && state.error !== null ? ` (${state.error})` : ""}`);
});

function httpBase(url: string): string {
	const parsed = new URL(url);
	parsed.protocol = parsed.protocol === "wss:" ? "https:" : "http:";
	parsed.pathname = "";
	parsed.search = "";
	return parsed.toString().replace(/\/$/, "");
}

export async function connect(settings: ServerSettings): Promise<Connection> {
	if (settings.token === "") throw new Error("Server token is empty");
	const health = await fetch(`${httpBase(settings.url)}/health?token=${encodeURIComponent(settings.token)}`);
	if (!health.ok) throw new Error(`Server health check failed: HTTP ${health.status}`);
	const { serverId } = (await health.json()) as { serverId: string };

	const client = await Client.connect({
		serverId,
		transportFactory: createWebSocketTransportFactory({ url: settings.url, token: settings.token }),
	});
	const server = createServerServiceSource(client);
	const session = createSessionServiceSource(client);
	const serverServices = server.open({
		services: [SessionDirectory, SessionManagement],
		assertAccess() {},
		onError(error) {
			console.error("server services", error);
		},
	});
	const sessionServices = session.open({
		services: [Models, AgentController, Transcript, Providers],
		assertAccess() {},
		onError(error) {
			console.error("session services", error);
		},
	});
	await Promise.all([serverServices.ready(context), sessionServices.ready(context)]);
	const management = serverServices.use(SessionManagement);

	return {
		serverId,
		client,
		server,
		session,
		directory: serverServices.use(SessionDirectory),
		management,
		models: sessionServices.use(Models),
		agent: sessionServices.use(AgentController),
		transcript: sessionServices.use(Transcript),
		providers: sessionServices.use(Providers),
		async attach(sessionId) {
			if (client.attachment?.sessionId === sessionId) return;
			await management.attach(sessionId, context);
			await session.whenAttached(sessionId, context);
		},
		async detach() {
			if (client.attachment === undefined) return;
			await management.detach(context);
			await session.whenDetached(context);
		},
		async dispose() {
			await session.dispose(context);
			await server.dispose(context);
			await client.dispose();
		},
	};
}

/** Connect with the stored settings and publish the result. */
export async function connectStored(): Promise<void> {
	const current = connectionStore.get();
	if (current.status === "connected") await current.connection.dispose();
	connectionStore.set({ status: "connecting" });
	try {
		const connection = await connect(await loadSettings());
		connection.client.onConnectionStateChange(({ state, error }) => {
			if (state === "disconnected") {
				connectionStore.set({ status: "disconnected", error: error?.message ?? "Connection closed" });
			}
		});
		connectionStore.set({ status: "connected", connection });
	} catch (error) {
		connectionStore.set({ status: "disconnected", error: error instanceof Error ? error.message : String(error) });
	}
}
