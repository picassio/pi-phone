/**
 * Screenshots on the server edition (PP-20): what the phone's `Renderer.java` does, with a headless Chrome. It takes the
 * render requests the phone's service would poll (`Screenshots.after`), lays each page out at each width in a tab of its
 * own (`tab-render.ts`), runs the page's layout check (`layout-check.ts`), and answers with JPEGs of at most 2000 pixels
 * tall, as the phone does. The app's own pages load signed in as the owner: the token goes only to requests for the
 * app's address, never to any other site a page loads.
 */
import type { Cdp } from "./browser/cdp.ts";
import { ChromeEngine } from "./browser/pi-browser.ts";
import type { RenderRequest, Screenshots } from "./screenshots.ts";
import { type RawShot, shootInTab } from "./tab-render.ts";

type Options = {
    /** Chrome headless shell, or Chrome. */
    binary: string;
    flags?: string[];
    /** The app's own address (`http://127.0.0.1:8787`), and the owner token its pages are signed in with. */
    base: string;
    token: () => string;
    log: (line: string) => void;
};

export class ChromeRenderer {
    readonly #screenshots: Screenshots;
    readonly #options: Options;
    readonly #engine: ChromeEngine;
    readonly #stop = new AbortController();

    constructor(screenshots: Screenshots, options: Options) {
        this.#screenshots = screenshots;
        this.#options = options;
        this.#engine = new ChromeEngine(options.binary, options.flags ?? []);
    }

    /** Take requests until stopped, one at a time, as the phone does. */
    async run(): Promise<void> {
        let after = -1;

        while (!this.#stop.signal.aborted) {
            try {
                const { seq, requests } = await this.#screenshots.after(after, this.#stop.signal);

                for (const request of requests) {
                    await this.#handle(request);
                }

                after = seq;
            } catch (error) {
                if (!this.#stop.signal.aborted) {
                    this.#options.log(`renders: ${String(error)}`);
                    await new Promise((resolve) => setTimeout(resolve, 3000));
                }
            }
        }
    }

    /** Start Chrome now and wait until it answers, rather than on the first request (whose time its start would take). */
    async ready(): Promise<void> {
        await this.#engine.tabs();
    }

    async stop(): Promise<void> {
        this.#stop.abort();
        await this.#engine.close();
    }

    async #handle(request: RenderRequest): Promise<void> {
        const started = Date.now();
        let answer: { shots: unknown[] } | { error: string };

        try {
            // Pi's browser's profile is the phone's WebView's (PP-500): this Chrome has none, and never draws without it.
            if (request.profile !== "") {
                throw new Error(`this renderer has no profile ${request.profile}`);
            }

            const shots = [];

            for (const width of request.widths) {
                shots.push(await this.#shot(request, width));
            }

            answer = { shots };
        } catch (error) {
            answer = { error: error instanceof Error ? error.message : String(error) };
            this.#options.log(`renders: ${request.url} at ${request.widths.join(", ")} px failed after ${Date.now() - started} ms: ${answer.error}`);
        }

        // An answer that came too late is said here, and the next request still rendered.
        try {
            this.#screenshots.answer(request.id, answer);
        } catch (error) {
            this.#options.log(`renders: ${request.url} at ${request.widths.join(", ")} px, after ${Date.now() - started} ms: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    /** One width (`tab-render.ts`), signed in to the app's own pages. */
    #shot(request: RenderRequest, width: number): Promise<RawShot> {
        return shootInTab(this.#engine, request, width, async (cdp: Cdp) => {
            const own = `${this.#options.base}/`;

            // Only the app's own requests carry the owner token.
            cdp.on("Fetch.requestPaused", (params) => {
                const asked = params.request as { url: string; headers: Record<string, string> };
                const headers = Object.entries(asked.headers).map(([name, value]) => ({ name, value }));

                void cdp
                    .send("Fetch.continueRequest", {
                        requestId: params.requestId,
                        headers: asked.url.startsWith(own) ? [...headers, { name: "Authorization", value: `Bearer ${this.#options.token()}` }] : headers,
                    })
                    .catch(() => {});
            });
            await cdp.send("Fetch.enable", { patterns: [{ urlPattern: `${own}*` }] });
        });
    }
}
