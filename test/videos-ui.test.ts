// Menu › Videos in a real browser (PP-297, PP-298): the models that make videos and those that watch them through
// OpenRouter, Automatic first with the default it means, each with its price; a tap picks one, as the settings
// video.model and video.askModel keep it. A video video_generate made plays in the chat under its line, with its
// length and cost. With PHONE_SHOTS, screenshots go there.
import { type App, cleanUp, cleanUpAll, context, home, lastText, newSession, owner, pastWelcome, root, scriptedModel, until, work } from "./helpers.ts";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { localEngine } from "../src/server/media.ts";
import { DEFAULT_MAKE_MODEL } from "../src/server/video-gen.ts";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { Browsers } from "./support/browser.ts";
import { findBrowser } from "./support/browser/discovery.ts";
import type { BrowserPage } from "./support/browser/page.ts";
import { VIEWPORTS } from "./support/browser/viewport.ts";
import { createHandler } from "../src/server/http.ts";

const { PocketApp } = await import("../src/server/app.ts");

const chromium = findBrowser();
const real = { skip: chromium === undefined ? "no Chromium-based browser on this machine" : false } as const;
const SHOTS = process.env.PHONE_SHOTS;
const engine = localEngine();
let polls = 0;

const stub = createServer((request, response) => {
    request.resume();
    request.on("end", () => {
        if (request.url === "/api/v1/videos/models") {
            response.end(
                JSON.stringify({
                    data: [
                        { id: DEFAULT_MAKE_MODEL, name: "The default", supported_durations: [4, 6, 8], supported_resolutions: ["720p"], pricing_skus: { duration_seconds_without_audio: "0.03", duration_seconds_with_audio: "0.05" } },
                        { id: "alibaba/wan-3.0", name: "Alibaba: Wan 3.0", supported_durations: [2, 30], supported_resolutions: ["480p", "720p", "1080p"], pricing_skus: { duration_seconds_480p: "0.05" } },
                    ],
                }),
            );

            return;
        }

        if (request.url === "/api/v1/videos") {
            response.end(JSON.stringify({ id: "gen-vid-1", status: "pending" }));

            return;
        }

        if (request.url === "/api/v1/videos/gen-vid-1") {
            polls++;
            response.end(JSON.stringify(polls < 2 ? { status: "in_progress" } : { status: "completed", usage: { cost: 0.4 } }));

            return;
        }

        if (request.url?.startsWith("/api/v1/videos/gen-vid-1/content")) {
            response.end(readFileSync(join(work, "clip.mp4")));

            return;
        }

        response.end(
            JSON.stringify({
                data: [
                    { id: "google/gemini-3.5-flash-lite", name: "Google: Gemini 3.5 Flash-Lite", architecture: { input_modalities: ["text", "video"] }, pricing: { prompt: "0.0000003" } },
                    { id: "google/gemini-3.8-flash", name: "Google: Gemini 3.8 Flash", architecture: { input_modalities: ["text", "video"] }, pricing: { prompt: "0.00000075" } },
                    { id: "google/gemini-4-argon", name: "Google: Gemini 4 Argon", architecture: { input_modalities: ["text", "video"] }, pricing: { prompt: "0.000002" } },
                ],
            }),
        );
    });
});

let app: App;
let server: Server;
let browsers: Browsers;
let page: BrowserPage;
let base = "";

async function inPage<T>(script: string): Promise<T> {
    return JSON.parse(await page.evaluate(script)) as T;
}

const see = (script: string, what: string) => until(async () => (await inPage<boolean>(script)) === true, what);

