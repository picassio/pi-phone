/**
 * Screenshots (DESIGN.md section 4): Pi sees what it made. The app's background service renders a page in an off-screen
 * WebView of the app (PiService.java's renderer), at the widths asked, signed in as the app's own WebView is, and posts
 * each picture back; the `screenshot` tool (`extensions/screenshot.ts`) gives them to Pi as images.
 *
 * The service long-polls `GET /api/phone/renders?after=<seq>` (as notifications poll `/api/phone/events`), renders each
 * request in turn, and answers `POST /api/phone/renders/<id>` with `{ shots: [{ width, height, jpeg (base64) }] }` or
 * `{ error }`. Requests are kept in memory: one that no service took, or answered, within its time fails, saying so.
 *
 * A renderer (the phone's `Renderer.java`, the server edition's `chrome-renderer.ts`) renders one request at a time, in
 * the order they came. So a request's time runs while it is first in line, not while it waits behind others (PP-429:
 * the artifact check's three widths, each given 40 s, timed out behind each other on a busy CI runner).
 */

/** What the service renders: an address on the app's server, or any http(s) page. */
import { layoutCheck, type LayoutReport, parseLayout } from "./layout-check.ts";
import { type RenderStep, stepsScript } from "./render-steps.ts";

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
    /**
     * Steps run before each width's check and picture (PP-423, `render-steps.ts`): the script that runs them, "" for none,
     * and how many; a renderer that ran them answers `steps` with that count in each shot.
     */
    steps: string;
    stepCount: number;
};

/** A picture of the page at one width: `width` × `height` CSS pixels, as JPEGs from the top, each at most 2000 tall. */
export type Shot = {
    width: number;
    height: number;
    parts: Buffer[];
    layout?: LayoutReport;
    /** What the request's script answered, as it came (another script than the layout check: the redlines' measure, PP-398). */
    check?: string;
};

/**
 * What the screenshot tool and the artifact check render by default: a phone's width, a desktop's and a large screen's
 * (PP-420: the owner found 1280 not enough), in CSS pixels. A 1920 px picture is sent as it is, not scaled: under the
 * 2000 px a side models take, and its text as sharp as the 1280 one's.
 */
export const DEFAULT_WIDTHS = [390, 1280, 1920];

/** How long a poll waits for a request before it answers with none. */
export const RENDER_POLL_MS = 50_000;
/** A service that polled within this is there to render. */
const PRESENT_MS = RENDER_POLL_MS + 20_000;
const KEPT = 20;

type Pending = {
    request: RenderRequest;
    resolve: (shots: Shot[]) => void;
    reject: (error: Error) => void;
    timeoutMs: number;
    /** Running once the request is first in line. */
    timer: NodeJS.Timeout | undefined;
    /** A renderer's poll has taken it. */
    taken: boolean;
};

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
        {
            widths,
            fullPage = true,
            maxHeight = 4000,
            settleMs = 1500,
            timeoutMs = 90_000,
            check = layoutCheck(),
            steps = [],
        }: { widths: number[]; fullPage?: boolean; maxHeight?: number; settleMs?: number; timeoutMs?: number; check?: string; steps?: readonly RenderStep[] },
    ): Promise<Shot[]> {
        if (!this.present()) {
            return Promise.reject(new Error("No phone is rendering: screenshots need the pi-phone app's service, which polls the server on the phone itself."));
        }

        const request: RenderRequest = {
            seq: ++this.#seq,
            id: crypto.randomUUID(),
            url,
            widths,
            fullPage,
            maxHeight,
            settleMs,
            check,
            steps: steps.length === 0 ? "" : stepsScript(steps),
            stepCount: steps.length,
        };

        this.#requests.push(request);

        if (this.#requests.length > KEPT) {
            this.#requests.shift();
        }

        return new Promise<Shot[]>((resolve, reject) => {
            this.#pending.set(request.id, { request, resolve, reject, timeoutMs, timer: undefined, taken: false });
            this.#clock();

            for (const wake of [...this.#waiting]) {
                wake();
            }
        });
    }

    /**
     * Start the time of the request first in line (the oldest that waits: the one being rendered). When it runs out on a
     * request no renderer took, nobody renders now: the ones behind it fail with it, rather than each waiting its time.
     */
    #clock(): void {
        const first = this.#pending.values().next().value;

        if (first === undefined || first.timer !== undefined) {
            return;
        }

        first.timer = setTimeout(() => {
            const failed = first.taken ? [first] : [...this.#pending.values()];

            for (const each of failed) {
                clearTimeout(each.timer);
                this.#pending.delete(each.request.id);
                each.reject(new Error(`The phone did not render ${each.request.url} within ${Math.round(each.timeoutMs / 1000)} seconds.`));
            }

            this.#clock();
        }, first.timeoutMs);
    }

    /** For the service: requests after `after` still waiting for an answer, waiting up to `RENDER_POLL_MS` for one. */
    async after(after: number, signal: AbortSignal): Promise<{ seq: number; requests: RenderRequest[] }> {
        this.#lastPoll = Date.now();
        const open = () => this.#requests.filter((request) => request.seq > after && this.#pending.has(request.id));

        if (after < 0) {
            // A service that (re)started takes what still waits.
            return { seq: this.#seq, requests: this.#take(this.#requests.filter((request) => this.#pending.has(request.id))) };
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

        return { seq: this.#seq, requests: this.#take(open()) };
    }

    #take(requests: RenderRequest[]): RenderRequest[] {
        for (const request of requests) {
            this.#pending.get(request.id)!.taken = true;
        }

        return requests;
    }

    /** The service's answer: pictures (base64 JPEG), or why it could not render. */
    answer(id: string, body: { shots?: unknown; error?: unknown }): void {
        const pending = this.#pending.get(id);

        if (pending === undefined) {
            throw new Error("No such render waits (it timed out, or was answered).");
        }

        this.#pending.delete(id);
        clearTimeout(pending.timer);
        this.#clock();

        if (typeof body.error === "string") {
            pending.reject(new Error(`The phone could not render ${pending.request.url}: ${body.error}`));

            return;
        }

        const shots = Array.isArray(body.shots) ? body.shots : [];

        // An app from before steps (PP-423) draws the page without them: a picture of another state, never passed off.
        if (pending.request.stepCount > 0 && !shots.every((shot: unknown) => (shot as { steps?: unknown }).steps === pending.request.stepCount)) {
            pending.reject(new Error("This pi-phone app does not run steps before a screenshot yet: update it (Menu › Check for app updates), or take the screenshot without steps."));

            return;
        }

        const parsed = shots.map((shot: unknown) => {
            const each = shot as { width?: unknown; height?: unknown; parts?: unknown; check?: unknown };

            if (typeof each.width !== "number" || typeof each.height !== "number" || !Array.isArray(each.parts) || each.parts.length === 0 || !each.parts.every((part) => typeof part === "string")) {
                throw new Error("A shot is { width, height, parts: [jpeg] }.");
            }

            const layout = parseLayout(each.check, each.width);

            return {
                width: each.width,
                height: each.height,
                parts: (each.parts as string[]).map((part) => Buffer.from(part, "base64")),
                ...(layout === undefined ? {} : { layout }),
                ...(typeof each.check === "string" ? { check: each.check } : {}),
            };
        });

        if (parsed.length === 0) {
            pending.reject(new Error(`The phone answered no pictures for ${pending.request.url}.`));

            return;
        }

        pending.resolve(parsed);
    }
}
