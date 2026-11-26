// Google Antigravity's images and dictation (PP-556, PP-557, antigravity-media.ts): pictures are asked for as agy's image
// tool asks (Cloud Code's generateContent, requestType image_gen, the catalog's image model, edits of up to three);
// speech goes as agy's /voice sends it (gRPC to aicode's BidiGenerateContent: its setup, 40 ms pcm messages, the end
// once Google has read it all), byte for byte as captured from agy 1.5.15; a file is cut into its stretches of speech;
// and all of it shows only while Antigravity is signed in: Menu › Images, Menu › Audio, Settings › Dictation. Google
// (Cloud Code, and the gRPC stream on a local HTTP/2 server) is stood in for.
import { type App, cleanUp, fakeTab, newSession, openApp, owner, root, say, scriptedModel, until } from "./helpers.ts";
import assert from "node:assert/strict";
import { join } from "node:path";
import { after, test } from "node:test";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { AGY_GRPC_TLS, AGY_TLS } from "../src/server/agy-wire.ts";
import { AGY_PROVIDER } from "../src/server/antigravity.ts";
import {
    AGY_TRANSCRIBE,
    AgyMedia,
    audioMessage,
    endMessage,
    grpcFrame,
    proxyFor,
    readHeard,
    setupMessage,
    speechSegments,
    startMessage,
    transcriptOf,
} from "../src/server/antigravity-media.ts";
import { appSettings } from "../src/server/settings-registry.ts";
import { AGY_AUTH as AUTH, AGY_MEDIA_CATALOG as CATALOG, AGY_STT_MODEL as MODEL, AGY_UA as UA, cloudCode, dictationServer, imageAnswer, pcm, PNG, signedInGoogle, varintOf } from "./support/fake-agy.ts";

test("the dictation stream's messages are agy's, byte for byte as captured; Google's answers read as agy reads them", () => {
    // Captured from agy 1.5.15's /voice on 2026-11-23 (wiki: resources/antigravity-agy-fingerprint).
    assert.equal(setupMessage(MODEL).toString("hex"), "0a270a1d6d6f64656c732f70726f6163746976652d6f627365727665722d7631302a04320208014200");
    assert.equal(startMessage().toString("hex"), "1a022a00");
    assert.equal(endMessage().toString("hex"), "1a0410013200");
    assert.equal(audioMessage(new Uint8Array(1280)).subarray(0, 30).toString("hex"), "1a9c0a0a990a0a14617564696f2f70636d3b726174653d31363030301280");
    assert.equal(audioMessage(new Uint8Array(1280)).length, 1311);
    assert.equal(grpcFrame(startMessage()).toString("hex"), "00000000041a022a00");

    assert.deepEqual(readHeard(Buffer.from("0a00", "hex")), { setup: true });
    assert.deepEqual(readHeard(Buffer.from("120e5a0c0a0a58696e206368c3a06f2e", "hex")), { running: "Xin chào." });
    assert.deepEqual(readHeard(Buffer.from("12021001", "hex")), { turnComplete: true });
    assert.deepEqual(readHeard(Buffer.from("1200", "hex")), {});
    const final = Buffer.concat([Buffer.from("12", "hex"), varintOf(26), Buffer.from("32", "hex"), varintOf(24), Buffer.from("0a", "hex"), varintOf(22), Buffer.from("Hello, this is a test.", "utf8")]);

    assert.deepEqual(readHeard(final), { final: "Hello, this is a test." });

    // The final covers the last turn only: it is the transcript when it covers what was heard, else the running one is.
    assert.equal(transcriptOf("Xin chào, lúc 7:00 tối.", "Xin chào, lúc 7 giờ tối."), "Xin chào, lúc 7 giờ tối.");
    assert.equal(transcriptOf("Xin chào, hôm nay trời đẹp. Hello, this is a test of speech.", "Hello, this is a test of speech."), "Xin chào, hôm nay trời đẹp. Hello, this is a test of speech.");
    assert.equal(transcriptOf("", ""), "");
});

