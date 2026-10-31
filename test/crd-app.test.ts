// Chrome Remote Desktop in the app (PP-263), with stand-in machines (`support/fake-crd.ts`, `support/fake-windows.ts`):
// Pi's computer_control setup with crd asks the owner on a card each time. Connect's card takes Google's command and a
// PIN, which only the owner may send: a bad redirect or an expired code keeps the card open with why; once connected the
// card is answered and Pi hears it, and the values never reach Pi, the model, the stored transcript or the log. Install
// and remove show what changes and run nothing on Deny; a Linux machine is refused with no card. When computer control
// finds a Windows screen locked, Pi is told to unlock it with Chrome Remote Desktop, or to offer to set it up.
import { type App, cleanUp, context, lastText, modelTexts, newSession, openApp, owner, root, scriptedModel, until } from "./helpers.ts";
import assert from "node:assert/strict";
import { lstatSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { installPlan, removePlan } from "../src/server/crd.ts";
import { CONNECTED, fakeCrd, NOT_INSTALLED } from "./support/fake-crd.ts";
import { type FakeWindows, fakeWindows } from "./support/fake-windows.ts";

const CODE = `4/0AVG7fiQ${"y".repeat(60)}Kp2`;
const REDIRECT = "https://remotedesktop.google.com/_/oauthredirect";
const PIN = "90210377";
const COMMAND = `& "\${Env:PROGRAMFILES(X86)}\\Google\\Chrome Remote Desktop\\CurrentVersion\\remoting_start_host.exe" --code="${CODE}" --redirect-url="${REDIRECT}" --name=$Env:COMPUTERNAME`;
const calls: Record<string, [string, Record<string, unknown>]> = {
    "connect it": ["computer_control", { action: "setup", machine: "tualh-laptop", crd: "connect" }],
    "install it": ["computer_control", { action: "setup", machine: "tualh-laptop", crd: "install", reason: "To unlock it from your phone" }],
    "remove it": ["computer_control", { action: "setup", machine: "tualh-laptop", crd: "remove" }],
    "connect the linux one": ["computer_control", { action: "setup", machine: "build-box", crd: "connect" }],
    "how is it": ["computer_control", { action: "status" }],
};
const requests: string[] = [];
const logs: string[] = [];
const dataDir = join(root, "crd-app-data");
const crd = fakeCrd({ ...CONNECTED, service: "Stopped", config: false });
const route: FauxResponseStep = (request) => {
    requests.push(JSON.stringify(request));
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
let laptop: string;

before(async () => {
    windows = await fakeWindows({ ocuLog: join(mkdtempSync(join(root, "crd-app-")), "calls.jsonl") });
    app = await openApp(scriptedModel(route), dataDir, undefined, {
        log: (line: string) => logs.push(line),
        crdRun: crd.run,
        computer: {
            machines: () => [{ id: laptop, name: "tualh-laptop", platform: "windows", connected: true, tools: { ocu: "1.1.2-pp.2" }, user: "Picassio" }],
            launch: windows.launch,
            run: windows.run,
            writeFile: windows.writeFile,
            forward: windows.forward,
            idleEndMs: 60_000,
            refreshMs: 60_000,
        },
    });
    const key = await app.sshKeys.generate("crd");

    laptop = app.machines.add({ name: "tualh-laptop", address: "Picassio@laptop", keyId: key.id }).id;
    Object.assign(app.machines.get(laptop), { hostKey: "SHA256:test (ED25519)", remote: { platform: "windows", arch: "x64", home: "C:/Users/Picassio" } });
    const box = app.machines.add({ name: "build-box", address: "me@box", keyId: key.id }).id;

    Object.assign(app.machines.get(box), { hostKey: "SHA256:test (ED25519)", remote: { platform: "linux", arch: "x64", home: "/home/me" } });
});

after(async () => {
    app.computerControl.close();
    await app?.close();
    await windows.close();
    cleanUp();
});

async function turn(id: number, text: string, answer?: (card: ReturnType<typeof app.approvals.all>[number]) => Promise<unknown>) {
    const { submissionId } = await app.commands.submit(id as never, owner(app), { text, requestId: crypto.randomUUID() });
    let card: ReturnType<typeof app.approvals.all>[number] | undefined;

    if (answer !== undefined) {
        await until(() => app.approvals.forConversation(id as never).length > 0, "the card", 20_000);
        card = app.approvals.forConversation(id as never)[0]!;
        await answer(card);
    }

    await (await app.harness.submission(submissionId, context))!.wait(context);

    return { said: (await modelTexts(app, id as never)).at(-1)!, card };
}

/** Everything kept on disk in the app's folder, as one text. */
function stored(dir = dataDir): string {
    return readdirSync(dir)
        .map((name) => {
            const path = join(dir, name);
            const kind = lstatSync(path);

            return kind.isDirectory() ? stored(path) : kind.isFile() ? readFileSync(path, "latin1") : "";
        })
        .join("\n");
}

test("connect: only the owner sends the card's command and PIN; a bad redirect or an expired code keeps it open; then it connects, and the values reach the machine alone", async () => {
    const id = await newSession(app);
    const guest = app.config.addUser("Lan", "guest").user;
    const connected = await turn(id, "connect it", async (card) => {
        assert.deepEqual(card.form, { type: "crd-connect", machine: laptop, machineName: "tualh-laptop" });
        await assert.rejects(app.answerCrdConnect(card.id, { command: COMMAND, pin: PIN, confirm: PIN }, guest), /Only the owner connects Chrome Remote Desktop/);
        await assert.rejects(app.answerApproval(card.id, true, owner(app)), /This connects Chrome Remote Desktop: paste Google's command and choose a PIN on the card/);
        await assert.rejects(app.answerCrdConnect(card.id, { command: COMMAND.replace(REDIRECT, "https://evil.example/_/oauthredirect"), pin: PIN, confirm: PIN }, owner(app)), /redirect address is not Google's/);
        await assert.rejects(app.answerCrdConnect(card.id, { command: COMMAND, pin: PIN, confirm: "11111111" }, owner(app)), /The two PINs differ/);
        assert.ok(!crd.calls.some((each) => each.kind === "connect"), "nothing ran for a bad command or PIN");
        crd.startHost = "expired";
        await assert.rejects(app.answerCrdConnect(card.id, { command: COMMAND, pin: PIN, confirm: PIN }, owner(app)), /expired or was used already.*Get a new one at https:\/\/remotedesktop\.google\.com\/headless/);
        assert.equal(app.approvals.forConversation(id as never).length, 1, "the card stays open for a new code");
        crd.startHost = "echo";
        await assert.rejects(app.answerCrdConnect(card.id, { command: COMMAND, pin: PIN, confirm: PIN }, owner(app)), (error: Error) => !error.message.includes(PIN) && !error.message.includes(CODE) && /\[removed\]/.test(error.message));
        crd.startHost = "started";
        assert.equal(await app.answerCrdConnect(card.id, { command: COMMAND, pin: PIN, confirm: PIN }, owner(app)), true);
    });

    assert.match(connected.said, /Chrome Remote Desktop on tualh-laptop is connected to the owner's Google account.*you never saw the code or the PIN/);
    assert.deepEqual(crd.given, { code: CODE, redirect: REDIRECT, pin: PIN });

    for (const value of [CODE, REDIRECT, PIN]) {
        for (const each of crd.calls) {
            assert.ok(!each.script.includes(value), "never in a script");
        }

        assert.ok(!requests.some((request) => request.includes(value)), "never in what the model got");
        assert.ok(!logs.some((line) => line.includes(value)), "never in the log");
        assert.ok(!(await modelTexts(app, id as never)).some((text) => text.includes(value)), "never in the transcript");
        assert.ok(!stored().includes(value), "never kept on disk");
    }

    assert.ok(logs.some((line) => /Chrome Remote Desktop: tualh-laptop is connected/.test(line)));

    // The machine's row sends the same way (`crdConnect`): connected already, Pi is told so without a card.
    assert.match((await turn(id, "connect it")).said, /is connected already/);
    assert.equal(app.approvals.forConversation(id as never).length, 0);
});

test("install and remove: each card shows what changes; Deny runs nothing; Approve does it. Not installed, connect says to install first", async () => {
    const id = await newSession(app);

    crd.state = { ...NOT_INSTALLED };
    assert.match((await turn(id, "connect it")).said, /not installed on tualh-laptop: install it first \(crd: \\"install\\"\)/);

    const denied = await turn(id, "install it", (card) => app.answerApproval(card.id, false, owner(app)));

    assert.equal(denied.card?.subject, installPlan("tualh-laptop"));
    assert.equal(denied.card?.reason, "To unlock it from your phone");
    assert.match(denied.said, /said no: nothing changed on tualh-laptop/);
    assert.ok(!crd.calls.some((each) => each.kind === "install"));

    const made = await turn(id, "install it", (card) => app.answerApproval(card.id, true, owner(app)));

    assert.match(made.said, /Chrome Remote Desktop 154\.0\.8037\.40 is installed on tualh-laptop \(Google's, its signature checked\): installed, not connected\..*crd: \\"connect\\"/);
    assert.equal(app.machines.get(laptop).tools?.crd, "154.0.8037.40");

    const removed = await turn(id, "remove it", (card) => app.answerApproval(card.id, true, owner(app)));

    assert.equal(removed.card?.subject, removePlan("tualh-laptop"));
    assert.match(removed.said, /Chrome Remote Desktop is removed from tualh-laptop/);
    assert.equal(crd.state.installed, false);
    assert.equal(app.machines.get(laptop).tools?.crd, undefined);
});

test("a Linux machine is not offered it: refused with no card, nothing run", async () => {
    const id = await newSession(app);
    const before = crd.calls.length;

    assert.match((await turn(id, "connect the linux one")).said, /for the owner's own Windows x64 machines for now \(Linux and macOS come later\); build-box is linux x64/);
    assert.equal(app.approvals.forConversation(id as never).length, 0);
    assert.equal(crd.calls.length, before);
});

test("computer control on a locked Windows screen tells Pi to unlock it with Chrome Remote Desktop, or to offer to set it up", async () => {
    const id = await newSession(app);

    windows.state = { task: true, loggedOn: true, locked: true, running: true };
    windows.crd = "connected";
    assert.match((await turn(id, "how is it")).said, /its screen is locked.*Ask the owner to unlock it with Chrome Remote Desktop from their phone/);
    windows.crd = "not installed";
    assert.match((await turn(id, "how is it")).said, /its screen is locked.*Offer to set up Chrome Remote Desktop/);
});
