// PP-200: how smooth the Browser panel is. Not part of `npm test`: run on a machine with Chrome (tuanlh-devbox-01),
// `node test/perf/browser-stream.ts [local|tailscale|slow]`, before and after a change to compare. Pi's browser is a headless Chrome reached through a TCP proxy that can
// hold Chrome's side to a bandwidth and a delay (a machine browser over the app's ssh forward, e.g. tualh-laptop over
// Tailscale); the panel is the real web app in another headless Chrome at a phone's size. Measured in the panel, from
// what it draws (its picture's middle pixel, read every animation frame):
//   fps        new pictures shown per second while the page animates
//   kB/frame   bytes Chrome sent per screencast frame (on the link)
//   lag        a change in the page (its color set at T) until the panel shows it
//   tap        a tap sent from the panel (Take over) until the page's answer shows
//   keys       10 keys sent from the panel, one after another: until the 10th's answer shows
import { createServer, type Server } from "node:http";
import { connect as tcpConnect, createServer as tcpServer, type Socket } from "node:net";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { cleanUp, newSession, openApp, root, scriptedModel } from "../helpers.ts";
import { createHandler } from "../../src/server/http.ts";
import { Cdp } from "../../src/server/browser/cdp.ts";
import type { BrowserEngine } from "../../src/server/browser/pi-browser.ts";
import type { BrowserPage } from "../../src/server/browser/page.ts";
import { ChromeEngine } from "../../src/server/browser/pi-browser.ts";

const PROFILES: Record<string, { bps: number; delayMs: number }> = {
    local: { bps: Infinity, delayMs: 0 },
    // Roughly tualh-laptop's uplink over Tailscale (owner's case): 12 Mbit/s, 25 ms each way.
    tailscale: { bps: 12_000_000 / 8, delayMs: 25 },
    slow: { bps: 4_000_000 / 8, delayMs: 40 },
};
const profile = PROFILES[process.argv[2] ?? "tailscale"]!;
const chromePath = process.env.CHROME ?? "google-chrome";

// ─── The page Pi's browser shows ────────────────────────────────────────────────────────────────────────────────────
const page = `<!doctype html><html><head><style>html,body{margin:0;height:100%}#c{position:fixed;inset:0}
.noise{position:fixed;inset:0;background:repeating-linear-gradient(45deg,rgba(0,0,0,.06) 0 2px,transparent 2px 9px)}
p{position:relative;font:16px system-ui;padding:20px;max-width:900px}</style></head><body><div id=c></div><div class=noise></div>
${Array.from({ length: 30 }, (_, i) => `<p>Row ${i}: the quick brown fox jumps over the lazy dog, settings and values for a web app.</p>`).join("")}
<script>
const c=document.getElementById('c');let anim=false,n=0,keys=0;
const hue=(h)=>'hsl('+h+',90%,50%)';
window.setColor=(css)=>{anim=false;c.style.background=css};
window.animate=(on)=>{anim=on;if(on)requestAnimationFrame(tick)};
function tick(){if(!anim)return;n++;c.style.background=hue((n*37)%360);requestAnimationFrame(tick)}
addEventListener('click',()=>{c.style.background=c.style.background==='rgb(255, 0, 255)'?'rgb(0, 255, 255)':'rgb(255, 0, 255)'});
addEventListener('keydown',()=>{keys++;c.style.background=keys>=10?'rgb(255, 255, 0)':'rgb('+(keys*20)+',0,0)'});
</script></body></html>`;
const pageServer: Server = createServer((_q, r) => r.end(page)).listen(0, "127.0.0.1");

await new Promise((resolve) => pageServer.once("listening", resolve));

const pageUrl = `http://127.0.0.1:${(pageServer.address() as { port: number }).port}/`;