before(async () => {
    if (chromium === undefined) {
        return;
    }

    await new Promise<void>((resolve) => stub.listen(0, "127.0.0.1", resolve));
    const route: FauxResponseStep = (request) => {
        const { role, text } = lastText(request as never);

        return role === "user" && text.endsWith("make a boat")
            ? fauxAssistantMessage([fauxToolCall("video_generate", { prompt: "A paper boat on a calm pond", duration: 8 })], { stopReason: "toolUse" })
            : fauxAssistantMessage([fauxText(role === "toolResult" ? "Here it is." : "ok")]);
    };
    const faux = scriptedModel(route);

    app = await PocketApp.open({
        dataDir: join(root, "videos-ui-data"),
        defaultCwd: work,
        supervised: false,
        log: () => {},
        home,
        configureModels: (models) => models.registerNativeProvider(faux.provider),
        officecli: { runs: false },
        videos: { endpoints: { openRouter: `http://127.0.0.1:${(stub.address() as AddressInfo).port}/api/v1` }, pollMs: 20 },
    });
    pastWelcome(app);
    await app.models.setRuntimeApiKey("openrouter", "or-test-key");
    server = createServer(createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    browsers = new Browsers({ dataDir: mkdtempSync(join(root, "videos-ui-browser-")), load: async () => undefined, save: () => {} });
    page = await browsers.open(1);
});

after(() =>
    cleanUpAll(
        () => browsers?.closeAll({ final: true }),
        () => server?.closeAllConnections(),
        () => server?.close(),
        () => stub.close(),
        () => app?.close(),
        () => cleanUp(),
    ),
);

test("Menu › Videos lists Automatic and the models that watch videos with their price; a tap picks one; the menu names it", real, async () => {
    await page.setViewport(VIEWPORTS.mobile);
    await page.navigate(`${base}/login?token=${encodeURIComponent(app.config.ownerToken)}`);
    await see(`return JSON.stringify((await import("/store.js")).store.state.me?.role === "owner")`, "signed in");
    await page.evaluate(`(await import("/store.js")).openSheet({ type: "videos" }); return "true";`);
    await see(`return JSON.stringify(document.querySelectorAll('[data-part="video-ask-model"]').length === 4)`, "Automatic and three models");

    const makers = await inPage<string[]>(`return JSON.stringify([...document.querySelectorAll('[data-part="video-model"]')].map((row) => [...row.querySelectorAll(".ds-text > span")].map((line) => line.textContent.replace(/\\s+/g, " ").trim()).join(" | ")))`);

    assert.deepEqual(makers, [
        `Automatic | Now ${DEFAULT_MAKE_MODEL}`,
        `The default | ${DEFAULT_MAKE_MODEL} · $0.03/s, $0.05/s with sound · 720p · 4-8 s`,
        "Alibaba: Wan 3.0 | alibaba/wan-3.0 · $0.05/s · 480p, 720p, 1080p · 2-30 s",
    ]);
    await page.evaluate(`document.querySelector('[data-part="video-model"][data-model="alibaba/wan-3.0"]').click(); return "true";`);
    await until(() => app.config.videoModel === "alibaba/wan-3.0", "the maker kept");
    await app.setVideoModel(owner(app), null);

    const rows = await inPage<string[]>(`return JSON.stringify([...document.querySelectorAll('[data-part="video-ask-model"]')].map((row) => [...row.querySelectorAll(".ds-text > span")].map((line) => line.textContent.replace(/\\s+/g, " ").trim()).join(" | ")))`);

    assert.deepEqual(rows, [
        "Automatic | Now google/gemini-3.5-flash-lite",
        "Google: Gemini 3.5 Flash-Lite | google/gemini-3.5-flash-lite · $0.30/M in",
        "Google: Gemini 3.8 Flash | google/gemini-3.8-flash · $0.75/M in",
        "Google: Gemini 4 Argon | google/gemini-4-argon · $2/M in",
    ]);

    if (SHOTS !== undefined) {
        mkdirSync(SHOTS, { recursive: true });
        await new Promise((resolve) => setTimeout(resolve, 400));
        writeFileSync(join(SHOTS, "videos-390.jpg"), Buffer.from((await page.screenshot()).data, "base64"));
    }

    await page.evaluate(`document.querySelector('[data-part="video-ask-model"][data-model="google/gemini-3.8-flash"]').click(); return "true";`);
    await until(() => app.config.videoAskModel === "google/gemini-3.8-flash", "the choice kept");
    await see(`return JSON.stringify(document.querySelector('[data-part="video-ask-model"][data-model="google/gemini-3.8-flash"]').getAttribute("aria-pressed") === "true")`, "the row marked");
    await app.setVideoAskModel(owner(app), null);
});

test("a video video_generate made plays in the chat under its line, with its file, length, size and cost", { skip: real.skip || (engine === undefined ? "no ffmpeg in native/" : false) }, async () => {
    execFileSync(engine!.ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc=duration=3:size=320x240:rate=10", "-c:v", "libx264", "-pix_fmt", "yuv420p", join(work, "clip.mp4")]);

    const id = await newSession(app);
    const { submissionId } = await app.commands.submit(id, owner(app), { text: "make a boat", requestId: crypto.randomUUID() });

    await (await app.harness.submission(submissionId, context))!.wait(context);
    await page.evaluate(`(await import("/store.js")).closeSheet(); (await import("/store.js")).navigate(${id}); return "true";`);
    await see(`return JSON.stringify(document.querySelector('[data-part="made-video"] video') !== null)`, "the video in the chat");

    // Chromium as tests run it has no H.264 decoder: the video's file is checked as served, not played.
    const shown = await inPage<{ meta: string; caption: string; playable: boolean }>(`
        const video = document.querySelector('[data-part="made-video"] video');
        const served = await fetch(video.src);
        const bytes = (await served.arrayBuffer()).byteLength;
        // As a player asks: a range.
        const part = await fetch(video.src, { headers: { range: "bytes=0-99" } });
        const partBytes = (await part.arrayBuffer()).byteLength;

        return JSON.stringify({
            meta: document.querySelector('[data-part="tool-call"] .step-meta')?.textContent.trim() ?? "",
            caption: document.querySelector('[data-part="made-video"] figcaption').textContent.replace(/\\s+/g, " ").trim(),
            playable: served.ok && bytes > 1000 && video.controls && part.status === 206 && partBytes === 100 && part.headers.get("content-range") === \`bytes 0-99/\${bytes}\`,
            status: served.status,
            type: served.headers.get("content-type"),
            bytes,
            src: video.getAttribute("src"),
        });
    `);

    assert.match(shown.caption, /^videos\/\d{8}-\d{6}-a-paper-boat-on-a-calm\.mp4 · 3 s · 320×240 ?\$0\.40$/, shown.caption);
    assert.equal(shown.meta, "3 s · $0.40");
    assert.equal(shown.playable, true, `its file is served, with the player's controls: ${JSON.stringify(shown)}`);

    // Download beside it (the owner's ask): the whole file, by its name.
    const saved = await inPage<{ name: string; bytes: number }>(`
        let name = "";
        let bytes = 0;
        const click = HTMLAnchorElement.prototype.click;
        const made = URL.createObjectURL;
        URL.createObjectURL = (blob) => { bytes = blob.size; return made(blob); };
        HTMLAnchorElement.prototype.click = function () { name = this.download; };
        document.querySelector('[data-part="made-video"] [data-part="made-download"]').click();
        await new Promise((resolve) => setTimeout(resolve, 800));
        HTMLAnchorElement.prototype.click = click;
        URL.createObjectURL = made;
        return JSON.stringify({ name, bytes });
    `);

    assert.match(saved.name, /^\d{8}-\d{6}-a-paper-boat-on-a-calm\.mp4$/);
    assert.equal(saved.bytes, readFileSync(join(work, "clip.mp4")).length);

    if (SHOTS !== undefined) {
        await new Promise((resolve) => setTimeout(resolve, 400));
        writeFileSync(join(SHOTS, "video-made-390.jpg"), Buffer.from((await page.screenshot()).data, "base64"));
    }
});
