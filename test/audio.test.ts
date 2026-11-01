// audio_transcribe (PP-305, audio.ts and extensions/media.ts) against a stand-in for OpenAI's realtime transcription
// socket: a file cut by the media engine into 24 kHz pcm parts of ten minutes, each sent at once into its own session
// with server VAD, the utterances' times offset by their part, and the transcript saved as text, SRT or VTT; the cues
// split by length; the Codex sign-in and Settings › Voice's language and words used.
import { type App, cleanUp, context, lastText, newSession, openApp, owner, scriptedModel, work } from "./helpers.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { WebSocketServer } from "ws";
import { TOKEN } from "./support/fake-openai.ts";
import { Audio, cuesOf, m4aArgs, PART_SECONDS, saidAsWritten, speakParts, srtOf, vttOf, wavData, wavOf } from "../src/server/audio.ts";
import { localEngine } from "../src/server/media.ts";

const engine = localEngine();
const real = { skip: engine === undefined ? "no ffmpeg in native/ (node scripts/server-tools.ts linux-x64 ffmpeg)" : false } as const;

/** Each session the stand-in had: what it was set to, the headers, and how many bytes of pcm came. */
const sessions: { update?: { session: { type: string; audio: { input: { transcription: Record<string, unknown>; turn_detection: Record<string, unknown> } } } }; headers: Record<string, unknown>; bytes: number }[] = [];
const http = createServer();
const sockets = new WebSocketServer({ server: http });

/** Each realtime model a text was read with: its URL, its session, and the text asked. */
const speeches: { url: string; update?: { session: { instructions: string; audio: { output: { voice: string } } } }; text?: string }[] = [];
let misread = 0;

sockets.on("connection", (socket, request) => {
    if (request.url?.includes("?model=") === true) {
        const speech: (typeof speeches)[number] = { url: request.url };

        speeches.push(speech);
        socket.on("message", (data) => {
            const event = JSON.parse(String(data)) as { type: string; session?: never; item?: { content: { text: string }[] } };

            if (event.type === "session.update") {
                speech.update = { session: event.session! };
            } else if (event.type === "conversation.item.create") {
                speech.text = /<<<\n([\s\S]*)\n>>>/.exec(event.item!.content[0]!.text)?.[1];
            } else if (event.type === "response.create") {
                const text = speech.text ?? "";
                // A text with MISREAD is answered instead of read the first time; one with NEVER, every time.
                const said = text.includes("NEVER") || (text.includes("MISREAD") && misread++ === 0) ? "Sure, I can help with that." : text.toUpperCase();
                const say = (event: Record<string, unknown>) => socket.send(JSON.stringify(event));

                // 10 ms of sound a character.
                say({ type: "response.output_audio.delta", delta: Buffer.alloc(text.length * 480).toString("base64") });
                say({ type: "response.output_audio_transcript.delta", delta: said });
                say({ type: "response.done", response: { status: "completed", usage: { input_tokens: 5, output_tokens: 7 } } });
            }
        });

        return;
    }

    const index = sessions.length;
    const session: (typeof sessions)[number] = { headers: request.headers, bytes: 0 };
    let spoke = false;

    sessions.push(session);
    socket.on("message", (data) => {
        const event = JSON.parse(String(data)) as { type: string; audio?: string };

        if (event.type === "session.update") {
            session.update = event as never;
        } else if (event.type === "input_audio_buffer.commit") {
            // What was left after the last utterance: committed, with nothing said in it.
            socket.send(JSON.stringify({ type: "input_audio_buffer.committed", item_id: `end${index}` }));
            socket.send(JSON.stringify({ type: "conversation.item.input_audio_transcription.completed", item_id: `end${index}`, transcript: "", usage: { input_tokens: 1, output_tokens: 0 } }));
        } else if (event.type === "input_audio_buffer.append") {
            session.bytes += Buffer.from(event.audio ?? "", "base64").length;

            // Two utterances in each part, as VAD would find them, then their texts.
            if (!spoke) {
                spoke = true;
                const say = (event: Record<string, unknown>) => socket.send(JSON.stringify(event));

                say({ type: "input_audio_buffer.speech_started", item_id: `a${index}`, audio_start_ms: 1000 });
                say({ type: "input_audio_buffer.speech_stopped", item_id: `a${index}`, audio_end_ms: 2500 });
                say({ type: "input_audio_buffer.speech_started", item_id: `b${index}`, audio_start_ms: 4000 });
                say({ type: "input_audio_buffer.speech_stopped", item_id: `b${index}`, audio_end_ms: 5000 });
                say({ type: "conversation.item.input_audio_transcription.completed", item_id: `b${index}`, transcript: `Second in part ${index + 1}.`, usage: { input_tokens: 10, output_tokens: 4 } });
                say({ type: "conversation.item.input_audio_transcription.completed", item_id: `a${index}`, transcript: `Xin chào from part ${index + 1}.`, usage: { input_tokens: 20, output_tokens: 6 } });
            }
        }
    });
});

