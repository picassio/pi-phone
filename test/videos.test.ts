// video_ask (PP-297, video-gen.ts and extensions/media.ts) against a stand-in for OpenRouter: the models that take video
// listed with their prices, the default Gemini Flash-Lite and the owner's setting (video.askModel, checked), a video
// file sent as a base64 data URL with the question and its cost in the tool's usage, a tall one shrunk to 720p first
// (with the server edition's ffmpeg fetched), a YouTube address passed as it is, and what is not one refused.
import { type App, cleanUp, context, lastText, newSession, openApp, owner, scriptedModel, work } from "./helpers.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { appSettings } from "../src/server/settings-registry.ts";
import { localEngine } from "../src/server/media.ts";
import { DEFAULT_MAKE_MODEL, openRouterVideoAskModels, openRouterVideoMakeModels, pricesOf, Videos } from "../src/server/video-gen.ts";
import { readFileSync, readdirSync } from "node:fs";

const engine = localEngine();
const real = { skip: engine === undefined ? "no ffmpeg in native/ (node scripts/server-tools.ts linux-x64 ffmpeg)" : false } as const;
const MODELS = {
    data: [
        { id: "google/gemini-3.5-flash-lite", name: "Google: Gemini 3.5 Flash-Lite", architecture: { input_modalities: ["text", "image", "video", "audio"] }, pricing: { prompt: "0.0000003", completion: "0.0000025" } },
        { id: "google/gemini-3.8-flash", name: "Google: Gemini 3.8 Flash", architecture: { input_modalities: ["text", "video"] }, pricing: { prompt: "0.00000075" } },
        { id: "google/gemini-3.8-flash:batch", name: "batch", architecture: { input_modalities: ["video"] }, pricing: { prompt: "0.0000004" } },
        { id: "google/gemma-4-31b-it:free", name: "free", architecture: { input_modalities: ["video"] }, pricing: { prompt: "0" } },
        { id: "anthropic/claude-x", name: "Claude", architecture: { input_modalities: ["text", "image"] }, pricing: { prompt: "0.000003" } },
    ],
};

type Seen = { path: string; headers: IncomingMessage["headers"]; body: { model: string; messages: { content: { type: string; text?: string; video_url?: { url: string } }[] }[]; usage?: unknown } };
const seen: Seen[] = [];
/** OpenRouter's video models, as its list gives them (the price keys as it writes them). */
const VIDEO_MODELS = {
    data: [
        {
            id: DEFAULT_MAKE_MODEL,
            name: "The default",
            supported_durations: [4, 6, 8],
            supported_resolutions: ["720p", "1080p"],
            supported_aspect_ratios: ["16:9", "9:16"],
            pricing_skus: { duration_seconds_with_audio: "0.05", duration_seconds_without_audio: "0.03", duration_seconds_with_audio_4k: "0.30" },
        },
        { id: "alibaba/wan-3.0", name: "Wan 3.0", supported_durations: [2, 30], supported_resolutions: ["480p", "720p"], supported_aspect_ratios: ["16:9"], pricing_skus: { duration_seconds_480p: "0.05", duration_seconds_720p: "0.1" } },
        { id: "x-ai/grok-imagine-video", name: "Grok", supported_durations: [5], pricing_skus: { cents_per_image_input: "0.2", cents_per_video_output_second_480p: "5", cents_per_video_output_second_720p: "7" } },
        { id: "bytedance/seedance-2.0", name: "Seedance", pricing_skus: { video_tokens: "0.000007" } },
    ],
};
/** What video_generate sent, and how many times its job was polled. */
const made: { body: Record<string, unknown>; polls: number }[] = [];
const stub = createServer((request, response) => {
    let raw = "";

    request.on("data", (chunk: Buffer) => (raw += chunk.toString()));
    request.on("end", () => {
        if (request.url === "/api/v1/models") {
            response.end(JSON.stringify(MODELS));

            return;
        }

        if (request.url === "/api/v1/videos/models") {
            response.end(JSON.stringify(VIDEO_MODELS));

            return;
        }

        if (request.url === "/api/v1/videos" && request.method === "POST") {
            made.push({ body: JSON.parse(raw) as Record<string, unknown>, polls: 0 });
            response.statusCode = 202;
            response.end(JSON.stringify({ id: "gen-vid-1", polling_url: "/api/v1/videos/gen-vid-1", status: "pending" }));

            return;
        }

        if (request.url === "/api/v1/videos/gen-vid-1") {
            const job = made.at(-1)!;

            job.polls++;
            response.end(JSON.stringify(job.polls < 2 ? { id: "gen-vid-1", status: "in_progress" } : { id: "gen-vid-1", status: "completed", unsigned_urls: ["/api/v1/videos/gen-vid-1/content?index=0"], usage: { cost: 1.01 } }));

            return;
        }

        if (request.url === "/api/v1/videos/gen-vid-1/content?index=0") {
            response.setHeader("content-type", "video/mp4");
            response.end(readFileSync(join(work, "clip.mp4")));

            return;
        }

        if (request.url === "/api/v1/chat/completions") {
            seen.push({ path: request.url, headers: request.headers, body: JSON.parse(raw) as Seen["body"] });
            response.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "0:01 a counter, 0:03 a beep." } }], usage: { prompt_tokens: 560, completion_tokens: 12, cost: 0.0002 } }));

            return;
        }

        response.statusCode = 404;
        response.end("{}");
    });
});

