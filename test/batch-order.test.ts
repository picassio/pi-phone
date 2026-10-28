// A batch's file and shell calls in order (PP-203, src/server/batch-order.ts): in one answer [edit X, bash `cat X`],
// bash runs after the edit landed and reads the edited text; edit, write and bash wait only for the calls of those
// three before them in the round, never for other tools.
import { type App, cleanUp, context, lastText, modelTexts, newSession, openApp, owner, scriptedModel, work } from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { TaskId, ToolSlot } from "@earendil-works/pi-durable";
import { earlierInBatch } from "../src/server/batch-order.ts";

const file = join(work, "batch-order.txt");
/** A file big enough that the edit takes longer than bash takes to start. */
const filler = `${"a line that is only there to make the file long\n".repeat(200_000)}`;

const route: FauxResponseStep = (request) => {
    const { role, text } = lastText(request as never);

    if (role === "user" && text.endsWith("edit, then read it")) {
        return fauxAssistantMessage(
            [
                fauxToolCall("edit", { path: file, edits: [{ oldText: "first: old", newText: "first: new" }] }),
                fauxToolCall("bash", { command: `head -c 10 ${file}` }),
            ],
            { stopReason: "toolUse" },
        );
    }

    return fauxAssistantMessage([fauxText(role === "toolResult" ? `tool said: ${text}` : `heard: ${text}`)]);
};

let app: App;

before(async () => {
    app = await openApp(scriptedModel(route));
    mkdirSync(work, { recursive: true });
});

after(async () => {
    await app.close();
    cleanUp();
});

test("one batch [edit X, bash `head X`]: bash reads the edited text", async () => {
    writeFileSync(file, `first: old\n${filler}`);

    const id = await newSession(app);
    const { submissionId } = await app.commands.submit(id, owner(app), { text: "edit, then read it", requestId: crypto.randomUUID() });

    await (await app.harness.submission(submissionId, context))!.wait(context);

    const texts = await modelTexts(app, id);
    const bash = texts.findLast((each) => each.includes("first: "))!;

    assert.match(bash, /first: new/, texts.slice(-3).join("\n"));
});

test("a call waits for the edit, write and bash calls before it in its round, and for nothing else", async () => {
    const settled: string[] = [];
    const waits = new Map<string, () => void>();
    const task = (id: string) => id as unknown as TaskId;
    const slots: ToolSlot[] = [
        { callId: "c1", name: "edit", status: "running", taskId: task("t1") },
        { callId: "c2", name: "read", status: "running", taskId: task("t2") },
        { callId: "c3", name: "write", status: "running", taskId: task("t3") },
        { callId: "c4", name: "bash", status: "pending", taskId: task("t4") },
        { callId: "c5", name: "web_search", status: "pending", taskId: task("t5") },
    ];
    const api = (callId: string) => ({
        callId,
        conversationId: "conv" as never,
        snapshot: (async () => ({ tools: slots })) as never,
        waitForTask: ((id: string) => {
            settled.push(`${callId} waits ${id}`);

            return new Promise<never>((resolve) => waits.set(id, () => resolve(undefined as never)));
        }) as never,
    });

    // The bash waits for the edit, then the write; never the read.
    let ran = false;
    const bash = earlierInBatch(api("c4"), context).then(() => (ran = true));

    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(settled, ["c4 waits t1"]);
    waits.get("t1")!();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(settled, ["c4 waits t1", "c4 waits t3"]);
    assert.equal(ran, false);
    waits.get("t3")!();
    await bash;
    assert.equal(ran, true);

    // The first of the round, and a call not in the round (a nested one), wait for nothing.
    settled.length = 0;
    await earlierInBatch(api("c1"), context);
    await earlierInBatch(api("c0/1"), context);
    assert.deepEqual(settled, []);
});
