// Computer control (PP-178) with a stand-in ocu (`test/support/fake-ocu.ts`) in place of the machine: a session shows
// its window on the machine first (and does not start when it cannot), runs one ocu, and checks every call before ocu
// gets it: the session's apps (and, following along, what they open), the Never list, password fields, an element
// still the one Pi read, and the owner's hands while they have the computer. It ends at its time, on Stop on the
// machine, after Pi's run, or when the owner puts its app on the Never list; a restart ends it.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { ComputerControl, type ComputerControlOptions, type ComputerFrame, type ComputerMachine, typesCharacter } from "../src/server/computer-control.ts";
import { parseApps, parseOutline, pngSize } from "../src/server/computer-outline.ts";

const FAKE = join(import.meta.dirname, "support", "fake-ocu.ts");
const root = mkdtempSync(join(tmpdir(), "pi-phone-computer-"));
let made = 0;

/** Every control made, closed at the end: a test that failed half-way leaves no ocu running. */
const controls: ComputerControl[] = [];

after(async () => {
    for (const control of controls) {
        control.close();
    }

    await new Promise((resolve) => setTimeout(resolve, 300));
    rmSync(root, { recursive: true, force: true });
});

async function eventually(check: () => boolean, what: string): Promise<void> {
    for (const started = Date.now(); !check(); ) {
        if (Date.now() - started > 10_000) {
            throw new Error(`Timed out waiting for ${what}`);
        }

        await new Promise((resolve) => setTimeout(resolve, 50));
    }
}

const SANDBOX: ComputerMachine = { id: "m1", name: "tuanlh-sandbox-01", platform: "linux", connected: true, tools: { ocu: "1.1.2-pp.1" } };

/** A control with the stand-in machine: what it was asked to run on it, and what ocu got (from the log). */
function make(options: { sign?: string; machines?: ComputerMachine[]; idleEndMs?: number; dataDir?: string } = {}) {
    const dataDir = options.dataDir ?? mkdtempSync(join(root, "data-"));
    const logFile = join(root, `ocu-${++made}.log`);
    const scripts: string[] = [];
    const launch: ComputerControlOptions["launch"] = (_machine, script) => {
        scripts.push(script);

        return spawn(process.execPath, [FAKE, script.includes("python3 -c") ? "sign" : "mcp"], {
            stdio: ["pipe", "pipe", "pipe"],
            env: { ...process.env, FAKE_OCU_LOG: logFile, ...(options.sign === undefined ? {} : { FAKE_SIGN: options.sign }) },
        });
    };
    const control = new ComputerControl({ dataDir, gateway: false, machines: () => options.machines ?? [SANDBOX], launch, idleEndMs: options.idleEndMs ?? 60_000, refreshMs: 60_000 });
    const calls = () => (existsSync(logFile) ? readFileSync(logFile, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as { tool: string; args: Record<string, unknown> }) : []);

    controls.push(control);

    return { control, scripts, calls, dataDir };
}

const DEMO = { label: "Pi OCU Demo", name: "demo_app.py" };
const start = (control: ComputerControl, extra: { follow?: boolean; apps?: { label: string; name: string }[]; conversationId?: number } = {}) =>
    control.start({
        machine: "m1",
        machineName: "tuanlh-sandbox-01",
        conversationId: extra.conversationId ?? 7,
        session: extra.conversationId ?? 7,
        approvedBy: "owner",
        apps: extra.apps ?? [DEMO, { label: "Ticker", name: "ticker" }],
        follow: extra.follow ?? false,
        reason: "greet",
        minutes: 15,
    });