test("a file is cut into its stretches of speech: quiet gaps of 1.5 s and more part them, none is longer than 45 s", () => {
    const parts = speechSegments(pcm(["quiet", 1], ["tone", 2], ["quiet", 2], ["tone", 1], ["quiet", 0.5], ["tone", 1], ["quiet", 1]));

    assert.equal(parts.length, 2, JSON.stringify(parts));
    assert.ok(Math.abs(parts[0]!.start - 790) <= 60 && Math.abs(parts[0]!.end - 3210) <= 60, JSON.stringify(parts));
    assert.ok(Math.abs(parts[1]!.start - 4790) <= 60 && Math.abs(parts[1]!.end - 7710) <= 60, JSON.stringify(parts));
    assert.deepEqual(speechSegments(pcm(["quiet", 3])), []);

    const long = speechSegments(pcm(["tone", 70]));

    assert.equal(long.length, 2);
    assert.ok(long.every((each) => each.end - each.start <= 45_000));
    assert.equal(long[0]!.end, long[1]!.start);
});

test("a picture is asked for as agy's image tool asks: generateContent, image_gen, agy's headers, the prompt then the images; edits take three at most", async () => {
    const { sent, send } = cloudCode((request) => (request.url.endsWith(":fetchAvailableModels") ? { body: JSON.stringify(CATALOG) } : imageAnswer()));
    const media = new AgyMedia({ apiKey: async () => AUTH, send, now: () => 1_795_438_869_238 });

    assert.deepEqual(await media.imageModels(), [{ id: "gemini-3.1-flash-image", name: "Gemini 3.1 Flash Image" }]);
    assert.deepEqual(await media.imageModels(), [{ id: "gemini-3.1-flash-image", name: "Gemini 3.1 Flash Image" }]);
    assert.equal(sent.filter((each) => each.url.endsWith(":fetchAvailableModels")).length, 1, "the catalog is kept an hour");
    assert.deepEqual(JSON.parse(sent[0]!.body), { project: "aicode-consumers" });

    const made = await media.makeImage({ model: "gemini-3.1-flash-image", prompt: "a red bicycle", inputs: [] });
    const request = sent.at(-1)!;
    const body = JSON.parse(request.body) as Record<string, unknown>;

    assert.equal(request.url, "https://daily-cloudcode-pa.googleapis.com/v1internal:generateContent");
    // As Go writes them (PP-558's wire): Host, User-Agent, Content-Length, the rest by name, Accept-Encoding last.
    assert.deepEqual(Object.entries(request.headers), [
        ["Host", "daily-cloudcode-pa.googleapis.com"],
        ["User-Agent", UA],
        ["Content-Length", String(Buffer.byteLength(request.body))],
        ["Authorization", "Bearer ya29.live"],
        ["Content-Type", "application/json"],
        ["Accept-Encoding", "gzip"],
    ]);
    assert.deepEqual(Object.keys(body), ["project", "requestId", "request", "model", "userAgent", "requestType"]);
    assert.match(String(body.requestId), /^image_gen\/1795438869238\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/2$/);
    assert.deepEqual(body.request, { contents: [{ role: "user", parts: [{ text: "a red bicycle" }] }], generationConfig: { candidateCount: 1, imageConfig: { aspectRatio: "1:1" } } });
    assert.deepEqual([body.project, body.model, body.userAgent, body.requestType], ["aicode-consumers", "gemini-3.1-flash-image", "antigravity", "image_gen"]);
    assert.equal(made.images.length, 1);
    assert.equal(made.images[0]!.mimeType, "image/png", "the type is the bytes', whatever Google says");
    assert.deepEqual(made.tokens, { input: 72, output: 1607 });

    await media.makeImage({ model: "gemini-3.1-flash-image", prompt: "make the wall blue", inputs: [{ mimeType: "image/png", data: new Uint8Array(PNG) }], aspect: "16:9" });
    const edit = JSON.parse(sent.at(-1)!.body) as { request: unknown };

    assert.deepEqual(edit.request, {
        contents: [{ role: "user", parts: [{ text: "make the wall blue" }, { inlineData: { mimeType: "image/png", data: PNG.toString("base64") } }] }],
        generationConfig: { candidateCount: 1, imageConfig: { aspectRatio: "16:9" } },
    });

    // A tool call of a session on Antigravity: agy's trajectory, and the step after the agent request that made it.
    const steps: unknown[] = [];
    const inSession = new AgyMedia({
        apiKey: async () => AUTH,
        send,
        now: () => 1_795_438_869_238,
        stepOf: async (id) => {
            steps.push(id);

            return { trajectory: "699a07fe-d017-4e54-aa86-9895b92c0a0d", step: 3 };
        },
    });

    await inSession.makeImage({ model: "gemini-3.1-flash-image", prompt: "x", inputs: [], conversationId: 7 as never });
    assert.equal((JSON.parse(sent.at(-1)!.body) as { requestId: string }).requestId, "image_gen/1795438869238/699a07fe-d017-4e54-aa86-9895b92c0a0d/4");
    assert.deepEqual(steps, [7]);

    const four = Array.from({ length: 4 }, () => ({ mimeType: "image/png", data: new Uint8Array(PNG) }));

    await assert.rejects(media.makeImage({ model: "gemini-3.1-flash-image", prompt: "x", inputs: four }), /at most 3 images/);
    await assert.rejects(new AgyMedia({ apiKey: async () => undefined, send }).makeImage({ model: "m", prompt: "x", inputs: [] }), /not signed in/);
    assert.deepEqual(await new AgyMedia({ apiKey: async () => undefined, send }).imageModels(), []);

    const refused = new AgyMedia({ apiKey: async () => AUTH, send: cloudCode(() => ({ status: 429, body: JSON.stringify({ error: { status: "RESOURCE_EXHAUSTED", message: "quota" } }) })).send });

    await assert.rejects(refused.makeImage({ model: "gemini-3.1-flash-image", prompt: "x", inputs: [] }), /Google Antigravity \(429\): RESOURCE_EXHAUSTED: quota/);
});

