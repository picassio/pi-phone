// HEIC and HEIF photos reach the model as JPEG (PP-348, from pi-pocket 0.28): converted by libheif-js (WebAssembly) in a
// worker, one at a time, with a note on the attachment's line; broken or huge ones fail at once; uploads get their type
// from the name when the browser does not know it.
import { type App, cleanUp, newSession, openApp, owner, say, scriptedModel } from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { heicToJpeg } from "../src/server/heic.ts";
import { uploadMime } from "../src/server/http/conversation-routes.ts";
import { modelImage } from "../src/server/model-images.ts";

const photo = readFileSync(new URL("./fixtures/photo.heic", import.meta.url));
let app: App;

before(async () => {
    app = await openApp(scriptedModel());
});

after(async () => {
    await app?.close();
    cleanUp();
});

test("a HEIC photo goes to the model as a JPEG with a note, and the file stays", async () => {
    const folder = mkdtempSync(join(tmpdir(), "heic-"));

    try {
        const path = join(folder, "photo.heic");

        writeFileSync(path, photo);
        const made = await modelImage(path, "image/heic");

        assert.equal(made.image.mimeType, "image/jpeg");
        assert.equal(Buffer.from(made.image.data, "base64").subarray(0, 3).toString("hex"), "ffd8ff");
        assert.equal(made.note, "[Image: shown to you as JPEG.]");
        assert.deepEqual(readFileSync(path), photo);
    } finally {
        rmSync(folder, { recursive: true, force: true });
    }
});

test("a broken HEIC file, or one that names too many pixels, fails without a hang", async () => {
    const folder = mkdtempSync(join(tmpdir(), "heic-"));

    try {
        const path = join(folder, "bad.heic");
        // The photo with the width and height of every `ispe` box set to 65535.
        const huge = Buffer.from(photo);

        for (let at = huge.indexOf("ispe"); at !== -1; at = huge.indexOf("ispe", at + 4)) {
            huge.writeUInt32BE(65535, at + 8);
            huge.writeUInt32BE(65535, at + 12);
        }

        // The photo with no `ispe` box that can be read: its size is not known.
        const unsized = Buffer.from(photo.toString("latin1").replaceAll("ispe", "xxxx"), "latin1");
        // The same photo, with the bytes `ispe` and a huge size in a box after it, as they could be in its data.
        const free = Buffer.alloc(28);

        free.writeUInt32BE(28, 0);
        free.write("freeispe", 4, "latin1");
        free.writeUInt32BE(40000, 16);
        free.writeUInt32BE(40000, 20);
        writeFileSync(path, Buffer.concat([photo, free]));
        assert.equal((await modelImage(path, "image/heic")).image.mimeType, "image/jpeg");

        for (const [bytes, message] of [
            [Buffer.from("....ftypheic not a photo at all"), /./],
            [photo.subarray(0, 300), /./],
            [huge, /too many pixels/],
            [unsized, /size cannot be read/],
        ] as const) {
            writeFileSync(path, bytes);
            await assert.rejects(modelImage(path, "image/heic"), message);
        }
    } finally {
        rmSync(folder, { recursive: true, force: true });
    }
});

test("HEIC photos convert one at a time, as the decoder's memory is outside the heap", async () => {
    const ports = () => process.getActiveResourcesInfo().filter((name) => name === "MessagePort").length;
    let most = 0;
    const timer = setInterval(() => (most = Math.max(most, ports())), 1);

    await Promise.all([heicToJpeg(photo), heicToJpeg(photo), heicToJpeg(photo)]);
    clearInterval(timer);
    assert.equal(most, 1);
});

test("an upload's type comes from its name when the browser does not know it", () => {
    assert.equal(uploadMime("photo.heic", undefined), "image/heic");
    assert.equal(uploadMime("photo.heif", "application/octet-stream"), "image/heif");
    assert.equal(uploadMime("notes.txt", "text/plain; charset=utf-8"), "text/plain");
    assert.equal(uploadMime("blob", undefined), "application/octet-stream");
});

test("a HEIC attachment reaches the model as a JPEG, and its line says so", async () => {
    const id = await newSession(app);

    await app.commands.configure(id, owner(app), { model: { provider: "faux", modelId: "faux-vision" } });
    const path = join(app.workspace.uploadDirectory(id), "photo.heic");

    writeFileSync(path, photo);
    await say(app, id, "look", [{ path, name: "photo.heic", mime: "image/heic", size: photo.length }]);
    const conversation = (await app.harness.conversation(id, BACKGROUND_CONTEXT))!;
    const entries = await conversation.entries({}, 256, undefined, BACKGROUND_CONTEXT);
    const user = entries.items.find((entry) => entry.kind === "pi.user")!;
    const image = (await app.transcripts.entryImage(id, user.id as unknown as number, 0))!;
    const history = await app.transcripts.history(id, Number.MAX_SAFE_INTEGER);
    const line = history.findLast((entry) => entry.kind === "user");

    assert.match(line?.kind === "user" ? line.text : "", /bytes\) \[Image: shown to you as JPEG\.\]$/);
    assert.equal(image.mimeType, "image/jpeg");
    assert.deepEqual(readFileSync(path), photo, "the original stays in uploads");
});
