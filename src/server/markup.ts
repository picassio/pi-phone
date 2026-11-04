/**
 * Marks on a picture (PP-119), for runbooks and reports: a box around something, a numbered badge for a step, a short
 * label, an arrow pointing at it, the rest dimmed (spotlight), and parts hidden, with a solid box (keys, tokens,
 * passwords: nothing can be recovered) or a heavy blur (names, emails). `browser_screenshot` marks a page's controls by
 * number; `image_markup` marks any picture file by pixel areas. Drawn on the pixels with Photon (PNG and JPEG in and
 * out, and its white text); the shapes are drawn here.
 */
import { createRequire } from "node:module";
import type { LegendLine, RedlineShape } from "./redline.ts";

type PhotonImage = {
    get_width(): number;
    get_height(): number;
    get_raw_pixels(): Uint8Array;
    get_bytes(): Uint8Array;
    get_bytes_jpeg(quality: number): Uint8Array;
    free(): void;
};

type Photon = {
    PhotonImage: { new (raw: Uint8Array, width: number, height: number): PhotonImage; new_from_byteslice(bytes: Uint8Array): PhotonImage };
    draw_text(image: PhotonImage, text: string, x: number, y: number, size: number): void;
    resize(image: PhotonImage, width: number, height: number, filter: number): PhotonImage;
};

// Photon's Node build is CommonJS and loads its WebAssembly as it is required.
const photon = createRequire(import.meta.url)("@silvia-odwyer/photon-node") as Photon;

/** A part of a picture, in its pixels (or, for a page, its CSS pixels before scaling). */
export type MarkArea = { x: number; y: number; width: number; height: number };

/** One mark: on an area, any of a box, a numbered badge, a label and an arrow; or the area hidden; or kept lit. */
export type Mark = {
    area: MarkArea;
    box?: boolean;
    number?: number;
    label?: string;
    arrow?: boolean;
    hide?: "solid" | "blur";
    spotlight?: boolean;
    color?: string;
};

const COLORS: Record<string, [number, number, number]> = {
    red: [229, 57, 53],
    orange: [245, 124, 0],
    yellow: [251, 192, 45],
    green: [46, 160, 67],
    blue: [30, 136, 229],
    purple: [142, 68, 173],
    pink: [216, 27, 96],
    black: [33, 33, 33],
};

export const MARK_COLORS = Object.keys(COLORS);

/** A color by name or `#rrggbb`; red by default. */
export function colorOf(color: string | undefined): [number, number, number] {
    if (color === undefined || color === "") {
        return COLORS.red!;
    }

    const named = COLORS[color.toLowerCase()];

    if (named !== undefined) {
        return named;
    }

    const hex = /^#?([0-9a-f]{6})$/i.exec(color)?.[1];

    if (hex === undefined) {
        throw new Error(`${color} is not a color: name one of ${MARK_COLORS.join(", ")}, or give #rrggbb.`);
    }

    return [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16)];
}

/** A canvas over RGBA pixels. */
class Pixels {
    readonly data: Uint8Array;
    readonly width: number;
    readonly height: number;

    constructor(data: Uint8Array, width: number, height: number) {
        this.data = data;
        this.width = width;
        this.height = height;
    }

    /** Blend a color over one pixel, `alpha` 0 to 1. */
    dot(x: number, y: number, [r, g, b]: [number, number, number], alpha = 1): void {
        if (x < 0 || y < 0 || x >= this.width || y >= this.height) {
            return;
        }

        const at = (Math.floor(y) * this.width + Math.floor(x)) * 4;

        this.data[at] = Math.round(this.data[at]! * (1 - alpha) + r * alpha);
        this.data[at + 1] = Math.round(this.data[at + 1]! * (1 - alpha) + g * alpha);
        this.data[at + 2] = Math.round(this.data[at + 2]! * (1 - alpha) + b * alpha);
        this.data[at + 3] = 255;
    }

