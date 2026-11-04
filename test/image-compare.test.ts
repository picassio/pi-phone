// A picture compared with a reference, pixel by pixel (PP-396, src/server/image-compare.ts): the share of changed
// pixels, the changed areas (near changes merged, the largest named), a diff picture; pictures of different sizes are
// compared only when asked; anti-aliased edges are left out.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
import { compareImages, describeComparison, diffPathOf, MAX_AREAS } from "../src/server/image-compare.ts";
import { decodePicture, isPng } from "../src/server/markup.ts";

type Photon = {
    PhotonImage: new (raw: Uint8Array, width: number, height: number) => { get_bytes(): Uint8Array; get_bytes_jpeg(quality: number): Uint8Array; free(): void };
};

const photon = createRequire(import.meta.url)("@silvia-odwyer/photon-node") as Photon;

/** A white picture with gray-level rectangles on it, as a PNG (or a JPEG). */
function picture(width: number, height: number, rects: { x: number; y: number; width: number; height: number; level: number }[] = [], jpeg = false): Uint8Array {
    const data = new Uint8Array(width * height * 4).fill(255);

    for (const rect of rects) {
        for (let y = rect.y; y < rect.y + rect.height; y++) {
            for (let x = rect.x; x < rect.x + rect.width; x++) {
                data.set([rect.level, rect.level, rect.level, 255], (y * width + x) * 4);
            }
        }
    }

    const image = new photon.PhotonImage(data, width, height);

    try {
        return jpeg ? image.get_bytes_jpeg(95) : image.get_bytes();
    } finally {
        image.free();
    }
}

const names = { reference: "/w/ref.png", picture: "/w/now.png", out: "/w/now-diff.png" };

test("the same picture: no pixel changed, no area", () => {
    const page = picture(200, 100, [{ x: 20, y: 20, width: 60, height: 30, level: 0 }]);
    const same = compareImages(page, page);

    assert.equal(same.changed, 0);
    assert.equal(same.antialiased, 0);
    assert.deepEqual(same.areas, []);
    assert.deepEqual([same.width, same.height], [200, 100]);
    assert.ok(isPng(same.png));
    assert.match(describeComparison(same, names), /^Compared \/w\/now\.png with the reference \/w\/ref\.png at 200×100 px: no pixel changed\.\nDiff picture saved as \/w\/now-diff\.png/);
});

test("one changed area: its share of the pixels, its box, and the diff picture with it in red", () => {
    const reference = picture(200, 100);
    const now = picture(200, 100, [{ x: 50, y: 30, width: 20, height: 10, level: 0 }]);
    const result = compareImages(reference, now);

    assert.equal(result.changed, 200);
    assert.deepEqual(result.areas, [{ x: 50, y: 30, width: 20, height: 10, pixels: 200 }]);
    assert.deepEqual(result.more, { areas: 0, pixels: 0 });

    const text = describeComparison(result, names);

    assert.match(text, /: 200 of 20,000 pixels changed \(1\.0%\)\./);
    assert.match(text, /\n1\. x 50, y 30, 20×10 px \(200 pixels changed\)\n/);
    assert.match(text, /the areas framed in blue with their numbers/);

    // The diff picture: the change red, the rest faded gray, a blue frame around the area.
    const diff = decodePicture(result.png);
    const at = (x: number, y: number) => [...diff.data.subarray((y * diff.width + x) * 4, (y * diff.width + x) * 4 + 3)];

    assert.deepEqual(at(60, 35), [255, 0, 0]);
    assert.equal(new Set(at(150, 80)).size, 1, "gray");
    assert.ok(Array.from({ length: 20 }, (_, n) => at(50 + n, 30 - 4)).some(([r, g, b]) => b! > 200 && r! < 100 && g! < 200), "a blue frame above it");
});

