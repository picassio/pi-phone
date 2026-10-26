// Pi's computer tools (PP-178) in the app, with a stand-in machine and ocu (`test/support/fake-ocu.ts`): computer_control
// start names the machine and apps the machine has (never a password manager), shows the owner one card, and on
// Approve the session starts; computer_screen and computer_act read and act through it, a password field refused;
// computer_screenshot sends the window's picture; stop ends it. Only the owner's Pi may.
import { type App, cleanUp, context, lastText, modelTexts, newSession, openApp, owner, root, scriptedModel, until } from "./helpers.ts";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";

const FAKE = join(import.meta.dirname, "support", "fake-ocu.ts");
/** What Pi calls, by the message's end: a tool and its arguments. */
const calls: Record<string, [string, Record<string, unknown>]> = {
    "start bad": ["computer_control", { action: "start", machine: "tuanlh-sandbox-01", apps: ["Calculator"], minutes: 10, reason: "x" }],
    "start never": ["computer_control", { action: "start", machine: "tuanlh-sandbox-01", apps: ["1Password"], minutes: 10, reason: "x" }],
    "start no minutes": ["computer_control", { action: "start", machine: "tuanlh-sandbox-01", apps: ["Pi OCU Demo"], reason: "x" }],
    "start it": ["computer_control", { action: "start", machine: "tuanlh-sandbox-01", apps: ["Pi OCU Demo"], minutes: 10, reason: "Greet me" }],
    "read it": ["computer_screen", { app: "Pi OCU Demo" }],
    "type the password": ["computer_act", { action: "set_value", index: 3, value: "hunter2" }],
    "fill the name": ["computer_act", { action: "set_value", index: 2, value: "Tuan" }],
    "picture it": ["computer_screenshot", {}],
    "how is it": ["computer_control", { action: "status", machine: "tuanlh-sandbox-01" }],
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

before(async () => {
    app = await openApp(scriptedModel(route), join(root, "computer-data"), undefined, {
        computer: {
            machines: () => [{ id: "m1", name: "tuanlh-sandbox-01", platform: "linux", connected: true, tools: { ocu: "1.1.2-pp.1" } }],
            launch: (_machine, script) => spawn(process.execPath, [FAKE, script.includes("python3 -c") ? "sign" : "mcp"], { stdio: ["pipe", "pipe", "pipe"] }),
            idleEndMs: 60_000,
            refreshMs: 60_000,
        },
    });
});

after(async () => {
    app.computerControl.close();
    await app?.close();
    cleanUp();
});

/** One turn; with `answer`, the card it waits on is answered so and returned. What Pi was told comes back. */
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

test("computer_control start: only apps the machine has, never a password manager, the minutes Pi asks for; one card, then the session", async () => {
    const id = await newSession(app);

    assert.match((await turn(id, "start bad")).said, /There is no app Calculator with a window on tuanlh-sandbox-01\. Its apps: Pi OCU Demo \(demo_app\.py\), Text Editor \(gedit\), 1Password/);
    assert.match((await turn(id, "start never")).said, /1Password \(1password\) is a password manager or authenticator: Pi never reads or controls it/);
    assert.match((await turn(id, "start no minutes")).said, /Say how long you need: minutes, a whole number from 5 to 60/);

    const { said, card } = await turn(id, "start it", true);

    assert.deepEqual(card?.form, {
        type: "computer",
        machine: "m1",
        machineName: "tuanlh-sandbox-01",
        platform: "linux",
        ocu: "1.1.2-pp.1",
        apps: [{ label: "Pi OCU Demo", name: "demo_app.py" }],
        minutes: 10,
        follow: false,
    });
    assert.equal(card?.reason, "Greet me");
    assert.match(said, /Computer control is on for 10 minutes \(until \d\d:\d\d\) on tuanlh-sandbox-01: Pi OCU Demo \(demo_app\.py\)/);
    assert.equal(app.computerControl.view()[0]?.conversationId, id);

    assert.match((await turn(id, "read it")).said, /3 password text \[password\][\s\S]*\(Computer control on tuanlh-sandbox-01: \d+ min left, until \d\d:\d\d\.\)/);
    assert.match((await turn(id, "type the password")).said, /\[3\] is a password field: Pi does not type into it/);
    assert.match((await turn(id, "fill the name")).said, /Set \[2\] text to \\"Tuan\\"\.[\s\S]*Value: Tuan/);
    assert.match((await turn(id, "how is it")).said, /- tuanlh-sandbox-01: ocu 1\.1\.2-pp\.1; session #\d+ controls it until/);

    const shot = await turn(id, "picture it");

    assert.match(shot.said, /Pi OCU Demo on tuanlh-sandbox-01 \(420x220 px/);
    assert.match((await turn(id, "stop it")).said, /Computer control on tuanlh-sandbox-01 is stopped/);
    assert.equal(app.computerControl.view().length, 0);
});

test("Deny starts nothing", async () => {
    await app.computerControl.end("m1", "the test before");
    const id = await newSession(app);
    const { said } = await turn(id, "start it", false);

    assert.match(said, /said no: Pi does not control tuanlh-sandbox-01/);
    assert.equal(app.computerControl.view().length, 0);
});
