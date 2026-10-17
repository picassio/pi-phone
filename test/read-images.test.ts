// Images through read: an image file comes back as an image the model sees; any other file reads as before.
import { type App, cleanUp, newSession, openApp, owner, say, scriptedModel, work } from "./helpers.ts";
import assert from "node:assert/strict";
import { copyFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { APP_ROOT } from "../src/server/config.ts";

type Message = { role: string; content: string | { type: string; text?: string; mimeType?: string }[] };

let lastResult: Message | undefined;

const route: FauxResponseStep = (request) => {
    const messages = (request as { messages: Message[] }).messages;
    const last = messages.at(-1)!;

    if (last.role === "toolResult") {
        lastResult = last;

        return fauxAssistantMessage([fauxText("seen")]);
    }

    const text = typeof last.content === "string" ? last.content : (last.content.find((each) => each.type === "text")?.text ?? "");
    const path = /^read (.+)$/.exec(text.trim())?.[1];

    return path === undefined
        ? fauxAssistantMessage([fauxText("ok")])
        : fauxAssistantMessage([fauxToolCall("read", { path })], { stopReason: "toolUse" });
};

let app: App;

before(async () => {
    copyFileSync(join(APP_ROOT, "web", "icon-192.png"), join(work, "icon.png"));
    writeFileSync(join(work, "notes.txt"), "plain words\n");
    app = await openApp(scriptedModel(route));
});

after(async () => {
    await app?.close();
    cleanUp();
});

test("an image file comes back as an image, resized and noted; a text file as its text", async () => {
    const id = await newSession(app);

    await app.commands.configure(id, owner(app), {
        model: { provider: "faux", modelId: "faux-vision" },
    });

    await say(app, id, "read icon.png");
    const content = lastResult!.content as { type: string; text?: string; mimeType?: string }[];

    assert.ok(content.some((each) => each.type === "image" && each.mimeType === "image/png"));
    assert.match(content.find((each) => each.type === "text")!.text!, /Read image file \[image\/png\]/);

    await say(app, id, "read notes.txt");
    assert.deepEqual(
        (lastResult!.content as { type: string; text?: string }[]).map((each) => each.text),
        ["plain words\n"],
    );
});