test("near changes are one area, far ones apart; past the cap the smaller ones are counted", () => {
    // Two marks 10 px apart (a word's letters) are one area; one 100 px away is another.
    const near = compareImages(
        picture(300, 100),
        picture(300, 100, [{ x: 10, y: 10, width: 8, height: 8, level: 0 }, { x: 28, y: 10, width: 8, height: 8, level: 0 }, { x: 200, y: 60, width: 4, height: 4, level: 0 }]),
    );

    assert.deepEqual(near.areas, [{ x: 10, y: 10, width: 26, height: 8, pixels: 128 }, { x: 200, y: 60, width: 4, height: 4, pixels: 16 }]);

    // 20 dots apart: the 12 largest named top to bottom, the rest counted.
    const dots = Array.from({ length: 20 }, (_, n) => ({ x: 20 + (n % 5) * 60, y: 20 + Math.floor(n / 5) * 60, width: n < MAX_AREAS ? 6 : 3, height: n < MAX_AREAS ? 6 : 3, level: 0 }));
    const many = compareImages(picture(320, 260), picture(320, 260, dots));

    assert.equal(many.areas.length, MAX_AREAS);
    assert.ok(many.areas.every((area) => area.pixels === 36));
    assert.deepEqual(many.more, { areas: 8, pixels: 72 });
    assert.deepEqual(many.areas.map((area) => area.y), [...many.areas.map((area) => area.y)].sort((a, b) => a - b));
    assert.match(describeComparison(many, names), /\nAnd 8 smaller areas \(72 pixels changed\)\./);
});

test("pictures of different sizes: not compared, both sizes said; with resize, the picture scaled to the reference's", () => {
    const reference = picture(200, 100);
    const big = picture(400, 200);

    assert.throws(
        () => compareImages(reference, big),
        /The pictures differ in size: the reference is 200×100 px, the picture 400×200 px\. Nothing was compared\. Give resize: true/,
    );

    const scaled = compareImages(reference, big, { resize: true });

    assert.equal(scaled.changed, 0);
    assert.deepEqual(scaled.scaledFrom, { width: 400, height: 200 });
    assert.match(describeComparison(scaled, names), /at 200×100 px \(the picture, 400×200, scaled to the reference's size\): no pixel changed/);

    const stretched = compareImages(reference, picture(300, 100), { resize: true });

    assert.match(describeComparison(stretched, names), /scaled to the reference's size, and stretched: their shapes differ/);
});

test("anti-aliased edges are left out by default and counted when asked", () => {
    const square = { x: 80, y: 30, width: 40, height: 40, level: 0 };
    // The same square with soft edges: a line of gray pixels along each side, as another renderer smooths it.
    const ring = [
        { x: 80, y: 29, width: 40, height: 1, level: 128 },
        { x: 80, y: 70, width: 40, height: 1, level: 128 },
        { x: 79, y: 30, width: 1, height: 40, level: 128 },
        { x: 120, y: 30, width: 1, height: 40, level: 128 },
    ];
    const reference = picture(200, 100, [square]);
    const soft = picture(200, 100, [...ring, square]);
    const left = compareImages(reference, soft);

    assert.equal(left.changed, 0);
    assert.equal(left.antialiased, 4 * 40);
    assert.match(describeComparison(left, names), /no pixel changed; 160 anti-aliased pixels differ and were left out\./);

    const counted = compareImages(reference, soft, { antialiasing: true });

    assert.equal(counted.changed, 160);
    assert.equal(counted.areas.length, 1);
});

test("a JPEG reads as well as a PNG; a file that is not a picture, a bad threshold, and the default diff path", () => {
    const page = [{ x: 20, y: 20, width: 60, height: 30, level: 0 }];

    assert.equal(compareImages(picture(200, 100, page, true), picture(200, 100, page), { threshold: 0.15 }).changed, 0);
    assert.throws(() => compareImages(new TextEncoder().encode("not a picture"), picture(10, 10)), /not a picture Pi can read/);
    assert.throws(() => compareImages(picture(10, 10), picture(10, 10), { threshold: 2 }), /threshold is from 0/);
    assert.equal(diffPathOf("shots/page-390.png"), "shots/page-390-diff.png");
    assert.equal(diffPathOf("/a.b/shot"), "/a.b/shot-diff.png");
});