    fill(area: MarkArea, color: [number, number, number], alpha = 1): void {
        const x0 = Math.max(0, Math.floor(area.x));
        const y0 = Math.max(0, Math.floor(area.y));
        const x1 = Math.min(this.width, Math.ceil(area.x + area.width));
        const y1 = Math.min(this.height, Math.ceil(area.y + area.height));

        for (let y = y0; y < y1; y++) {
            for (let x = x0; x < x1; x++) {
                this.dot(x, y, color, alpha);
            }
        }
    }

    /** An outline `thickness` wide, inside the area's edge. */
    frame(area: MarkArea, color: [number, number, number], thickness: number): void {
        this.fill({ x: area.x, y: area.y, width: area.width, height: thickness }, color);
        this.fill({ x: area.x, y: area.y + area.height - thickness, width: area.width, height: thickness }, color);
        this.fill({ x: area.x, y: area.y, width: thickness, height: area.height }, color);
        this.fill({ x: area.x + area.width - thickness, y: area.y, width: thickness, height: area.height }, color);
    }

    disc(cx: number, cy: number, radius: number, color: [number, number, number]): void {
        for (let y = Math.floor(cy - radius - 1); y <= Math.ceil(cy + radius + 1); y++) {
            for (let x = Math.floor(cx - radius - 1); x <= Math.ceil(cx + radius + 1); x++) {
                // Edge pixels partly covered: a smooth rim.
                const cover = Math.max(0, Math.min(1, radius + 0.5 - Math.hypot(x + 0.5 - cx, y + 0.5 - cy)));

                if (cover > 0) {
                    this.dot(x, y, color, cover);
                }
            }
        }
    }

    line(x0: number, y0: number, x1: number, y1: number, color: [number, number, number], thickness: number): void {
        const steps = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / Math.max(1, thickness / 3)));

        for (let step = 0; step <= steps; step++) {
            this.disc(x0 + ((x1 - x0) * step) / steps, y0 + ((y1 - y0) * step) / steps, thickness / 2, color);
        }
    }

    triangle(points: [number, number][], color: [number, number, number]): void {
        const [a, b, c] = points as [[number, number], [number, number], [number, number]];
        const side = (p: [number, number], q: [number, number], x: number, y: number) => (q[0] - p[0]) * (y - p[1]) - (q[1] - p[1]) * (x - p[0]);

        for (let y = Math.floor(Math.min(a[1], b[1], c[1])); y <= Math.ceil(Math.max(a[1], b[1], c[1])); y++) {
            for (let x = Math.floor(Math.min(a[0], b[0], c[0])); x <= Math.ceil(Math.max(a[0], b[0], c[0])); x++) {
                const [d1, d2, d3] = [side(a, b, x + 0.5, y + 0.5), side(b, c, x + 0.5, y + 0.5), side(c, a, x + 0.5, y + 0.5)];

                if ((d1 >= 0 && d2 >= 0 && d3 >= 0) || (d1 <= 0 && d2 <= 0 && d3 <= 0)) {
                    this.dot(x, y, color);
                }
            }
        }
    }

    /** Hidden past reading: tiles of one color each, then blurred, so nothing of the text is left to sharpen. */
    blur(area: MarkArea): void {
        const x0 = Math.max(0, Math.floor(area.x));
        const y0 = Math.max(0, Math.floor(area.y));
        const x1 = Math.min(this.width, Math.ceil(area.x + area.width));
        const y1 = Math.min(this.height, Math.ceil(area.y + area.height));
        const tile = Math.max(6, Math.round(Math.min(x1 - x0, y1 - y0) / 2.5));

        for (let ty = y0; ty < y1; ty += tile) {
            for (let tx = x0; tx < x1; tx += tile) {
                const sum = [0, 0, 0];
                let count = 0;

                for (let y = ty; y < Math.min(y1, ty + tile); y++) {
                    for (let x = tx; x < Math.min(x1, tx + tile); x++) {
                        const at = (y * this.width + x) * 4;

                        sum[0]! += this.data[at]!;
                        sum[1]! += this.data[at + 1]!;
                        sum[2]! += this.data[at + 2]!;
                        count++;
                    }
                }

                this.fill({ x: tx, y: ty, width: Math.min(tile, x1 - tx), height: Math.min(tile, y1 - ty) }, [sum[0]! / count, sum[1]! / count, sum[2]! / count]);
            }
        }

        // Soften the tiles' edges: a box blur, three passes each way, on a copy of the area alone.
        const radius = Math.max(2, Math.round(tile / 2));
        const w = x1 - x0;
        const h = y1 - y0;

        if (w <= 0 || h <= 0) {
            return;
        }

        let area3 = new Float32Array(w * h * 3);

        for (let y = 0; y < h; y++) {
            for (let x = 0; x < w; x++) {
                const at = ((y0 + y) * this.width + x0 + x) * 4;

                area3.set([this.data[at]!, this.data[at + 1]!, this.data[at + 2]!], (y * w + x) * 3);
            }
        }

        for (let pass = 0; pass < 3; pass++) {
            for (const horizontal of [true, false]) {
                const next = new Float32Array(area3.length);

                for (let y = 0; y < h; y++) {
                    for (let x = 0; x < w; x++) {
                        let r = 0;
                        let g = 0;
                        let b = 0;
                        let count = 0;

                        for (let k = -radius; k <= radius; k++) {
                            const sx = horizontal ? x + k : x;
                            const sy = horizontal ? y : y + k;

                            if (sx < 0 || sy < 0 || sx >= w || sy >= h) {
                                continue;
                            }

                            const at = (sy * w + sx) * 3;

                            r += area3[at]!;
                            g += area3[at + 1]!;
                            b += area3[at + 2]!;
                            count++;
                        }

                        next.set([r / count, g / count, b / count], (y * w + x) * 3);
                    }
                }

                area3 = next;
            }
        }

        for (let y = 0; y < h; y++) {
            for (let x = 0; x < w; x++) {
                const from = (y * w + x) * 3;
                const at = ((y0 + y) * this.width + x0 + x) * 4;

                this.data[at] = Math.round(area3[from]!);
                this.data[at + 1] = Math.round(area3[from + 1]!);
                this.data[at + 2] = Math.round(area3[from + 2]!);
            }
        }
    }
}