// ─── Pi's browser: Chrome behind a throttling proxy ─────────────────────────────────────────────────────────────────
const profileDir = mkdtempSync(join(tmpdir(), "perf-chrome-"));
const chrome = spawn(chromePath, ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profileDir}`, "--no-sandbox", "--no-first-run", "--disable-gpu", "about:blank"], { stdio: "ignore" });
let devPort = 0;

for (let i = 0; i < 200 && devPort === 0; i++) {
    try {
        devPort = Number(readFileSync(join(profileDir, "DevToolsActivePort"), "utf8").split("\n")[0]);
    } catch {
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
}

let linkBytes = 0;
let linkFrames = 0;

/** One direction of a link: at most `bps`, each chunk `delayMs` late, in order. */
function pipe(from: Socket, to: Socket, count: boolean): void {
    let free = 0;
    const queue: { at: number; chunk: Buffer }[] = [];
    let timer: NodeJS.Timeout | undefined;
    // In order, each when due: one timer for the head of the queue.
    const drain = () => {
        timer = undefined;

        while (queue.length > 0 && queue[0]!.at <= Date.now()) {
            to.write(queue.shift()!.chunk);
        }

        if (queue.length > 0) {
            timer = setTimeout(drain, Math.max(1, queue[0]!.at - Date.now()));
        }
    };

    from.on("data", (chunk: Buffer) => {
        const now = Date.now();
        const transfer = profile.bps === Infinity ? 0 : (chunk.length / profile.bps) * 1000;

        free = Math.max(free, now) + transfer;

        if (count) {
            linkBytes += chunk.length;
            linkFrames += chunk.toString("latin1").split("Page.screencastFrame\"").length - 1;
        }

        if (profile.delayMs === 0 && transfer === 0 && queue.length === 0) {
            to.write(chunk);

            return;
        }

        queue.push({ at: free + profile.delayMs, chunk });
        timer ??= setTimeout(drain, Math.max(0, queue[0]!.at - now));
    });
    from.on("close", () => {
        setTimeout(() => to.destroy(), profile.delayMs + 50);
    });
    from.on("error", (error) => {
        console.error(`[proxy] ${count ? "chrome side" : "server side"} error: ${error.message}`);
        to.destroy();
    });
}

const proxy = tcpServer((client) => {
    const upstream = tcpConnect(devPort, "127.0.0.1");

    pipe(client, upstream, false);
    pipe(upstream, client, true);
}).listen(0, "127.0.0.1");

await new Promise((resolve) => proxy.once("listening", resolve));

const proxyPort = (proxy.address() as { port: number }).port;
const json = async (path: string, method = "GET") => (await fetch(`http://127.0.0.1:${devPort}${path}`, { method })).json() as Promise<unknown>;
const engine: BrowserEngine = {
    label: "the machine's Chrome",
    popups: false,
    asksWindows: false,
    watchWindows: () => () => {},
    local: true,
    actAsPhone: true,
    reopensToResize: false,
    tabs: async () => [],
    newTab: async () => ((await json("/json/new?about:blank", "PUT")) as { id: string }).id,
    connect: (id: string) => Cdp.connect({ url: `ws://127.0.0.1:${proxyPort}/devtools/page/${id}` }),
    closeTab: async (id: string) => void (await fetch(`http://127.0.0.1:${devPort}/json/close/${id}`)),
    close: async () => {},
    pdf: async () => Buffer.alloc(0),
    picture: (_id: string, p: BrowserPage, quality: number, timeoutMs?: number, options?: Parameters<BrowserPage["screenshot"]>[2]) => p.screenshot(quality, timeoutMs, options),
    stage: async (name: string) => name,
};

// ─── The app, and the panel in a phone-sized Chrome ─────────────────────────────────────────────────────────────────
const app = await openApp(scriptedModel(), join(root, "perf"), undefined, { browserEngine: engine, log: (line) => /browser/.test(line) && console.error(`[app] ${line}`) });
const session = Number(await newSession(app));
const server = createServer(createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }));

await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const browser = app.browserAt("phone", session);

await browser.resize(session, "desktop");
await browser.open(session, pageUrl);