test("a picture on one more account (accounts.ts) is made on its own sign-in, catalog, reads and trajectory; dictation stays the original's", async () => {
    const WORK = `${AGY_PROVIDER}~work`;
    const WORK_AUTH = JSON.stringify({ token: "ya29.work", project: "work-project", userAgent: UA });
    const { sent, send } = cloudCode((request) => (request.url.endsWith(":fetchAvailableModels") ? { body: JSON.stringify(CATALOG) } : imageAnswer()));
    const used: string[] = [];
    const steps: unknown[][] = [];
    const media = new AgyMedia({
        apiKey: async (account) => (account === WORK ? WORK_AUTH : account === AGY_PROVIDER ? AUTH : undefined),
        accounts: async () => [{ id: AGY_PROVIDER }, { id: WORK, name: "Work" }],
        send,
        now: () => 1_795_438_869_238,
        beforeUse: async (account) => void used.push(`before ${account}`),
        afterUse: (account) => void used.push(`after ${account}`),
        stepOf: async (id, account) => {
            steps.push([id, account]);

            return account === WORK ? { trajectory: "0b1f3d6e-0000-4000-8000-000000000001", step: 5 } : undefined;
        },
    });

    assert.deepEqual(await media.accounts(), [{ id: AGY_PROVIDER }, { id: WORK, name: "Work" }]);
    assert.deepEqual(await media.imageModels(WORK), [{ id: "gemini-3.1-flash-image", name: "Gemini 3.1 Flash Image" }]);
    assert.equal(sent.at(-1)!.headers.Authorization, "Bearer ya29.work", "its catalog asked on its token");
    await media.imageModels(AGY_PROVIDER);
    assert.equal(sent.at(-1)!.headers.Authorization, "Bearer ya29.live", "each account's catalog is kept apart");

    await media.makeImage({ account: WORK, model: "gemini-3.1-flash-image", prompt: "x", inputs: [], conversationId: 9 as never });
    const request = sent.at(-1)!;

    assert.equal(request.headers.Authorization, "Bearer ya29.work");
    assert.equal((JSON.parse(request.body) as { project: string }).project, "work-project");
    assert.equal((JSON.parse(request.body) as { requestId: string }).requestId, "image_gen/1795438869238/0b1f3d6e-0000-4000-8000-000000000001/6");
    assert.deepEqual(steps, [[9, WORK]]);
    assert.deepEqual(used, [`before ${WORK}`, `after ${WORK}`]);

    // Not signed in: it says which account.
    const signedOut = new AgyMedia({ apiKey: async (account) => (account === AGY_PROVIDER ? AUTH : undefined), send });

    await assert.rejects(signedOut.makeImage({ account: WORK, model: "m", prompt: "x", inputs: [] }), /account google-antigravity~work is not signed in/);
    assert.deepEqual(await signedOut.accounts(), [{ id: AGY_PROVIDER }], "by default, the original's alone");
    assert.equal(await signedOut.signedIn(), true, "dictation and transcription ask the original's");
    assert.equal(await signedOut.signedIn(WORK), false);
});

