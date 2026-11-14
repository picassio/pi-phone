/**
 * Images and video for Pi (PP-296, the owner's pick: one engine everywhere): ffmpeg and ffprobe where the session works.
 *
 * - On the phone: the slim build the APK carries (`scripts/build-ffmpeg-android.sh`, native/android-arm64/ffmpeg/).
 * - In the server edition (Docker, team): BtbN's static build the image carries (`scripts/server-tools.ts`,
 *   native/linux-<arch>/ffmpeg/), the same pinned release machines install.
 * - On a machine: its ffmpeg machine tool (Menu › Machines › Install tools, `~/.pi/mobile/tools/bin/`), or its own.
 *
 * What the media tool does is built here as ffmpeg's arguments (each operation one or a few runs), so every engine does
 * the same: an image resized, cropped, turned, converted or compressed; a video's frames, a contact sheet, a clip
 * trimmed, shrunk or muted; and what a file is (ffprobe).
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Context } from "@earendil-works/chord/context";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { APP_ROOT } from "./config.ts";
import { jpegOrientation } from "./image-meta.ts";

/**
 * ffmpeg and ffprobe, as a command runs them where the session works. `script`: they are a machine tool's wrappers
 * (bash scripts, run through bash so Windows' Git Bash runs them too).
 */
export type MediaEngine = { ffmpeg: string; ffprobe: string; where: "phone" | "server" | "machine"; script?: true };

/** The command line that runs one of the engine's programs with `args`. */
export const commandOf = (engine: MediaEngine, program: "ffmpeg" | "ffprobe", args: readonly string[]): string[] =>
    engine.script === true ? ["bash", engine[program], ...args] : [engine[program], ...args];

/** The image formats the tool writes. */
export const IMAGE_FORMATS = ["jpg", "png", "webp"] as const;
export type ImageFormat = (typeof IMAGE_FORMATS)[number];

/** Frames at most in one call, and in a contact sheet. */
export const MAX_FRAMES = 48;
/** How long one ffmpeg run may take, in seconds. */
const RUN_SECONDS = 15 * 60;

/** The engine this server carries: the phone's build or the server edition's; undefined when it has none. */
export function localEngine(root = APP_ROOT, platform: string = process.platform, arch: string = process.arch): MediaEngine | undefined {
    const folder = platform === "android" ? "android-arm64" : platform === "linux" ? `linux-${arch === "arm64" ? "arm64" : "x64"}` : undefined;

    if (folder === undefined) {
        return undefined;
    }

    const dir = join(root, "native", folder, "ffmpeg");
    const ffmpeg = join(dir, "ffmpeg");
    const ffprobe = join(dir, "ffprobe");

    return existsSync(ffmpeg) && existsSync(ffprobe) ? { ffmpeg, ffprobe, where: platform === "android" ? "phone" : "server" } : undefined;
}

/**
 * A machine's engine: its ffmpeg machine tool when installed, else an ffmpeg of its own on its PATH; undefined with
 * neither (the tool then says how to install it).
 */
export async function machineEngine(env: ExecutionEnv, tools: Record<string, string>, context: Context): Promise<MediaEngine | undefined> {
    if (tools.ffmpeg !== undefined) {
        const home = await env.absolutePath("~", context);

        if (home.ok) {
            const bin = `${home.value.replaceAll("\\", "/")}/.pi/mobile/tools/bin`;

            return { ffmpeg: `${bin}/ffmpeg`, ffprobe: `${bin}/ffprobe`, where: "machine", script: true };
        }
    }

    const found = await output(env, ["sh", "-c", "command -v ffmpeg && command -v ffprobe"], context, 15);

    if (found.code === 0) {
        const [ffmpeg, ffprobe] = found.stdout.trim().split("\n").map((line) => line.trim());

        if (ffmpeg !== undefined && ffprobe !== undefined && ffmpeg !== "" && ffprobe !== "") {
            return { ffmpeg, ffprobe, where: "machine" };
        }
    }

    return undefined;
}

/** The engine where a session works: its machine's (`machine`), or this server's; or what is missing, to tell Pi. */
export async function engineWhere(machine: { name: string; tools: Record<string, string> } | undefined, env: ExecutionEnv, context: Context): Promise<MediaEngine | string> {
    if (machine !== undefined) {
        return (
            (await machineEngine(env, machine.tools, context)) ??
            `${machine.name} has no ffmpeg: install it in Menu › Machines › ${machine.name} › Install tools (ffmpeg, about 350 MB), or run there what installs ffmpeg and ffprobe; then try again.`
        );
    }

    return localEngine() ?? "This server has no ffmpeg: it comes with the pi-phone app and the server edition's image (native/<platform>/ffmpeg). Update the app or the image.";
}

