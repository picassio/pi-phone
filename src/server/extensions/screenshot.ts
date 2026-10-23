/**
 * `screenshot`: Pi sees what it made (`screenshots.ts`). The app's background service renders a page off screen, as the
 * app's own WebView would show it, at a phone's width and a desktop's, and the pictures come back to Pi as images: an
 * artifact of this session, a file (HTML, SVG, or a Word, Excel, or PowerPoint file as OfficeCLI renders it), or any
 * web page. It closes the check-and-fix step Effective HTML's skills and OfficeCLI's ask for.
 */
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, section } from "@earendil-works/pi-durable";
import type { PocketHost } from "../host.ts";
import { describeLayout } from "../layout-check.ts";
import { isPng, markUp } from "../markup.ts";
import { AREA, MARK_STYLE, MARKS_NOTE } from "../mark-schema.ts";

const reply = (text: string, isError = false) => ({ output: [{ type: "text" as const, text }], ...(isError ? { isError: true } : {}) });

/** A phone's width and a desktop's, in CSS pixels. */
export const DEFAULT_WIDTHS = [390, 1280];
const MIN_WIDTH = 240;
const MAX_WIDTH = 1920;

const DESCRIPTION =
    "See a page as it shows: the phone renders it off screen and gives you a picture at each width (default a phone's 390 px and a desktop's 1280 px, whole page up to 4000 px tall). " +
    "Name one of: artifact (an artifact of this session, by id, as the person opens it), path (a file: .html, .htm, .svg, or .docx/.xlsx/.pptx as OfficeCLI renders it), or url (an http or https page). " +
    "Use it after making or changing an artifact or a page, to check layout, overflow, clipped or overlapping text, and broken states, then fix what you see and look again. " +
    "Each width comes with a measured layout check (what spills out of its box or its parent, and whether the page is wider than the screen, with sizes): trust its numbers over the picture, and when they disagree, find out why. " +
    "Scripts run and the network works; give a page a moment to load what it fetches (settle). " +
    "With save, the pictures are saved as files too, to mark up with image_markup or put in documents.";

