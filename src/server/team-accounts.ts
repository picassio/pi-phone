/**
 * The team's provider accounts, as this pi-phone sees them on the team server (PP-69, `src/gateway/team-accounts.ts`):
 * listed in the Providers sheet beside the person's own, and, for someone with providers.manage, added, signed in,
 * renamed, signed out and removed there. Their sign-ins and keys stay on the gateway: a sign-in runs there, and this
 * pi-phone fetches its steps (a link, a code to paste, a device code) and shows them in its sign-in card as its own
 * sign-ins do (the `auth` event), and sends the answers back.
 */
import { HttpError } from "./errors.ts";

/** A sign-in step as the Providers sheet shows it (`providers.ts`, `client.send("auth", …)`). */
type Step = { step: string; [key: string]: unknown };

export type TeamAccountRow = {
    id: string;
    provider: string;
    name: string;
    providerName: string;
    configured: boolean;
    oauth: boolean;
    signIn: { oauth: string | null; apiKey: boolean };
    models: number;
    /** The roles that may use it, by name. */
    roles: string[];
};

export class TeamAccountsClient {
    readonly #server: { url: string; token: string } | undefined;
    /** Send a sign-in's step to this person's open tabs. */
    readonly #send: (data: Record<string, unknown>) => void;
    /** Sign-ins under way here, by id: whose they are. */
    readonly #flows = new Set<string>();

    constructor(server: { url: string; token: string } | undefined, send: (data: Record<string, unknown>) => void) {
        this.#server = server;
        this.#send = send;
    }

    /** On the team server only. */
    get available(): boolean {
        return this.#server !== undefined;
    }

    async #call<T>(body: Record<string, unknown>, timeoutMs = 15_000): Promise<T> {
        const server = this.#server;

        if (server === undefined) {
            throw new HttpError(400, "Team accounts are for the team server.");
        }

        const response = await fetch(`${server.url}/internal/team-accounts`, {
            method: "POST",
            headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(timeoutMs),
        });
        const answer = (await response.json()) as { value?: T; error?: string };

        if (!response.ok) {
            throw new HttpError(response.status, answer.error ?? `The team server answered ${response.status}.`);
        }

        return answer.value as T;
    }

    /** The team accounts this person may see, and whether they manage them. */
    async list(): Promise<{ manage: boolean; accounts: TeamAccountRow[] }> {
        return await this.#call({ action: "list" });
    }

    async add(provider: unknown, name: unknown): Promise<unknown> {
        return await this.#call({ action: "add", provider, name });
    }

    async rename(id: string, name: unknown): Promise<unknown> {
        return await this.#call({ action: "rename", id, name });
    }

    async logout(id: string): Promise<void> {
        await this.#call({ action: "logout", id });
    }

    async remove(id: string): Promise<void> {
        await this.#call({ action: "remove", id });
    }

    /**
     * Sign a team account in, on the gateway: its steps reach this person's tabs as they come, as one of their own
     * sign-ins does. `onDone`: after it finished (well or not).
     */
    async startLogin(id: string, providerName: string, type: "oauth" | "api_key", onDone: () => void): Promise<string> {
        const { flowId } = await this.#call<{ flowId: string }>({ action: "login", id, type });

        this.#flows.add(flowId);
        void (async () => {
            let after = 0;

            try {
                for (;;) {
                    const { steps, done } = await this.#call<{ steps: Step[]; done: boolean }>({ action: "wait", flowId, after }, 40_000);

                    after += steps.length;

                    for (const step of steps) {
                        this.#send({ flowId, providerId: id, providerName, ...step });
                    }

                    if (done) {
                        break;
                    }
                }
            } catch (error) {
                this.#send({ flowId, providerId: id, providerName, step: "done", ok: false, loginType: type, error: "The team server stopped answering. Try again.", details: error instanceof Error ? error.message : String(error) });
            } finally {
                this.#flows.delete(flowId);
                onDone();
            }
        })();

        return flowId;
    }

    /** Whether a sign-in is one of the team's, under way here. */
    owns(flowId: string): boolean {
        return this.#flows.has(flowId);
    }

    async answer(flowId: string, promptId: string, value: string | undefined): Promise<void> {
        await this.#call({ action: "answer", flowId, promptId, value: value ?? null });
    }

    async cancel(flowId: string): Promise<void> {
        await this.#call({ action: "cancel", flowId });
    }
}