/** The long side, at most, of a picture turned upright for a model. */
export const UPRIGHT_MAX = 2048;

/** ffmpeg's arguments for a picture turned upright by its Exif orientation (ffmpeg applies it as it reads), as a JPEG at most UPRIGHT_MAX on its long side. */
export function uprightArgs(input: string, out: string): string[] {
    return [
        "-hide_banner", "-loglevel", "error", "-y", "-i", input,
        "-vf", `scale='min(${UPRIGHT_MAX},iw)':'min(${UPRIGHT_MAX},ih)':force_original_aspect_ratio=decrease`,
        "-frames:v", "1", "-c:v", "mjpeg", "-pix_fmt", "yuvj420p", "-q:v", "3", "-update", "1", out,
    ];
}

/**
 * A picture for a model, upright (PP-304): a JPEG whose Exif orientation turns it (a phone's portrait photo, stored
 * landscape) is turned by the media engine into `out` and read back, since models take the pixels as they are; any
 * other picture comes back as it is. A string says what went wrong.
 */
export async function uprightPicture(
    env: ExecutionEnv,
    input: string,
    bytes: Uint8Array,
    out: string,
    engine: () => Promise<MediaEngine | string>,
    context: Context,
): Promise<{ data: Uint8Array; mimeType?: "image/jpeg"; turned?: string } | string> {
    const orientation = jpegOrientation(bytes);

    if (orientation === undefined || orientation === 1) {
        return { data: bytes };
    }

    const found = await engine();

    if (typeof found === "string") {
        return `${input} is a photo stored on its side (Exif orientation ${orientation}), and turning it upright needs ffmpeg. ${found}`;
    }

    const folder = out.slice(0, out.lastIndexOf("/"));
    const created = folder === "" ? { ok: true as const } : await env.createDir(folder, { recursive: true }, context);

    if (!created.ok) {
        return `Could not make ${folder}: ${created.error.message}`;
    }

    const ran = await output(env, commandOf(found, "ffmpeg", uprightArgs(input, out)), context, 120);

    if (ran.code !== 0) {
        return `Could not turn ${input} upright: ${ran.stderr.trim() || `ffmpeg ended with ${ran.code}`}`;
    }

    const read = await env.readBinaryFile(out, context);

    return read.ok ? { data: read.value, mimeType: "image/jpeg", turned: out } : `Could not read ${out}: ${read.error.message}`;
}

/** A command's exit code, its standard output, and the end of what it printed on standard error. */
export async function output(env: ExecutionEnv, argv: readonly string[], context: Context, timeout = RUN_SECONDS): Promise<{ code: number; stdout: string; stderr: string }> {
    let stdout = "";
    let stderr = "";
    const ran = await env.exec(
        argv,
        {
            timeout,
            onOutput: (text, _context, info) => {
                if (info.stream === "stdout") {
                    stdout += text;
                } else {
                    stderr = (stderr + text).slice(-4000);
                }
            },
        },
        context,
    );

    if (!ran.ok) {
        return { code: -1, stdout, stderr: ran.error.message };
    }

    return { code: ran.value.exitCode, stdout, stderr };
}

/** What ffprobe says of a file, in short. */
export type MediaInfo = {
    kind: "image" | "video" | "audio";
    format: string;
    bytes: number;
    /** Seconds; absent for an image. */
    duration?: number;
    width?: number;
    height?: number;
    /** Degrees the video is turned when played (a phone's portrait video). */
    rotation?: number;
    fps?: number;
    video?: string;
    audio?: string;
    bitrate?: number;
};

type Probe = {
    format?: { format_name?: string; duration?: string; size?: string; bit_rate?: string };
    streams?: {
        codec_type?: string;
        codec_name?: string;
        width?: number;
        height?: number;
        avg_frame_rate?: string;
        nb_frames?: string;
        disposition?: { attached_pic?: number };
        side_data_list?: { rotation?: number }[];
        tags?: { rotate?: string };
    }[];
};

