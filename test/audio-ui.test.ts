// Menu › Audio and the audio tools' results in a real browser (PP-307, the owner's mockup audio-sheet-mock v3): three
// dropdowns (transcription model, reading model, default voice) kept as the settings audio.*; the voice's sample made
// once by the reading model and served as m4a; audio_speak's file in a player with its waveform under its line;
// audio_transcribe's first lines with their times, how many more, and Open file. With PHONE_SHOTS, screenshots go there.
import { type App, cleanUp, cleanUpAll, context, home, lastText, newSession, owner, pastWelcome, root, scriptedModel, until, work } from "./helpers.ts";
import { execFileSync } from "node:child_process";
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { localEngine } from "../src/server/media.ts";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { WebSocketServer } from "ws";
import { Browsers } from "./support/browser.ts";
import { findBrowser } from "./support/browser/discovery.ts";
import type { BrowserPage } from "./support/browser/page.ts";
import { VIEWPORTS } from "./support/browser/viewport.ts";
import { createHandler } from "../src/server/http.ts";

const { PocketApp } = await import("../src/server/app.ts");

const chromium = findBrowser();
const engine = localEngine();
const real = { skip: chromium === undefined ? "no Chromium-based browser on this machine" : engine === undefined ? "no ffmpeg in native/" : false } as const;
const SHOTS = process.env.PHONE_SHOTS;
const spoken: string[] = [];

// OpenAI's realtime sockets as the audio tools use them: a model reads (a rising tone, 10 ms a character), and a
// transcription session hears six utterances.
const http = createServer();
const sockets = new WebSocketServer({ server: http });

sockets.on("connection", (socket, request) => {
    const say = (event: Record<string, unknown>) => socket.send(JSON.stringify(event));
    let heard = false;

    socket.on("message", (data) => {
        const event = JSON.parse(String(data)) as { type: string; item?: { content: { text: string }[] } };

        if (request.url?.includes("?model=") === true && event.type === "conversation.item.create") {
            const text = /<<<\n([\s\S]*)\n>>>/.exec(event.item!.content[0]!.text)![1]!;
            const samples = Buffer.alloc(text.length * 480);

            for (let at = 0; at < samples.length / 2; at++) {
                samples.writeInt16LE(Math.round(Math.sin(at / 8) * 8000 * (at / (samples.length / 2))), at * 2);
            }

            spoken.push(text);
            say({ type: "response.output_audio.delta", delta: samples.toString("base64") });
            say({ type: "response.output_audio_transcript.delta", delta: text });
            say({ type: "response.done", response: { status: "completed", usage: { input_tokens: 5, output_tokens: 7 } } });
        } else if (event.type === "input_audio_buffer.append" && !heard) {
            heard = true;

            for (let index = 0; index < 6; index++) {
                say({ type: "input_audio_buffer.speech_started", item_id: `u${index}`, audio_start_ms: index * 7000 + 500 });
                say({ type: "input_audio_buffer.speech_stopped", item_id: `u${index}`, audio_end_ms: index * 7000 + 6000 });
                say({ type: "conversation.item.input_audio_transcription.completed", item_id: `u${index}`, transcript: `Câu số ${index + 1} trong cuộc họp.` });
            }
        } else if (event.type === "input_audio_buffer.commit") {
            say({ type: "input_audio_buffer.committed", item_id: "end" });
            say({ type: "conversation.item.input_audio_transcription.completed", item_id: "end", transcript: "" });
        }
    });
});

let app: App;
let server: Server;
let browsers: Browsers;
let page: BrowserPage;
let base = "";

async function inPage<T>(script: string): Promise<T> {
    return JSON.parse(await page.evaluate(script)) as T;
}

const see = (script: string, what: string) => until(async () => (await inPage<boolean>(script)) === true, what);

before(async () => {
    if (real.skip !== false) {
        return;
    }

    await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
    const route: FauxResponseStep = (request) => {
        const { role, text } = lastText(request as never);

        if (role === "user" && text.endsWith("read it")) {
            return fauxAssistantMessage([fauxToolCall("audio_speak", { text: "Chào anh Tuấn, đây là bản thử." })], { stopReason: "toolUse" });
        }

        if (role === "user" && text.endsWith("transcribe it")) {
            return fauxAssistantMessage([fauxToolCall("audio_transcribe", { path: "meeting.flac" })], { stopReason: "toolUse" });
        }

        return fauxAssistantMessage([fauxText(role === "toolResult" ? "Done." : "ok")]);
    };
    const faux = scriptedModel(route);

    app = await PocketApp.open({
        dataDir: join(root, "audio-ui-data"),
        defaultCwd: work,
        supervised: false,
        log: () => {},
        home,
        configureModels: (models) => models.registerNativeProvider(faux.provider),
        officecli: { runs: false },
        audio: { endpoints: { socket: `ws://127.0.0.1:${(http.address() as AddressInfo).port}` }, auth: async () => ({ token: "codex-token", account: "acct-1" }) },
    });
    pastWelcome(app);
    await app.models.setRuntimeApiKey("openai-codex", "codex-token");
    server = createServer(createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    browsers = new Browsers({ dataDir: mkdtempSync(join(root, "audio-ui-browser-")), load: async () => undefined, save: () => {} });
    page = await browsers.open(1);
    execFileSync(engine!.ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "sine=duration=45:sample_rate=16000", "-ac", "1", join(work, "meeting.flac")]);
});

