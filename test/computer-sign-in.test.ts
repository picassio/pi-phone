// computer_sign_in (PP-183) in the app, with a stand-in machine and ocu (`test/support/fake-ocu.ts`): Pi names the
// fields of a window in its computer control session by number, and the owner types the username, the password or a
// code on a card whose labels are the app's own words. Each value goes into its element as ocu's set_value with
// allow_password_input, and never reaches Pi, the stored transcript, the model or the log: Pi reads [username for
// <app>] and the like, a value too short to hide withholds the window, and computer_screenshot blacks the field out.
// Not now fills nothing; a session that controls no computer is refused; only the owner answers the card; Remember
// keeps the sign-in in Secrets, asking before each use, and "Use the kept sign-in" fills it again.
import { type App, cleanUp, context, lastText, modelTexts, newSession, openApp, owner, root, scriptedModel, until } from "./helpers.ts";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, lstatSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";

const FAKE = join(import.meta.dirname, "support", "fake-ocu.ts");
const photon = createRequire(import.meta.url)("@silvia-odwyer/photon-node") as {
    PhotonImage: { new_from_byteslice(bytes: Uint8Array): { get_raw_pixels(): Uint8Array; get_width(): number; free(): void } };
};
const calls: Record<string, [string, Record<string, unknown>]> = {
    "start it": ["computer_control", { action: "start", machine: "tuanlh-sandbox-01", apps: ["Pi OCU Demo"], minutes: 10, reason: "Sign me in" }],
    "read it": ["computer_screen", { app: "Pi OCU Demo" }],
    "sign me in": ["computer_sign_in", { username: 2, password: 3 }],
    "a code please": ["computer_sign_in", { code: 2 }],
    "greet": ["computer_act", { action: "click", index: 5 }],
    "picture it": ["computer_screenshot", {}],
    "stop it": ["computer_control", { action: "stop" }],
};
const USER = "tuan.le@example.test";
const PASSWORD = "card-pass-88888";
const requests: string[] = [];
const logs: string[] = [];
const ocuLog = join(mkdtempSync(join(root, "computer-sign-in-ocu-")), "calls.jsonl");
const ocuCalls = (): { tool: string; args: Record<string, unknown> }[] =>
    existsSync(ocuLog) ? readFileSync(ocuLog, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as { tool: string; args: Record<string, unknown> }) : [];
const dataDir = join(root, "computer-sign-in-data");

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

