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
import { openRouterVideoAskModels } from "../src/server/video-gen.ts";

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
const stub = createServer((request, response) => {
    let raw = "";

    request.on("data", (chunk: Buffer) => (raw += chunk.toString()));
    request.on("end", () => {
        if (request.url === "/api/v1/models") {
            response.end(JSON.stringify(MODELS));

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
            return fauxAssistantMessage([fauxToolCall("video_ask", args as never)], { stopReason: "toolUse" });
        }
    }

    return fauxAssistantMessage([fauxText("ok")]);
};
let app: App;

before(async () => {
    await new Promise<void>((resolve) => stub.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${(stub.address() as AddressInfo).port}`;

    app = await openApp(scriptedModel(route), undefined, undefined, { videos: { endpoints: { openRouter: `${base}/api/v1` } } });
    await app.models.setRuntimeApiKey("openrouter", "or-test-key");

    if (engine !== undefined) {
        execFileSync(engine.ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc=duration=3:size=320x240:rate=10", "-f", "lavfi", "-i", "sine=duration=3", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", join(work, "clip.mp4")]);
        execFileSync(engine.ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc=duration=2:size=608x1080:rate=10", "-c:v", "libx264", "-pix_fmt", "yuv420p", join(work, "tall.mp4")]);
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

    const setting = appSettings(app).settings.find((each) => each.id === "video.askModel")!;

    assert.equal(await setting.read(undefined), "auto (google/gemini-3.5-flash-lite)");
    await setting.apply(owner(app), "google/gemini-3.8-flash ($0.75/M in)", undefined);
    assert.equal(app.config.videoAskModel, "google/gemini-3.8-flash");
    await assert.rejects(async () => setting.apply(owner(app), "anthropic/claude-x", undefined), /does not take video/);
    await setting.apply(owner(app), "auto", undefined);
    assert.equal(app.config.videoAskModel, null);
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