const asks: Record<string, Record<string, unknown>> = {
    "transcribe the talk": { path: "talk.flac", format: "srt", language: "vi" },
    "transcribe as text": { path: "talk.flac" },
    "transcribe the picture": { path: "still.png" },
    "read it aloud": { text: `${"Mot cau tieng Viet de doc thu. ".repeat(20)}Phan hai MISREAD mot lan. ${"Cau cuoi cung. ".repeat(5)}`, style: "calm" },
    "read it as wav": { text: "Xin chào.", voice: "cedar", format: "wav", model: "gpt-realtime" },
    "read the impossible": { text: "This one is NEVER read." },
};
const results: string[] = [];
const route: FauxResponseStep = (request) => {
    const { role, text } = lastText(request as never);

    if (role === "toolResult") {
        results.push(text);

        return fauxAssistantMessage([fauxText("done")]);
    }

    for (const [ask, args] of Object.entries(asks)) {
        if (role === "user" && text.endsWith(ask)) {
            return fauxAssistantMessage([fauxToolCall(ask.startsWith("read") ? "audio_speak" : "audio_transcribe", args as never)], { stopReason: "toolUse" });
        }
    }

    return fauxAssistantMessage([fauxText("ok")]);
};
let app: App;

before(async () => {
    await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
    app = await openApp(scriptedModel(route), undefined, undefined, { audio: { endpoints: { socket: `ws://127.0.0.1:${(http.address() as AddressInfo).port}` }, auth: async () => ({ token: TOKEN, account: "acct-1" }) } });

    if (engine !== undefined) {
        // Ten minutes and ten seconds: two parts.
        execFileSync(engine.ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", `sine=duration=${PART_SECONDS + 10}:sample_rate=16000`, "-ac", "1", join(work, "talk.flac")]);
        execFileSync(engine.ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc=size=64x36", "-frames:v", "1", join(work, "still.png")]);
    }
});

after(async () => {
    sockets.close();
    http.close();
    await app?.close();
    cleanUp();
});

async function ask(id: number, text: string): Promise<string> {
    const { submissionId } = await app.commands.submit(id as never, owner(app), { text, requestId: crypto.randomUUID() });

    await (await app.harness.submission(submissionId, context))!.wait(context);

    return results.at(-1)!;
}

test("cues: a long utterance split by words, its time shared by length; SRT and VTT clocks", () => {
    const long = { start: 0, end: 12000, text: "one two three four five six seven eight nine ten" };
    const cues = cuesOf([long, { start: 60000 + 3723004, end: 3723004 + 61000, text: "short" }]);

    assert.equal(cues.length, 3);
    assert.deepEqual(cues.slice(0, 2).map((cue) => cue.text), ["one two three four five", "six seven eight nine ten"]);
    assert.equal(cues[0]!.start, 0);
    assert.equal(cues[1]!.end, 12000);
    assert.ok(cues[0]!.end > 5000 && cues[0]!.end < 7000, String(cues[0]!.end));
    assert.equal(srtOf([{ start: 3723004, end: 3724500, text: "hi" }]), "1\n01:02:03,004 --> 01:02:04,500\nhi\n");
    assert.equal(vttOf([{ start: 1500, end: 2000, text: "hi" }]), "WEBVTT\n\n00:00:01.500 --> 00:00:02.000\nhi\n");
});

test("a text in parts after its sentences (a long sentence after words); what was said compared by letters and digits", () => {
    assert.deepEqual(speakParts("One two. Three four! Five six?", 20), ["One two. Three four!", "Five six?"]);
    assert.deepEqual(speakParts("a b c d e f g h", 5), ["a b c", "d e f", "g h"]);
    assert.deepEqual(speakParts("  Short.  "), ["Short."]);
    assert.ok(saidAsWritten("Xin chào, anh Tuấn!", "xin chào anh tuấn"));
    assert.ok(!saidAsWritten("Xin chào anh Tuấn", "Xin chao anh Tuan"));
    assert.deepEqual([...wavData(wavOf(new Uint8Array([1, 2, 3, 4])))!], [1, 2, 3, 4]);
    // The phone's slim ffmpeg has the mp4 muxer but not ipod, which .m4a picks: the format is named (seen on #386).
    assert.deepEqual(m4aArgs("in.wav", "out.m4a").slice(-3), ["-f", "mp4", "out.m4a"]);
});

test("a WAV's samples, chunks before them skipped; what is not a WAV refused", () => {
    const chunk = (id: string, body: number[]) => [...Buffer.from(id, "latin1"), body.length & 255, 0, 0, 0, ...body];
    const wav = new Uint8Array([...Buffer.from("RIFF\0\0\0\0WAVE", "latin1"), ...chunk("fmt ", Array(16).fill(1)), ...chunk("LIST", [9, 9, 9]), 0, ...chunk("data", [1, 2, 3, 4])]);

    assert.deepEqual([...wavData(wav)!], [1, 2, 3, 4]);
    assert.equal(wavData(new Uint8Array(Buffer.from("not a wav file"))), undefined);
});

test("the model and the hints: asked, else the setting, else the default; Settings › Voice's language and words", () => {
    let language = "auto";
    const audio = new Audio({ auth: async () => undefined, transcribeSetting: () => null, voice: () => ({ language, words: " Pi, pi-phone " }) });

    assert.equal(audio.transcribeModel(), "gpt-4o-transcribe");
    assert.equal(audio.transcribeModel("whisper-1"), "whisper-1");
    assert.throws(() => audio.transcribeModel("gpt-5"), /not a transcription model/);
    assert.deepEqual(audio.transcribeHints({}), { prompt: "Pi, pi-phone" });
    language = "vi";
    assert.deepEqual(audio.transcribeHints({ language: "en", prompt: "ZeroHop" }), { language: "en", prompt: "ZeroHop" });
    assert.deepEqual(audio.transcribeHints({}), { language: "vi", prompt: "Pi, pi-phone" });
});

test("audio_transcribe: a ten-minute-and-more file in two parts, each its own session, times offset, saved as SRT and text", real, async () => {
    const id = await newSession(app);
    const said = await ask(id, "transcribe the talk");

    assert.match(said, /^Transcribed talk\.flac \(610 s, 2 parts\) with gpt-4o-transcribe: 4 utterances, saved as .*\/transcripts\/\d{8}-\d{6}-talk\.srt/, said);
    assert.equal(sessions.length, 2);
    assert.equal(sessions[0]!.headers.authorization, `Bearer ${TOKEN}`);
    assert.equal(sessions[0]!.headers["chatgpt-account-id"], "acct-1");
    // Settings › Voice's hint: its words, and the names of the sessions used last.
    assert.deepEqual(sessions[0]!.update?.session.audio.input.transcription, { model: "gpt-4o-transcribe", language: "vi", prompt: app.voiceWords() });
    assert.match(app.voiceWords(), /Names: transcribe the talk/);
    assert.equal(sessions[0]!.update?.session.audio.input.turn_detection.type, "server_vad");
    // 24 kHz pcm16: 600 s, then 10 s, each with 2 s of silence after it.
    assert.deepEqual(sessions.map((each) => each.bytes), [(PART_SECONDS + 2) * 48000, 12 * 48000]);

    const srt = readdirSync(join(work, "transcripts")).find((name) => name.endsWith("-talk.srt"))!;

    assert.equal(
        readFileSync(join(work, "transcripts", srt), "utf8"),
        [
            "1\n00:00:01,000 --> 00:00:02,500\nXin chào from part 1.\n",
            "2\n00:00:04,000 --> 00:00:05,000\nSecond in part 1.\n",
            "3\n00:10:01,000 --> 00:10:02,500\nXin chào from part 2.\n",
            "4\n00:10:04,000 --> 00:10:05,000\nSecond in part 2.\n",
        ].join("\n"),
    );
    assert.deepEqual(readdirSync(join(work, "transcripts")).filter((name) => name.endsWith(".wav")), [], "no part left behind");

    const entries = await app.transcripts.allEntries(id as never, true);
    const result = entries.filter((entry) => entry.kind === "toolResult").at(-1) as unknown as { details?: { tokens?: unknown; transcript?: { parts?: number } } };

    assert.deepEqual(result.details?.tokens, { input: 62, output: 20 });
    assert.equal(result.details?.transcript?.parts, 2);

    // Text by default, with no language when Settings › Voice says auto.
    assert.match(await ask(id, "transcribe as text"), /saved as .*\.txt\n\nXin chào from part 3\.\nSecond in part 3\.\nXin chào from part 4\.\nSecond in part 4\.$/);
    assert.deepEqual(sessions.at(-1)!.update?.session.audio.input.transcription, { model: "gpt-4o-transcribe", prompt: app.voiceWords() });
    // A picture has no sound.
    assert.match(await ask(id, "transcribe the picture"), /still\.png has no sound to transcribe/);
});

test("audio_speak: a long text read in parts, a part read wrong read again, joined into an m4a in audio/; wav without ffmpeg; never read: nothing saved", real, async () => {
    const id = await newSession(app);
    const said = await ask(id, "read it aloud");
    const text = asks["read it aloud"]!.text as string;
    const parts = speakParts(text);

    assert.equal(parts.length, 2);
    assert.match(said, /^Read aloud with gpt-realtime-mini, voice marin, in 2 parts: .*\/audio\/\d{8}-\d{6}-mot-cau-tieng-viet[-a-z]*\.m4a \(\d+(\.\d)? s, \d+ KB\)\. It plays in the chat\.$/, said);
    // The second part read twice: the first time it answered instead.
    assert.deepEqual(speeches.map((each) => each.text), [parts[0], parts[1], parts[1]]);
    assert.ok(speeches.every((each) => each.url.endsWith("/realtime?model=gpt-realtime-mini")));
    assert.equal(speeches[0]!.update?.session.audio.output.voice, "marin");
    assert.match(speeches[0]!.update!.session.instructions, /word for word.*How to read it: calm$/);

    const m4a = readdirSync(join(work, "audio")).filter((name) => name.endsWith(".m4a"));
    const probe = JSON.parse(execFileSync(engine!.ffprobe, ["-v", "error", "-show_format", "-show_streams", "-of", "json", join(work, "audio", m4a[0]!)], { encoding: "utf8" })) as { format: { duration: string }; streams: { codec_name: string }[] };

    assert.equal(m4a.length, 1);
    assert.equal(probe.streams[0]!.codec_name, "aac");
    // 10 ms a character, both parts.
    assert.ok(Math.abs(Number(probe.format.duration) - (parts[0]!.length + parts[1]!.length) / 100) < 0.2, probe.format.duration);
    assert.deepEqual(readdirSync(join(work, "audio")).filter((name) => name.endsWith(".wav")), [], "the WAV it was made from is gone");

    // A WAV, another voice and model.
    assert.match(await ask(id, "read it as wav"), /with gpt-realtime, voice cedar: .*\.wav \(0\.1 s/);
    assert.ok(speeches.at(-1)!.url.endsWith("?model=gpt-realtime"));
    assert.equal(speeches.at(-1)!.update?.session.audio.output.voice, "cedar");

    // Read wrong twice: said so, and nothing saved.
    const before = readdirSync(join(work, "audio")).length;

    assert.match(await ask(id, "read the impossible"), /did not read part 1 of 1 as written, twice\. It was to read: "This one is NEVER read\."\. It said: "Sure, I can help with that\."/);
    assert.equal(readdirSync(join(work, "audio")).length, before);
});
