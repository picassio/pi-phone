/**
 * Screenshots (DESIGN.md section 4): Pi sees what it made. The app's background service renders a page in an off-screen
 * WebView of the app (PiService.java's renderer), at the widths asked, signed in as the app's own WebView is, and posts
 * each picture back; the `screenshot` tool (`extensions/screenshot.ts`) gives them to Pi as images.
 *
 * The service long-polls `GET /api/phone/renders?after=<seq>` (as notifications poll `/api/phone/events`), renders each
 * request in turn, and answers `POST /api/phone/renders/<id>` with `{ shots: [{ width, height, jpeg (base64) }] }` or
 * `{ error }`. Requests are kept in memory: one that no service took, or answered, within its time fails, saying so.
 */

/** What the service renders: an address on the app's server, or any http(s) page. */
import { layoutCheck, type LayoutReport, parseLayout } from "./layout-check.ts";

export type RenderRequest = {
    seq: number;
    id: string;
    url: string;
    /** CSS pixel widths, each one picture. */
    widths: number[];
    /** Capture the whole page (up to `maxHeight`), not only the first screen. */
    fullPage: boolean;
    /** Tallest picture, in CSS pixels. */
    maxHeight: number;
    /** Wait after the page loads, for scripts, fonts, and pictures from the network. */
    settleMs: number;
    /** A script the page runs just before it is drawn (`layout-check.ts`): its JSON text comes back with the shot. */
    check: string;
};

/** A picture of the page at one width: `width` × `height` CSS pixels, as JPEGs from the top, each at most 2000 tall. */
export type Shot = { width: number; height: number; parts: Buffer[]; layout?: LayoutReport };

/** How long a poll waits for a request before it answers with none. */
export const RENDER_POLL_MS = 50_000;
/** A service that polled within this is there to render. */
const PRESENT_MS = RENDER_POLL_MS + 20_000;
const KEPT = 20;

type Pending = { request: RenderRequest; resolve: (shots: Shot[]) => void; reject: (error: Error) => void; timer: NodeJS.Timeout };

export class Screenshots {
    #seq = 0;
    readonly #requests: RenderRequest[] = [];
    readonly #pending = new Map<string, Pending>();
    readonly #waiting = new Set<() => void>();
    #lastPoll = 0;

    /** Whether the app's service polls now: it renders only on the phone, with the app installed. */
    present(): boolean {
        return Date.now() - this.#lastPoll < PRESENT_MS;
    }

    /** Render `url` at each width; resolves with one picture per width, or fails saying why. */
    render(
        url: string,
        { widths, fullPage = true, maxHeight = 4000, settleMs = 1500, timeoutMs = 90_000 }: { widths: number[]; fullPage?: boolean; maxHeight?: number; settleMs?: number; timeoutMs?: number },
    ): Promise<Shot[]> {
        if (!this.present()) {
            return Promise.reject(new Error("No phone is rendering: screenshots need the pi-phone app's service, which polls the server on the phone itself."));
        }

        const request: RenderRequest = { seq: ++this.#seq, id: crypto.randomUUID(), url, widths, fullPage, maxHeight, settleMs, check: layoutCheck() };

        this.#requests.push(request);

        if (this.#requests.length > KEPT) {
            this.#requests.shift();
        }

        return new Promise<Shot[]>((resolve, reject) => {
            const timer = setTimeout(() => {
                this.#pending.delete(request.id);
                reject(new Error(`The phone did not render ${url} within ${Math.round(timeoutMs / 1000)} seconds.`));
            }, timeoutMs);

            this.#pending.set(request.id, { request, resolve, reject, timer });

            for (const wake of [...this.#waiting]) {
                wake();
            }
        });
    }

    /** For the service: requests after `after` still waiting for an answer, waiting up to `RENDER_POLL_MS` for one. */
    async after(after: number, signal: AbortSignal): Promise<{ seq: number; requests: RenderRequest[] }> {
        this.#lastPoll = Date.now();
        const open = () => this.#requests.filter((request) => request.seq > after && this.#pending.has(request.id));

        if (after < 0) {
            // A service that (re)started takes what still waits.
            return { seq: this.#seq, requests: this.#requests.filter((request) => this.#pending.has(request.id)) };
        }

        if (open().length === 0) {
            await new Promise<void>((resolve) => {
                const wake = () => {
                    clearTimeout(timer);
                    this.#waiting.delete(wake);
                    resolve();
                };
                const timer = setTimeout(wake, RENDER_POLL_MS);

                this.#waiting.add(wake);
                signal.addEventListener("abort", wake, { once: true });
            });
        }

        this.#lastPoll = Date.now();

        return { seq: this.#seq, requests: open() };
    }

    /** The service's answer: pictures (base64 JPEG), or why it could not render. */
    answer(id: string, body: { shots?: unknown; error?: unknown }): void {
        const pending = this.#pending.get(id);

        if (pending === undefined) {
            throw new Error("No such render waits (it timed out, or was answered).");
        }

        this.#pending.delete(id);
        clearTimeout(pending.timer);

        if (typeof body.error === "string") {
            pending.reject(new Error(`The phone could not render ${pending.request.url}: ${body.error}`));

            return;
        }

        const shots = Array.isArray(body.shots) ? body.shots : [];
        const parsed = shots.map((shot: unknown) => {
            const each = shot as { width?: unknown; height?: unknown; parts?: unknown; check?: unknown };

            if (typeof each.width !== "number" || typeof each.height !== "number" || !Array.isArray(each.parts) || each.parts.length === 0 || !each.parts.every((part) => typeof part === "string")) {
                throw new Error("A shot is { width, height, parts: [jpeg] }.");
            }

            const layout = parseLayout(each.check);

            return { width: each.width, height: each.height, parts: (each.parts as string[]).map((part) => Buffer.from(part, "base64")), ...(layout === undefined ? {} : { layout }) };
        });

        if (parsed.length === 0) {
            pending.reject(new Error(`The phone answered no pictures for ${pending.request.url}.`));

            return;
        }

        pending.resolve(parsed);
    }
}