/** About how wide Photon's text is: its glyphs average 0.42 of the font size. */
const textWidth = (text: string, size: number) => Math.ceil(text.length * size * 0.45) + 2;

/** Whether a byte string is a PNG. */
export const isPng = (bytes: Uint8Array) => bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;

/** A picture's RGBA pixels, row by row. */
export type RawPicture = { data: Uint8Array; width: number; height: number };

/** A PNG's or a JPEG's pixels; anything else fails, saying what it takes. */
export function decodePicture(bytes: Uint8Array): RawPicture {
    let image: PhotonImage;

    try {
        image = photon.PhotonImage.new_from_byteslice(bytes);
    } catch {
        throw new Error("That file is not a picture Pi can read: give a PNG or a JPEG.");
    }

    try {
        return { data: image.get_raw_pixels(), width: image.get_width(), height: image.get_height() };
    } finally {
        image.free();
    }
}

/** A picture scaled to `width`×`height` (Lanczos). */
export function scalePicture(picture: RawPicture, width: number, height: number): RawPicture {
    const image = new photon.PhotonImage(picture.data, picture.width, picture.height);

    try {
        const scaled = photon.resize(image, width, height, 5);

        try {
            return { data: scaled.get_raw_pixels(), width: scaled.get_width(), height: scaled.get_height() };
        } finally {
            scaled.free();
        }
    } finally {
        image.free();
    }
}

/**
 * Redlines on a page's picture (PP-398, `redline.ts`): translucent strips for padding and gaps, thin frames, numbered
 * tags (a quarter arc before a radius), and a legend in a band added under the picture. Shapes are in the page's CSS
 * pixels; `cssWidth` is the page's width (the picture may be at twice it), `top` where this picture starts on the page
 * (a tall page comes in parts). Tags marked `first` (what is off a spec) are placed first; each moves aside when its
 * place is taken, or stays out when there is no room near it (`dropped`), so numbers never cover each other.
 */
