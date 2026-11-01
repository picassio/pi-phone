// Pi's media tool (PP-296, src/server/media.ts and extensions/media.ts): ffmpeg's arguments for each operation, what
// ffprobe says read in short, which engine runs where (the phone's build, the server edition's, a machine's tool or its
// own ffmpeg), and, with the server edition's ffmpeg fetched (node scripts/server-tools.ts linux-x64 ffmpeg), the tool
// itself on a real image and video: info, an image resized and converted, frames, a contact sheet, a clip.
import { type App, cleanUp, context, lastText, newSession, openApp, owner, scriptedModel, work } from "./helpers.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { clipArgs, commandOf, grid, imageArgs, localEngine, machineEngine, readProbe, sampleRate, sheetArgs } from "../src/server/media.ts";

const engine = localEngine();
const real = { skip: engine === undefined ? "no ffmpeg in native/ (node scripts/server-tools.ts linux-x64 ffmpeg)" : false } as const;

test("ffmpeg's arguments: an image fitted, cropped, turned and converted; a clip shrunk and trimmed; a contact sheet's grid", () => {
    const image = imageArgs("in.png", "out.webp", "webp", { width: 800, height: 600, crop: { width: 100, height: 50, x: 10, y: 20 }, rotate: 90, quality: 70 });

    assert.equal(image[image.indexOf("-vf") + 1], "crop=100:50:10:20,transpose=1,scale=800:600:force_original_aspect_ratio=decrease");
    assert.deepEqual(image.slice(image.indexOf("-c:v"), image.indexOf("-c:v") + 4), ["-c:v", "libwebp", "-quality", "70"]);
    assert.ok(!imageArgs("in.png", "out.png", "png", {}).includes("-vf"), "nothing to change: no filter");
    assert.deepEqual(imageArgs("a.jpg", "b.jpg", "jpg", { width: 320, quality: 100 }).slice(-9, -3), ["-c:v", "mjpeg", "-pix_fmt", "yuvj420p", "-q:v", "2"], "quality 100: JPEG's best");

    const clip = clipArgs("in.mov", "out.mp4", { start: 5, end: 12, mute: true });

    assert.deepEqual(clip.slice(clip.indexOf("-ss"), clip.indexOf("-ss") + 4), ["-ss", "5", "-to", "12"]);
    assert.equal(clip[clip.indexOf("-vf") + 1], "scale=-2:'min(720,ih)',format=yuv420p");
    assert.ok(clip.includes("-an") && clip.includes("+faststart"));
    assert.deepEqual(grid(12), { columns: 4, rows: 3 });
    assert.deepEqual(grid(1), { columns: 1, rows: 1 });
    assert.equal(sampleRate({ count: 10, duration: 20 }), "0.5");
    assert.equal(sampleRate({ every: 4 }), "0.25");
    assert.match(sheetArgs("v.mp4", "s.jpg", "0.5", 12, 320, "jpg").join(" "), /fps=0\.5,scale=320:-1,tile=4x3/);
});

test("what ffprobe says, in short: a phone's portrait video, an image, audio", () => {
    const video = readProbe(
        JSON.stringify({
            format: { format_name: "mov,mp4,m4a,3gp,3g2,mj2", duration: "12.345", size: "2048000", bit_rate: "1327000" },
            streams: [
                { codec_type: "video", codec_name: "h264", width: 1920, height: 1080, avg_frame_rate: "30000/1001", side_data_list: [{ rotation: -90 }] },
                { codec_type: "audio", codec_name: "aac" },
            ],
        }),
    );

    assert.deepEqual(video, { kind: "video", format: "mov,mp4,m4a,3gp,3g2,mj2", bytes: 2048000, duration: 12.35, width: 1920, height: 1080, rotation: 270, fps: 29.97, video: "h264", audio: "aac", bitrate: 1327000 });
    assert.deepEqual(readProbe(JSON.stringify({ format: { format_name: "png_pipe", size: "5000" }, streams: [{ codec_type: "video", codec_name: "png", width: 64, height: 32, avg_frame_rate: "0/0" }] })), {
        kind: "image",
        format: "png",
        bytes: 5000,
        width: 64,
        height: 32,
    });
    assert.equal(readProbe(JSON.stringify({ format: { format_name: "mp3", duration: "3", size: "1" }, streams: [{ codec_type: "audio", codec_name: "mp3" }] })).kind, "audio");
});

