/**
 * `screenshot`: Pi sees what it made (`screenshots.ts`). The app's background service renders a page off screen, as the
 * app's own WebView would show it, at a phone's width, a desktop's and a large screen's, and the pictures come back to Pi as images: an
 * artifact of this session, a file (HTML, SVG, or a Word, Excel, or PowerPoint file as OfficeCLI renders it), or any
 * web page. It closes the check-and-fix step Effective HTML's skills and OfficeCLI's ask for.
 */
import { arr, bool, num, obj, opt, str } from "@earendil-works/pi-schema";
import type { Context } from "@earendil-works/chord";
import { type Cursor, defineExtension, defineTool, GenerationTask, type HookApi, hook, section } from "@earendil-works/pi-durable";
import type { PocketHost } from "../host.ts";
import { compareImages, describeComparison, diffPathOf } from "../image-compare.ts";
import { describeLayout } from "../layout-check.ts";
import { DEFAULT_WIDTHS } from "../screenshots.ts";
import { isPicturePath, NO_DOM, parseRedline, redlinePictures, redlineScript, specFrom } from "../redline.ts";
import { isPng, markUp } from "../markup.ts";
import { AREA, MARK_STYLE, MARKS_NOTE } from "../mark-schema.ts";
import { type ClientEntry, projectEntry } from "../projection.ts";
import { checkSteps, MAX_STEPS, type RenderStep, STEPS_MS, stepWords } from "../render-steps.ts";
import { reminderText, startsTurn, uncheckedUi } from "../ui-reminder.ts";

/** The most entries read back for one turn. */
const TURN_ENTRIES = 3000;

/** The turn's entries, oldest first: back to the message that started it (`startsTurn`). */
async function turnEntries(api: HookApi, context: Context): Promise<ClientEntry[]> {
    const found: ClientEntry[] = [];
    let cursor: Cursor | undefined;

    while (found.length < TURN_ENTRIES) {
        const page = await api.entries({ order: "descending" }, 200, cursor, context);

        for (const record of page.items) {
            const entry = projectEntry(record);

            if (entry === undefined) {
                continue;
            }

            found.push(entry);

            if (startsTurn(entry)) {
                return found.reverse();
            }
        }

        if (page.next === undefined) {
            break;
        }

        cursor = page.next;
    }

    return found.reverse();
}

const reply = (text: string, isError = false) => ({ output: [{ type: "text" as const, text }], ...(isError ? { isError: true } : {}) });

const MIN_WIDTH = 240;
const MAX_WIDTH = 1920;
/** How long a render may take: the request's default, and each width's steps on top. */
const RENDER_MS = 90_000;

/** Steps before the shot (PP-423, `render-steps.ts`), for screenshot and redline alike. */
// One open object a step, checked by `checkSteps`: four object shapes in the schema cost every request 400 characters.
const STEPS = opt(
    arr(obj({}, { open: true }), {
        maxItems: MAX_STEPS,
        description: "Run in the page first, each width, to measure a menu, picker or dialog open: {click: css} | {type: css, text} | {press: key} | {wait: ms | css}",
    }),
);

/** The steps checked, or why not; and what the answer says of them. */
const stepsOf = (given: readonly unknown[] | undefined): { steps: RenderStep[]; words: string } | { error: string } => {
    const steps = checkSteps(given ?? []);

    return "error" in steps ? steps : { steps, words: steps.length === 0 ? "" : ` after ${steps.length === 1 ? "one step" : `${steps.length} steps`} (${steps.map(stepWords).join(", ")})` };
};

