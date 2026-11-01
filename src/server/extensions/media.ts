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
import { Type } from "@earendil-works/pi-ai";
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
    imageArgs,
    localEngine,
    machineEngine,
    MAX_FRAMES,
    type MediaEngine,
    type MediaInfo,
    output,
    probeArgs,
    readProbe,
    sampleRate,
    sheetArgs,
} from "../media.ts";
import { slugOf } from "./images.ts";

const FOLDER = "media";
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
        const machine = host.machineOf(cwd);

        if (machine !== undefined) {
            return (
                (await machineEngine(env, machine.tools, context)) ??
                `${machine.name} has no ffmpeg: install it in Menu › Machines › ${machine.name} › Install tools (ffmpeg, about 350 MB), or run there what installs ffmpeg and ffprobe; then try again.`
            );
        }

        return localEngine() ?? "This server has no ffmpeg: it comes with the pi-phone app and the server edition's image (native/<platform>/ffmpeg). Update the app or the image.";
    }

    const media = defineTool({
        name: "media",
        description: DESCRIPTION,
        parameters: Type.Object({
            action: Type.Union([Type.Literal("info"), Type.Literal("image"), Type.Literal("frames"), Type.Literal("clip")], { description: "info, image, frames, or clip" }),
            path: Type.String({ description: "The image or video: a path, absolute or relative to this session's folder" }),
            width: Type.Optional(Type.Integer({ minimum: 8, maximum: 8192, description: "image: fit within this width; frames: each frame this wide (default 480; 320 in a sheet)" })),
            height: Type.Optional(Type.Integer({ minimum: 8, maximum: 8192, description: "image: fit within this height; clip: shrink to at most this height (default 720)" })),
            crop: Type.Optional(Type.String({ description: "image: the part to keep, width:height:x:y in pixels of the original" })),
            rotate: Type.Optional(Type.Union([Type.Literal(90), Type.Literal(180), Type.Literal(270)], { description: "image: turn clockwise" })),
            flip: Type.Optional(Type.Union([Type.Literal("horizontal"), Type.Literal("vertical")])),
            format: Type.Optional(Type.Union([Type.Literal("jpg"), Type.Literal("png"), Type.Literal("webp")], { description: "image and frames: jpg, png or webp (image: default its own, else jpg)" })),
            quality: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, description: "image: 1 to 100 for jpg and webp (smaller files lower)" })),
            at: Type.Optional(Type.Array(Type.Number({ minimum: 0 }), { maxItems: MAX_FRAMES, description: "frames: seconds to take a frame at" })),
            every: Type.Optional(Type.Number({ exclusiveMinimum: 0, description: "frames: one frame every this many seconds" })),
            count: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_FRAMES, description: `frames: how many (default 12; at most ${MAX_FRAMES})` })),
            sheet: Type.Optional(Type.Boolean({ description: "frames: one contact sheet image instead of separate frames" })),
            start: Type.Optional(Type.Number({ minimum: 0, description: "clip: from this second" })),
            end: Type.Optional(Type.Number({ exclusiveMinimum: 0, description: "clip: to this second" })),
            mute: Type.Optional(Type.Boolean({ description: "clip: without sound" })),
        }),
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

    return defineExtension({ name: "pocket-media", tools: [media] });
}