test("speech goes as agy's /voice sends it: gRPC headers, the setup with the catalog's model, 40 ms messages, the end once Google is quiet; a file in its stretches of speech", async () => {
    const google = await dictationServer();
    const { send } = cloudCode(() => ({ body: JSON.stringify(CATALOG) }));
    const media = new AgyMedia({ apiKey: async () => AUTH, send, dictationUrl: google.url, idleMs: 150 });

    try {
        const audio = pcm(["quiet", 1], ["tone", 2], ["quiet", 2], ["tone", 1], ["quiet", 1]);
        const { model, utterances } = await media.transcribe(audio);

        assert.equal(model, MODEL);
        assert.equal(google.streams.length, 2, "one stream for each stretch of speech");
        const headers = google.streams[0]!.headers;

        assert.deepEqual(
            [headers[":method"], headers[":path"], headers["content-type"], headers["user-agent"], headers.te, headers.authorization],
            ["POST", "/google.gca.aicode.v1alpha.PredictionService/BidiGenerateContent", "application/grpc", "grpc-go/1.86.0-dev", "trailers", "Bearer ya29.live"],
        );
        // grpc-go's order on the wire: the pseudo-headers, content-type, user-agent, te, then the call's metadata.
        assert.deepEqual(
            google.streams[0]!.raw.filter((_, index) => index % 2 === 0),
            [":method", ":scheme", ":path", ":authority", "content-type", "user-agent", "te", "authorization"],
        );

        for (const stream of google.streams) {
            const messages = stream.messages;

            assert.equal(messages[0]!.toString("hex"), setupMessage(MODEL).toString("hex"));
            assert.equal(messages[1]!.toString("hex"), "1a022a00");
            assert.equal(messages.at(-1)!.toString("hex"), "1a0410013200");
            const audioMessages = messages.slice(2, -1);

            assert.ok(audioMessages.slice(0, -1).every((each) => each.length === 1311), "40 ms of audio a message, as agy sends it");
        }

        const bytes = (each: { start: number; end: number }) => Math.floor((each.end * 32) / 2) * 2 - Math.floor((each.start * 32) / 2) * 2;

        assert.deepEqual(
            utterances.map((each) => each.text),
            speechSegments(audio).map((each) => `final ${bytes(each)}`),
            "the whole of each stretch reached Google, and its transcript is the final one",
        );
        assert.ok(Math.abs(utterances[0]!.start - 790) <= 60 && Math.abs(utterances[1]!.start - 4790) <= 60, JSON.stringify(utterances));
    } finally {
        await google.close();
    }

    // grpc-go's ClientHello: Go's, without the CBC suites, and only h2.
    assert.equal(AGY_GRPC_TLS.ciphers.split(":").length, 9);
    assert.ok(AGY_GRPC_TLS.ciphers.split(":").every((each) => /GCM|CHACHA20/.test(each)));
    assert.deepEqual(AGY_GRPC_TLS.ALPNProtocols, ["h2"]);
    assert.equal(AGY_GRPC_TLS.ecdhCurve, AGY_TLS.ecdhCurve);

    // The app's proxy, as Go reads it.
    const env = { HTTPS_PROXY: "http://user:pw@127.0.0.1:18080", NO_PROXY: "localhost,.internal.example" };

    assert.equal(proxyFor(new URL("https://aicode.googleapis.com"), env)?.host, "127.0.0.1:18080");
    assert.equal(proxyFor(new URL("https://a.internal.example"), env), undefined);
    assert.equal(proxyFor(new URL("https://aicode.googleapis.com"), { NO_PROXY: "*", HTTPS_PROXY: "http://p:1" }), undefined);
    assert.equal(proxyFor(new URL("https://aicode.googleapis.com"), {}), undefined);

    const refusing = await dictationServer({ status: "8" });

    try {
        const failing = new AgyMedia({ apiKey: async () => AUTH, send, dictationUrl: refusing.url, idleMs: 100 });

        await assert.rejects(failing.transcribe(pcm(["tone", 1])), /dictation refused \(gRPC 8: quota exhausted\)/);
    } finally {
        await refusing.close();
    }
});