const DESCRIPTION =
    "See a page as it shows: the phone renders it off screen and gives you a picture at each width (default 390, 1280 and 1920 px: a phone, a desktop, a large screen; whole page up to 4000 px tall). " +
    "Name one of: artifact (an artifact of this session, by id, as the person opens it), path (a file: .html, .htm, .svg, or .docx/.xlsx/.pptx as OfficeCLI renders it), or url (an http or https page). " +
    "Use it after making or changing an artifact or a page, then fix what you see and look again. " +
    "Each width comes with a measured layout check, grouped with numbers: spills, a page wider than the screen, cut text, elements covering text or controls, tap targets under 40 px on a phone, sizes off the 4 px grid, text under WCAG AA contrast or 12 px, emoji as icons, gradient text, uppercase labels, long lines, too many font sizes or colours. Trust its numbers over the picture, and when they disagree, find out why. " +
    "Scripts run and the network works; give a page a moment to load what it fetches (settle). " +
    "With save, the pictures are saved as files too, to mark up with image_markup or put in documents.";

/** In every prompt while the module is on. */
export const SEEING = `Seeing your work: after you make or change an artifact, an HTML page, or an Office file, look at it with screenshot (390, 1280 and 1920 px) and fix what you see before you call it done. Check app changes in the live app (http://127.0.0.1:8787/s/<id>, or a sheet by /?sheet=...), not only a test page. Go by the layout check's numbers more than the picture; when the picture, the numbers, or a test page disagree, find out why before you call it right, never explain it away. For pixel-perfect work, keep a reference picture (the mockup, or a screenshot saved with save or path once it is right) and compare each new screenshot with it with image_compare. To check spacing, radii and type against a spec, use redline.`;