/** Codecs of single pictures: a file whose only video stream is one of these, and has no length, is an image. */
const STILLS = new Set(["mjpeg", "png", "webp", "gif", "bmp", "tiff"]);

/** ffprobe's JSON, in short. */
export function readProbe(json: string): MediaInfo {
    const probe = JSON.parse(json) as Probe;
    const streams = probe.streams ?? [];
    const video = streams.find((stream) => stream.codec_type === "video" && stream.disposition?.attached_pic !== 1);
    const audio = streams.find((stream) => stream.codec_type === "audio");
    const duration = Number(probe.format?.duration);
    const name = probe.format?.format_name ?? "";
    const still = video !== undefined && STILLS.has(video.codec_name ?? "") && (name.includes("image2") || name.endsWith("_pipe") || !(duration > 0)) && audio === undefined;
    const [num, den] = (video?.avg_frame_rate ?? "0/1").split("/").map(Number);
    const fps = den !== undefined && den > 0 && num !== undefined && num > 0 ? Math.round((num / den) * 100) / 100 : undefined;
    const rotation = video?.side_data_list?.find((data) => typeof data.rotation === "number")?.rotation ?? (video?.tags?.rotate === undefined ? undefined : Number(video.tags.rotate));

    return {
        kind: still ? "image" : video !== undefined ? "video" : "audio",
        format: still ? (video?.codec_name === "mjpeg" ? "jpeg" : (video?.codec_name ?? name)) : name,
        bytes: Number(probe.format?.size ?? 0),
        ...(!still && duration > 0 ? { duration: Math.round(duration * 100) / 100 } : {}),
        ...(video?.width === undefined ? {} : { width: video.width, height: video.height }),
        ...(rotation === undefined || rotation === 0 || Number.isNaN(rotation) ? {} : { rotation: ((Math.round(rotation) % 360) + 360) % 360 }),
        ...(!still && fps !== undefined ? { fps } : {}),
        ...(!still && video?.codec_name !== undefined ? { video: video.codec_name } : {}),
        ...(audio?.codec_name === undefined ? {} : { audio: audio.codec_name }),
        ...(!still && probe.format?.bit_rate !== undefined ? { bitrate: Number(probe.format.bit_rate) } : {}),
    };
}

/** ffprobe's arguments for `readProbe`. */
export const probeArgs = (input: string): string[] => ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", input];

/** How an image is changed. */
export type ImageEdit = {
    /** Fit within this box, keeping the shape (one side alone sets that side). */
    width?: number;
    height?: number;
    /** A part to keep: `width:height:x:y` in pixels of the original. */
    crop?: { width: number; height: number; x: number; y: number };
    /** Turned clockwise. */
    rotate?: 90 | 180 | 270;
    flip?: "horizontal" | "vertical";
    /** 1 to 100: for JPEG and WebP; PNG is lossless. */
    quality?: number;
};

const TURNS: Record<90 | 180 | 270, string[]> = { 90: ["transpose=1"], 180: ["hflip", "vflip"], 270: ["transpose=2"] };

/** The scale filter that fits a picture within width × height (either may be absent), keeping its shape. */
function fit(width: number | undefined, height: number | undefined, even: boolean): string | undefined {
    if (width === undefined && height === undefined) {
        return undefined;
    }

    const round = even ? -2 : -1;

    if (width !== undefined && height !== undefined) {
        return `scale=${width}:${height}:force_original_aspect_ratio=decrease${even ? ":force_divisible_by=2" : ""}`;
    }

    return width !== undefined ? `scale=${width}:${round}` : `scale=${round}:${height}`;
}

/** The encoder's settings for an image format and quality. */
function stillCodec(format: ImageFormat, quality: number | undefined): string[] {
    if (format === "jpg") {
        // ffmpeg's JPEG quality scale: 2 (best) to 31.
        const q = quality === undefined ? 3 : Math.max(2, Math.min(31, Math.round(31 - (quality / 100) * 29)));

        return ["-c:v", "mjpeg", "-pix_fmt", "yuvj420p", "-q:v", String(q)];
    }

    if (format === "webp") {
        return ["-c:v", "libwebp", "-quality", String(quality ?? 82), "-compression_level", "4"];
    }

    return ["-c:v", "png", "-pred", "mixed"];
}

