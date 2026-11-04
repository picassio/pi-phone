/**
 * A picture compared with a reference, pixel by pixel (PP-396), for pixel-perfect work: a mockup or a design file, or a
 * screenshot Pi kept as good (`screenshot`'s save, `browser_screenshot`'s path), against a new screenshot. pixelmatch
 * (ISC, pure JavaScript, about 37 KB) counts the pixels whose colour moved past a tolerance and finds anti-aliased
 * edge pixels to leave out; Photon (already in for markup) reads PNG and JPEG and writes the diff picture. The changed
 * pixels are grouped into areas (near ones merged, the largest kept), and the diff picture shows the new picture
 * faded to gray, the changed pixels red, the anti-aliasing left out yellow, and the areas framed with their numbers.
 */
import pixelmatch from "pixelmatch";
import { decodePicture, type MarkArea, markUp, type RawPicture, scalePicture } from "./markup.ts";

/** A changed area, in the reference's pixels, with how many of its pixels changed. */
export type ChangedArea = MarkArea & { pixels: number };

export type Comparison = {
    width: number;
    height: number;
    /** The picture's own size, when it was scaled to the reference's. */
    scaledFrom?: { width: number; height: number };
    changed: number;
    /** Anti-aliased pixels that differ and were left out (0 when they count). */
    antialiased: number;
    /** The largest changed areas, numbered top to bottom as in the diff picture. */
    areas: ChangedArea[];
    /** The areas left out of `areas`, and their changed pixels. */
    more: { areas: number; pixels: number };
    /** The diff picture as a PNG (to save) and a JPEG (to show). */
    png: Uint8Array;
    jpeg: Uint8Array;
};

export type CompareOptions = { threshold?: number; antialiasing?: boolean; resize?: boolean };

/** Areas named one by one; the rest are counted. */
export const MAX_AREAS = 12;
/** Pixels at most in each picture: four buffers of this many fit in the phone's server. */
export const MAX_PIXELS = 30_000_000;
/** Changed pixels closer than this (in pixels) are one area: the letters of a word, the parts of an icon. */
const GAP = 16;
const CELL = 8;
const RED: [number, number, number] = [255, 0, 0];
const YELLOW: [number, number, number] = [255, 200, 0];

/** Where the diff picture goes by default: beside the picture, `-diff.png` added to its name. */
export function diffPathOf(picture: string): string {
    const dot = picture.lastIndexOf(".");

    return `${dot > picture.lastIndexOf("/") ? picture.slice(0, dot) : picture}-diff.png`;
}

const sizeOf = (picture: { width: number; height: number }) => `${picture.width}×${picture.height}`;

/** The changed pixels (red in `diff`) grouped into areas: cells of 8 px, joined when within `GAP`, then boxes that overlap. */
export function changedAreas(diff: Uint8Array, width: number, height: number): ChangedArea[] {
    const columns = Math.ceil(width / CELL);
    const rows = Math.ceil(height / CELL);
    const count = new Int32Array(columns * rows);
    const x0 = new Int32Array(columns * rows).fill(width);
    const y0 = new Int32Array(columns * rows).fill(height);
    const x1 = new Int32Array(columns * rows).fill(-1);
    const y1 = new Int32Array(columns * rows).fill(-1);

    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const at = (y * width + x) * 4;

            if (diff[at] === RED[0] && diff[at + 1] === RED[1] && diff[at + 2] === RED[2]) {
                const cell = Math.floor(y / CELL) * columns + Math.floor(x / CELL);

                count[cell]!++;
                x0[cell] = Math.min(x0[cell]!, x);
                y0[cell] = Math.min(y0[cell]!, y);
                x1[cell] = Math.max(x1[cell]!, x);
                y1[cell] = Math.max(y1[cell]!, y);
            }
        }
    }

    const reach = Math.ceil(GAP / CELL);
    const seen = new Uint8Array(columns * rows);
    let boxes: { x0: number; y0: number; x1: number; y1: number; pixels: number }[] = [];

    for (let start = 0; start < count.length; start++) {
        if (count[start] === 0 || seen[start] === 1) {
            continue;
        }

        const box = { x0: width, y0: height, x1: -1, y1: -1, pixels: 0 };
        const queue = [start];

        seen[start] = 1;

        while (queue.length > 0) {
            const cell = queue.pop()!;
            const cx = cell % columns;
            const cy = Math.floor(cell / columns);

            box.x0 = Math.min(box.x0, x0[cell]!);
            box.y0 = Math.min(box.y0, y0[cell]!);
            box.x1 = Math.max(box.x1, x1[cell]!);
            box.y1 = Math.max(box.y1, y1[cell]!);
            box.pixels += count[cell]!;

            for (let ny = Math.max(0, cy - reach); ny <= Math.min(rows - 1, cy + reach); ny++) {
                for (let nx = Math.max(0, cx - reach); nx <= Math.min(columns - 1, cx + reach); nx++) {
                    const next = ny * columns + nx;

                    if (count[next]! > 0 && seen[next] === 0) {
                        seen[next] = 1;
                        queue.push(next);
                    }
                }
            }
        }

        boxes.push(box);
    }

    // Boxes that overlap (or nearly) are one area: an L-shaped change is one box, not two crossing ones.
    for (let merged = true; merged; ) {
        merged = false;

        const kept: typeof boxes = [];

        for (const box of boxes) {
            const into = kept.find((other) => box.x0 <= other.x1 + GAP && other.x0 <= box.x1 + GAP && box.y0 <= other.y1 + GAP && other.y0 <= box.y1 + GAP);

            if (into === undefined) {
                kept.push({ ...box });
            } else {
                into.x0 = Math.min(into.x0, box.x0);
                into.y0 = Math.min(into.y0, box.y0);
                into.x1 = Math.max(into.x1, box.x1);
                into.y1 = Math.max(into.y1, box.y1);
                into.pixels += box.pixels;
                merged = true;
            }
        }

        boxes = kept;
    }

    return boxes
        .sort((a, b) => b.pixels - a.pixels)
        .map((box) => ({ x: box.x0, y: box.y0, width: box.x1 - box.x0 + 1, height: box.y1 - box.y0 + 1, pixels: box.pixels }));
}

