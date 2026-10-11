// Providers facet: pi's ModelRuntime login flows as a service. Prompts and events of each flow are published into
// replicated state; the app answers prompts through `answer()`. Finished flows stay listed until the next
// `startLogin` or `refresh`, so a reconnecting app still sees how a flow ended.
import { randomUUID } from "node:crypto";
import { defineFacet, type Facet } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { AuthEvent, AuthPrompt } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "pi-src/core/model-runtime.ts";
import type { SettingsManager } from "pi-src/core/settings-manager.ts";
import {
	type LoginEvent,
	type LoginPrompt,
	type ProviderSummary,
	Providers,
	type ProvidersState,
} from "../../contracts/providers.ts";

interface PendingPrompt {
	resolve(value: string): void;
	reject(error: Error): void;
}

interface ActiveFlow {
	readonly abort: AbortController;
	readonly prompts: Map<string, PendingPrompt>;
}

function toLoginEvent(event: AuthEvent): LoginEvent {
	switch (event.type) {
		case "info":
			return {
				type: "info",
				message: event.message,
				links: (event.links ?? []).map((link) => ({ url: link.url, label: link.label ?? null })),
			};
		case "auth_url":
			return { type: "auth_url", url: event.url, instructions: event.instructions ?? null };
		case "device_code":
			return {
				type: "device_code",
				userCode: event.userCode,
				verificationUri: event.verificationUri,
				expiresInSeconds: event.expiresInSeconds ?? null,
			};
		case "progress":
			return { type: "progress", message: event.message };
	}
}

function toLoginPrompt(id: string, prompt: AuthPrompt): LoginPrompt {
	if (prompt.type === "select") {
		return {
			id,
			type: "select",
			message: prompt.message,
			options: prompt.options.map((option) => ({
				id: option.id,
				label: option.label,
				description: option.description ?? null,
			})),
		};
	}
	return { id, type: prompt.type, message: prompt.message, placeholder: prompt.placeholder ?? null };
}

export function summarizeProviders(runtime: ModelRuntime): ProviderSummary[] {
	return runtime.getProviders().map((provider) => {
		const status = runtime.getProviderAuthStatus(provider.id);
		const oauth = provider.auth.oauth;
		return {
			id: provider.id,
			name: provider.name,
			configured: status.configured,
			source: status.source ?? null,
			label: status.label ?? null,
			apiKey: provider.auth.apiKey?.login !== undefined,
			oauth: oauth === undefined ? null : (oauth.loginLabel ?? `Sign in with ${oauth.name}`),
			subscription: oauth?.isSubscription === true,
			models: runtime.getModels(provider.id).length,
		};
	});
}

export function createProvidersFacet(runtime: ModelRuntime, settings: SettingsManager): Facet {
	return defineFacet({
		id: "@pi-phone/providers",
		setup(env) {
			const state = env.replicatedState<ProvidersState>({
				revision: 1,
				providers: summarizeProviders(runtime),
				flows: {},
			});
			const active = new Map<string, ActiveFlow>();

			const publish = (mutate: (draft: ProvidersState) => void): void => {
				state.change(BACKGROUND_CONTEXT, (draft) => {
					draft.revision += 1;
					mutate(draft as ProvidersState);
				});
			};
			const refreshProviders = async (): Promise<void> => {
				await runtime.getAvailable();
				const providers = summarizeProviders(runtime);
				publish((draft) => {
					draft.providers = providers;
				});
			};
			const flowOf = (draft: ProvidersState, flowId: string) => {
				const flow = draft.flows[flowId];
				if (flow === undefined) throw new Error(`Unknown login flow: ${flowId}`);
				return flow;
			};

			env.provide(Providers, {
				state,
				async startLogin({ providerId, authType }) {
					for (const flow of active.values()) flow.abort.abort(new Error("Another login started"));
					const flowId = randomUUID();
					const flow: ActiveFlow = { abort: new AbortController(), prompts: new Map() };
					active.set(flowId, flow);
					publish((draft) => {
						draft.flows = {
							[flowId]: {
								providerId,
								authType,
								status: "running",
								startedAt: Date.now(),
								events: [],
								prompt: null,
								error: null,
							},
						};
					});
					const interaction = {
						signal: flow.abort.signal,
						prompt: (prompt: AuthPrompt) =>
							new Promise<string>((resolve, reject) => {
								const promptId = randomUUID();
								flow.prompts.set(promptId, { resolve, reject });
								prompt.signal?.addEventListener("abort", () => {
									if (!flow.prompts.delete(promptId)) return;
									publish((draft) => {
										flowOf(draft, flowId).prompt = null;
									});
									reject(new Error("Prompt cancelled"));
								});
								publish((draft) => {
									flowOf(draft, flowId).prompt = toLoginPrompt(promptId, prompt);
								});
							}),
						notify: (event: AuthEvent) =>
							publish((draft) => {
								flowOf(draft, flowId).events.push(toLoginEvent(event));
							}),
					};
					void runtime
						.login(providerId, authType, interaction, { getDeviceId: () => settings.getOrCreateDeviceId() })
						.then(
							async () => {
								publish((draft) => {
									const record = flowOf(draft, flowId);
									record.status = "done";
									record.prompt = null;
								});
								await refreshProviders();
							},
							(error: unknown) => {
								const message = error instanceof Error ? error.message : String(error);
								publish((draft) => {
									const record = flowOf(draft, flowId);
									record.status = flow.abort.signal.aborted ? "cancelled" : "failed";
									record.prompt = null;
									record.error = message;
								});
							},
						)
						.finally(() => active.delete(flowId));
					return { flowId };
				},
				async answer({ flowId, promptId, value }) {
					const flow = active.get(flowId);
					if (flow === undefined) throw new Error(`Login flow is not running: ${flowId}`);
					const pending = flow.prompts.get(promptId);
					if (pending === undefined) throw new Error(`No prompt ${promptId} waiting in flow ${flowId}`);
					flow.prompts.delete(promptId);
					publish((draft) => {
						flowOf(draft, flowId).prompt = null;
					});
					pending.resolve(value);
				},
				async cancel({ flowId }) {
					const flow = active.get(flowId);
					if (flow === undefined) throw new Error(`Login flow is not running: ${flowId}`);
					for (const pending of flow.prompts.values()) pending.reject(new Error("Login cancelled"));
					flow.prompts.clear();
					flow.abort.abort(new Error("Login cancelled"));
				},
				async logout({ providerId }) {
					await runtime.logout(providerId);
					await refreshProviders();
				},
				refresh: () => refreshProviders(),
			});

			env.onDeactivate(() => {
				for (const flow of active.values()) flow.abort.abort(new Error("Session worker stopping"));
			});
		},
	});
}
