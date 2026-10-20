/**
 * Screenshots on the server edition (PP-20): what the phone's `Renderer.java` does, with a headless Chrome. It takes the
 * render requests the phone's service would poll (`Screenshots.after`), lays each page out at each width in a tab of its
 * own, runs the page's layout check (`layout-check.ts`), and answers with JPEGs of at most 2000 pixels tall, as the phone
 * does. The app's own pages load signed in as the owner: the token goes only to requests for the app's address, never
 * to any other site a page loads.
 */
import type { Cdp } from "./browser/cdp.ts";
import { ChromeEngine } from "./browser/pi-browser.ts";
import type { RenderRequest, Screenshots } from "./screenshots.ts";

/** The tallest part of a picture: models take no image over 2000 pixels a side once a conversation holds many. */
const PART = 2000;

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

    async stop(): Promise<void> {
        this.#stop.abort();
        await this.#engine.close();
    }

    async #handle(request: RenderRequest): Promise<void> {
        try {
            const shots = [];

            for (const width of request.widths) {
                shots.push(await this.#shot(request, width));
            }

            this.#screenshots.answer(request.id, { shots });
        } catch (error) {
            this.#screenshots.answer(request.id, { error: error instanceof Error ? error.message : String(error) });
        }
    }

    /** One width: laid out as the phone's renderer lays it out (a phone's height, or a desktop's), then pictured. */
    async #shot(request: RenderRequest, width: number): Promise<{ width: number; height: number; parts: string[]; check: string }> {
        const id = await this.#engine.newTab();
        const cdp = await this.#engine.connect(id);

        try {
            const viewport = width < 600 ? 844 : 800;
            const own = `${this.#options.base}/`;

            await cdp.send("Page.enable");
            await cdp.send("Emulation.setDeviceMetricsOverride", { width, height: viewport, deviceScaleFactor: 1, mobile: width < 600 });
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
            await this.#load(cdp, request.url);
            await new Promise((resolve) => setTimeout(resolve, request.settleMs));

            const evaluate = async <T>(expression: string): Promise<T> =>
                ((await cdp.send("Runtime.evaluate", { expression, returnByValue: true })) as { result: { value: T } }).result.value;
            const content = Math.max(viewport, Math.ceil(await evaluate<number>("Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0)")));
            const height = request.fullPage ? Math.min(content, request.maxHeight) : viewport;

            if (height !== viewport) {
                // As tall as the picture, as the phone lays it out: the whole page is in view.
                await cdp.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: width < 600 });
                await new Promise((resolve) => setTimeout(resolve, 400));
            }

            // The page measures itself just before it is pictured.
            const check = await evaluate<string>(request.check);
            const parts: string[] = [];

            for (let top = 0; top < height; top += PART) {
                const shot = (await cdp.send("Page.captureScreenshot", {
                    format: "jpeg",
                    quality: 82,
                    clip: { x: 0, y: top, width, height: Math.min(PART, height - top), scale: 1 },
                })) as { data: string };

                parts.push(shot.data);
            }

            return { width, height, parts, check };
        } finally {
            cdp.close();
            await this.#engine.closeTab(id).catch(() => {});
        }
    }

    /** Open the page and wait until it loaded (45 s at most). */
    async #load(cdp: Cdp, url: string): Promise<void> {
        const loaded = new Promise<void>((resolve) => {
            const off = cdp.on("Page.loadEventFired", () => {
                off();
                resolve();
            });
        });
        const answer = (await cdp.send("Page.navigate", { url })) as { errorText?: string };

        if (answer.errorText !== undefined && answer.errorText !== "") {
            throw new Error(`the page did not load: ${answer.errorText}`);
        }

        await Promise.race([loaded, new Promise((resolve) => setTimeout(resolve, 45_000))]);
    }
}