/** In every prompt while the module is on. */
export const SEEING = `Seeing your work: after you make or change an artifact, an HTML page, or an Office file, look at it with screenshot (a phone's width and a desktop's) and fix what you see before you call it done. Check app changes in the live app (http://127.0.0.1:8787/s/<id>, or a sheet by /?sheet=...), not only a test page. Go by the layout check's numbers more than the picture; when the picture, the numbers, or a test page disagree, find out why before you call it right, never explain it away.`;

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
            save: Type.Optional(
                Type.String({
                    description: "Save the pictures too, ending in .png or .jpg (absolute or relative to this session's folder): one per width, its width added to the name (page-390.png), and -2, -3 for the parts of a tall one",
                }),
            ),
        }),
        // Only looks: a render runs again after a restart.
        replay: "safe",
        execute: async (args, api, context) => {
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

            const kind = args.save === undefined ? undefined : /\.png$/i.test(args.save) ? "png" : /\.jpe?g$/i.test(args.save) ? "jpeg" : "bad";

            if (kind === "bad") {
                return reply("Give save a path ending in .png or .jpg.", true);
            }

            let shots;
            const saved: string[] = [];

            try {
                shots = await host.render(url, {
                    widths,
                    fullPage: args.fullPage ?? true,
                    settleMs: Math.round(Math.max(0, Math.min(10, args.settle ?? 1.5)) * 1000),
                });

                // Saved, one file per width (and part): for image_markup and documents (PP-119).
                if (args.save !== undefined) {
                    const save = args.save;
                    const env = host.envOf((await api.agent(context)).cwd ?? "");
                    const dot = save.lastIndexOf(".");

                    for (const shot of shots) {
                        for (const [n, part] of shot.parts.entries()) {
                            const name = `${save.slice(0, dot)}-${shot.width}${n === 0 ? "" : `-${n + 1}`}${save.slice(dot)}`;
                            const absolute = await env.absolutePath(name, context);

                            if (!absolute.ok) {
                                throw new Error(`Cannot save to ${name}: ${absolute.error.message}`);
                            }

                            const bytes = kind === "png" && !isPng(part) ? markUp(part, [], { png: true }).bytes : part;
                            const written = await env.writeFile(absolute.value, bytes, context);

                            if (!written.ok) {
                                throw new Error(`Could not save ${absolute.value}: ${written.error.message}`);
                            }

                            saved.push(absolute.value);
                        }
                    }
                }
            } catch (error) {
                return reply(error instanceof Error ? error.message : String(error), true);
            }

            return {
                output: [
                    {
                        type: "text" as const,
                        text: `${what}, as the phone renders it: ${shots.map((shot) => `${shot.width}×${shot.height}${shot.parts.length > 1 ? ` in ${shot.parts.length} pictures, top to bottom` : ""}`).join(", ")} (CSS pixels${shots.some((shot) => shot.height >= 4000) ? "; cut at 4000 px tall" : ""}).${saved.length === 0 ? "" : ` Saved as ${saved.join(", ")}.`}`,
                    },
                    ...shots.flatMap((shot) => [
                        ...shot.parts.map((part) => ({ type: "image" as const, data: part.toString("base64"), mimeType: "image/jpeg" })),
                        {
                            type: "text" as const,
                            text: shot.layout === undefined ? `Layout check at ${shot.width} px: not measured (an older app).` : describeLayout(shot.layout),
                        },
                    ]),
                ],
            };
        },
    });

    const imageMarkup = defineTool({
        name: "image_markup",
        description: `Draw marks on a picture file where this session works (a .png or .jpg: a screenshot saved with path, a photo, a picture from a document), and save it: for runbooks, reports and documents (doc_image). ${MARKS_NOTE} Areas are in the picture's pixels, from its top left; the answer gives its size and shows the result, so check it and mark again if a mark is off.`,
        parameters: Type.Object({
            path: Type.String({ description: "The picture: absolute or relative to this session's folder" }),
            marks: Type.Array(Type.Object({ area: AREA, ...MARK_STYLE }), { minItems: 1, maxItems: 40, description: "Marks drawn on the picture, in order" }),
            out: Type.Optional(Type.String({ description: "Where to save the marked picture, .png or .jpg (default: beside it, -marked added to its name)" })),
        }),
        execute: async (args, api, context) => {
            const dot = args.path.lastIndexOf(".");
            const out = args.out ?? (dot > args.path.lastIndexOf("/") ? `${args.path.slice(0, dot)}-marked${args.path.slice(dot)}` : `${args.path}-marked.png`);
            const png = /\.png$/i.test(out);

            if (!png && !/\.jpe?g$/i.test(out)) {
                return reply("Save it as a .png or .jpg (out).", true);
            }

            try {
                const env = host.envOf((await api.agent(context)).cwd ?? "");
                const source = await env.absolutePath(args.path, context);
                const target = await env.absolutePath(out, context);

                if (!source.ok || !target.ok) {
                    throw new Error(`Cannot use ${!source.ok ? args.path : out}: ${(!source.ok ? source.error : !target.ok ? target.error : undefined)?.message ?? ""}`);
                }

                const bytes = await env.readBinaryFile(source.value, context);

                if (!bytes.ok) {
                    throw new Error(`Could not read ${source.value}: ${bytes.error.message}`);
                }

                const marked = markUp(bytes.value, args.marks, { png });
                const outside = args.marks.filter((mark) => mark.area.x >= marked.width || mark.area.y >= marked.height || mark.area.x + mark.area.width <= 0 || mark.area.y + mark.area.height <= 0).length;
                const written = await env.writeFile(target.value, marked.bytes, context);

                if (!written.ok) {
                    throw new Error(`Could not save ${target.value}: ${written.error.message}`);
                }

                return {
                    output: [
                        {
                            type: "text" as const,
                            text: `Marked ${args.marks.length} on a ${marked.width}×${marked.height} px picture; saved as ${target.value} (${Math.max(1, Math.round(marked.bytes.length / 1024))} KB).${outside > 0 ? ` ${outside} of the marks lie outside the picture and drew nothing.` : ""}`,
                        },
                        { type: "image" as const, data: Buffer.from(marked.bytes).toString("base64"), mimeType: png ? "image/png" : "image/jpeg" },
                    ],
                };
            } catch (error) {
                return reply(error instanceof Error ? error.message : String(error), true);
            }
        },
    });

    return defineExtension({
        name: "pocket-screenshot",
        tools: [screenshot, imageMarkup],
        sections: [section("seeing", () => SEEING)],
    });
}