test("the outline: elements with frames, password fields, the focus, the window's size; apps from list_apps; a PNG's size", () => {
    const outline = parseOutline(
        [
            "App=demo_app.py (pid 27702)",
            'Window: "Pi OCU Demo", App: demo_app.py.',
            "\t0 frame Pi OCU Demo Frame: {x: 0, y: 0, width: 420, height: 220}",
            "\t\t\t3 password text [password] Secondary Actions: activate Frame: {x: 12, y: 54, width: 396, height: 34}",
            "",
            "The focused UI element is password text [password].",
        ].join("\n"),
    );

    assert.equal(outline.app, "demo_app.py");
    assert.equal(outline.window, "Pi OCU Demo");
    assert.deepEqual(outline.size, { width: 420, height: 220 });
    assert.deepEqual(outline.elements[1], {
        index: 3,
        what: "password text [password] Secondary Actions: activate",
        name: "password text [password]",
        frame: { x: 12, y: 54, width: 396, height: 34 },
        password: true,
    });
    // What an element is leaves out what was typed into it.
    assert.deepEqual(
        parseOutline("App=a\nWindow: \"A\", App: a.\n\t2 text  Value: Tuan Secondary Actions: activate Frame: {x: 1, y: 2, width: 3, height: 4}").elements[0]?.what,
        "text  Secondary Actions: activate",
    );
    assert.equal(outline.focusedPassword, true);
    assert.deepEqual(parseApps("demo_app.py -- demo_app.py [running, pid=27702, window=Pi OCU Demo]"), [{ name: "demo_app.py", id: "demo_app.py", window: "Pi OCU Demo", running: true }]);
    assert.deepEqual(pngSize("iVBORw0KGgoAAAANSUhEUgAAAaQAAADcCAIAAAA"), { width: 420, height: 220 });
    assert.equal(pngSize("aGVsbG8gd29ybGQ="), undefined);
    assert.equal(typesCharacter("a") && typesCharacter("shift+a") && typesCharacter("space") && typesCharacter("KP_1"), true);
    assert.equal(typesCharacter("Return") || typesCharacter("ctrl+a") || typesCharacter("BackSpace"), false);
});

test("a machine must be connected, Linux, with ocu; its desktop setup line runs before ocu", async () => {
    const { control } = make({
        machines: [
            SANDBOX,
            { id: "m2", name: "laptop", platform: "windows", connected: true, tools: { ocu: "1.1.2-pp.1" } },
            { id: "m3", name: "devbox", platform: "linux", connected: true, tools: {} },
            { id: "m4", name: "off", connected: false },
        ],
    });

    assert.equal(control.machine("TUANLH-SANDBOX-01").id, "m1");
    assert.throws(() => control.machine("laptop"), /Windows needs pi-phone's task/);
    assert.throws(() => control.machine("devbox"), /ocu\) is not installed on devbox: install it in Settings › Machines › Install tools/);
    assert.throws(() => control.machine("off"), /off is not connected/);
    assert.throws(() => control.machine("nope"), /There is no machine nope/);
    assert.throws(() => control.setPrepare("m1", "a\nb"), /one shell line/);
});

test("ocu installed since the app last looked at the machine's tools: it asks the machine again before refusing", async () => {
    const devbox: ComputerMachine = { id: "m3", name: "devbox", platform: "linux", connected: true, tools: {} };
    const asked: string[] = [];
    const control = new ComputerControl({
        dataDir: mkdtempSync(join(root, "data-")),
        gateway: false,
        machines: () => [devbox],
        launch: () => {
            throw new Error("not started here");
        },
        refreshTools: async (id) => {
            asked.push(id);
            devbox.tools = { ocu: "1.1.2-pp.1" };
        },
    });

    controls.push(control);
    assert.throws(() => control.machine("devbox"), /not installed on devbox/);
    assert.equal((await control.ready("devbox")).id, "m3");
    assert.deepEqual(asked, ["m3"]);
    // Known now: no second look.
    await control.ready("devbox");
    assert.deepEqual(asked, ["m3"]);
});