export function drawRedlines(
    bytes: Uint8Array | RawPicture,
    shapes: RedlineShape[],
    legend: LegendLine[],
    { png, cssWidth, top = 0, quality = 88 }: { png: boolean; cssWidth: number; top?: number; quality?: number },
): { bytes: Uint8Array; width: number; height: number; placed: number; dropped: number } {
    const source = bytes instanceof Uint8Array ? decodePicture(bytes) : bytes;
    const { width } = source;
    const scale = width / cssWidth;
    const font = Math.max(12, Math.round(12 * scale));
    const pad = Math.max(3, Math.round(3 * scale));
    const lineHeight = Math.round(font * 1.5);
    const chars = Math.max(20, Math.floor((width - 2 * pad - font * 1.6) / (font * 0.45)));
    const legendLines = legend.flatMap((line) => {
        const words = line.text.split(" ");
        const rows: string[] = [];

        for (const word of words) {
            const last = rows.at(-1);

            if (last !== undefined && last.length + word.length + 1 <= chars) {
                rows[rows.length - 1] = `${last} ${word}`;
            } else {
                rows.push(word);
            }
        }

        return rows.map((text, index) => ({ color: line.color, text, swatch: index === 0 }));
    });
    const band = legendLines.length === 0 ? 0 : 2 * pad + legendLines.length * lineHeight;
    const height = source.height + band;
    const data = new Uint8Array(width * height * 4);

    data.set(source.data.subarray(0, width * source.height * 4));

    const pixels = new Pixels(data, width, height);
    const at = (x: number, y: number) => [x * scale, (y - top) * scale] as const;
    const area = (box: [number, number, number, number]) => {
        const [x, y] = at(box[0], box[1]);

        return { x, y, width: box[2] * scale, height: Math.max(1, box[3] * scale) };
    };
    const inPicture = (rect: MarkArea) => rect.x < width && rect.y < source.height && rect.x + rect.width > 0 && rect.y + rect.height > 0;
    const texts: { text: string; x: number; y: number; size: number }[] = [];

    for (const shape of shapes) {
        if (shape.kind === "fill") {
            pixels.fill(area(shape.box), shape.color, shape.alpha);
        } else if (shape.kind === "frame") {
            pixels.frame(area(shape.box), shape.color, Math.max(1, Math.round(scale)));
        }
    }

    const taken: MarkArea[] = [];
    const overlaps = (a: MarkArea) => taken.some((b) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height);
    const labels = shapes.filter((shape) => shape.kind === "label").sort((a, b) => Number(b.first === true) - Number(a.first === true));
    let placed = 0;
    let dropped = 0;

    for (const label of labels) {
        const arc = label.arc === true ? Math.round(font * 0.9) : 0;
        const w = textWidth(label.text, font) + 2 * pad + arc;
        const h = Math.round(font * 1.4) + 2;
        const [px, py] = at(label.x, label.y);
        const x0 = label.anchor === "center" ? px - w / 2 : label.anchor === "end" ? px - w : px + 1;
        const y0 = label.anchor === "center" ? py - h / 2 : label.anchor === "end" || label.anchor === "above" ? py - h - 1 : py + 1;
        // Another part's (a tall page comes in parts).
        if (!inPicture({ x: x0, y: y0, width: w, height: h })) {
            continue;
        }

        const fit = (x: number, y: number) => ({ x: Math.max(0, Math.min(width - w, x)), y: Math.max(0, Math.min(source.height - h, y)), width: w, height: h });
        const tries = [fit(x0, y0), fit(x0, y0 + h + 2), fit(x0, y0 - h - 2), fit(x0 + w / 2 + 2, y0), fit(x0 - w / 2 - 2, y0), fit(x0, y0 + 2 * h + 4)];
        const spot = tries.find((each) => !overlaps(each));

        if (spot === undefined) {
            dropped++;
            continue;
        }

        taken.push(spot);
        placed++;
        pixels.fill(spot, label.color);

        if (arc > 0) {
            // A quarter arc, as a corner: the radius's sign.
            const r = Math.round(font * 0.5);
            const cx = spot.x + pad + r;
            const cy = spot.y + (h - r) / 2 + r;
            const stroke = Math.max(1.5, 1.3 * scale);

            for (let step = 0; step < 12; step++) {
                const a0 = Math.PI + (step / 12) * (Math.PI / 2);
                const a1 = Math.PI + ((step + 1) / 12) * (Math.PI / 2);

                pixels.line(cx + r * Math.cos(a0), cy + r * Math.sin(a0), cx + r * Math.cos(a1), cy + r * Math.sin(a1), [255, 255, 255], stroke);
            }
        }

        texts.push({ text: label.text, x: Math.round(spot.x + pad + arc), y: Math.round(spot.y + (h - font * 1.2) / 2), size: font });
    }

    if (band > 0) {
        pixels.fill({ x: 0, y: source.height, width, height: band }, [24, 24, 30]);

        for (const [index, line] of legendLines.entries()) {
            const y = source.height + pad + index * lineHeight;

            if (line.swatch) {
                pixels.fill({ x: pad, y: y + (lineHeight - font * 0.8) / 2, width: font * 0.8, height: font * 0.8 }, line.color);
            }

            texts.push({ text: line.text, x: Math.round(pad + font * 1.4), y: Math.round(y + (lineHeight - font * 1.2) / 2), size: font });
        }
    }

    const marked = new photon.PhotonImage(pixels.data, width, height);

    try {
        for (const each of texts) {
            photon.draw_text(marked, each.text, each.x, each.y, each.size);
        }

        return { bytes: png ? marked.get_bytes() : marked.get_bytes_jpeg(quality), width, height, placed, dropped };
    } finally {
        marked.free();
    }
}