export default function createScreenshot(host: PocketHost) {
    /** The address the phone renders for an artifact of this session, a file, or a web page, and its name in answers. */
    const pageOf = (args: { artifact?: string; path?: string; url?: string; fullPage?: boolean }, conversation: string): { url: string; what: string } | { error: string } => {
        const base = host.serverBase();

        if (base === undefined) {
            return { error: "This server has no address for the phone to render from." };
        }

        if (args.url !== undefined) {
            return /^https?:\/\//i.test(args.url) ? { url: args.url, what: args.url } : { error: "url is an http or https address." };
        }

        if (args.artifact !== undefined) {
            return { url: `${base}/a/${conversation}/${encodeURIComponent(args.artifact)}/latest`, what: `artifact ${args.artifact}` };
        }

        const path = args.path!;
        const office = /\.(docx|xlsx|pptx)$/i.test(path);

        if (!office && !/\.(html?|svg)$/i.test(path)) {
            return { error: "path is a .html, .htm, .svg, .docx, .xlsx, or .pptx file." };
        }

        // A whole workbook: every sheet in full (`wholeWorkbookPage`), as its own page shows one screen of one.
        const whole = (args.fullPage ?? true) && /\.xlsx$/i.test(path) ? "&whole=1" : "";

        return { url: `${base}/a/${office ? "office" : "file"}/${conversation}?path=${encodeURIComponent(path)}${whole}`, what: path };
    };

    const screenshot = defineTool({
        name: "screenshot",
        description: DESCRIPTION,
        parameters: obj({
            artifact: opt(str({ description: "An artifact of this session, by its id" })),
            path: opt(str({ description: "A file to show: .html, .htm, .svg, .docx, .xlsx, or .pptx" })),
            url: opt(str({ description: "An http or https page" })),
            widths: opt(arr(num(), { description: "CSS pixel widths, one picture each; default [390, 1280, 1920]" })),
            fullPage: opt(bool({ description: "The whole page (default), or only the first screen" })),
            settle: opt(num({ description: "Seconds to wait after loading, for scripts and pictures (default 1.5, at most 10)" })),
            save: opt(str({
                    description: "Save the pictures too, ending in .png or .jpg (absolute or relative to this session's folder): one per width, its width added to the name (page-390.png), and -2, -3 for the parts of a tall one",
                })),
            steps: STEPS,
        }, { open: true }),
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

            const steps = stepsOf(args.steps);

            if ("error" in steps) {
                return reply(steps.error, true);
            }

            const page = pageOf(args, String(api.conversationId));

            if ("error" in page) {
                return reply(page.error, true);
            }

            const { url, what } = page;

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
                    ...(steps.steps.length === 0 ? {} : { steps: steps.steps, timeoutMs: RENDER_MS + widths.length * STEPS_MS }),
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
                        text: `${what}, as the phone renders it${steps.words}: ${shots.map((shot) => `${shot.width}×${shot.height}${shot.parts.length > 1 ? ` in ${shot.parts.length} pictures, top to bottom` : ""}`).join(", ")} (CSS pixels${shots.some((shot) => shot.height >= 4000) ? "; cut at 4000 px tall" : ""}).${saved.length === 0 ? "" : ` Saved as ${saved.join(", ")}.`}`,
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
        parameters: obj({
            path: str({ description: "The picture: absolute or relative to this session's folder" }),
            marks: arr(obj({ area: AREA, ...MARK_STYLE }, { open: true }), { minItems: 1, maxItems: 40, description: "Marks drawn on the picture, in order" }),
            out: opt(str({ description: "Where to save the marked picture, .png or .jpg (default: beside it, -marked added to its name)" })),
        }, { open: true }),
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

    const imageCompare = defineTool({
        name: "image_compare",
        description:
            "Compare a picture with a reference picture, pixel by pixel, for pixel-perfect work: the reference is a mockup or design file, or a screenshot you kept once it was right (screenshot's save, browser_screenshot's path); the picture is a new screenshot of the same page at the same width. " +
            "Both are .png or .jpg files where this session works, of the same size: pictures of different sizes are not compared (the answer gives both sizes) unless resize scales the picture to the reference's size. " +
            "The answer gives the share of changed pixels and the changed areas (x, y, width, height in the reference's pixels; near changes merged, the largest 12 named), and shows a diff picture, saved beside the picture: the picture faded to gray, changed pixels red, the areas framed in blue with their numbers. " +
            "Anti-aliased edge pixels (text and curves drawn a little differently) are found and left out unless antialiasing counts them.",
        parameters: obj({
            reference: str({ description: "The reference picture, .png or .jpg: absolute or relative to this session's folder" }),
            picture: str({ description: "The picture to compare with it, .png or .jpg" }),
            out: opt(str({ description: "Where to save the diff picture, a .png (default: beside the picture, -diff added to its name)" })),
            threshold: opt(num({ minimum: 0, maximum: 1, description: "How far a pixel's colour may move and still count as the same, 0 (exact) to 1 (default 0.1; JPEG pictures may need 0.15)" })),
            antialiasing: opt(bool({ description: "Count anti-aliased edge pixels as changes too (default false: they are left out)" })),
            resize: opt(bool({ description: "Pictures of different sizes: scale the picture to the reference's size and compare (default false: say the sizes and compare nothing)" })),
        }, { open: true }),
        execute: async (args, api, context) => {
            const out = args.out ?? diffPathOf(args.picture);

            if (!/\.png$/i.test(out)) {
                return reply("Save the diff picture as a .png (out): a JPEG blurs single changed pixels.", true);
            }

            try {
                const env = host.envOf((await api.agent(context)).cwd ?? "");
                const read = async (path: string) => {
                    const absolute = await env.absolutePath(path, context);

                    if (!absolute.ok) {
                        throw new Error(`Cannot use ${path}: ${absolute.error.message}`);
                    }

                    const bytes = await env.readBinaryFile(absolute.value, context);

                    if (!bytes.ok) {
                        throw new Error(`Could not read ${absolute.value}: ${bytes.error.message}`);
                    }

                    return { path: absolute.value, bytes: bytes.value };
                };
                const reference = await read(args.reference);
                const picture = await read(args.picture);
                const target = await env.absolutePath(out, context);

                if (!target.ok) {
                    throw new Error(`Cannot save to ${out}: ${target.error.message}`);
                }

                const comparison = compareImages(reference.bytes, picture.bytes, {
                    ...(args.threshold === undefined ? {} : { threshold: args.threshold }),
                    ...(args.antialiasing === undefined ? {} : { antialiasing: args.antialiasing }),
                    ...(args.resize === undefined ? {} : { resize: args.resize }),
                });
                const written = await env.writeFile(target.value, comparison.png, context);

                if (!written.ok) {
                    throw new Error(`Could not save ${target.value}: ${written.error.message}`);
                }

                return {
                    output: [
                        { type: "text" as const, text: describeComparison(comparison, { reference: reference.path, picture: picture.path, out: target.value }) },
                        // Nothing changed: nothing to look at.
                        ...(comparison.changed === 0 ? [] : [{ type: "image" as const, data: Buffer.from(comparison.jpeg).toString("base64"), mimeType: "image/jpeg" }]),
                    ],
                };
            } catch (error) {
                return reply(error instanceof Error ? error.message : String(error), true);
            }
        },
    });

    const redline = defineTool({
        name: "redline",
        description:
            "Measure a page from its DOM and draw the numbers on its picture, as a designer's redlines: padding as green strips and gaps between blocks as magenta ones with their pixels, corner radii as blue tags, control sizes in orange (tap targets under 40 px on a phone in red), type (size/line height, weight, colour) in purple, and a legend of the values used under the picture. " +
            "Name one of artifact (this session's), path (an .html or .htm file) or url (an http or https page, the live app too: http://127.0.0.1:8787/s/<id>, /?sheet=...); for the page in front of Pi's browser use browser_redline. " +
            "Auto mode measures the main blocks (surfaces with a background, border or shadow, and controls); selector measures the elements it finds. " +
            "With spec, values off it are red with the spec's nearest value (\"gap 23, spec 24\") and listed: a design system's tokens.css path (the design-system skill's `systems.ts show <id>` names it), or a plain list such as \"padding 16, gap 8/16, radius 24/12/20, font 22/13/12, weight 400/500, line 20, target 44\" (spacing sets padding and gap). " +
            "With steps (as screenshot's), a menu, a picker or a dialog is opened first and measured open. " +
            "A picture file has no DOM: compare it with image_compare.",
        parameters: obj({
            artifact: opt(str({ description: "An artifact of this session, by its id" })),
            path: opt(str({ description: "An .html or .htm file" })),
            url: opt(str({ description: "An http or https page" })),
            width: opt(num({ description: "CSS pixels wide (default 390)" })),
            selector: opt(str({ description: "A CSS selector: measure the elements it finds (at most 40) instead of the main blocks" })),
            spec: opt(str({ description: "A tokens.css path, or a plain list like \"padding 16, radius 24/12/20, font 22/13/12\"" })),
            fullPage: opt(bool({ description: "The whole page (default), or only the first screen" })),
            settle: opt(num({ description: "Seconds to wait after loading (default 1.5, at most 10)" })),
            save: opt(str({ description: "Save the marked picture too, .png or .jpg; a tall page's later parts get -2, -3" })),
            steps: STEPS,
        }, { open: true }),
        replay: "safe",
        execute: async (args, api, context) => {
            const named = [args.artifact, args.path, args.url].filter((each) => each !== undefined && each !== "");

            if (named.length !== 1) {
                return reply("Name exactly one of artifact, path, or url.", true);
            }

            if (args.path !== undefined && isPicturePath(args.path)) {
                return reply(NO_DOM, true);
            }

            if (args.path !== undefined && !/\.html?$/i.test(args.path)) {
                return reply("path is an .html or .htm file: redlines measure a page's DOM.", true);
            }

            const width = args.width ?? 390;

            if (!Number.isInteger(width) || width < MIN_WIDTH || width > MAX_WIDTH) {
                return reply(`width is a whole number from ${MIN_WIDTH} to ${MAX_WIDTH}.`, true);
            }

            const kind = args.save === undefined ? undefined : /\.png$/i.test(args.save) ? "png" : /\.jpe?g$/i.test(args.save) ? "jpeg" : "bad";

            if (kind === "bad") {
                return reply("Give save a path ending in .png or .jpg.", true);
            }

            const steps = stepsOf(args.steps);

            if ("error" in steps) {
                return reply(steps.error, true);
            }

            const page = pageOf(args, String(api.conversationId));

            if ("error" in page) {
                return reply(page.error, true);
            }

            try {
                const env = host.envOf((await api.agent(context)).cwd ?? "");
                const spec = await specFrom(args.spec, async (path) => {
                    const read = await env.readTextFile(path, context);

                    if (!read.ok) {
                        throw new Error(`Could not read the spec ${path}: ${read.error.message}`);
                    }

                    return read.value;
                });
                const [shot] = await host.render(page.url, {
                    widths: [width],
                    fullPage: args.fullPage ?? true,
                    settleMs: Math.round(Math.max(0, Math.min(10, args.settle ?? 1.5)) * 1000),
                    check: redlineScript({ width, ...(args.selector === undefined ? {} : { selector: args.selector }) }),
                    ...(steps.steps.length === 0 ? {} : { steps: steps.steps, timeoutMs: RENDER_MS + STEPS_MS }),
                });
                const measure = parseRedline(shot?.check);

                if (shot === undefined || measure === undefined) {
                    throw new Error(`${page.what} gave no measure: its script could not run there${shot?.check === undefined ? "" : ` (${shot.check.slice(0, 200)})`}.`);
                }

                const tops = shot.parts.map((_, index) => index * 2000);
                const { pictures, text } = redlinePictures(
                    shot.parts.map((bytes, index) => ({ bytes, top: tops[index]! })),
                    measure,
                    spec,
                    { cssWidth: shot.width, cssHeight: shot.height, png: kind === "png" },
                );
                const saved: string[] = [];

                if (args.save !== undefined) {
                    const dot = args.save.lastIndexOf(".");

                    for (const [index, picture] of pictures.entries()) {
                        const name = index === 0 ? args.save : `${args.save.slice(0, dot)}-${index + 1}${args.save.slice(dot)}`;
                        const absolute = await env.absolutePath(name, context);

                        if (!absolute.ok) {
                            throw new Error(`Cannot save to ${name}: ${absolute.error.message}`);
                        }

                        const written = await env.writeFile(absolute.value, picture, context);

                        if (!written.ok) {
                            throw new Error(`Could not save ${absolute.value}: ${written.error.message}`);
                        }

                        saved.push(absolute.value);
                    }
                }

                return {
                    output: [
                        { type: "text" as const, text: `${page.what}, measured and pictured${steps.words} at ${shot.width}×${shot.height} CSS px.${saved.length === 0 ? "" : ` Saved as ${saved.join(", ")}.`}\n${text}` },
                        ...pictures.map((picture) => ({ type: "image" as const, data: Buffer.from(picture).toString("base64"), mimeType: kind === "png" ? "image/png" : "image/jpeg" })),
                    ],
                };
            } catch (error) {
                return reply(error instanceof Error ? error.message : String(error), true);
            }
        },
    });

    return defineExtension({
        name: "pocket-screenshot",
        tools: [screenshot, imageMarkup, imageCompare, redline],
        sections: [section("seeing", () => SEEING)],
        hooks: [
            // "Remind to check UI before finishing" (PP-422, Settings › Hooks): a turn that ends with UI changed after its
            // last look gets one follow-up, in subagents too. The artifact check counts as a look while it is on.
            hook(GenerationTask, {
                onYield: async (_answer, api, context) => {
                    if (!host.hookOn("uiReminder")) {
                        return undefined;
                    }

                    // Once a turn: its transcript holds the reminder once sent (`uncheckedUi`), a restart included.
                    const files = uncheckedUi(await turnEntries(api, context), !host.hookOn("artifactCheck"));

                    return files.length === 0 ? undefined : { continue: reminderText(files) };
                },
            }),
        ],
    });
}
