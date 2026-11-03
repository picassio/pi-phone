// Attached images made ready for the model as they are uploaded (PP-347, from pi-pocket 0.28 #236).
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { forModel, modelImage, prepareModelImage } from "../src/server/model-images.ts";

// A 1×1 PNG.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");

test("an image prepared at upload is the one a message sends, without making it again", async () => {
    const folder = mkdtempSync(join(tmpdir(), "model-images-"));

    try {
        const path = join(folder, "a.png");

        writeFileSync(path, PNG);
        prepareModelImage(path, "image/png", PNG.length);
        const first = modelImage(path, "image/png");

        assert.equal((await first).image.mimeType, "image/png");
        // The file is gone: only the prepared image can answer.
        rmSync(path);
        assert.equal(modelImage(path, "image/png"), first);
        assert.equal(await modelImage(path, "image/png"), await first);
    } finally {
        rmSync(folder, { recursive: true, force: true });
    }
});

test("images are made one after another, in the order asked, and a failed one is made again on the next send", async () => {
    const folder = mkdtempSync(join(tmpdir(), "model-images-"));

    try {
        const paths = ["b.png", "c.png", "d.png"].map((name) => join(folder, name));
        const done: string[] = [];

        for (const path of paths) {
            writeFileSync(path, PNG);
        }

        await Promise.all(paths.map((path) => modelImage(path, "image/png").then(() => done.push(path))));
        assert.deepEqual(done, paths);

        // Not an image at all: it fails, is not kept, and is tried again once it is one.
        const broken = join(folder, "broken.png");

        writeFileSync(broken, "not a png");
        prepareModelImage(broken, "image/png", 9);
        await assert.rejects(modelImage(broken, "image/png"));
        writeFileSync(broken, PNG);
        assert.equal((await modelImage(broken, "image/png")).image.mimeType, "image/png");
    } finally {
        rmSync(folder, { recursive: true, force: true });
    }
});

test("only images the model takes are prepared", () => {
    assert.equal(forModel("image/png", 1000), true);
    assert.equal(forModel("text/plain", 1000), false);
    assert.equal(forModel("image/png", 6 * 1024 * 1024), false);
});