const asks: Record<string, Record<string, unknown>> = {
    "watch it": { question: "What happens, with times?", path: "clip.mp4" },
    "watch the tall one": { question: "What is it?", path: "tall.mp4" },
    "watch youtube": { question: "Summarize", url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" },
    "watch a page": { question: "Summarize", url: "https://example.com/video.mp4" },
    "watch with argon": { question: "What is it?", path: "clip.mp4", model: "openai/gpt-x" },
    "make a boat": { prompt: "A paper boat on a calm pond", duration: 8, aspect: "16:9", audio: true, first_frame: "photo.png" },
    "make a long one": { prompt: "A paper boat", duration: 20 },
    "make a square one": { prompt: "A paper boat", aspect: "1:1" },
};
const results: string[] = [];
const route: FauxResponseStep = (request) => {
    const { role, text } = lastText(request as never);

    if (role === "toolResult") {
        results.push(text);

        return fauxAssistantMessage([fauxText("done")]);
    }

    for (const [ask, args] of Object.entries(asks)) {
        if (role === "user" && text.endsWith(ask)) {
            return fauxAssistantMessage([fauxToolCall(ask.startsWith("make") ? "video_generate" : "video_ask", args as never)], { stopReason: "toolUse" });
        }
    }

    return fauxAssistantMessage([fauxText("ok")]);
};
let app: App;

before(async () => {
    await new Promise<void>((resolve) => stub.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${(stub.address() as AddressInfo).port}`;

    app = await openApp(scriptedModel(route), undefined, undefined, { videos: { endpoints: { openRouter: `${base}/api/v1` }, pollMs: 20 } });
    await app.models.setRuntimeApiKey("openrouter", "or-test-key");

    if (engine !== undefined) {
        execFileSync(engine.ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc=duration=3:size=320x240:rate=10", "-f", "lavfi", "-i", "sine=duration=3", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", join(work, "clip.mp4")]);
        execFileSync(engine.ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc=duration=2:size=608x1080:rate=10", "-c:v", "libx264", "-pix_fmt", "yuv420p", join(work, "tall.mp4")]);
        execFileSync(engine.ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc=size=64x36", "-frames:v", "1", join(work, "photo.png")]);
    }
});

after(async () => {
    await app?.close();
    stub.close();
    cleanUp();
});

async function ask(id: number, text: string): Promise<string> {
    const { submissionId } = await app.commands.submit(id as never, owner(app), { text, requestId: crypto.randomUUID() });

    await (await app.harness.submission(submissionId, context))!.wait(context);

    return results.at(-1)!;
}

test("the models that take video, with their prices: no batch, free or routers; the setting checks a model against them", async () => {
    assert.deepEqual(
        openRouterVideoAskModels(MODELS).map((model) => [model.id, model.price]),
        [
            ["google/gemini-3.5-flash-lite", { input: 0.3, output: 2.5 }],
            ["google/gemini-3.8-flash", { input: 0.75 }],
        ],
    );

    // Without OpenRouter signed in, nothing is asked of it (the settings tool listed it for every app, from the network).
    let fetched = 0;
    const signedOut = new Videos({ openRouterKey: async () => undefined, askSetting: () => null, fetch: (async () => { fetched++; throw new Error("no"); }) as typeof fetch });

    await assert.rejects(signedOut.askModels(), /OpenRouter, which is not signed in/);
    assert.equal(fetched, 0);

    const setting = appSettings(app).settings.find((each) => each.id === "video.askModel")!;

    assert.equal(await setting.read(undefined), "auto (google/gemini-3.5-flash-lite)");
    await setting.apply(owner(app), "google/gemini-3.8-flash ($0.75/M in)", undefined);
    assert.equal(app.config.videoAskModel, "google/gemini-3.8-flash");
    await assert.rejects(async () => setting.apply(owner(app), "anthropic/claude-x", undefined), /does not take video/);
    await setting.apply(owner(app), "auto", undefined);
    assert.equal(app.config.videoAskModel, null);
});

test("the models that make videos, with their lowest price a second (dollars or cents as OpenRouter writes them; by tokens, none)", () => {
    assert.deepEqual(
        openRouterVideoMakeModels(VIDEO_MODELS).map((model) => [model.id, model.perSecond, model.withAudio, model.durations]),
        [
            [DEFAULT_MAKE_MODEL, 0.03, 0.05, [4, 6, 8]],
            ["alibaba/wan-3.0", 0.05, undefined, [2, 30]],
            ["x-ai/grok-imagine-video", 0.05, undefined, [5]],
            ["bytedance/seedance-2.0", undefined, undefined, []],
        ],
    );
    assert.deepEqual(pricesOf({ duration_seconds: "0.084", duration_seconds_with_audio: "0.126" }), { perSecond: 0.084, withAudio: 0.126 });
});

test("video_generate: the job submitted with the prompt, length, shape, sound and first frame; polled until done; the video saved in videos/ with its cost", real, async () => {
    const id = await newSession(app);
    const said = await ask(id, "make a boat");
    const job = made.at(-1)!;

    assert.match(said, new RegExp(`^Made a video with ${DEFAULT_MAKE_MODEL.replace(/[./]/g, "\\$&")}, cost \\$1\\.01:\\n- .*/videos/\\d{8}-\\d{6}-a-paper-boat-on-a-calm\\.mp4 \\(video, mov,mp4.*, 320×240, 3 s`), said);
    assert.equal(job.body.model, DEFAULT_MAKE_MODEL);
    assert.deepEqual({ ...job.body, frame_images: undefined }, { model: DEFAULT_MAKE_MODEL, prompt: "A paper boat on a calm pond", duration: 8, aspect_ratio: "16:9", generate_audio: true, frame_images: undefined });
    assert.equal((job.body.frame_images as { frame_type: string }[])[0]!.frame_type, "first_frame");
    assert.match((job.body.frame_images as { image_url: { url: string } }[])[0]!.image_url.url, /^data:image\/png;base64,/);
    assert.ok(job.polls >= 2, "polled until completed");

    const saved = readdirSync(join(work, "videos"));

    assert.equal(saved.length, 1);
    assert.deepEqual(readFileSync(join(work, "videos", saved[0]!)), readFileSync(join(work, "clip.mp4")));

    const entries = await app.transcripts.allEntries(id as never, true);
    const result = entries.filter((entry) => entry.kind === "toolResult").at(-1) as unknown as { details?: { video?: { width?: number; duration?: number }; cost?: number } };

    assert.equal(result.details?.cost, 1.01);
    assert.equal(result.details?.video?.width, 320);

    // What the model does not take is said before anything is paid.
    const count = made.length;

    assert.match(await ask(id, "make a long one"), /takes durations \(s\) 4, 6, 8, not 20/);
    assert.match(await ask(id, "make a square one"), /takes aspects 16:9, 9:16, not 1:1/);
    assert.equal(made.length, count, "nothing submitted");
});

test("video_ask: a file goes as a base64 mp4 with the question to the default model, its cost in the tool's usage; a YouTube address as it is", real, async () => {
    const id = await newSession(app);
    const before = seen.length;
    const said = await ask(id, "watch it");
    const request = seen[before]!;

    assert.match(said, /^google\/gemini-3\.5-flash-lite watched clip\.mp4, cost \$0\.0002:\n\n0:01 a counter, 0:03 a beep\.$/);
    assert.equal(request.body.model, "google/gemini-3.5-flash-lite");
    assert.equal(request.headers.authorization, "Bearer or-test-key");
    assert.deepEqual(request.body.usage, { include: true });
    assert.equal(request.body.messages[0]!.content[0]!.text, "What happens, with times?");
    assert.match(request.body.messages[0]!.content[1]!.video_url!.url, /^data:video\/mp4;base64,AAAA/);

    const entries = await app.transcripts.allEntries(id as never, true);
    const result = entries.filter((entry) => entry.kind === "toolResult").at(-1) as unknown as { details?: { cost?: number; model?: string } };

    assert.deepEqual(result.details, { model: "google/gemini-3.5-flash-lite", cost: 0.0002 });

    // Taller than 720 lines: a 720p mp4 first, in media/.
    const tall = await ask(id, "watch the tall one");

    assert.match(tall, /watched tall\.mp4 \(shrunk to .*\/media\/\d{8}-\d{6}-tall-for-model\.mp4\)/, tall);

    await ask(id, "watch youtube");
    assert.equal(seen.at(-1)!.body.messages[0]!.content[1]!.video_url!.url, "https://www.youtube.com/watch?v=dQw4w9WgXcQ");

    const count = seen.length;

    assert.match(await ask(id, "watch a page"), /url is a YouTube address/);
    assert.match(await ask(id, "watch with argon"), /openai\/gpt-x does not take video on OpenRouter now/);
    assert.equal(seen.length, count, "neither asked OpenRouter");
});
