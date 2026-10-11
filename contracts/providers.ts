// Providers service contract: provider sign-in status and login flows driven from the app. Runtime-neutral (the
// app imports it). The login runs in the Session worker; each prompt and event of pi-ai's AuthInteraction is
// published into `flows`, and the app answers prompts by id. See DESIGN.md section 4.
import { type Context, defineService, type ReplicatedState } from "@earendil-works/chord";

export interface ProviderSummary {
	id: string;
	name: string;
	configured: boolean;
	/** Where the credential comes from: "stored" (auth.json), "runtime", "environment", or null. */
	source: string | null;
	/** Environment-source label, such as "ANTHROPIC_API_KEY". */
	label: string | null;
	/** The provider offers API-key login. */
	apiKey: boolean;
	/** OAuth login label such as "Sign in with Claude Pro/Max", or null without OAuth. */
	oauth: string | null;
	/** OAuth access is backed by a subscription. */
	subscription: boolean;
	models: number;
}

export type LoginPrompt = { id: string } & (
	| { type: "text"; message: string; placeholder: string | null }
	| { type: "secret"; message: string; placeholder: string | null }
	| { type: "manual_code"; message: string; placeholder: string | null }
	| { type: "select"; message: string; options: { id: string; label: string; description: string | null }[] }
);

export type LoginEvent =
	| { type: "info"; message: string; links: { url: string; label: string | null }[] }
	| { type: "auth_url"; url: string; instructions: string | null }
	| { type: "device_code"; userCode: string; verificationUri: string; expiresInSeconds: number | null }
	| { type: "progress"; message: string };

export interface LoginFlow {
	providerId: string;
	authType: "api_key" | "oauth";
	status: "running" | "done" | "failed" | "cancelled";
	startedAt: number;
	events: LoginEvent[];
	/** The prompt waiting for an answer, or null. */
	prompt: LoginPrompt | null;
	error: string | null;
}

export interface ProvidersState {
	revision: number;
	providers: ProviderSummary[];
	flows: Record<string, LoginFlow>;
}

export interface Providers {
	readonly state: ReplicatedState<ProvidersState>;
	startLogin(request: { providerId: string; authType: "api_key" | "oauth" }, context: Context): Promise<{ flowId: string }>;
	answer(request: { flowId: string; promptId: string; value: string }, context: Context): Promise<void>;
	cancel(request: { flowId: string }, context: Context): Promise<void>;
	logout(request: { providerId: string }, context: Context): Promise<void>;
	refresh(context: Context): Promise<void>;
}

export const Providers = defineService<Providers>("pi-phone.providers");