let app: App | undefined;

after(async () => {
    await app?.close();
    cleanUp();
});

test("in the app: Antigravity's image model, its transcription and its dictation show only once it is signed in; the message box's dictation goes through the server", async () => {
    // A session on Antigravity: its first request calls image_generate, its second answers.
    let turns = 0;
    const { sent, send } = cloudCode((request) => {
        if (!request.url.includes("streamGenerateContent")) {
            return signedInGoogle(request);
        }

        turns++;
        const parts = turns === 1 ? [{ functionCall: { name: "image_generate", args: { prompt: "a red bicycle" }, id: "call_1" } }] : [{ text: "Done." }];

        return { body: `data: ${JSON.stringify({ response: { candidates: [{ content: { role: "model", parts }, finishReason: "STOP" }] } })}\n\n` };
    });
    const google = await dictationServer();

    try {
        app = await openApp(scriptedModel(() => fauxAssistantMessage([fauxText("ok")])), join(root, "agy-media-data"), undefined, {
            antigravity: { send, platform: { osType: "linux", arch: "amd64" } },
            agyMedia: { send, dictationUrl: google.url, idleMs: 150 },
        });
        const user = owner(app);
        const setting = (id: string) => appSettings(app!).settings.find((each) => each.id === id)!;

        // Signed out: nothing of Antigravity's to pick, and its dictation is refused.
        assert.equal((await app.images.models()).models.some((each) => each.provider === AGY_PROVIDER), false);
        assert.deepEqual(await app.audio.transcribeModels(), ["gpt-4o-transcribe", "gpt-4o-mini-transcribe", "whisper-1"]);
        await assert.rejects(app.setAudioChoice(user, "transcribeModel", AGY_TRANSCRIBE), /Choose one of/);
        await assert.rejects(app.setVoice(user, { engine: "antigravity" }), /needs its sign-in/);
        assert.deepEqual(await setting("voice.engine").choices!(), ["android", "codex"]);
        assert.equal(sent.length, 0, "nothing goes to Google before the owner signs in");

        // Sign in, as the Providers card does.
        const tab = fakeTab(undefined, user);

        app.attach(tab.client);
        const flowId = app.providers.startLogin(user, AGY_PROVIDER, "oauth");

        await until(() => tab.last("auth")?.step === "prompt", "the code prompt");
        app.providers.answerLogin(user, flowId, tab.last("auth")!.promptId as string, "4/0Aean-code");
        await until(() => tab.last("auth")?.step === "done", "the sign-in to finish");

        // Menu › Images: Antigravity's image model, on its plan; auto picks it when no other provider makes images.
        const { models } = await app.images.models();

        assert.deepEqual(
            models.filter((each) => each.provider === AGY_PROVIDER).map((each) => [each.id, each.name]),
            [["google-antigravity/gemini-3.1-flash-image", "Gemini 3.1 Flash Image"]],
        );
        const choice = await app.images.resolve();

        assert.equal(choice.id, "google-antigravity/gemini-3.1-flash-image");
        const made = await app.images.generate(choice, { prompt: "a red bicycle", inputs: [], aspect: "16:9", count: 1 });

        assert.equal(made.images.length, 1);
        assert.equal(made.cost, undefined, "on the Antigravity plan: no money");
        assert.deepEqual((JSON.parse(sent.at(-1)!.body) as { request: { generationConfig: unknown } }).request.generationConfig, { candidateCount: 1, imageConfig: { aspectRatio: "16:9" } });
        assert.ok(sent.some((each) => each.url.endsWith(":retrieveUserQuotaSummary")), "a media call starts agy's background reads, as a turn does");

        // A session on Antigravity calls image_generate: the image request names its trajectory and the next step, as agy's.
        const id = await newSession(app);
        const agyModel = (await app.modelList()).find((each) => each.provider === AGY_PROVIDER)!;

        await app.commands.configure(id, user, { model: { provider: AGY_PROVIDER, modelId: agyModel.id }, thinkingLevel: "off" });
        await say(app, id, "Draw a red bicycle.");
        const ids = sent
            .filter((each) => each.url.includes("streamGenerateContent") || each.url.endsWith(":generateContent"))
            .slice(-3)
            .map((each) => (JSON.parse(each.body) as { requestId: string }).requestId.split("/"));

        assert.deepEqual(
            ids.map((each) => each[0]),
            ["agent", "image_gen", "agent"],
        );
        assert.deepEqual([ids[0]![4], ids[1]![3], ids[2]![4]], ["1", "2", "3"], "agent/1, image_gen/2, agent/3: agy's steps");
        assert.equal(ids[1]![2], ids[0]![3], "the image request names the calling trajectory");
        assert.equal(ids[2]![3], ids[0]![3]);

        // Menu › Audio: Antigravity's transcription is one to pick now.
        assert.deepEqual(await app.audio.transcribeModels(), ["gpt-4o-transcribe", "gpt-4o-mini-transcribe", "whisper-1", AGY_TRANSCRIBE]);
        await app.setAudioChoice(user, "transcribeModel", AGY_TRANSCRIBE);
        assert.equal(app.audio.transcribeModel(), AGY_TRANSCRIBE);
        assert.ok((await setting("audio.transcribeModel").choices!()).includes(AGY_TRANSCRIBE));

        // Settings › Dictation: Antigravity listens; the page's audio goes through the server to Google's stream.
        assert.deepEqual(await setting("voice.engine").choices!(), ["android", "codex", "antigravity"]);
        await app.setVoice(user, { engine: "antigravity" });
        assert.equal(app.config.voice.engine, "antigravity");
        const started = await app.agyMedia.startDictation(user.id);

        assert.deepEqual([started.model, started.rate], [MODEL, 16000]);
        app.agyMedia.dictationAudio(user.id, started.dictation, pcm(["tone", 0.5]));
        await until(() => app!.agyMedia.dictationAudio(user.id, started.dictation, new Uint8Array(0)).text !== "", "the running transcript");
        assert.deepEqual(await app.agyMedia.endDictation(user.id, started.dictation, false), { text: "final 16000" });
        assert.throws(() => app!.agyMedia.dictationAudio(user.id, started.dictation, new Uint8Array(2)), /it ended/);
        assert.throws(() => app!.agyMedia.dictationAudio("someone-else", started.dictation, new Uint8Array(2)), /No such dictation/);
        assert.doesNotMatch(JSON.stringify(tab.events), /ya29\.live|kept-refresh/);
    } finally {
        await google.close();
    }
});
