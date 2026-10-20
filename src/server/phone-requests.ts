/**
 * Requests for the app's background service, long-polled as screenshots are (`screenshots.ts`): the server queues one,
 * the service takes it (`GET /api/phone/<kind>?after=<seq>`) and answers it (`POST /api/phone/<kind>/<id>`). Pi's
 * browser (`browser/pi-browser.ts`) uses it to have the service make and remove its WebView.
 */

/** How long a poll waits for a request before it answers with none. */
export const PHONE_POLL_MS = 50_000;
/** A service that polled within this is there to answer. */
const PRESENT_MS = PHONE_POLL_MS + 20_000;
const KEPT = 20;

export type PhoneRequest = { seq: number; id: string } & Record<string, unknown>;

type Pending = { request: PhoneRequest; resolve: (answer: Record<string, unknown>) => void; reject: (error: Error) => void; timer: NodeJS.Timeout };

export class PhoneRequests {
    readonly #what: string;
    #seq = 0;
    readonly #requests: PhoneRequest[] = [];
    readonly #pending = new Map<string, Pending>();
    readonly #waiting = new Set<() => void>();
    #lastPoll = 0;

    /** `what` names the requests in errors ("Pi's browser"). */
    constructor(what: string) {
        this.#what = what;
    }

    /** Whether the app's service polls now: only on the phone, with the app installed. */
    present(): boolean {
        return Date.now() - this.#lastPoll < PRESENT_MS;
    }

    /** Queue a request; resolves with the service's answer, or fails with the error it gave. */
    request(payload: Record<string, unknown>, timeoutMs = 30_000): Promise<Record<string, unknown>> {
        if (!this.present()) {
            return Promise.reject(new Error(`${this.#what} needs the pi-phone app's service, which polls the server on the phone itself.`));
        }

        const request: PhoneRequest = { ...payload, seq: ++this.#seq, id: crypto.randomUUID() };

        this.#requests.push(request);

        if (this.#requests.length > KEPT) {
            this.#requests.shift();
        }

        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.#pending.delete(request.id);
                reject(new Error(`The phone did not answer for ${this.#what} within ${Math.round(timeoutMs / 1000)} seconds.`));
            }, timeoutMs);

            this.#pending.set(request.id, { request, resolve, reject, timer });

            for (const wake of [...this.#waiting]) {
                wake();
            }
        });
    }

    /** For the service: requests after `after` still waiting for an answer, waiting up to `PHONE_POLL_MS` for one. */
    async after(after: number, signal: AbortSignal): Promise<{ seq: number; requests: PhoneRequest[] }> {
        this.#lastPoll = Date.now();
        const open = () => this.#requests.filter((request) => request.seq > after && this.#pending.has(request.id));

        if (after < 0) {
            return { seq: this.#seq, requests: this.#requests.filter((request) => this.#pending.has(request.id)) };
        }

        if (open().length === 0) {
            await new Promise<void>((resolve) => {
                const wake = () => {
                    clearTimeout(timer);
                    this.#waiting.delete(wake);
                    resolve();
                };
                const timer = setTimeout(wake, PHONE_POLL_MS);

                this.#waiting.add(wake);
                signal.addEventListener("abort", wake, { once: true });
            });
        }

        this.#lastPoll = Date.now();

        return { seq: this.#seq, requests: open() };
    }

    /** The service's answer: what it reports, or `{ error }` saying why it could not. */
    answer(id: string, body: Record<string, unknown>): void {
        const pending = this.#pending.get(id);

        if (pending === undefined) {
            throw new Error("No such request waits (it timed out, or was answered).");
        }

        this.#pending.delete(id);
        clearTimeout(pending.timer);

        if (typeof body.error === "string") {
            pending.reject(new Error(`The phone could not do it for ${this.#what}: ${body.error}`));

            return;
        }

        pending.resolve(body);
    }
}
