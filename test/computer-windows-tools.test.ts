// Pi's computer tools on a Windows machine (PP-179), in the app, with a stand-in Windows machine and bridge
// (`test/support/fake-windows.ts`): status says whether it is ready, not set up, or not logged on; start on a machine
// without pi-phone's task says so; computer_control setup with task waits for the owner's card (which shows what is made)
// and runs nothing on Deny; then a session runs through the bridge.
import { type App, cleanUp, context, lastText, modelTexts, newSession, openApp, owner, root, scriptedModel, until } from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { taskPlan } from "../src/server/computer-windows.ts";
import { type FakeWindows, fakeWindows } from "./support/fake-windows.ts";

const calls: Record<string, [string, Record<string, unknown>]> = {
    "how is it": ["computer_control", { action: "status" }],
    "start it": ["computer_control", { action: "start", machine: "tualh-laptop", apps: ["Pi OCU Demo"], minutes: 10, reason: "Greet me" }],
    "set it up": ["computer_control", { action: "setup", machine: "tualh-laptop", task: "install", reason: "To use your apps" }],
    "remove it": ["computer_control", { action: "setup", machine: "tualh-laptop", task: "remove" }],
    "read it": ["computer_screen", { app: "Pi OCU Demo" }],
    "stop it": ["computer_control", { action: "stop" }],
};
const route: FauxResponseStep = (request) => {
    const { role, text } = lastText(request as never);

    for (const [ask, [tool, args]] of Object.entries(calls)) {
        if (role === "user" && text.endsWith(ask)) {
            return fauxAssistantMessage([fauxToolCall(tool, args as never)], { stopReason: "toolUse" });
        }
    }

    return fauxAssistantMessage([fauxText(role === "toolResult" ? `told: ${text}` : "ok")]);
};
let app: App;
let windows: FakeWindows;

before(async () => {
    windows = await fakeWindows({ ocuLog: join(mkdtempSync(join(root, "computer-windows-")), "calls.jsonl") });
    app = await openApp(scriptedModel(route), join(root, "computer-windows-data"), undefined, {
        computer: {
            machines: () => [{ id: "w1", name: "tualh-laptop", platform: "windows", connected: true, tools: { ocu: "1.1.2-pp.2" }, user: "Picassio" }],
            launch: windows.launch,
            run: windows.run,
            writeFile: windows.writeFile,
            forward: windows.forward,
            idleEndMs: 60_000,
            refreshMs: 60_000,
        },
    });
});

after(async () => {
    app.computerControl.close();
    await app?.close();
    await windows.close();
    cleanUp();
});

async function turn(id: number, text: string, answer?: boolean) {
    const { submissionId } = await app.commands.submit(id as never, owner(app), { text, requestId: crypto.randomUUID() });
    let card: ReturnType<typeof app.approvals.all>[number] | undefined;

    if (answer !== undefined) {
        await until(() => app.approvals.forConversation(id as never).length > 0, "the card", 20_000);
        card = app.approvals.forConversation(id as never)[0]!;
        await app.answerApproval(card.id, answer, owner(app));
    }

    await (await app.harness.submission(submissionId, context))!.wait(context);

    return { said: (await modelTexts(app, id as never)).at(-1)!, card };
}

test("status and start say when pi-phone's task is not set up, or nobody is signed in", async () => {
    const id = await newSession(app);

    windows.state = { task: false, loggedOn: true, locked: false, running: false };
    assert.match((await turn(id, "how is it")).said, /- tualh-laptop: Windows, ocu 1\.1\.2-pp\.2, not set up: pi-phone's task \\"pi-phone ocu\\" is not on tualh-laptop/);
    assert.match((await turn(id, "start it")).said, /ocu could not read tualh-laptop's desktop: not set up: pi-phone's task/);
    assert.equal(app.approvals.forConversation(id as never).length, 0, "no card for a session that cannot start");

    windows.state = { task: true, loggedOn: false, locked: false, running: false };
    assert.match((await turn(id, "how is it")).said, /- tualh-laptop: Windows, ocu 1\.1\.2-pp\.2, not logged on: nobody is signed in to tualh-laptop's desktop/);
    assert.match((await turn(id, "start it")).said, /not logged on: nobody is signed in/);
});

test("computer_control setup with task: the owner's card shows what is made; Deny runs nothing; Approve makes it; then a session runs through the bridge", async () => {
    const id = await newSession(app);

    windows.state = { task: false, loggedOn: true, locked: false, running: false };
    const denied = await turn(id, "set it up", false);

    assert.equal(denied.card?.tool, "computer_control");
    assert.equal(denied.card?.subject, taskPlan("tualh-laptop", "Picassio", "install"));
    assert.equal(denied.card?.reason, "To use your apps");
    assert.match(denied.said, /said no: nothing changed on tualh-laptop/);
    assert.ok(!windows.scripts.some((each) => each.kind === "install"));

    const made = await turn(id, "set it up", true);

    assert.match(made.said, /pi-phone's task is on tualh-laptop\. It is ready\./);
    assert.match((await turn(id, "how is it")).said, /- tualh-laptop: Windows, ocu 1\.1\.2-pp\.2, ready/);

    const started = await turn(id, "start it", true);

    assert.equal(started.card?.form?.type, "computer");
    assert.match(started.said, /Computer control is on for 10 minutes \(until \d\d:\d\d\) on tualh-laptop: Pi OCU Demo \(demo_app\.py\)/);
    assert.match((await turn(id, "read it")).said, /3 password text \[password\]/);
    assert.match((await turn(id, "stop it")).said, /Computer control on tualh-laptop is stopped/);

    const removed = await turn(id, "remove it", true);

    assert.match(removed.card?.subject ?? "", /remove pi-phone's computer control/);
    assert.match(removed.said, /are gone from tualh-laptop/);
});
