/**
 * `media` (PP-296): Pi's images and video, with ffmpeg where the session works: on the phone (the APK's slim build), in
 * the server edition (the image's), or on a machine (its ffmpeg tool, or its own). See `media.ts`.
 *
 * - info: what a file is (kind, size, length, width and height, codecs, frames a second, turn).
 * - image: resize to fit, crop, turn, flip, convert (jpg, png, webp), compress.
 * - frames: one frame at each given second, one every so many seconds, a number spread over the video, or one contact
 *   sheet of them.
 * - clip: an H.264/AAC mp4, trimmed, shrunk (720p by default), muted: smaller to send, to a model or to a person.
 *
 * What it makes goes into `media/` where the session works, named by the file and the moment; Pi gets the paths, sizes
 * and dimensions, and reads an image with `read` when it must look.
 */
import { arr, bool, int, num, obj, opt, str, union } from "@earendil-works/pi-schema";
import { literal } from "../tool-schema.ts";
import type { Context, JsonValue } from "@earendil-works/chord";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import type { PocketHost } from "../host.ts";
import {
    clipArgs,
    commandOf,
    frameAtArgs,
    framesArgs,
    IMAGE_FORMATS,
    type ImageFormat,
    engineWhere,
    imageArgs,
    MAX_FRAMES,
    type MediaEngine,
    type MediaInfo,
    output,
    probeArgs,
    readProbe,
    sampleRate,
    sheetArgs,
    uprightPicture,
} from "../media.ts";
import { slugOf } from "./images.ts";
import { imageType } from "../image-meta.ts";
import { m4aArgs, PART_SECONDS, PCM_RATE, pcmPartArgs, saidAsWritten, SPEAK_MODELS, speakParts, srtOf, TRANSCRIBE_MODELS, type Utterance, VOICES, vttOf, wavData, wavOf } from "../audio.ts";
import type { Usage } from "@earendil-works/pi-ai";

const FOLDER = "media";
/** Where the audio Pi reads aloud goes. */
const AUDIO = "audio";
/** Where transcripts go. */
const TRANSCRIPTS = "transcripts";
/** Where the videos Pi makes go. */
const VIDEOS = "videos";
/** A video larger than this is shrunk to a 720p mp4 before a model watches it. */
const MAX_ASK_MB = 20;
/** The most a video sent to a model may be, after shrinking (base64 in one request). */
const MAX_SEND_MB = 45;
const reply = (text: string, isError = false) => ({ output: [{ type: "text" as const, text }], ...(isError ? { isError: true } : {}) });

const DESCRIPTION =
    "Images and video with ffmpeg where this session works (the phone, the server, or a machine). action: info (what a file is: size, length, width and height, codecs), " +
    "image (resize to fit width/height, crop, rotate, flip, convert to jpg/png/webp, compress with quality), frames (a video's frames: at given seconds, every N seconds, " +
    `or count spread over it; sheet: true puts them in one contact sheet; at most ${MAX_FRAMES}), clip (an mp4 trimmed from start to end seconds, shrunk to height (720 by default), muted). ` +
    "What it makes goes in media/ where this session works; you get the paths and sizes: read an image to look at it. Shrink a video with clip, or look at its frames, before sending it to a model.";

/** A moment as `20261101-143205`, in the server's time. */
function stamp(at: Date): string {
    const two = (value: number) => String(value).padStart(2, "0");

    return `${at.getFullYear()}${two(at.getMonth() + 1)}${two(at.getDate())}-${two(at.getHours())}${two(at.getMinutes())}${two(at.getSeconds())}`;
}

/** A result's details as JSON (what it holds has no undefined left in it). */
const plain = (value: object): JsonValue => JSON.parse(JSON.stringify(value)) as JsonValue;

const megabytes = (bytes: number) => (bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);

/** What a file is, in a line. */
function describe(info: MediaInfo): string {
    return [
        info.kind,
        info.format,
        megabytes(info.bytes),
        ...(info.width === undefined ? [] : [`${info.width}×${info.height}`]),
        ...(info.duration === undefined ? [] : [`${info.duration} s`]),
        ...(info.fps === undefined ? [] : [`${info.fps} fps`]),
        ...(info.video === undefined ? [] : [`video ${info.video}`]),
        ...(info.audio === undefined ? [] : [`audio ${info.audio}`]),
        ...(info.rotation === undefined ? [] : [`turned ${info.rotation}°`]),
    ].join(", ");
}

