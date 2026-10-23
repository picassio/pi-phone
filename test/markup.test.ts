// Marks on a picture (src/server/markup.ts, PP-119): a box, a badge, a label, an arrow, spotlight, and parts hidden
// with a solid box or a blur, drawn on the pixels; PNG and JPEG out; areas of a page in CSS pixels scaled to its picture.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
import { colorOf, isPng, markUp } from "../src/server/markup.ts";

type Image = { get_raw_pixels(): Uint8Array; get_width(): number; get_bytes(): Uint8Array; free(): void };
const photon = createRequire(import.meta.url)("@silvia-odwyer/photon-node") as {
    PhotonImage: { new (raw: Uint8Array, width: number, height: number): Image; new_from_byteslice(bytes: Uint8Array): Image };
};

/** A white picture with black and white stripes (text-like) in its left half, as a PNG. */
function picture(width = 400, height = 200): Uint8Array {
    const raw = new Uint8Array(width * height * 4).fill(255);

    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width / 2; x++) {
            if (x % 4 < 2) {
                raw.fill(0, (y * width + x) * 4, (y * width + x) * 4 + 3);
            }
        }
    }

    const image = new photon.PhotonImage(raw, width, height);

    try {
        return image.get_bytes();
    } finally {
        image.free();
    }
}

function pixelsOf(bytes: Uint8Array): { at: (x: number, y: number) => [number, number, number]; width: number } {
    const image = photon.PhotonImage.new_from_byteslice(bytes);
    const raw = image.get_raw_pixels();
    const width = image.get_width();

    image.free();

    return { at: (x, y) => [raw[(y * width + x) * 4]!, raw[(y * width + x) * 4 + 1]!, raw[(y * width + x) * 4 + 2]!], width };
}

test("a box goes around its area, outside it, in its color; inside stays as it was", () => {
    const { bytes, width, height } = markUp(picture(), [{ area: { x: 250, y: 60, width: 80, height: 40 }, color: "blue" }], { png: true });
    const out = pixelsOf(bytes);

    assert.ok(isPng(bytes));
    assert.deepEqual([width, height], [400, 200]);
    assert.deepEqual(out.at(290, 80), [255, 255, 255], "inside untouched");
    // The outline is a little outside the area (3 px of room, then the line).
    assert.deepEqual(out.at(290, 60 - 4), colorOf("blue"));
    assert.deepEqual(out.at(250 - 4, 80), colorOf("blue"));
});

test("hidden parts: solid leaves one dark color; blur leaves no stripe to read; boxes are not blurred", () => {
    const area = { x: 20, y: 20, width: 120, height: 40 };
    const solid = pixelsOf(markUp(picture(), [{ area, hide: "solid" }], { png: true }).bytes);

    for (const [x, y] of [[20, 20], [21, 30], [80, 45], [139, 59]] as const) {
        assert.deepEqual(solid.at(x, y), [24, 24, 27]);
    }

    const blurred = pixelsOf(markUp(picture(), [{ area, hide: "blur" }], { png: true }).bytes);
    // The stripes alternate 0 and 255 every 2 px; blurred, neighbours differ by little.
    const row = Array.from({ length: 100 }, (_, n) => blurred.at(30 + n, 40)[0]);
    const spread = Math.max(...row) - Math.min(...row);

    assert.ok(spread < 40, `blurred stripes vary by ${spread}`);
    // Outside the area the stripes are as they were.
    assert.deepEqual([blurred.at(160, 40)[0], blurred.at(162, 40)[0]], [0, 255]);
});

test("spotlight dims all but its area; a badge, a label and an arrow draw in the mark's color", () => {
    const marks = [{ area: { x: 250, y: 60, width: 80, height: 40 }, spotlight: true, number: 1, label: "Click here", arrow: true }];
    const out = pixelsOf(markUp(picture(), marks, { png: true }).bytes);
    const [r, g, b] = out.at(380, 190);

    assert.ok(r < 140 && g < 140 && b < 140, `dimmed outside: ${[r, g, b]}`);
    assert.deepEqual(out.at(290, 80), [255, 255, 255], "lit inside");

    // The label sits under the box, in red, with white text on it.
    let red = 0;
    let white = 0;

    for (let x = 245; x < 330; x++) {
        for (let y = 110; y < 140; y++) {
            const [pr, pg, pb] = out.at(x, y);

            red += pr === 229 && pg === 57 && pb === 53 ? 1 : 0;
            white += pr > 240 && pg > 240 && pb > 240 ? 1 : 0;
        }
    }

    assert.ok(red > 600 && white > 30, `label: ${red} red, ${white} white`);
});

test("a page's areas in CSS pixels land on its picture at twice them; JPEG out; a wrong color is refused", () => {
    // A 400 px picture of a 200 px wide view: the area 125..165 is 250..330 in the picture.
    const { bytes } = markUp(picture(), [{ area: { x: 125, y: 30, width: 40, height: 20 }, color: "#00aa00" }], { png: false, cssWidth: 200 });
    const out = pixelsOf(bytes);
    const [r, g, b] = out.at(290, 56);

    assert.equal(bytes[0], 0xff, "a JPEG");
    assert.ok(r < 60 && g > 130 && b < 60, `the box at twice: ${[r, g, b]}`);
    assert.throws(() => markUp(picture(), [{ area: { x: 1, y: 1, width: 5, height: 5 }, color: "teal-ish" }], { png: true }), /is not a color/);
});