/**
 * `picture` compared with `reference` (PNG or JPEG bytes each). Pictures of different sizes fail, naming both sizes,
 * unless `resize` asks to scale the picture to the reference's size.
 */
export function compareImages(referenceBytes: Uint8Array, pictureBytes: Uint8Array, { threshold = 0.1, antialiasing = false, resize = false }: CompareOptions = {}): Comparison {
    if (!(threshold >= 0 && threshold <= 1)) {
        throw new Error("threshold is from 0 (exact) to 1.");
    }

    const reference = decodePicture(referenceBytes);
    let picture: RawPicture = decodePicture(pictureBytes);

    for (const [name, each] of [["reference", reference], ["picture", picture]] as const) {
        if (each.width * each.height > MAX_PIXELS) {
            throw new Error(`The ${name} is ${sizeOf(each)} px: Pi compares pictures of up to ${MAX_PIXELS / 1_000_000} million pixels. Crop it first (media, action image, crop).`);
        }
    }

    let scaledFrom: { width: number; height: number } | undefined;

    if (picture.width !== reference.width || picture.height !== reference.height) {
        if (!resize) {
            throw new Error(
                `The pictures differ in size: the reference is ${sizeOf(reference)} px, the picture ${sizeOf(picture)} px. Nothing was compared. ` +
                    `Give resize: true to compare at the reference's size (the picture scaled to ${sizeOf(reference)}), or take the picture again at the reference's size.`,
            );
        }

        scaledFrom = { width: picture.width, height: picture.height };
        picture = scalePicture(picture, reference.width, reference.height);
    }

    const { width, height } = reference;
    const diff = new Uint8Array(width * height * 4);
    // The new picture first: the diff picture fades it to gray behind the changes.
    const changed = pixelmatch(picture.data, reference.data, diff, width, height, { threshold, includeAA: antialiasing, alpha: 0.3, diffColor: RED, aaColor: YELLOW });
    let antialiased = 0;

    if (!antialiasing) {
        for (let at = 0; at < diff.length; at += 4) {
            if (diff[at] === YELLOW[0] && diff[at + 1] === YELLOW[1] && diff[at + 2] === YELLOW[2]) {
                antialiased++;
            }
        }
    }

    const all = changedAreas(diff, width, height);
    const areas = all.slice(0, MAX_AREAS).sort((a, b) => a.y - b.y || a.x - b.x);
    const rest = all.slice(MAX_AREAS);
    const png = markUp({ data: diff, width, height }, areas.map((area, n) => ({ area, number: n + 1, color: "blue" })), { png: true }).bytes;

    return {
        width,
        height,
        ...(scaledFrom === undefined ? {} : { scaledFrom }),
        changed,
        antialiased,
        areas,
        more: { areas: rest.length, pixels: rest.reduce((sum, area) => sum + area.pixels, 0) },
        png,
        jpeg: markUp(png, [], { png: false }).bytes,
    };
}

/** A share of the pixels, readable: 0.12%, under 0.01%. */
export function shareOf(changed: number, total: number): string {
    if (changed === 0) {
        return "0%";
    }

    const percent = (changed / total) * 100;

    return percent < 0.01 ? "under 0.01%" : `${percent < 1 ? percent.toFixed(2) : percent < 10 ? percent.toFixed(1) : Math.round(percent)}%`;
}

/** What Pi reads of a comparison. */
export function describeComparison(comparison: Comparison, names: { reference: string; picture: string; out: string }): string {
    const { width, height, changed, antialiased, areas, more } = comparison;
    const total = width * height;
    const lines = [
        `Compared ${names.picture} with the reference ${names.reference} at ${width}×${height} px` +
            (comparison.scaledFrom === undefined
                ? ""
                : ` (the picture, ${sizeOf(comparison.scaledFrom)}, scaled to the reference's size${comparison.scaledFrom.width * height !== comparison.scaledFrom.height * width ? ", and stretched: their shapes differ" : ""})`) +
            `: ${changed === 0 ? "no pixel changed" : `${changed.toLocaleString("en")} of ${total.toLocaleString("en")} pixels changed (${shareOf(changed, total)})`}` +
            `${antialiased > 0 ? `; ${antialiased.toLocaleString("en")} anti-aliased pixels differ and were left out` : ""}.`,
    ];

    if (areas.length > 0) {
        lines.push(`Changed areas, in the reference's pixels, top to bottom:`);

        for (const [n, area] of areas.entries()) {
            lines.push(`${n + 1}. x ${area.x}, y ${area.y}, ${area.width}×${area.height} px (${area.pixels.toLocaleString("en")} pixels changed)`);
        }

        if (more.areas > 0) {
            lines.push(`And ${more.areas} smaller areas (${more.pixels.toLocaleString("en")} pixels changed).`);
        }
    }

    lines.push(
        `Diff picture saved as ${names.out}: the picture faded to gray, changed pixels red${antialiased > 0 ? ", anti-aliasing left out yellow" : ""}${areas.length > 0 ? ", the areas framed in blue with their numbers" : ""}.`,
    );

    return lines.join("\n");
}