test("which engine: the phone's build, the server edition's, a machine's ffmpeg tool, its own ffmpeg, or none", async () => {
    const root = mkdtempSync(join(tmpdir(), "media-root-"));

    for (const folder of ["android-arm64", "linux-arm64"]) {
        mkdirSync(join(root, "native", folder, "ffmpeg"), { recursive: true });
        writeFileSync(join(root, "native", folder, "ffmpeg", "ffmpeg"), "");
        writeFileSync(join(root, "native", folder, "ffmpeg", "ffprobe"), "");
    }

    assert.deepEqual(localEngine(root, "android", "arm64"), { ffmpeg: join(root, "native/android-arm64/ffmpeg/ffmpeg"), ffprobe: join(root, "native/android-arm64/ffmpeg/ffprobe"), where: "phone" });
    assert.equal(localEngine(root, "linux", "arm64")?.where, "server");
    assert.equal(localEngine(root, "linux", "x64"), undefined, "not carried: none");
    assert.equal(localEngine(root, "darwin", "arm64"), undefined);

    // A machine: its tool's wrappers (run through bash), else its own ffmpeg, else none.
    const ran: string[][] = [];
    const machine = (own: boolean) =>
        ({
            absolutePath: async (path: string) => ({ ok: true, value: path === "~" ? "/home/tuan" : path }),
            exec: async (argv: readonly string[], options: { onOutput?: (text: string, context: unknown, info: { stream: string }) => void }) => {
                ran.push([...argv]);
                if (own) {
                    options.onOutput?.("/usr/bin/ffmpeg\n/usr/bin/ffprobe\n", undefined, { stream: "stdout" });
                }

                return { ok: true, value: { exitCode: own ? 0 : 1 } };
            },
        }) as unknown as ExecutionEnv;

    const tool = await machineEngine(machine(false), { ffmpeg: "9.0.2" }, context);

    assert.deepEqual(tool, { ffmpeg: "/home/tuan/.pi/mobile/tools/bin/ffmpeg", ffprobe: "/home/tuan/.pi/mobile/tools/bin/ffprobe", where: "machine", script: true });
    assert.deepEqual(commandOf(tool!, "ffprobe", ["x"]), ["bash", "/home/tuan/.pi/mobile/tools/bin/ffprobe", "x"]);
    assert.deepEqual(await machineEngine(machine(true), {}, context), { ffmpeg: "/usr/bin/ffmpeg", ffprobe: "/usr/bin/ffprobe", where: "machine" });
    assert.deepEqual(ran.at(-1), ["sh", "-c", "command -v ffmpeg && command -v ffprobe"]);
    assert.equal(await machineEngine(machine(false), {}, context), undefined);
});

// ─── The tool, on a real image and video ───

const asks: Record<string, Record<string, unknown>> = {
    "what is it": { action: "info", path: "clip.mp4" },
    "make it small": { action: "image", path: "photo.png", width: 160, format: "webp", quality: 60 },
    "frames please": { action: "frames", path: "clip.mp4", at: [0.5, 2] },
    "a sheet": { action: "frames", path: "clip.mp4", count: 6, sheet: true, width: 120 },
    "cut it": { action: "clip", path: "clip.mp4", start: 1, end: 3, height: 120, mute: true },
    "frames of a photo": { action: "frames", path: "photo.png" },
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
            return fauxAssistantMessage([fauxToolCall("media", args as never)], { stopReason: "toolUse" });
        }
    }

    return fauxAssistantMessage([fauxText("ok")]);
};
let app: App;

before(async () => {
    if (engine === undefined) {
        return;
    }

    app = await openApp(scriptedModel(route));
    // A 4-second 320×240 video with a tone, and a 640×480 picture, made by the same ffmpeg.
    execFileSync(engine.ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc=duration=4:size=320x240:rate=10", "-f", "lavfi", "-i", "sine=duration=4", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", join(work, "clip.mp4")]);
    execFileSync(engine.ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc=size=640x480", "-frames:v", "1", join(work, "photo.png")]);
});

after(async () => {
    await app?.close();
    cleanUp();
});

async function ask(id: number, text: string): Promise<string> {
    const { submissionId } = await app.commands.submit(id as never, owner(app), { text, requestId: crypto.randomUUID() });

    await (await app.harness.submission(submissionId, context))!.wait(context);

    return results.at(-1)!;
}

test("the media tool where the session works: info, an image fitted and converted, frames, a contact sheet, a trimmed and shrunk clip", real, async () => {
    const id = await newSession(app);

    assert.match(await ask(id, "what is it"), /^clip\.mp4: video, mov,mp4.*, 320×240, 4(\.\d+)? s, 10 fps, video h264, audio aac$/);

    const small = await ask(id, "make it small");

    assert.match(small, /media\/\d{8}-\d{6}-photo\.webp \(image, webp, \d+ KB, 160×120\)/, small);
    assert.match(await ask(id, "frames please"), /-001-0\.5s\.jpg \(image, jpeg, \d+ KB, 320×240\)[\s\S]*-002-2s\.jpg/);
    // Six frames 120 wide in a 3 × 2 grid, 4 pixels apart and around: 3 × 120 + 2 × 4 + 2 × 4 by 2 × 90 + 4 + 2 × 4.
    assert.match(await ask(id, "a sheet"), /-sheet\.jpg \(image, jpeg, \d+ KB, 376×192\)/);

    const clip = await ask(id, "cut it");

    assert.match(clip, /-clip\.mp4 \(video, mov,mp4[^)]*, 160×120, 2(\.\d+)? s, 10 fps, video h264\)/, clip);
    assert.doesNotMatch(clip.split("made:")[1]!, /audio/, "muted");
    assert.match(await ask(id, "frames of a photo"), /is an image, not a video/);
    assert.equal(readdirSync(join(work, "media")).length, 5, "the image, two frames, the sheet and the clip");
});