test("the apps on the desktop, each with why it is never controlled; the setup line goes first", async () => {
    const { control, scripts } = make();

    control.setPrepare("m1", ". ~/tmp/ocu/env.sh");
    const apps = await control.apps("m1");

    assert.deepEqual(
        apps.map((each) => [each.name, each.never]),
        [
            ["demo_app.py", null],
            ["gedit", null],
            ["1password", "a password manager or authenticator"],
            ["ticker", null],
        ],
    );
    assert.match(scripts[0]!, /^if \[ ! -x "\$HOME\/\.pi\/mobile\/tools\/bin\/ocu" \]; then .*\n\. ~\/tmp\/ocu\/env\.sh\nexec "\$HOME\/\.pi\/mobile\/tools\/bin\/ocu" mcp$/);
    assert.equal(control.neverReason({ name: "pi-phone" }), "pi-phone itself");
    assert.equal(control.neverReason({ name: "x", window: "Bitwarden" }), "a password manager or authenticator");
    assert.equal(control.neverReason({ name: "chrome", window: "Vietcombank - Google Chrome" }), "a banking or payment app");
});

test("a session shows its window on the machine before ocu starts; without it nothing starts", async () => {
    const failing = make({ sign: "fail" });

    await assert.rejects(start(failing.control), /tuanlh-sandbox-01 could not show that Pi is using it, so the session did not start: ModuleNotFoundError: No module named 'gi'/);
    assert.equal(failing.control.sessions().length, 0);
    assert.equal(failing.scripts.filter((each) => each.includes("ocu\" mcp")).length, 0, "no ocu started");

    const { control, scripts } = make();
    const session = await start(control);

    assert.match(scripts[0]!, /exec python3 -c '.*set_keep_above\(True\).*' 'Pi is using this computer until \d\d:\d\d \(pi-phone\)'$/s);
    assert.match(scripts[1]!, /ocu" mcp$/);
    assert.equal(control.active("m1"), session);
    assert.equal(session.until - session.startedAt, 15 * 60_000);
    await control.end("m1", "test over");
});

test("Pi reads and acts in its apps only; never a password field; [n] only while it is still what Pi read", async () => {
    const { control, calls } = make();
    const frames: ComputerFrame[] = [];

    control.onFrame((frame) => frames.push(frame));
    const session = await start(control);

    await assert.rejects(control.screen(session, "gedit"), /gedit is not in this session/);
    await assert.rejects(control.screen(session, "1password"), /not in this session/);
    const { text } = await control.screen(session, "Pi OCU Demo");

    assert.match(text, /3 password text \[password\]/);
    await control.act(session, undefined, { op: "set_value", index: 2, value: "Tuan" });
    const greeted = await control.act(session, undefined, { op: "click", index: 5 });

    assert.match(greeted.text, /label Hello, Tuan!/);
    assert.equal(greeted.did, "Clicked [5] push button Greet.");
    // The picture after it, with the box on Greet (window fractions).
    const last = frames.at(-1)!;

    assert.equal(last.app, "demo_app.py");
    assert.deepEqual([last.width, last.height], [420, 220]);
    assert.deepEqual(last.hit, { x: 12 / 420, y: 125 / 220, width: 396 / 420, height: 34 / 220, label: "click [5]" });

    // Password fields: refused here, before ocu gets them.
    const before = calls().length;

    await assert.rejects(control.act(session, undefined, { op: "set_value", index: 3, value: "hunter2" }), /\[3\] is a password field: Pi does not type into it/);
    await control.act(session, undefined, { op: "press_key", key: "Tab" });
    await assert.rejects(control.act(session, undefined, { op: "type_text", text: "hunter2" }), /The field in focus is a password field/);
    await assert.rejects(control.act(session, undefined, { op: "press_key", key: "h" }), /a key at a time either/);
    assert.deepEqual(calls().slice(before).map((each) => each.tool), ["press_key"], "only Tab reached ocu");
    await control.act(session, undefined, { op: "press_key", key: "Return" });

    // The ticker's numbers move with each read: after the panel read it again, Pi's [1] is no longer its [1].
    await control.screen(session, "ticker");
    await control.setTab(7, "ticker");
    await assert.rejects(control.act(session, "ticker", { op: "click", index: 1 }), /\[1\] in Ticker is no longer what you read \(the window changed\): read it again/);
    await control.end("m1", "test over");
});

test("while the owner has the computer, Pi waits; their taps and keys go through ocu, never into a password field", async () => {
    const { control, calls } = make();
    const session = await start(control);

    await control.screen(session, "demo_app.py");
    assert.equal(control.takeOver(7, true).takenOver, true);
    await assert.rejects(control.screen(session, "demo_app.py"), /The owner took the computer over: wait until they hand it back/);
    await control.input(7, { type: "tap", x: 200, y: 140 });
    assert.deepEqual(calls().at(-1), { tool: "click", args: { app: "demo_app.py", x: 200, y: 140 } });
    await control.input(7, { type: "text", text: "Tu" });
    assert.equal((await control.input(7, { type: "key", key: "Tab" })).password, true);
    await assert.rejects(control.input(7, { type: "text", text: "secret" }), /type it on the computer itself/);
    await assert.rejects(control.input(7, { type: "key", key: "F13" }), /The keys are Enter/);
    control.takeOver(7, false);
    assert.match((await control.screen(session, "demo_app.py")).text, /text {2}Value: Tu/);
    await control.end("m1", "test over");
});

test("following along: an app the named one opens joins, one step", async () => {
    const { control } = make();
    const session = await start(control, { follow: true, apps: [DEMO] });

    await control.screen(session, "demo_app.py");
    const done = await control.act(session, undefined, { op: "click", index: 7 });

    assert.deepEqual(done.joined, [{ label: "Help", name: "help-viewer" }]);
    assert.deepEqual(session.followed, [{ label: "Help", name: "help-viewer" }]);
    assert.match((await control.screen(session, "Help")).text, /Window: "Help"/);
    await control.end("m1", "test over");
});

test("it ends after Pi's run unless another starts, on Stop on the machine, and when its app goes on the Never list", async () => {
    const idle = make({ idleEndMs: 100 });

    await start(idle.control);
    idle.control.runEnded(7);
    idle.control.runStarted(7);
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.ok(idle.control.active("m1"), "a new run keeps it");
    idle.control.runEnded(7);
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.equal(idle.control.active("m1"), undefined);
    assert.match(idle.control.noSession("m1"), /ended at \d\d:\d\d: Pi's turn ended/);

    const stopped = make({ sign: "stop" });

    // Stop may come while ocu still starts: then start says so, and it is stopped all the same.
    await start(stopped.control).catch((error: Error) => assert.match(error.message, /Stop was pressed on tuanlh-sandbox-01 as the session started/));
    await eventually(() => stopped.control.active("m1") === undefined, "Stop on the machine");
    assert.match(stopped.control.noSession("m1"), /Stop on the computer/);

    const never = make();

    await start(never.control);
    await never.control.addNever("OCU Demo");
    assert.equal(never.control.active("m1"), undefined);
    assert.match(never.control.noSession("m1"), /the owner put Pi OCU Demo on the Never list/);
    assert.equal(never.control.neverReason({ name: "demo_app.py", window: "Pi OCU Demo" }), "on the owner's Never list");
    never.control.removeNever("ocu demo");
    assert.equal(never.control.neverReason({ name: "demo_app.py", window: "Pi OCU Demo" }), undefined);
});

test("a restart ends the session (its ocu and window went with the server); the Never list and setup lines stay", async () => {
    const first = make();

    first.control.setPrepare("m1", ". ~/env.sh");
    await first.control.addNever("Outlook");
    await start(first.control);
    const again = make({ dataDir: first.dataDir });

    assert.equal(again.control.sessions().length, 0);
    assert.match(again.control.noSession("m1"), /pi-phone restarted/);
    assert.equal(again.control.prepareOf("m1"), ". ~/env.sh");
    assert.deepEqual(again.control.neverList().own, [{ label: "Outlook" }]);
    await first.control.end("m1", "test over");
});
