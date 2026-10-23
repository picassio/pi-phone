/**
 * Marks on a picture (PP-119), for runbooks and reports: a box around something, a numbered badge for a step, a short
 * label, an arrow pointing at it, the rest dimmed (spotlight), and parts hidden, with a solid box (keys, tokens,
 * passwords: nothing can be recovered) or a heavy blur (names, emails). `browser_screenshot` marks a page's controls by
 * number; `image_markup` marks any picture file by pixel areas. Drawn on the pixels with Photon (PNG and JPEG in and
 * out, and its white text); the shapes are drawn here.
 */
import { createRequire } from "node:module";

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

/**
 * The picture with its marks, as a PNG or a JPEG. Areas are in the picture's pixels. Hidden parts first (and the
 * spotlight), so no box, badge or label is blurred; texts last, over their own backgrounds.
 */
export function markUp(
    bytes: Uint8Array,
    given: Mark[],
    { png, quality = 88, cssWidth }: { png: boolean; quality?: number; cssWidth?: number },
): { bytes: Uint8Array; width: number; height: number } {
    let image: PhotonImage;

    try {
        image = photon.PhotonImage.new_from_byteslice(bytes);
    } catch {
        throw new Error("That file is not a picture Pi can read: give a PNG or a JPEG.");
    }

    const width = image.get_width();
    const height = image.get_height();
    const pixels = new Pixels(image.get_raw_pixels(), width, height);

    image.free();

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
            // From open space beside it, up-left first, to the edge of the box.
            const length = Math.round(70 * unit);
            const cx = outer.x + outer.width / 2;
            const cy = outer.y + outer.height / 2;
            const starts: [number, number][] = [
                [outer.x - length, outer.y - length * 0.6],
                [outer.x + outer.width + length, outer.y - length * 0.6],
                [outer.x - length, outer.y + outer.height + length * 0.6],
                [outer.x + outer.width + length, outer.y + outer.height + length * 0.6],
                [outer.x - length, cy],
                [outer.x + outer.width + length, cy],
            ];
            const start = starts.find(([x, y]) => x >= thickness && y >= thickness && x < width - thickness && y < height - thickness) ?? [Math.max(thickness, Math.min(width - thickness, outer.x - length)), Math.max(thickness, outer.y - length)];
            // Where the line from the start to the box's middle meets the box.
            const dx = cx - start[0];
            const dy = cy - start[1];
            const t = Math.min(dx === 0 ? Infinity : Math.abs((outer.width / 2) / dx), dy === 0 ? Infinity : Math.abs((outer.height / 2) / dy));
            const end: [number, number] = [cx - dx * t, cy - dy * t];
            const angle = Math.atan2(end[1] - start[1], end[0] - start[0]);
            const head = thickness * 4.5;
            const base: [number, number] = [end[0] - Math.cos(angle) * head, end[1] - Math.sin(angle) * head];

            pixels.line(start[0], start[1], base[0], base[1], color, thickness * 1.4);
            pixels.triangle(
                [
                    end,
                    [base[0] + Math.cos(angle + Math.PI / 2) * head * 0.6, base[1] + Math.sin(angle + Math.PI / 2) * head * 0.6],
                    [base[0] + Math.cos(angle - Math.PI / 2) * head * 0.6, base[1] + Math.sin(angle - Math.PI / 2) * head * 0.6],
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