export default function createMedia(host: PocketHost) {
    /** The engine where `cwd` is: a machine's, or this server's; or what is missing. */
    async function engineFor(cwd: string, env: ExecutionEnv, context: Context): Promise<MediaEngine | string> {
        return engineWhere(host.machineOf(cwd), env, context);
    }

    const media = defineTool({
        name: "media",
        description: DESCRIPTION,
        parameters: obj({
            action: union([literal("info"), literal("image"), literal("frames"), literal("clip")], { description: "info, image, frames, or clip" }),
            path: str({ description: "The image or video: a path, absolute or relative to this session's folder" }),
            width: opt(int({ minimum: 8, maximum: 8192, description: "image: fit within this width; frames: each frame this wide (default 480; 320 in a sheet)" })),
            height: opt(int({ minimum: 8, maximum: 8192, description: "image: fit within this height; clip: shrink to at most this height (default 720)" })),
            crop: opt(str({ description: "image: the part to keep, width:height:x:y in pixels of the original" })),
            rotate: opt(union([literal(90), literal(180), literal(270)], { description: "image: turn clockwise" })),
            flip: opt(union([literal("horizontal"), literal("vertical")])),
            format: opt(union([literal("jpg"), literal("png"), literal("webp")], { description: "image and frames: jpg, png or webp (image: default its own, else jpg)" })),
            quality: opt(int({ minimum: 1, maximum: 100, description: "image: 1 to 100 for jpg and webp (smaller files lower)" })),
            at: opt(arr(num({ minimum: 0 }), { maxItems: MAX_FRAMES, description: "frames: seconds to take a frame at" })),
            every: opt(num({ exclusiveMinimum: 0, description: "frames: one frame every this many seconds" })),
            count: opt(int({ minimum: 1, maximum: MAX_FRAMES, description: `frames: how many (default 12; at most ${MAX_FRAMES})` })),
            sheet: opt(bool({ description: "frames: one contact sheet image instead of separate frames" })),
            start: opt(num({ minimum: 0, description: "clip: from this second" })),
            end: opt(num({ exclusiveMinimum: 0, description: "clip: to this second" })),
            mute: opt(bool({ description: "clip: without sound" })),
        }, { open: true }),
        execute: async (args, api, context) => {
            const cwd = (await api.agent(context)).cwd ?? "";
            const env = host.envOf(cwd);
            const absolute = await env.absolutePath(args.path, context);

            if (!absolute.ok) {
                return reply(`Cannot find ${args.path}: ${absolute.error.message}`, true);
            }

            const input = absolute.value;
            const exists = await env.fileInfo(input, context);

            if (!exists.ok || exists.value.kind !== "file") {
                return reply(`${args.path} is not a file where this session works.`, true);
            }

            const engine = await engineFor(cwd, env, context);

            if (typeof engine === "string") {
                return reply(engine, true);
            }

            const probe = async (path: string): Promise<MediaInfo | string> => {
                const ran = await output(env, commandOf(engine, "ffprobe", probeArgs(path)), context, 60);

                if (ran.code !== 0) {
                    return `ffprobe could not read ${path}: ${ran.stderr.trim().slice(-400) || `exit ${ran.code}`}`;
                }

                try {
                    return readProbe(ran.stdout);
                } catch (error) {
                    return `ffprobe answered what is not JSON for ${path}: ${error instanceof Error ? error.message : String(error)}`;
                }
            };
            const ffmpeg = async (argv: string[]): Promise<string | undefined> => {
                const ran = await output(env, commandOf(engine, "ffmpeg", argv), context);

                return ran.code === 0 ? undefined : `ffmpeg failed (exit ${ran.code}): ${ran.stderr.trim().slice(-600)}`;
            };
            const info = await probe(input);

            if (typeof info === "string") {
                return reply(info, true);
            }

            if (args.action === "info") {
                return { output: [{ type: "text" as const, text: `${args.path}: ${describe(info)}` }], details: plain({ info, engine: engine.where }) };
            }

            const folder = await env.absolutePath(FOLDER, context);

            if (!folder.ok) {
                return reply(`Cannot save in ${FOLDER}: ${folder.error.message}`, true);
            }

            const created = await env.createDir(folder.value, { recursive: true }, context);

            if (!created.ok) {
                return reply(`Could not make ${folder.value}: ${created.error.message}`, true);
            }

            const base = `${folder.value}/${stamp(new Date())}-${slugOf(args.path.split("/").pop()?.replace(/\.[^.]+$/, "") ?? "media")}`;
            const made: string[] = [];

            if (args.action === "image") {
                const own = info.format === "jpeg" ? "jpg" : info.format;
                const format: ImageFormat = args.format ?? ((IMAGE_FORMATS as readonly string[]).includes(own) ? (own as ImageFormat) : "jpg");
                const crop = args.crop === undefined ? undefined : args.crop.split(":").map(Number);

                if (crop !== undefined && (crop.length !== 4 || crop.some((each) => !Number.isInteger(each) || each < 0))) {
                    return reply("crop is width:height:x:y, whole pixels of the original (like 800:600:0:120).", true);
                }

                const out = `${base}.${format}`;
                const failed = await ffmpeg(
                    imageArgs(input, out, format, {
                        ...(args.width === undefined ? {} : { width: args.width }),
                        ...(args.height === undefined ? {} : { height: args.height }),
                        ...(crop === undefined ? {} : { crop: { width: crop[0]!, height: crop[1]!, x: crop[2]!, y: crop[3]! } }),
                        ...(args.rotate === undefined ? {} : { rotate: args.rotate }),
                        ...(args.flip === undefined ? {} : { flip: args.flip }),
                        ...(args.quality === undefined ? {} : { quality: args.quality }),
                    }),
                );

                if (failed !== undefined) {
                    return reply(failed, true);
                }

                made.push(out);
            } else if (args.action === "frames") {
                const format: ImageFormat = args.format ?? "jpg";

                if (info.kind !== "video") {
                    return reply(`${args.path} is ${info.kind === "image" ? "an image" : "audio"}, not a video: frames come from videos.`, true);
                }

                if (args.at !== undefined && args.at.length > 0) {
                    const beyond = args.at.filter((seconds) => info.duration !== undefined && seconds > info.duration);

                    if (beyond.length > 0) {
                        return reply(`${args.path} is ${info.duration} s long: no frame at ${beyond.join(", ")} s.`, true);
                    }

                    for (const [index, seconds] of args.at.entries()) {
                        const out = `${base}-${String(index + 1).padStart(3, "0")}-${seconds}s.${format}`;
                        const failed = await ffmpeg(frameAtArgs(input, out, seconds, args.width ?? 480, format));

                        if (failed !== undefined) {
                            return reply(failed, true);
                        }

                        made.push(out);
                    }
                } else {
                    const count = Math.min(args.count ?? 12, MAX_FRAMES);

                    if (args.every === undefined && info.duration === undefined) {
                        return reply(`${args.path} has no length ffprobe knows: give every (seconds) instead of count.`, true);
                    }

                    const rate = sampleRate(args.every !== undefined ? { every: args.every } : { count, duration: info.duration ?? 0 });

                    if (args.sheet === true) {
                        const out = `${base}-sheet.${format}`;
                        const failed = await ffmpeg(sheetArgs(input, out, rate, count, args.width ?? 320, format));

                        if (failed !== undefined) {
                            return reply(failed, true);
                        }

                        made.push(out);
                    } else {
                        const failed = await ffmpeg(framesArgs(input, `${base}-%03d.${format}`, rate, count, args.width ?? 480, format));

                        if (failed !== undefined) {
                            return reply(failed, true);
                        }

                        for (let index = 1; index <= count; index++) {
                            const out = `${base}-${String(index).padStart(3, "0")}.${format}`;
                            const there = await env.exists(out, context);

                            if (there.ok && there.value) {
                                made.push(out);
                            }
                        }
                    }
                }
            } else {
                if (info.kind === "image") {
                    return reply(`${args.path} is an image: clip cuts videos.`, true);
                }

                if (args.start !== undefined && args.end !== undefined && args.end <= args.start) {
                    return reply("end must come after start.", true);
                }

                const out = `${base}-clip.mp4`;
                const failed = await ffmpeg(
                    clipArgs(input, out, {
                        ...(args.start === undefined ? {} : { start: args.start }),
                        ...(args.end === undefined ? {} : { end: args.end }),
                        ...(args.height === undefined ? {} : { height: args.height }),
                        ...(args.mute === undefined ? {} : { mute: args.mute }),
                    }),
                );

                if (failed !== undefined) {
                    return reply(failed, true);
                }

                made.push(out);
            }

            if (made.length === 0) {
                return reply(`ffmpeg made nothing from ${args.path}.`, true);
            }

            const results: { path: string; info: MediaInfo }[] = [];

            for (const path of made) {
                const about = await probe(path);

                if (typeof about === "string") {
                    return reply(about, true);
                }

                results.push({ path, info: about });
            }

            const lines = [
                `From ${args.path} (${describe(info)}), ${made.length === 1 ? "made" : `made ${made.length}`}:`,
                ...results.map((each) => `- ${each.path} (${describe(each.info)})`),
                ...(results.some((each) => each.info.kind === "image") ? ["Read an image to look at it."] : []),
            ];

            return { output: [{ type: "text" as const, text: lines.join("\n") }], details: plain({ engine: engine.where, input: info, made: results }) };
        },
    });

    const ask = defineTool({
        name: "video_ask",
        description:
            "Ask a model that watches video about a video (PP-297): the model Menu › Videos sets (setting video.askModel, Gemini Flash-Lite by default), through OpenRouter. " +
            `Give path (a video where this session works: mp4, mov, webm, mkv; larger than ${MAX_ASK_MB} MB or taller than 720 lines, it is shrunk to a 720p mp4 first with the media tool's engine) or url (a YouTube address), and the question. ` +
            "It answers in words, with times (0:12) when you ask for them; the cost is in Spend. model overrides the setting for this call, an OpenRouter model that takes video.",
        parameters: obj({
            question: str({ description: "What to ask about the video" }),
            path: opt(str({ description: "The video: a path, absolute or relative to this session's folder" })),
            url: opt(str({ description: "A YouTube address instead of a file" })),
            model: opt(str({ description: "An OpenRouter model that takes video, for this call only, instead of the setting video.askModel" })),
        }, { open: true }),
        execute: async (args, api, context) => {
            if ((args.path === undefined) === (args.url === undefined)) {
                return reply("Give path (a video file) or url (a YouTube address): one of them.", true);
            }

            if (args.question.trim() === "") {
                return reply("Give the question: what to ask about the video.", true);
            }

            let model;

            try {
                model = await host.videos.resolveAsk(args.model);
            } catch (error) {
                return reply(error instanceof Error ? error.message : String(error), true);
            }

            let video: { data: Uint8Array; mimeType: string } | { url: string };
            let shrunk: string | undefined;

            if (args.url !== undefined) {
                if (!/^https:\/\/(www\.|m\.)?(youtube\.com\/(watch\?|shorts\/|live\/)|youtu\.be\/)/.test(args.url.trim())) {
                    return reply("url is a YouTube address (youtube.com/watch?v=…, youtu.be/…); a video elsewhere: download it, then give its path.", true);
                }

                video = { url: args.url.trim() };
            } else {
                const cwd = (await api.agent(context)).cwd ?? "";
                const env = host.envOf(cwd);
                const absolute = await env.absolutePath(args.path!, context);

                if (!absolute.ok) {
                    return reply(`Cannot find ${args.path}: ${absolute.error.message}`, true);
                }

                const engine = await engineFor(cwd, env, context);

                if (typeof engine === "string") {
                    return reply(engine, true);
                }

                const probed = await output(env, commandOf(engine, "ffprobe", probeArgs(absolute.value)), context, 60);
                let info: MediaInfo;

                try {
                    if (probed.code !== 0) {
                        throw new Error(probed.stderr.trim().slice(-300) || `exit ${probed.code}`);
                    }

                    info = readProbe(probed.stdout);
                } catch (error) {
                    return reply(`ffprobe could not read ${args.path}: ${error instanceof Error ? error.message : String(error)}`, true);
                }

                if (info.kind !== "video") {
                    return reply(`${args.path} is ${info.kind === "image" ? "an image" : "audio"}, not a video.`, true);
                }

                let file = absolute.value;
                const sent = info.format.split(",").some((name) => ["mov", "mp4", "webm"].includes(name));

                // Too big, too tall, or a container OpenRouter does not take: a 720p mp4 first.
                if (info.bytes > MAX_ASK_MB * 1024 * 1024 || (info.height ?? 0) > 720 || !sent) {
                    const folder = await env.absolutePath(FOLDER, context);

                    if (!folder.ok) {
                        return reply(`Cannot save in ${FOLDER}: ${folder.error.message}`, true);
                    }

                    await env.createDir(folder.value, { recursive: true }, context);
                    shrunk = `${folder.value}/${stamp(new Date())}-${slugOf(args.path!.split("/").pop()?.replace(/\.[^.]+$/, "") ?? "video")}-for-model.mp4`;

                    const ran = await output(env, commandOf(engine, "ffmpeg", clipArgs(file, shrunk, { height: 720 })), context);

                    if (ran.code !== 0) {
                        return reply(`ffmpeg could not shrink ${args.path}: ${ran.stderr.trim().slice(-400)}`, true);
                    }

                    file = shrunk;
                }

                const bytes = await env.readBinaryFile(file, context);

                if (!bytes.ok) {
                    return reply(`Could not read ${file}: ${bytes.error.message}`, true);
                }

                if (bytes.value.length > MAX_SEND_MB * 1024 * 1024) {
                    return reply(`${args.path} is still ${megabytes(bytes.value.length)} as a 720p mp4; models take up to about ${MAX_SEND_MB} MB: cut the part to ask about with media (action clip, start and end) and ask about that.`, true);
                }

                video = { data: bytes.value, mimeType: file.toLowerCase().endsWith(".webm") ? "video/webm" : file.toLowerCase().endsWith(".mov") ? "video/quicktime" : "video/mp4" };
            }

            let answer;

            try {
                answer = await host.videos.ask(model, args.question, video, context.abortSignal);
            } catch (error) {
                return reply(error instanceof Error ? error.message : String(error), true);
            }

            const cost = answer.cost === undefined ? "cost not reported" : `cost $${answer.cost < 0.01 ? answer.cost.toFixed(4) : answer.cost.toFixed(2)}`;
            const usage: Usage = {
                input: answer.tokens.input,
                output: answer.tokens.output,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: answer.tokens.input + answer.tokens.output,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: answer.cost ?? 0 },
            };

            return {
                output: [{ type: "text" as const, text: [`${model.id} watched ${args.path ?? args.url}${shrunk === undefined ? "" : ` (shrunk to ${shrunk})`}, ${cost}:`, "", answer.text].join("\n") }],
                details: plain({ model: model.id, ...(shrunk === undefined ? {} : { shrunk }), ...(answer.cost === undefined ? {} : { cost: answer.cost }) }),
                usage,
            };
        },
    });

    const generate = defineTool({
        name: "video_generate",
        description:
            "Make a video with the model Menu › Videos sets (setting video.model, Kling 3.0 Standard by default), through OpenRouter: from a prompt, or from images it starts and ends on (first_frame, last_frame) and style references. " +
            "It takes a minute or more, and money (Kling Standard about $0.08 a second, $0.13 with sound): say what it will cost when you are not asked for a set length. " +
            "duration (seconds), aspect (16:9, 9:16, 1:1, 4:3, 3:4, 21:9), resolution (480p, 720p, 1080p...) and audio are checked against what the model takes. " +
            "The video is saved where this session works, in videos/, and shows in the chat; you get its path, size and cost. model overrides the setting for this call.",
        parameters: obj({
            prompt: str({ description: "What the video shows: the scene, the motion, the camera, the light, the sound" }),
            duration: opt(int({ minimum: 1, maximum: 60, description: "Seconds (the model's own lengths; Kling 3 to 15)" })),
            aspect: opt(str({ description: "16:9, 9:16, 1:1, 4:3, 3:4, 3:2, 2:3, 21:9" })),
            resolution: opt(str({ description: "480p, 720p, 1080p, 2K or 4K, as the model takes" })),
            audio: opt(bool({ description: "With sound (when the model makes it; it costs more)" })),
            first_frame: opt(str({ description: "An image it starts on: a path where this session works" })),
            last_frame: opt(str({ description: "An image it ends on" })),
            references: opt(arr(str(), { maxItems: 4, description: "Images for its look (paths)" })),
            model: opt(str({ description: "An OpenRouter video model for this call only, instead of the setting video.model" })),
        }, { open: true }),
        execute: async (args, api, context) => {
            if (args.prompt.trim() === "") {
                return reply("Give a prompt: what the video shows.", true);
            }

            let model;

            try {
                model = await host.videos.resolveMake(args.model);
            } catch (error) {
                return reply(error instanceof Error ? error.message : String(error), true);
            }

            const takes = (what: string, value: string | number | undefined, allowed: readonly (string | number)[]) =>
                value === undefined || allowed.length === 0 || allowed.includes(value) ? undefined : `${model.id} takes ${what} ${allowed.join(", ")}, not ${value}.`;
            const wrong = takes("durations (s)", args.duration, model.durations) ?? takes("aspects", args.aspect, model.aspects) ?? takes("resolutions", args.resolution, model.resolutions);

            if (wrong !== undefined) {
                return reply(wrong, true);
            }

            const cwd = (await api.agent(context)).cwd ?? "";
            const env = host.envOf(cwd);
            const picture = async (path: string): Promise<{ data: Uint8Array; mimeType: string } | string> => {
                const absolute = await env.absolutePath(path, context);
                const bytes = absolute.ok ? await env.readBinaryFile(absolute.value, context) : absolute;

                if (!bytes.ok) {
                    return `Could not read ${path}: ${bytes.error.message}`;
                }

                const mimeType = imageType(bytes.value);

                if (mimeType === undefined) {
                    return `${path} is not a PNG, JPEG, GIF or WebP image.`;
                }

                // A phone's photo stored on its side is turned upright first (PP-304).
                const folder = await env.absolutePath(FOLDER, context);
                const upright = folder.ok
                    ? await uprightPicture(env, absolute.ok ? absolute.value : path, bytes.value, `${folder.value}/${stamp(new Date())}-${slugOf(path.split("/").pop()?.replace(/\.[^.]+$/, "") ?? "image")}-upright.jpg`, () => engineFor(cwd, env, context), context)
                    : `Cannot save in ${FOLDER}: ${folder.error.message}`;

                if (typeof upright === "string") {
                    return upright;
                }

                return upright.data.length > 15 * 1024 * 1024 ? `${path} is over 15 MB: shrink it with media first.` : { data: upright.data, mimeType: upright.mimeType ?? mimeType };
            };
            const images: Record<string, { data: Uint8Array; mimeType: string }> = {};

            for (const [name, path] of [["first", args.first_frame], ["last", args.last_frame], ...(args.references ?? []).map((each, index) => [`reference ${index}`, each])] as [string, string | undefined][]) {
                if (path !== undefined) {
                    const read = await picture(path);

                    if (typeof read === "string") {
                        return reply(read, true);
                    }

                    images[name] = read;
                }
            }

            let made;

            try {
                made = await host.videos.make(
                    model,
                    {
                        prompt: args.prompt,
                        ...(args.duration === undefined ? {} : { duration: args.duration }),
                        ...(args.aspect === undefined ? {} : { aspect: args.aspect }),
                        ...(args.resolution === undefined ? {} : { resolution: args.resolution }),
                        ...(args.audio === undefined ? {} : { audio: args.audio }),
                        ...(images.first === undefined ? {} : { firstFrame: images.first }),
                        ...(images.last === undefined ? {} : { lastFrame: images.last }),
                        ...(args.references === undefined ? {} : { references: args.references.map((_, index) => images[`reference ${index}`]!) }),
                    },
                    context.abortSignal,
                );
            } catch (error) {
                return reply(error instanceof Error ? error.message : String(error), true);
            }

            const folder = await env.absolutePath(VIDEOS, context);

            if (!folder.ok) {
                return reply(`Cannot save in ${VIDEOS}: ${folder.error.message}`, true);
            }

            const created = await env.createDir(folder.value, { recursive: true }, context);

            if (!created.ok) {
                return reply(`Could not make ${folder.value}: ${created.error.message}`, true);
            }

            const path = `${folder.value}/${stamp(new Date())}-${slugOf(args.prompt)}.mp4`;
            const written = await env.writeFile(path, made.data, context);

            if (!written.ok) {
                return reply(`Could not save ${path}: ${written.error.message} (OpenRouter's job ${made.job} keeps it a while).`, true);
            }

            // Its size and length, read by the media engine where the session works.
            const engine = await engineFor(cwd, env, context);
            let info: MediaInfo | undefined;

            if (typeof engine !== "string") {
                const probed = await output(env, commandOf(engine, "ffprobe", probeArgs(path)), context, 60);

                info = probed.code === 0 ? readProbe(probed.stdout) : undefined;
            }

            const cost = made.cost === undefined ? "cost not reported" : `cost $${made.cost.toFixed(2)}`;
            const usage: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: made.cost ?? 0 } };

            return {
                output: [{ type: "text" as const, text: `Made a video with ${model.id}, ${cost}:\n- ${path} (${info === undefined ? megabytes(made.data.length) : describe(info)})\nIt shows in the chat.` }],
                details: plain({
                    model: model.id,
                    video: { path, bytes: made.data.length, ...(info?.width === undefined ? {} : { width: info.width, height: info.height }), ...(info?.duration === undefined ? {} : { duration: info.duration }) },
                    job: made.job,
                    ...(made.cost === undefined ? {} : { cost: made.cost }),
                }),
                usage,
            };
        },
    });

    const transcribe = defineTool({
        name: "audio_transcribe",
        description:
            "Transcribe speech in an audio or video file where this session works (m4a, mp3, wav, ogg, opus, flac, aac, mp4, mov, webm, mkv) to text, SRT or VTT subtitles, or JSON (utterances with start and end in ms), " +
            `on the person's ChatGPT (Codex) sign-in (gpt-4o-transcribe by default; setting audio.transcribeModel). Long files go in parts of ${PART_SECONDS / 60} minutes. ` +
            "The transcript is saved in transcripts/ where this session works; you get its path and its start. language (a code like vi or en) and prompt (names and words to expect) default to Settings › Voice's.",
        parameters: obj({
            path: str({ description: "The audio or video file: a path, absolute or relative to this session's folder" }),
            format: opt(union([literal("text"), literal("srt"), literal("vtt"), literal("json")], { description: "text (default), srt, vtt or json" })),
            language: opt(str({ description: "The language spoken, as a code (vi, en, ...); default Settings › Voice's, or detected" })),
            prompt: opt(str({ description: "Names, terms and words to expect" })),
            model: opt(union(TRANSCRIBE_MODELS.map((each) => literal(each)), { description: "The transcription model for this call only" })),
        }, { open: true }),
        execute: async (args, api, context) => {
            let model;

            try {
                model = host.audio.transcribeModel(args.model);
            } catch (error) {
                return reply(error instanceof Error ? error.message : String(error), true);
            }

            const cwd = (await api.agent(context)).cwd ?? "";
            const env = host.envOf(cwd);
            const absolute = await env.absolutePath(args.path, context);

            if (!absolute.ok) {
                return reply(`Cannot find ${args.path}: ${absolute.error.message}`, true);
            }

            const engine = await engineFor(cwd, env, context);

            if (typeof engine === "string") {
                return reply(engine, true);
            }

            const probed = await output(env, commandOf(engine, "ffprobe", probeArgs(absolute.value)), context, 60);

            if (probed.code !== 0) {
                return reply(`${args.path} is not an audio or video file ffmpeg reads: ${probed.stderr.trim()}`, true);
            }

            const info = readProbe(probed.stdout);

            if (info.audio === undefined || info.duration === undefined) {
                return reply(`${args.path} has no sound to transcribe (${describe(info)}).`, true);
            }

            const folder = await env.absolutePath(TRANSCRIPTS, context);
            const created = folder.ok ? await env.createDir(folder.value, { recursive: true }, context) : folder;

            if (!folder.ok || !created.ok) {
                return reply(`Cannot save in ${TRANSCRIPTS}: ${!created.ok ? created.error.message : ""}`, true);
            }

            const base = `${folder.value}/${stamp(new Date())}-${slugOf(args.path.split("/").pop()?.replace(/\.[^.]+$/, "") ?? "audio")}`;
            const hints = host.audio.transcribeHints({ ...(args.language === undefined ? {} : { language: args.language }), ...(args.prompt === undefined ? {} : { prompt: args.prompt }) });
            const parts = Math.max(1, Math.ceil(info.duration / PART_SECONDS));
            const utterances: Utterance[] = [];
            const tokens = { input: 0, output: 0 };

            for (let part = 0; part < parts; part++) {
                const wav = `${base}.part.wav`;
                const cut = await output(env, commandOf(engine, "ffmpeg", pcmPartArgs(absolute.value, wav, part * PART_SECONDS, PART_SECONDS)), context);
                const read = cut.code === 0 ? await env.readBinaryFile(wav, context) : undefined;

                await env.remove(wav, { force: true }, context);

                if (read === undefined || !read.ok) {
                    return reply(`Could not read the sound of ${args.path}${parts > 1 ? ` (part ${part + 1} of ${parts})` : ""}: ${read === undefined ? cut.stderr.trim() : read.error.message}`, true);
                }

                const pcm = wavData(read.value);

                if (pcm === undefined) {
                    return reply(`ffmpeg did not make a WAV of ${args.path}.`, true);
                }

                try {
                    const heard = await host.audio.transcribePart(pcm, { model, ...hints }, context.abortSignal);

                    utterances.push(...heard.utterances.map((each) => ({ ...each, start: each.start + part * PART_SECONDS * 1000, end: each.end + part * PART_SECONDS * 1000 })));
                    tokens.input += heard.usage.input;
                    tokens.output += heard.usage.output;
                } catch (error) {
                    return reply(`${error instanceof Error ? error.message : String(error)}${parts > 1 ? ` (part ${part + 1} of ${parts})` : ""}`, true);
                }
            }

            const format = args.format ?? "text";
            const text = utterances.map((each) => each.text).join("\n");
            const content = format === "srt" ? srtOf(utterances) : format === "vtt" ? vttOf(utterances) : format === "json" ? `${JSON.stringify(utterances, null, 1)}\n` : `${text}\n`;
            const path = `${base}.${format === "text" ? "txt" : format}`;
            const written = await env.writeFile(path, content, context);

            if (!written.ok) {
                return reply(`Could not write ${path}: ${written.error.message}`, true);
            }

            const start = text.length > 1500 ? `${text.slice(0, 1500)}…` : text;

            return {
                output: [
                    {
                        type: "text" as const,
                        text:
                            utterances.length === 0
                                ? `No speech heard in ${args.path} (${info.duration} s). Saved an empty transcript: ${path}`
                                : `Transcribed ${args.path} (${info.duration} s${parts > 1 ? `, ${parts} parts` : ""}) with ${model}: ${utterances.length} utterances, saved as ${path}\n\n${start}`,
                    },
                ],
                details: plain({ model, transcript: { path, format, utterances: utterances.length, duration: info.duration, parts, lines: utterances.slice(0, 4).map((each) => ({ start: each.start, text: each.text.slice(0, 300) })) }, tokens }),
            };
        },
    });

    const speak = defineTool({
        name: "audio_speak",
        description:
            "Read a text aloud into an audio file (m4a by default, or wav) on the person's ChatGPT (Codex) sign-in, through a realtime model (gpt-realtime-mini by default; setting audio.speakModel), in any language: voice-overs, read-aloud reports, audio summaries. " +
            `voice: one of ${VOICES.join(", ")} (default setting audio.voice); style: how to read it (calm, cheerful, slow, a news anchor...). Long text is read in parts, each checked against what the voice says it said and read again once when it differs. ` +
            "Saved in audio/ where this session works; it plays in the chat.",
        parameters: obj({
            text: str({ description: "What to read, as it should be said" }),
            voice: opt(union(VOICES.map((each) => literal(each)))),
            style: opt(str({ description: "How to read it" })),
            format: opt(union([literal("m4a"), literal("wav")], { description: "m4a (default, AAC) or wav" })),
            model: opt(union(SPEAK_MODELS.map((each) => literal(each)), { description: "The realtime model for this call only" })),
        }, { open: true }),
        execute: async (args, api, context) => {
            if (args.text.trim() === "") {
                return reply("Give the text to read.", true);
            }

            let choice;

            try {
                choice = host.audio.speakChoice({ ...(args.model === undefined ? {} : { model: args.model }), ...(args.voice === undefined ? {} : { voice: args.voice }) });
            } catch (error) {
                return reply(error instanceof Error ? error.message : String(error), true);
            }

            const cwd = (await api.agent(context)).cwd ?? "";
            const env = host.envOf(cwd);
            const format = args.format ?? "m4a";
            const engine = format === "m4a" ? await engineFor(cwd, env, context) : undefined;

            if (typeof engine === "string") {
                return reply(`${engine} (or ask for format: "wav")`, true);
            }

            const parts = speakParts(args.text);
            const pcm: Uint8Array[] = [];
            const tokens = { input: 0, output: 0 };

            for (const [index, part] of parts.entries()) {
                let read;

                try {
                    for (let attempt = 0; attempt < 2; attempt++) {
                        read = await host.audio.speakPart(part, { ...choice, ...(args.style === undefined ? {} : { style: args.style }) }, context.abortSignal);
                        tokens.input += read.usage.input;
                        tokens.output += read.usage.output;

                        if (saidAsWritten(part, read.said)) {
                            break;
                        }
                    }
                } catch (error) {
                    return reply(`${error instanceof Error ? error.message : String(error)}${parts.length > 1 ? ` (part ${index + 1} of ${parts.length})` : ""}`, true);
                }

                if (read === undefined || !saidAsWritten(part, read.said)) {
                    return reply(`The voice did not read part ${index + 1} of ${parts.length} as written, twice. It was to read: "${part}". It said: "${read?.said ?? ""}". Nothing was saved; change the wording (spell out numbers and abbreviations) and try again.`, true);
                }

                pcm.push(read.pcm);
            }

            const folder = await env.absolutePath(AUDIO, context);
            const created = folder.ok ? await env.createDir(folder.value, { recursive: true }, context) : folder;

            if (!folder.ok || !created.ok) {
                return reply(`Cannot save in ${AUDIO}: ${!created.ok ? created.error.message : ""}`, true);
            }

            const base = `${folder.value}/${stamp(new Date())}-${slugOf(args.text)}`;
            const joined = Buffer.concat(pcm);
            const wav = `${base}.wav`;
            const written = await env.writeFile(wav, wavOf(joined), context);

            if (!written.ok) {
                return reply(`Could not write ${wav}: ${written.error.message}`, true);
            }

            let path = wav;

            if (engine !== undefined) {
                path = `${base}.m4a`;
                const ran = await output(env, commandOf(engine, "ffmpeg", m4aArgs(wav, path)), context);

                await env.remove(wav, { force: true }, context);

                if (ran.code !== 0) {
                    return reply(`Could not make ${path}: ${ran.stderr.trim()}`, true);
                }
            }

            const seconds = Math.round((joined.length / (PCM_RATE * 2)) * 10) / 10;
            const size = await env.fileInfo(path, context);
            const bytes = size.ok ? size.value.size : joined.length;

            return {
                output: [{ type: "text" as const, text: `Read aloud with ${choice.model}, voice ${choice.voice}${parts.length > 1 ? `, in ${parts.length} parts` : ""}: ${path} (${seconds} s, ${megabytes(bytes)}). It plays in the chat.` }],
                details: plain({ model: choice.model, voice: choice.voice, audio: { path, bytes, duration: seconds }, parts: parts.length, tokens }),
            };
        },
    });

    return defineExtension({ name: "pocket-media", tools: [media, ask, generate, transcribe, speak] });
}