/**
 * The picture with its marks, as a PNG or a JPEG: its bytes, or its pixels (`RawPicture`, drawn on in place). Areas
 * are in the picture's pixels. Hidden parts first (and the spotlight), so no box, badge or label is blurred; texts
 * last, over their own backgrounds.
 */
export function markUp(
    bytes: Uint8Array | RawPicture,
    given: Mark[],
    { png, quality = 88, cssWidth }: { png: boolean; quality?: number; cssWidth?: number },
): { bytes: Uint8Array; width: number; height: number } {
    const { data, width, height } = bytes instanceof Uint8Array ? decodePicture(bytes) : bytes;
    const pixels = new Pixels(data, width, height);

    // A page's areas are in CSS pixels; its picture may be at twice them.
    const scale = cssWidth === undefined ? 1 : width / cssWidth;
    const marks = given.map((mark) => ({
        ...mark,
        area: { x: mark.area.x * scale, y: mark.area.y * scale, width: mark.area.width * scale, height: mark.area.height * scale },
    }));

    // Sizes from the picture: a line 3 px wide on a 1280 px picture, 6 on 2560.
    const unit = Math.max(1, Math.min(width, height) / 400);
    const thickness = Math.max(2, Math.round(2.5 * unit));
    const pad = Math.round(3 * unit);
    const font = Math.max(16, Math.round(9 * unit));
    const badgeFont = Math.round(font * 1.15);
    const texts: { text: string; x: number; y: number; size: number }[] = [];
    const lit = marks.filter((mark) => mark.spotlight === true).map((mark) => mark.area);

    for (const mark of marks) {
        colorOf(mark.color);
    }

    if (lit.length > 0) {
        const inside = (x: number, y: number) => lit.some((area) => x >= area.x - pad && x < area.x + area.width + pad && y >= area.y - pad && y < area.y + area.height + pad);

        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                if (!inside(x, y)) {
                    pixels.dot(x, y, [0, 0, 0], 0.55);
                }
            }
        }
    }

    for (const mark of marks) {
        if (mark.hide === "solid") {
            pixels.fill(mark.area, [24, 24, 27]);
        } else if (mark.hide === "blur") {
            pixels.blur(mark.area);
        }
    }

    for (const mark of marks) {
        if (mark.hide !== undefined) {
            continue;
        }

        const color = colorOf(mark.color);
        const outer = { x: mark.area.x - pad - thickness, y: mark.area.y - pad - thickness, width: mark.area.width + 2 * (pad + thickness), height: mark.area.height + 2 * (pad + thickness) };

        if (mark.box !== false) {
            pixels.frame(outer, color, thickness);
        }

        if (mark.arrow === true) {
            // From open space beside it, at a shallow angle, to the middle of its nearest side (the badge is on a
            // corner), stopping short of the edge so the head stands clear: left first, then right, below, above.
            const length = Math.round(110 * unit);
            const gap = Math.max(8, Math.round(thickness * 3));
            const cx = outer.x + outer.width / 2;
            const cy = outer.y + outer.height / 2;
            const rise = length * 0.35;
            const ways: { start: [number, number]; end: [number, number] }[] = [
                { start: [outer.x - gap - length, cy - rise], end: [outer.x - gap, cy] },
                { start: [outer.x + outer.width + gap + length, cy - rise], end: [outer.x + outer.width + gap, cy] },
                { start: [cx - rise, outer.y + outer.height + gap + length], end: [cx, outer.y + outer.height + gap] },
                { start: [cx - rise, outer.y - gap - length], end: [cx, outer.y - gap] },
            ];
            const inside = ([x, y]: [number, number]) => x >= thickness && y >= thickness && x < width - thickness && y < height - thickness;
            const { start, end } = ways.find((way) => inside(way.start) && inside(way.end)) ?? ways[0]!;
            const angle = Math.atan2(end[1] - start[1], end[0] - start[0]);
            const head = thickness * 5.5;
            const base: [number, number] = [end[0] - Math.cos(angle) * head, end[1] - Math.sin(angle) * head];

            pixels.line(start[0], start[1], base[0], base[1], color, thickness * 1.4);
            pixels.triangle(
                [
                    end,
                    [base[0] + Math.cos(angle + Math.PI / 2) * head * 0.65, base[1] + Math.sin(angle + Math.PI / 2) * head * 0.65],
                    [base[0] + Math.cos(angle - Math.PI / 2) * head * 0.65, base[1] + Math.sin(angle - Math.PI / 2) * head * 0.65],
                ],
                color,
            );
        }

        if (mark.number !== undefined) {
            const text = String(mark.number);
            const radius = Math.max(badgeFont * 0.75, textWidth(text, badgeFont) / 2 + 4);
            const cx = Math.max(radius, Math.min(width - radius, outer.x));
            const cy = Math.max(radius, Math.min(height - radius, outer.y));

            pixels.disc(cx, cy, radius + Math.max(1, thickness / 2), [255, 255, 255]);
            pixels.disc(cx, cy, radius, color);
            texts.push({ text, x: Math.round(cx - textWidth(text, badgeFont) / 2 + 1), y: Math.round(cy - badgeFont * 0.62), size: badgeFont });
        }

        if (mark.label !== undefined && mark.label.trim() !== "") {
            const text = mark.label.trim().slice(0, 80);
            const boxWidth = textWidth(text, font) + 2 * pad + 8;
            const boxHeight = Math.round(font * 1.35) + 2 * pad;
            // Under the box where it fits, else above it, else inside its top.
            const below = outer.y + outer.height + 2;
            const y = below + boxHeight <= height ? below : outer.y - boxHeight - 2 >= 0 ? outer.y - boxHeight - 2 : outer.y + thickness;
            const x = Math.max(0, Math.min(width - boxWidth, outer.x));

            pixels.fill({ x, y, width: boxWidth, height: boxHeight }, color);
            texts.push({ text, x: Math.round(x + pad + 4), y: Math.round(y + pad + font * 0.05), size: font });
        }
    }

    const marked = new photon.PhotonImage(pixels.data, width, height);

    try {
        for (const each of texts) {
            photon.draw_text(marked, each.text, each.x, each.y, each.size);
        }

        return { bytes: png ? marked.get_bytes() : marked.get_bytes_jpeg(quality), width, height };
    } finally {
        marked.free();
    }
}