const viewerEngine = new ChromeEngine(chromePath, ["--no-sandbox"]);
const viewer = await viewerEngine.connect(await viewerEngine.newTab());
const inViewer = async <T>(expression: string): Promise<T> => {
    const answer = await viewer.send<{ result: { value?: unknown }; exceptionDetails?: { exception?: { description?: string } } }>("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, 60_000);

    if (answer.exceptionDetails !== undefined) {
        throw new Error(answer.exceptionDetails.exception?.description ?? "the viewer threw");
    }

    return answer.result.value as T;
};
const inPi = async (expression: string) => {
    const tab = ((await json("/json/list")) as { id: string; type: string; url: string }[]).find((each) => each.url === pageUrl)!;
    const direct = await Cdp.connect({ url: `ws://127.0.0.1:${devPort}/devtools/page/${tab.id}` });

    try {
        await direct.send("Runtime.evaluate", { expression });
    } finally {
        direct.close();
    }
};

await viewer.send("Page.enable");
await viewer.send("Emulation.setDeviceMetricsOverride", { width: 412, height: 860, deviceScaleFactor: 2.625, mobile: true });
await viewer.send("Page.navigate", { url: `${base}/login?token=${encodeURIComponent(app.config.ownerToken)}&next=/s/${session}` });
await new Promise((resolve) => setTimeout(resolve, 4000));
await inViewer(`(async () => { const store = await import("/store.js"); if (store.store.state.conversationId !== ${session}) store.navigate(${session}); })()`);
await new Promise((resolve) => setTimeout(resolve, 1500));
await inViewer(`(async () => { const { setBrowserOpen } = await import("/browser-panel.js"); setBrowserOpen(true); })()`);
await new Promise((resolve) => setTimeout(resolve, 3000));
// The sampler: the panel's picture's middle pixel, every animation frame, its changes kept with their time.
await inViewer(`(() => {
    const probe = new OffscreenCanvas(1, 1).getContext("2d", { willReadFrequently: true });
    window.seen = [];
    let last = "";
    const sample = () => {
        const shown = document.querySelector(".pb-frame canvas, .pb-frame img");
        if (shown && (shown.tagName === "CANVAS" || shown.complete) && (shown.width || shown.naturalWidth)) {
            const w = shown.tagName === "CANVAS" ? shown.width : shown.naturalWidth;
            const h = shown.tagName === "CANVAS" ? shown.height : shown.naturalHeight;
            try {
                probe.drawImage(shown, w * 0.75, h * 0.08, 1, 1, 0, 0, 1, 1);
                const [r, g, b] = probe.getImageData(0, 0, 1, 1).data;
                const key = r + "," + g + "," + b;
                if (key !== last) { last = key; window.seen.push({ t: Date.now(), r, g, b }); }
            } catch {}
        }
        requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
})()`);

const near = (s: { r: number; g: number; b: number }, [r, g, b]: number[]) => Math.abs(s.r - r!) + Math.abs(s.g - g!) + Math.abs(s.b - b!) < 90;
const shownAt = async (color: number[], after: number, timeoutMs = 15_000): Promise<number | undefined> => {
    const end = Date.now() + timeoutMs;

    while (Date.now() < end) {
        const seen = await inViewer<{ t: number; r: number; g: number; b: number }[]>("window.seen");
        const hit = seen.find((each) => each.t >= after && near(each, color));

        if (hit !== undefined) {
            return hit.t;
        }

        await new Promise((resolve) => setTimeout(resolve, 50));
    }

    return undefined;
};
const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? NaN;

// fps and bytes per frame while the page animates for 5 s.
await inPi("animate(true)");
await new Promise((resolve) => setTimeout(resolve, 1000));

const fromSeen = (await inViewer<unknown[]>("window.seen")).length;
const [bytes0, frames0] = [linkBytes, linkFrames];

await new Promise((resolve) => setTimeout(resolve, 5000));

const shownFrames = (await inViewer<unknown[]>("window.seen")).length - fromSeen;
const sentFrames = linkFrames - frames0;
const sentBytes = linkBytes - bytes0;

await inPi("animate(false)");
await new Promise((resolve) => setTimeout(resolve, 1500));

// Lag: a color set in the page until the panel shows it.
const lags: number[] = [];
const arrivals: number[] = [];
const colors = [[0, 0, 255], [0, 255, 0], [255, 0, 0], [0, 0, 255], [0, 255, 0], [255, 0, 0]];

for (const color of colors) {
    const at = Date.now();

    const seqBefore = (browser.lastFrame() as { seq?: number } | undefined)?.seq;
    let arrived = NaN;
    const watcher = setInterval(() => {
        const now = browser.lastFrame() as { seq?: number } | undefined;

        if (Number.isNaN(arrived) && now !== undefined && (now.seq === undefined ? true : now.seq !== seqBefore)) {
            arrived = Date.now() - at;
        }
    }, 2);

    await inPi(`setColor("rgb(${color.join(",")})")`);

    const shown = await shownAt(color, at);

    clearInterval(watcher);
    arrivals.push(arrived);
    lags.push(shown === undefined ? NaN : shown - at);
    await new Promise((resolve) => setTimeout(resolve, 600));
}

// Take over: taps, and 10 keys.
await inViewer(`(async () => { const { browserApi, setPiBrowser } = await import("/store.js"); setPiBrowser(await browserApi("browser/take-over", { on: true })); })()`);
await new Promise((resolve) => setTimeout(resolve, 1000));

const taps: number[] = [];

for (let i = 0; i < 6; i++) {
    const at = Date.now();
    const target = i % 2 === 0 ? [255, 0, 255] : [0, 255, 255];

    // As the panel taps: a click on its picture (the panel's own handler sends it).
    await inViewer(`(() => { const img = document.querySelector(".pb-frame canvas, .pb-frame img"); if (!img) throw new Error("no picture: " + (document.querySelector(".pb-body")?.innerText ?? "no panel") + " | " + document.querySelector(".pb-status")?.innerText); const box = img.getBoundingClientRect();
        img.dispatchEvent(new MouseEvent("click", { clientX: box.left + box.width * 0.75, clientY: box.top + box.height * 0.5, bubbles: true })); })()`);

    const shown = await shownAt(target, at);

    taps.push(shown === undefined ? NaN : shown - at);
    await new Promise((resolve) => setTimeout(resolve, 600));
}

const keysAt = Date.now();

await inViewer(`(() => { const field = document.querySelector(".pb-frame input, .pb-frame textarea"); if (!field) throw new Error("no keyboard field");
    for (let i = 0; i < 10; i++) field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); })()`);

const keysShown = await shownAt([255, 255, 0], keysAt, 30_000);

console.log(JSON.stringify({
    profile: process.argv[2] ?? "tailscale",
    fps: +(shownFrames / 5).toFixed(1),
    sentFps: +(sentFrames / 5).toFixed(1),
    kBPerFrame: Math.round(sentBytes / Math.max(1, sentFrames) / 1024),
    linkMbps: +((sentBytes * 8) / 5 / 1e6).toFixed(1),
    lagMs: { median: median(lags), all: lags, atServer: arrivals },
    tapMs: { median: median(taps), all: taps },
    keys10Ms: keysShown === undefined ? null : keysShown - keysAt,
}));

viewer.close();
await viewerEngine.close();
await app.close();
server.close();
proxy.close();
pageServer.close();
chrome.kill();
cleanUp();
process.exit(0);