before(async () => {
    app = await openApp(scriptedModel(route), dataDir, undefined, {
        log: (line: string) => logs.push(line),
        computer: {
            machines: () => [{ id: "m1", name: "tuanlh-sandbox-01", platform: "linux", connected: true, tools: { ocu: "1.1.2-pp.2" } }],
            launch: (_machine, script) => spawn(process.execPath, [FAKE, script.includes("python3 -c") ? "sign" : "mcp"], { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, FAKE_OCU_LOG: ocuLog } }),
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

/** One turn; with `answer`, the card it waits on is answered by it and returned. What Pi was told comes back. */
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

/** Everything kept on disk in the app's folder but Secrets (where Remember puts a sign-in), as one text. */
function stored(): string {
    const read = (dir: string): string =>
        readdirSync(dir)
            .map((name) => {
                const path = join(dir, name);
                const kind = lstatSync(path);

                return kind.isDirectory() ? read(path) : kind.isFile() && name !== "secrets.json" ? readFileSync(path, "latin1") : "";
            })
            .join("\n");

    return read(dataDir);
}

const started = async () => {
    await app.computerControl.end("m1", "the test before");
    const id = await newSession(app);

    await turn(id, "start it", (card) => app.answerApproval(card.id, true, owner(app)));
    await turn(id, "read it");

    return id;
};

test("a session that controls no computer is refused: no card", async () => {
    const id = await newSession(app);
    const { said } = await turn(id, "sign me in");

    assert.match(said, /This session controls no computer now\. Ask for one with computer_control start/);
    assert.equal(app.approvals.forConversation(id as never).length, 0);
});

test("the owner's values go into the window through ocu with allow_password_input, and never reach Pi, the transcript, the model or the log", async () => {
    const id = await started();
    const guest = app.config.addUser("Lan", "guest").user;
    const filled = await turn(id, "sign me in", async (card) => {
        // A guest neither answers it nor allows it as a plain approval; the owner's plain Allow is refused too (no values).
        await assert.rejects(app.answerComputerSignIn(card.id, { values: { username: USER, password: PASSWORD } }, guest), /Only the owner signs in on their computer/);
        await assert.rejects(app.answerApproval(card.id, true, owner(app)), /This asks you to sign in: type it on the card/);
        await assert.rejects(app.answerComputerSignIn(card.id, { values: { username: USER } }, owner(app)), /Fill in Username and Password/);
        assert.ok(!ocuCalls().some((each) => each.tool === "set_value"), "nothing filled yet");
        await app.answerComputerSignIn(card.id, { values: { username: USER, password: PASSWORD }, remember: true }, owner(app));
    });

    // The card: the machine, the app, the fields by Pi's numbers in fixed words; the Secrets name it may be kept under.
    assert.equal(filled.card?.tool, "computer_sign_in");
    assert.equal(filled.card?.subject, "Sign in to Pi OCU Demo on tuanlh-sandbox-01");
    assert.deepEqual(filled.card?.form, {
        type: "computer-sign-in",
        machine: "m1",
        machineName: "tuanlh-sandbox-01",
        app: { label: "Pi OCU Demo", name: "demo_app.py" },
        fields: [
            { name: "username", index: 2, label: "Username" },
            { name: "password", index: 3, label: "Password" },
        ],
        secret: "LOGIN_TUANLH_SANDBOX_01_DEMO_APP_PY",
        saved: false,
    });
    // Each value into its element, with this call's opt-out of ocu's password guard.
    assert.deepEqual(
        ocuCalls().filter((each) => each.tool === "set_value"),
        [
            { tool: "set_value", args: { app: "demo_app.py", element_index: "2", value: USER, allow_password_input: true } },
            { tool: "set_value", args: { app: "demo_app.py", element_index: "3", value: PASSWORD, allow_password_input: true } },
        ],
    );
    // Pi reads the masks: in what it is told, and in the window read again.
    assert.match(filled.said, /The owner filled in the card's fields; you never see what/);
    assert.match(filled.said, /Filled \[username for Pi OCU Demo\] into \[2\], \[password for Pi OCU Demo\] into \[3\]\./);
    assert.match(filled.said, /2 text {2}Value: \[username for Pi OCU Demo\]/);
    assert.match((await turn(id, "read it")).said, /Value: \[username for Pi OCU Demo\]/);
    // A label that greets the username: read as its mask too.
    assert.match((await turn(id, "greet")).said, /label Hello, \[username for Pi OCU Demo\]!/);

    // The picture a model gets has the field blacked out (and the greeting): white elsewhere.
    const shot = await turn(id, "picture it");

    assert.match(shot.said, /Pi OCU Demo on tuanlh-sandbox-01 \(420x220 px/);
    const pngs = (await modelTexts(app, id as never)).flatMap((content) => [...content.matchAll(/"data":"(iVBOR[^"]+)"/g)].map((match) => match[1]!));
    const image = photon.PhotonImage.new_from_byteslice(Buffer.from(pngs.at(-1)!, "base64"));
    const raw = image.get_raw_pixels();
    const width = image.get_width();
    const at = (x: number, y: number) => [...raw.subarray((y * width + x) * 4, (y * width + x) * 4 + 3)];

    image.free();
    assert.deepEqual(at(200, 29), [24, 24, 27], "the username field is blacked out");
    assert.deepEqual(at(200, 175), [24, 24, 27], "the label greeting the username is blacked out");
    assert.deepEqual(at(200, 140), [255, 255, 255], "the Greet button is not");

    // Remembered: in Secrets, asking before any use.
    assert.deepEqual(JSON.parse(app.secrets.value("LOGIN_TUANLH_SANDBOX_01_DEMO_APP_PY")!), { username: USER, password: PASSWORD });

    // Never in what Pi was told, the transcript kept on disk, the model's requests, or the log.
    const seen = JSON.stringify(await modelTexts(app, id as never)) + requests.join("\n") + logs.join("\n") + stored();

    for (const value of [USER, PASSWORD]) {
        assert.ok(!seen.includes(value), `${value} reached Pi, the transcript, the model or the log`);
    }

    // The kept sign-in fills it again from the card, without typing.
    const again = await turn(id, "sign me in", async (card) => {
        assert.equal((card.form as { saved?: boolean }).saved, true);
        await app.answerComputerSignIn(card.id, { useSaved: true }, owner(app));
    });

    assert.match(again.said, /Filled \[username for Pi OCU Demo\] into \[2\]/);
    assert.equal(ocuCalls().filter((each) => each.tool === "set_value" && each.args.value === PASSWORD && each.args.allow_password_input === true).length, 2);
    await turn(id, "stop it");
});

test("Not now leaves the fields alone", async () => {
    const id = await started();
    const before = ocuCalls().length;
    const { said, card } = await turn(id, "sign me in", (asked) => app.answerApproval(asked.id, false, owner(app)));

    assert.equal(card?.tool, "computer_sign_in");
    assert.match(said, /said not now: nothing was filled in/);
    assert.ok(!ocuCalls().slice(before).some((each) => each.tool === "set_value" || each.tool === "type_text"), "nothing typed");
    assert.equal(await app.answerComputerSignIn(card!.id, { values: { username: USER, password: PASSWORD } }, owner(app)), false, "a late answer finds no card");
    assert.ok(!ocuCalls().slice(before).some((each) => each.tool === "set_value"), "a late answer fills nothing");
    await turn(id, "stop it");
});

test("a code too short to hide withholds the window while it shows; a code card offers no Remember", async () => {
    const id = await started();
    const { said, card } = await turn(id, "a code please", (asked) => app.answerComputerSignIn(asked.id, { values: { code: "42" } }, owner(app)));

    assert.deepEqual((card?.form as { fields: unknown }).fields, [{ name: "code", index: 2, label: "Code" }]);
    assert.equal((card?.form as { secret?: string }).secret, undefined);
    assert.deepEqual(ocuCalls().findLast((each) => each.tool === "set_value")?.args, { app: "demo_app.py", element_index: "2", value: "42", allow_password_input: true });
    assert.match(said, /The window is not shown: a field shows what the owner typed on the card, too short to hide from you/);
    assert.match((await turn(id, "read it")).said, /The window is not shown/);
    assert.match((await turn(id, "picture it")).said, /The window is not shown/);
    await turn(id, "stop it");
});
