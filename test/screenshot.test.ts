// Screenshots (src/server/screenshots.ts, extensions/screenshot.ts): Pi asks to see a page; the app's service on the
// phone (here, the test standing in for Renderer.java) takes the request from its long poll, renders, and answers with
// pictures, which reach Pi as images. A page the service is not there to render fails, saying so.
import { type App, cleanUp, context, lastText, modelTexts, newSession, openApp, owner, scriptedModel, work } from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { Screenshots } from "../src/server/screenshots.ts";

// The smallest JPEG: one white pixel.
const JPEG = Buffer.from(
    "/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=",
    "base64",
);
let lastImages = 0;
const route: FauxResponseStep = (request) => {
    const { role, text } = lastText(request as never);
    const messages = (request as { messages: { role: string; content?: unknown }[] }).messages;
    const last = messages.at(-1);

    if (last?.role === "toolResult" && Array.isArray(last.content)) {
        lastImages = (last.content as { type: string }[]).filter((part) => part.type === "image").length;
    }

    if (role === "user" && text.endsWith("look at the artifact")) {
        return fauxAssistantMessage([fauxToolCall("screenshot", { artifact: "demo" })], { stopReason: "toolUse" });
    }

    if (role === "user" && text.endsWith("look at the file")) {
        return fauxAssistantMessage([fauxToolCall("screenshot", { path: join(work, "page.html"), widths: [390], fullPage: false })], { stopReason: "toolUse" });
    }

    if (role === "user" && text.endsWith("look badly")) {
        return fauxAssistantMessage([fauxToolCall("screenshot", { path: "notes.txt" })], { stopReason: "toolUse" });
    }

    return fauxAssistantMessage([fauxText(role === "toolResult" ? `saw: ${text.slice(0, 600)}` : "ok")]);
};
let app: App;

before(async () => {
    app = await openApp(scriptedModel(route));
    app.serverPort = 8799;
});

after(async () => {
    await app?.close();
    cleanUp();
});

/** Stands in for the phone's renderer: polls, records each request, answers with a picture per width. */
function phone(screenshots: Screenshots, seen: { url: string; widths: number[]; fullPage: boolean }[]) {
    const stop = new AbortController();
    const loop = (async () => {
        let at = -1;

        while (!stop.signal.aborted) {
            const { seq, requests } = await screenshots.after(at, stop.signal);

            for (const request of requests) {
                seen.push({ url: request.url, widths: request.widths, fullPage: request.fullPage });
                screenshots.answer(request.id, { shots: request.widths.map((width) => ({ width, height: 900, parts: [JPEG.toString("base64")] })) });
            }

            at = seq;
        }
    })();

    return async () => {
        stop.abort();
        await loop;
    };
}

test("without the phone's service, a render fails at once, saying why", async () => {
    await assert.rejects(new Screenshots().render("https://example.com", { widths: [390] }), /No phone is rendering/);
});

test("the service takes requests from its poll and answers with pictures; a failure it reports reaches the caller", async () => {
    const screenshots = new Screenshots();
    const seen: { url: string; widths: number[]; fullPage: boolean }[] = [];

    // The service's first poll marks it present.
    await screenshots.after(-1, new AbortController().signal);
    const stop = phone(screenshots, seen);

    try {
        const shots = await screenshots.render("https://example.com/a", { widths: [390, 1280] });

        assert.deepEqual(shots.map((shot) => [shot.width, shot.height, shot.parts.length]), [[390, 900, 1], [1280, 900, 1]]);
        assert.deepEqual(seen, [{ url: "https://example.com/a", widths: [390, 1280], fullPage: true }]);
    } finally {
        await stop();
    }

    const failing = new Screenshots();

    await failing.after(-1, new AbortController().signal);
    const pending = failing.render("https://example.com/b", { widths: [390], timeoutMs: 5000 });
    const { requests } = await failing.after(-1, new AbortController().signal);

    failing.answer(requests[0]!.id, { error: "net::ERR_NAME_NOT_RESOLVED" });
    await assert.rejects(pending, /The phone could not render https:\/\/example\.com\/b: net::ERR_NAME_NOT_RESOLVED/);
    assert.throws(() => failing.answer(requests[0]!.id, { shots: [] }), /No such render waits/);
});

test("Pi's screenshot: an artifact and a file, at the widths asked, as images it sees; a wrong path says what it takes", async () => {
    const id = await newSession(app);
    const seen: { url: string; widths: number[]; fullPage: boolean }[] = [];

    await app.screenshots.after(-1, new AbortController().signal);
    const stop = phone(app.screenshots, seen);
    const ask = async (text: string) => {
        const { submissionId } = await app.commands.submit(id, owner(app), { text, requestId: crypto.randomUUID() });

        await (await app.harness.submission(submissionId, context))!.wait(context);
        await app.harness.waitForIdle(context);

        return (await modelTexts(app, id)).at(-1)!;
    };

    mkdirSync(work, { recursive: true });
    writeFileSync(join(work, "page.html"), "<!doctype html><title>Page</title><h1>Hello</h1>");

    try {
        const artifact = await ask("look at the artifact");

        assert.match(artifact, /artifact demo, as the phone renders it: 390×900, 1280×900/);
        assert.equal(lastImages, 2, "both pictures reach the model as images");
        assert.equal(seen[0]!.url, `http://127.0.0.1:8799/a/${String(id)}/demo/latest`);
        assert.deepEqual(seen[0]!.widths, [390, 1280]);

        const file = await ask("look at the file");

        assert.match(file, /page\.html, as the phone renders it: 390×900/);
        assert.equal(seen[1]!.url, `http://127.0.0.1:8799/a/file/${String(id)}?path=${encodeURIComponent(join(work, "page.html"))}`);
        assert.equal(seen[1]!.fullPage, false);

        assert.match(await ask("look badly"), /path is a \.html, \.htm, \.svg, \.docx, \.xlsx, or \.pptx file/);
    } finally {
        await stop();
    }
});

test("an HTML file of a session as its own page, in the artifacts' sandbox", async () => {
    const { createHandler } = await import("../src/server/http.ts");
    const server = createServer(createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }));

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const id = await newSession(app);
    const get = (path: string) =>
        fetch(`${base}/a/file/${String(id)}?path=${encodeURIComponent(path)}`, { headers: { authorization: `Bearer ${app.config.ownerToken}` } });

    mkdirSync(work, { recursive: true });
    writeFileSync(join(work, "page.html"), "<!doctype html><h1>Hello</h1>");

    try {
        const page = await get(join(work, "page.html"));

        assert.equal(page.status, 200);
        assert.match(page.headers.get("content-security-policy") ?? "", /^sandbox /);
        assert.match(await page.text(), /<h1>Hello<\/h1>/);
        assert.equal((await get(join(work, "notes.txt"))).status, 400);
    } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
    }
});
