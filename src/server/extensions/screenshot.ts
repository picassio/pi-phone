/**
 * `screenshot`: Pi sees what it made (`screenshots.ts`). The app's background service renders a page off screen, as the
 * app's own WebView would show it, at a phone's width and a desktop's, and the pictures come back to Pi as images: an
 * artifact of this session, a file (HTML, SVG, or a Word, Excel, or PowerPoint file as OfficeCLI renders it), or any
 * web page. It closes the check-and-fix step Effective HTML's skills and OfficeCLI's ask for.
 */
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, section } from "@earendil-works/pi-durable";
import type { PocketHost } from "../host.ts";

const reply = (text: string, isError = false) => ({ output: [{ type: "text" as const, text }], ...(isError ? { isError: true } : {}) });

/** A phone's width and a desktop's, in CSS pixels. */
export const DEFAULT_WIDTHS = [390, 1280];
const MIN_WIDTH = 240;
const MAX_WIDTH = 1920;

const DESCRIPTION =
    "See a page as it shows: the phone renders it off screen and gives you a picture at each width (default a phone's 390 px and a desktop's 1280 px, whole page up to 4000 px tall). " +
    "Name one of: artifact (an artifact of this session, by id, as the person opens it), path (a file: .html, .htm, .svg, or .docx/.xlsx/.pptx as OfficeCLI renders it), or url (an http or https page). " +
    "Use it after making or changing an artifact or a page, to check layout, overflow, clipped or overlapping text, and broken states, then fix what you see and look again. " +
    "Scripts run and the network works; give a page a moment to load what it fetches (settle).";

/** In every prompt while the module is on. */
export const SEEING = `Seeing your work: after you make or change an artifact, an HTML page, or an Office file, look at it with screenshot (a phone's width and a desktop's) and fix what you see before you call it done.`;

export default function createScreenshot(host: PocketHost) {
    const screenshot = defineTool({
        name: "screenshot",
        description: DESCRIPTION,
        parameters: Type.Object({
            artifact: Type.Optional(Type.String({ description: "An artifact of this session, by its id" })),
            path: Type.Optional(Type.String({ description: "A file to show: .html, .htm, .svg, .docx, .xlsx, or .pptx" })),
            url: Type.Optional(Type.String({ description: "An http or https page" })),
            widths: Type.Optional(Type.Array(Type.Number(), { description: "CSS pixel widths, one picture each; default [390, 1280]" })),
            fullPage: Type.Optional(Type.Boolean({ description: "The whole page (default), or only the first screen" })),
            settle: Type.Optional(Type.Number({ description: "Seconds to wait after loading, for scripts and pictures (default 1.5, at most 10)" })),
        }),
        // Only looks: a render runs again after a restart.
        replay: "safe",
        execute: async (args, api) => {
            const named = [args.artifact, args.path, args.url].filter((each) => each !== undefined && each !== "");

            if (named.length !== 1) {
                return reply("Name exactly one of artifact, path, or url.", true);
            }

            const widths = args.widths ?? DEFAULT_WIDTHS;

            if (widths.length === 0 || widths.length > 4 || !widths.every((width) => Number.isInteger(width) && width >= MIN_WIDTH && width <= MAX_WIDTH)) {
                return reply(`widths are 1 to 4 whole numbers from ${MIN_WIDTH} to ${MAX_WIDTH}.`, true);
            }

            const base = host.serverBase();

            if (base === undefined) {
                return reply("This server has no address for the phone to render from.", true);
            }

            let url: string;
            let what: string;

            if (args.url !== undefined) {
                if (!/^https?:\/\//i.test(args.url)) {
                    return reply("url is an http or https address.", true);
                }

                url = args.url;
                what = args.url;
            } else if (args.artifact !== undefined) {
                url = `${base}/a/${String(api.conversationId)}/${encodeURIComponent(args.artifact)}/latest`;
                what = `artifact ${args.artifact}`;
            } else {
                const path = args.path!;
                const office = /\.(docx|xlsx|pptx)$/i.test(path);

                if (!office && !/\.(html?|svg)$/i.test(path)) {
                    return reply("path is a .html, .htm, .svg, .docx, .xlsx, or .pptx file.", true);
                }

                // A whole workbook: every sheet in full (`wholeWorkbookPage`), as its own page shows one screen of one.
                const whole = (args.fullPage ?? true) && /\.xlsx$/i.test(path) ? "&whole=1" : "";

                url = `${base}/a/${office ? "office" : "file"}/${String(api.conversationId)}?path=${encodeURIComponent(path)}${whole}`;
                what = path;
            }

            let shots;

            try {
                shots = await host.render(url, {
                    widths,
                    fullPage: args.fullPage ?? true,
                    settleMs: Math.round(Math.max(0, Math.min(10, args.settle ?? 1.5)) * 1000),
                });
            } catch (error) {
                return reply(error instanceof Error ? error.message : String(error), true);
            }

            return {
                output: [
                    {
                        type: "text" as const,
                        text: `${what}, as the phone renders it: ${shots.map((shot) => `${shot.width}×${shot.height}${shot.parts.length > 1 ? ` in ${shot.parts.length} pictures, top to bottom` : ""}`).join(", ")} (CSS pixels${shots.some((shot) => shot.height >= 4000) ? "; cut at 4000 px tall" : ""}).`,
                    },
                    ...shots.flatMap((shot) => shot.parts.map((part) => ({ type: "image" as const, data: part.toString("base64"), mimeType: "image/jpeg" }))),
                ],
            };
        },
    });

    return defineExtension({
        name: "pocket-screenshot",
        tools: [screenshot],
        sections: [section("seeing", () => SEEING)],
    });
}