/** ffmpeg's arguments to change one image into `out` (its format by its extension). */
export function imageArgs(input: string, out: string, format: ImageFormat, edit: ImageEdit): string[] {
    const filters = [
        ...(edit.crop === undefined ? [] : [`crop=${edit.crop.width}:${edit.crop.height}:${edit.crop.x}:${edit.crop.y}`]),
        ...(edit.rotate === undefined ? [] : TURNS[edit.rotate]),
        ...(edit.flip === undefined ? [] : [edit.flip === "horizontal" ? "hflip" : "vflip"]),
        ...[fit(edit.width, edit.height, false)].filter((each) => each !== undefined),
    ];

    return ["-hide_banner", "-loglevel", "error", "-y", "-i", input, ...(filters.length === 0 ? [] : ["-vf", filters.join(",")]), "-frames:v", "1", ...stillCodec(format, edit.quality), "-update", "1", out];
}

/** Which frames of a video: at given seconds, every so many seconds, or so many spread over it. */
export type FramePick = { at: number[] } | { every: number; count: number } | { count: number; duration: number };

/** The scale filter that makes frames at most `width` wide, never wider than the video. */
const shrink = (width: number | undefined): string | undefined => (width === undefined ? undefined : `scale='min(${width},iw)':-1`);

/** ffmpeg's arguments for one frame at `seconds` (each time a run of its own: a fast seek). */
export function frameAtArgs(input: string, out: string, seconds: number, width: number | undefined, format: ImageFormat): string[] {
    const scale = shrink(width);

    return ["-hide_banner", "-loglevel", "error", "-y", "-ss", String(seconds), "-i", input, ...(scale === undefined ? [] : ["-vf", scale]), "-frames:v", "1", ...stillCodec(format, 80), "-update", "1", out];
}

/** The sampling rate (frames a second) that gives `count` frames over `duration`, or one every `every` seconds. */
export function sampleRate(pick: { every: number } | { count: number; duration: number }): string {
    const rate = "every" in pick ? 1 / pick.every : pick.count / Math.max(pick.duration, 0.01);

    return String(Math.round(rate * 100000) / 100000);
}

/** ffmpeg's arguments for frames sampled over a video into a numbered pattern (`out` with `%03d`). */
export function framesArgs(input: string, outPattern: string, rate: string, count: number, width: number | undefined, format: ImageFormat): string[] {
    const filters = [`fps=${rate}`, shrink(width)].filter((each) => each !== undefined);

    return ["-hide_banner", "-loglevel", "error", "-y", "-i", input, "-vf", filters.join(","), "-frames:v", String(count), ...stillCodec(format, 80), outPattern];
}

/** The grid a contact sheet of `count` frames has: columns × rows, about as wide as tall for a 16:9 video. */
export function grid(count: number): { columns: number; rows: number } {
    const columns = Math.max(1, Math.ceil(Math.sqrt(count)));

    return { columns, rows: Math.ceil(count / columns) };
}

/** ffmpeg's arguments for a contact sheet: `count` frames spread over the video, each `width` wide, in one picture. */
export function sheetArgs(input: string, out: string, rate: string, count: number, width: number, format: ImageFormat): string[] {
    const { columns, rows } = grid(count);

    return [
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-i",
        input,
        "-vf",
        `fps=${rate},scale=${width}:-1,tile=${columns}x${rows}:padding=4:margin=4`,
        "-frames:v",
        "1",
        ...stillCodec(format, 82),
        "-update",
        "1",
        out,
    ];
}

/** How a clip is cut from a video. */
export type ClipEdit = {
    /** Seconds from the start. */
    start?: number;
    end?: number;
    /** Shrunk to at most this many lines high (default 720), keeping the shape; never enlarged. */
    height?: number;
    mute?: boolean;
};

/** ffmpeg's arguments for an H.264/AAC mp4 clip: trimmed, shrunk, muted, streamable. */
export function clipArgs(input: string, out: string, edit: ClipEdit): string[] {
    const height = edit.height ?? 720;

    return [
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        ...(edit.start === undefined ? [] : ["-ss", String(edit.start)]),
        ...(edit.end === undefined ? [] : ["-to", String(edit.end)]),
        "-i",
        input,
        "-vf",
        `scale=-2:'min(${height},ih)',format=yuv420p`,
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        "26",
        ...(edit.mute === true ? ["-an"] : ["-c:a", "aac", "-b:a", "128k"]),
        "-movflags",
        "+faststart",
        out,
    ];
}
