/**
 * A render request (`screenshots.ts`) drawn in a tab of a Chrome over DevTools, at one width: the server edition's
 * renderer (`chrome-renderer.ts`, a headless Chrome of its own) and Pi's browser (PP-500: a background tab of the
 * session's browser on a machine or the server edition, with its profile's sign-ins) both draw this way, as the phone's
 * `Renderer.java` does: laid out at a phone's or a desktop's height, then as tall as the picture, steps run, the page's
 * script measures it, and JPEGs of at most 2000 pixels tall come back.
 */
import type { Cdp } from "./browser/cdp.ts";
import { MAX_PAGES, parseStepsState, STEPS_MS, STEPS_STATE, stepsFrom } from "./render-steps.ts";
import { parseShot, type RenderRequest, type Shot } from "./screenshots.ts";

/** The tallest part of a picture: models take no image over 2000 pixels a side once a conversation holds many. */
const PART = 2000;

/** Where the tabs come from: a Chrome's DevTools. */
export type TabMaker = { newTab(): Promise<string>; connect(id: string): Promise<Cdp>; closeTab(id: string): Promise<void> };

/** A shot as a renderer answers it (`parseShot` takes it). */
export type RawShot = { width: number; height: number; parts: string[]; check: string; steps?: number };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * One width in a new tab, closed after: laid out as the phone's renderer lays it out (a phone's height, or a desktop's),
 * then pictured. `prepare` runs on the tab's connection before the page loads (the app's token for its own pages).
 */
export async function shootInTab(tabs: TabMaker, request: RenderRequest, width: number, prepare?: (cdp: Cdp) => Promise<void>): Promise<RawShot> {
    const id = await tabs.newTab();
    let cdp: Cdp | undefined;

    try {
        cdp = await tabs.connect(id);

        const page = cdp;
        const viewport = width < 600 ? 844 : 800;

        await page.send("Page.enable");
        await page.send("Emulation.setDeviceMetricsOverride", { width, height: viewport, deviceScaleFactor: 1, mobile: width < 600 });
        await prepare?.(page);
        await load(page, request.url);
        await sleep(request.settleMs);

        const evaluate = async <T>(expression: string): Promise<T> =>
            ((await page.send("Runtime.evaluate", { expression, returnByValue: true })) as { result: { value: T } }).result.value;
        // The whole page's height, a box it scrolls in included (`PAGE_HEIGHT`, PP-440).
        const heightOf = async (): Promise<number> => {
            const measured = await evaluate<unknown>(request.height);

            if (typeof measured !== "number" || !Number.isFinite(measured)) {
                throw new Error(`the page's height could not be measured (${String(measured)})`);
            }

            const content = Math.max(viewport, Math.ceil(measured));

            return request.fullPage ? Math.min(content, request.maxHeight) : viewport;
        };
        const layOut = async (height: number) => {
            // As tall as the picture, as the phone lays it out: the whole page is in view.
            await page.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: width < 600 });
            await sleep(400);
        };
        let height = await heightOf();

        if (height !== viewport) {
            await layOut(height);
        }

        // Steps before the shot (PP-423, `render-steps.ts`); a page a step loaded is measured again (PP-500).
        if (request.stepCount > 0 && (await runSteps(evaluate, request))) {
            const now = await heightOf();

            if (now !== height) {
                height = now;
                await layOut(height);
            }
        }

        // The page measures itself just before it is pictured.
        let check = await evaluate<string>(request.check);

        // An open modal in a whole-page picture (PP-501): position:fixed follows the view, laid out as tall as the page,
        // so the dialog sat mid-page (y 1650-2340 of 4000 on visa-dashboard). The view the person has is pictured, at the
        // phone's or desktop's height, and measured again there; the answer says so.
        if (height !== viewport && modalOpen(check)) {
            height = viewport;
            await layOut(height);
            check = await evaluate<string>(request.check);
        }

        const parts: string[] = [];

        for (let top = 0; top < height; top += PART) {
            const shot = (await page.send("Page.captureScreenshot", {
                format: "jpeg",
                quality: 82,
                clip: { x: 0, y: top, width, height: Math.min(PART, height - top), scale: 1 },
            })) as { data: string };

            parts.push(shot.data);
        }

        return { width, height, parts, check, ...(request.stepCount > 0 ? { steps: request.stepCount } : {}) };
    } finally {
        cdp?.close();
        await tabs.closeTab(id).catch(() => {});
    }
}

/**
 * Run the request's steps: started, then read every 100 ms until done, failed, or `STEPS_MS` passed. A read that finds
 * no state is a new page a step loaded: once it loaded, the steps go on there from the first not done. Whether a step
 * loaded a page.
 */
async function runSteps(evaluate: <T>(expression: string) => Promise<T>, request: RenderRequest): Promise<boolean> {
    await evaluate<string>(request.steps);

    const until = Date.now() + STEPS_MS;
    let resume = 0;
    let pages = 0;

    for (;;) {
        if (Date.now() > until) {
            throw new Error(`the steps did not finish within ${STEPS_MS / 1000} seconds (at step ${resume + 1})`);
        }

        // While a page is replaced, there may be no page to ask: asked again.
        const read = await evaluate<string>(STEPS_STATE).then(
            (value) => ({ value }),
            () => undefined,
        );

        if (read === undefined) {
            await sleep(100);
            continue;
        }

        const state = parseStepsState(read.value);

        if (state === undefined) {
            if ((await evaluate<boolean>("document.readyState === 'complete'").catch(() => false)) !== true) {
                await sleep(100);
                continue;
            }

            if (++pages > MAX_PAGES) {
                throw new Error(`the steps loaded more than ${MAX_PAGES} pages (at step ${resume + 1})`);
            }

            // Its scripts start, as after the first page's load.
            await sleep(300);

            if (resume >= request.stepCount) {
                return true;
            }

            await evaluate<string>(stepsFrom(resume) + request.steps);
            continue;
        }

        resume = state.resume ?? resume;

        if (state.state === "failed") {
            throw new Error(`a step failed: ${state.error ?? "no reason given"}`);
        }

        if (state.state === "done") {
            return pages > 0;
        }

        await sleep(100);
    }
}

/** Whether a check's answer is a layout check that names an open modal dialog (`layout-check.ts` `modal`). */
export function modalOpen(check: string): boolean {
    return check.startsWith("{") && typeof (JSON.parse(check) as { modal?: unknown }).modal === "string";
}

/** Open the page and wait until it loaded (45 s at most). */
async function load(cdp: Cdp, url: string): Promise<void> {
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

    let timer: NodeJS.Timeout | undefined;

    // The wait's timer is cleared once the page loaded: left running, it held the process 45 s after the last page.
    await Promise.race([loaded, new Promise((resolve) => (timer = setTimeout(resolve, 45_000)))]).finally(() => clearTimeout(timer));
}

/** Every width of a request, one after another, each in a tab of its own: the shots, checked as the phone's are. */
export async function renderInTabs(tabs: TabMaker, request: RenderRequest): Promise<Shot[]> {
    const shots: Shot[] = [];

    for (const width of request.widths) {
        shots.push(parseShot(request, await shootInTab(tabs, request, width)));
    }

    return shots;
}
