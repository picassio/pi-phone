// A stopping server ends its voice calls at once (PP-198; src/server/voice-bridge.ts `closeAll`, app.ts `close`): a
// call's sideband whose other end no longer answers (a network that died, not even OpenAI's answer to the close) is
// ended within moments instead of ws's 30 s, which held the old server alive while the phone started the next one; and
// what was said in the call is in the transcript before the storage closes.
import { type App, cleanUp, newSession, openApp, owner, root, scriptedModel, until } from "./helpers.ts";
import { projectEntry, type ClientEntry } from "../src/server/projection.ts";
import { CLOSE_GRACE_MS } from "../src/server/voice-bridge.ts";
import { FakeOpenAI, TOKEN } from "./support/fake-openai.ts";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ConversationId } from "@earendil-works/pi-durable";
import assert from "node:assert/strict";
import { join } from "node:path";
import { after, test } from "node:test";

const dataDir = join(root, "voice-shutdown");
let openai: FakeOpenAI | undefined;
let app: App | undefined;

after(async () => {
    await app?.close();
    await openai?.close();
    cleanUp();
});

const open = (fake: FakeOpenAI) => openApp(scriptedModel(), dataDir, undefined, { voice: { endpoints: fake.endpoints, auth: async () => ({ token: TOKEN }) } });

async function entries(on: App, id: ConversationId): Promise<ClientEntry[]> {
    const view = await (await on.conversation(id)).viewState(BACKGROUND_CONTEXT);

    try {
        return view.value.entries.map((entry) => projectEntry(entry)).filter((entry): entry is ClientEntry => entry !== undefined);
    } finally {
        view.dispose();
    }
}

test("closing the app ends a call whose connection no longer answers within moments, and keeps what was said", async () => {
    openai = await new FakeOpenAI().start();
    openai.deaf = true;
    app = await open(openai);
    await app.voice.check();

    const id = await newSession(app);
    const start = (await app.startVoiceCall(owner(app), id)) as { call: string; key: string; url: string };
    const posted = await fetch(start.url, { method: "POST", headers: { authorization: `Bearer ${start.key}`, "content-type": "application/sdp" }, body: "v=0\r\n" });
    const rtc = posted.headers.get("location")!.split("/").pop()!;

    app.voice.joined(owner(app).id, start.call, rtc);
    await until(() => (openai!.deafSidebands.get(rtc)?.bytes ?? 0) > 0, "the server joined and said its session", 10_000);

    // The owner says something; the call's response has not ended when the app closes.
    openai.pushDeaf(rtc, { type: "response.created" });
    openai.pushDeaf(rtc, { type: "conversation.item.input_audio_transcription.completed", transcript: "The deploy window is Friday" });
    await new Promise((resolve) => setTimeout(resolve, 200));

    const side = openai.deafSidebands.get(rtc)!;
    const closing = Date.now();

    await app.close();
    await until(() => side.endedAt !== undefined, "the sideband ended", 10_000);
    assert.ok(side.endedAt! - closing < CLOSE_GRACE_MS + 1500, `ended ${side.endedAt! - closing} ms after the app began to close`);
    assert.equal(app.voice.calls().length, 0);

    // Opened again: what was said is in the transcript.
    app = await open(openai);

    const row = (await entries(app, id)).find((entry) => entry.kind === "voice") as Extract<ClientEntry, { kind: "voice" }> | undefined;

    assert.deepEqual(row?.turns, [{ speaker: "you", text: "The deploy window is Friday" }]);
});