after(() =>
    cleanUpAll(
        () => browsers?.closeAll({ final: true }),
        () => server?.closeAllConnections(),
        () => server?.close(),
        () => sockets.close(),
        () => http.close(),
        () => app?.close(),
        () => cleanUp(),
    ),
);

async function shot(name: string): Promise<void> {
    if (SHOTS !== undefined) {
        mkdirSync(SHOTS, { recursive: true });
        await new Promise((resolve) => setTimeout(resolve, 500));
        writeFileSync(join(SHOTS, name), Buffer.from((await page.screenshot()).data, "base64"));
    }
}

test("Menu › Audio: three dropdowns, Automatic naming the default; a pick is kept; the voice's sample made once and served", real, async () => {
    await page.setViewport(VIEWPORTS.mobile);
    await page.navigate(`${base}/login?token=${encodeURIComponent(app.config.ownerToken)}`);
    await see(`return JSON.stringify((await import("/store.js")).store.state.me?.role === "owner")`, "signed in");
    await page.evaluate(`(await import("/store.js")).openSheet({ type: "audio" }); return "true";`);
    await see(`return JSON.stringify(document.querySelectorAll('[data-part^="audio-"] .choice').length === 3)`, "three dropdowns");

    const shown = await inPage<string[]>(`return JSON.stringify([...document.querySelectorAll('[data-part^="audio-"] .choice .choice-text')].map((each) => [...each.children].map((part) => part.textContent.trim()).join(" | ")))`);

    assert.deepEqual(shown, ["Automatic | Now gpt-4o-transcribe", "Automatic | Now gpt-realtime-mini", "Automatic | Now marin"]);
    assert.equal(await inPage<boolean>(`return JSON.stringify(document.querySelector('[data-part="audio-problem"]') === null)`), true, "signed in: no problem shown");
    await shot("audio-sheet-390.jpg");

    // The reading model: open its dropdown, pick gpt-realtime.
    await page.evaluate(`document.querySelector('[data-part="audio-speak-model"] .choice').click(); return "true";`);
    await see(`return JSON.stringify(document.querySelectorAll('.choice-menu .pop-menu-row').length === 3)`, "Automatic and two models");
    await shot("audio-dropdown-390.jpg");
    await page.evaluate(`[...document.querySelectorAll('.choice-menu .pop-menu-row')].find((row) => row.textContent.includes("gpt-realtime") && !row.textContent.includes("mini")).click(); return "true";`);
    await until(() => app.config.audioChoice("audioSpeakModel") === "gpt-realtime", "the reading model kept");
    await see(`return JSON.stringify(document.querySelector('[data-part="audio-speak-model"] .choice-text').textContent.includes("gpt-realtime"))`, "the dropdown names it");
    await assert.rejects(app.setAudioChoice(owner(app), "voice", "nova"), /Choose one of: marin/);

    // The sample: read by the reading model set now, kept under the data folder, served as m4a.
    const served = await inPage<{ status: number; type: string | null; bytes: number }>(`
        const response = await fetch("api/audio/sample?voice=cedar");
        return JSON.stringify({ status: response.status, type: response.headers.get("content-type"), bytes: (await response.arrayBuffer()).byteLength });
    `);

    assert.deepEqual({ ...served, bytes: served.bytes > 500 }, { status: 200, type: "audio/mp4", bytes: true });
    assert.ok(existsSync(join(root, "audio-ui-data", "audio-samples", "gpt-realtime-cedar-en.m4a")));
    const asked = spoken.length;

    await inPage(`await fetch("api/audio/sample?voice=cedar"); return "true";`);
    assert.equal(spoken.length, asked, "kept: not read again");
    await app.setAudioChoice(owner(app), "speakModel", null);
});

test("audio_speak's file plays under its line with its waveform; audio_transcribe's first lines show with times and Open file", real, async () => {
    const id = await newSession(app);

    for (const text of ["read it", "transcribe it"]) {
        const { submissionId } = await app.commands.submit(id, owner(app), { text, requestId: crypto.randomUUID() });

        await (await app.harness.submission(submissionId, context))!.wait(context);
    }

    const entries = await app.transcripts.allEntries(id as never, true);
    const results = entries.filter((entry) => entry.kind === "toolResult") as unknown as { isError?: boolean; text?: string }[];

    assert.equal(results.length, 2);
    assert.ok(results.every((each) => each.isError !== true), results.map((each) => each.text).join("\n"));

    await page.evaluate(`(await import("/store.js")).closeSheet(); (await import("/store.js")).navigate(${id}); return "true";`);
    // The older turn's work is folded, as every older turn's: unfold it.
    await see(`return JSON.stringify(document.querySelectorAll('[data-part="activity-head"]').length === 2)`, "both turns in the chat");
    await page.evaluate(`document.querySelector('[data-part="activity-head"]').click(); return "true";`);
    await see(`return JSON.stringify(document.querySelectorAll('[data-part="tool-call"]').length === 2)`, "both lines shown");
    await see(
        `return JSON.stringify(document.querySelector('[data-part="made-audio"] audio') !== null && document.querySelector('[data-part="made-transcript"]') !== null)`,
        `the player and the transcript under their lines: ${await page.evaluate(`return JSON.stringify([...document.querySelectorAll('[data-part="tool-call"]')].map((step) => step.outerHTML.slice(0, 600)))`)}`,
    );

    const player = await inPage<{ bars: number; caption: string; status: number; type: string | null; range: number }>(`
        const audio = document.querySelector('[data-part="made-audio"] audio');
        const part = await fetch(audio.src, { headers: { range: "bytes=0-99" } });
        return JSON.stringify({
            bars: document.querySelectorAll('[data-part="made-audio"] .made-audio-wave i').length,
            caption: document.querySelector('[data-part="made-audio"] figcaption').textContent.replace(/\\s+/g, " ").trim(),
            status: part.status,
            type: part.headers.get("content-type"),
            range: (await part.arrayBuffer()).byteLength,
        });
    `);

    assert.equal(player.bars, 48);
    // Each line says what it did, not its arguments as JSON.
    const heads = await inPage<string[]>(`return JSON.stringify([...document.querySelectorAll('[data-part="tool-call"] [data-part="step-head"]')].map((head) => head.textContent.replace(/\\s+/g, " ").trim()))`);

    assert.match(heads[0]!, /^audio_speak ?Chào anh Tuấn, đây là bản thử\. ?marin · 0 s$/, heads[0]!);
    assert.match(heads[1]!, /^audio_transcribe ?meeting\.flac ?6 lines$/, heads[1]!);
    // Download beside the audio and the transcript (the owner's ask): the file comes from the download route, whole.
    const saved = await inPage<{ buttons: number; names: string[] }>(`
        const names = [];
        const real = URL.createObjectURL;
        const click = HTMLAnchorElement.prototype.click;
        HTMLAnchorElement.prototype.click = function () { names.push(this.download); };
        for (const button of document.querySelectorAll('[data-part="made-download"]')) button.click();
        await new Promise((resolve) => setTimeout(resolve, 800));
        HTMLAnchorElement.prototype.click = click;
        return JSON.stringify({ buttons: document.querySelectorAll('[data-part="made-download"]').length, names });
    `);

    assert.equal(saved.buttons, 2);
    assert.equal(saved.names.length, 2, JSON.stringify(saved));
    assert.match(saved.names[0]!, /^\d{8}-\d{6}-chao-anh-tuan[-a-z]*\.m4a$/);
    assert.match(saved.names[1]!, /^\d{8}-\d{6}-meeting\.txt$/);
    await page.evaluate(`document.querySelector('[data-part="made-audio"]').scrollIntoView({ block: "center" }); return "true";`);
    await shot("audio-player-390.jpg");
    assert.match(player.caption, /^0:00 \/ 0:0\d ?marin · audio\/\d{8}-\d{6}-chao-anh-tuan[-a-z]*\.m4a$/, player.caption);
    assert.deepEqual([player.status, player.type, player.range], [206, "audio/mp4", 100]);

    const lines = await inPage<string[]>(`return JSON.stringify([...document.querySelectorAll('[data-part="made-transcript"] p')].map((line) => line.textContent.replace(/\\s+/g, " ").trim()))`);

    assert.deepEqual(lines, ["0:00Câu số 1 trong cuộc họp.", "0:07Câu số 2 trong cuộc họp.", "0:14Câu số 3 trong cuộc họp.", "0:21Câu số 4 trong cuộc họp.", "+ 2 more lines"]);
    await shot("audio-results-390.jpg");
    await page.evaluate(`document.querySelector('[data-part="transcript-open"]').click(); return "true";`);
    await see(`return JSON.stringify((await import("/store.js")).store.state.sheet?.type === "file" && (await import("/store.js")).store.state.sheet.id.endsWith("-meeting.txt"))`, "the transcript opened in the viewer");
});
