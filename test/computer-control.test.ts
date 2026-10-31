// Computer control (PP-178) with a stand-in ocu (`test/support/fake-ocu.ts`) in place of the machine: a session shows
// its window on the machine first (and does not start when it cannot), runs one ocu, and checks every call before ocu
// gets it: the session's apps (and, following along, what they open), the Never list, password fields, an element
// still the one Pi read, and the owner's hands while they have the computer. It ends at its time, on Stop on the
// machine, after Pi's run, or when the owner puts its app on the Never list; a restart ends it.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { ComputerControl, type ComputerControlOptions, type ComputerFrame, type ComputerMachine, typesCharacter } from "../src/server/computer-control.ts";
import { parseApps, parseError, parseOutline, pngSize, withoutErrorLine } from "../src/server/computer-outline.ts";

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
function make(options: { sign?: string; machines?: ComputerMachine[]; idleEndMs?: number; dataDir?: string; env?: Record<string, string> } = {}) {
    const dataDir = options.dataDir ?? mkdtempSync(join(root, "data-"));
    const logFile = join(root, `ocu-${++made}.log`);
    const scripts: string[] = [];
    const launch: ComputerControlOptions["launch"] = (_machine, script) => {
        scripts.push(script);

        return spawn(process.execPath, [FAKE, script.includes("python3 -c") ? "sign" : "mcp"], {
            stdio: ["pipe", "pipe", "pipe"],
            env: { ...process.env, FAKE_OCU_LOG: logFile, ...(options.sign === undefined ? {} : { FAKE_SIGN: options.sign }), ...options.env },
        });
    };
    const lines: string[] = [];
    const control = new ComputerControl({ dataDir, gateway: false, machines: () => options.machines ?? [SANDBOX], launch, idleEndMs: options.idleEndMs ?? 60_000, refreshMs: 60_000, log: (line) => lines.push(line) });
    /** What ocu got, as it got it. */
    const rawCalls = () => (existsSync(logFile) ? readFileSync(logFile, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as { tool: string; args: Record<string, unknown> }) : []);
    /** The same without the newest read's snapshot_id every action names (PP-270, tested on its own below). */
    const calls = () =>
        rawCalls().map(({ tool, args }) => {
            const { snapshot_id: _, ...rest } = args;

            return { tool, args: rest };
        });

    controls.push(control);

    return { control, scripts, calls, rawCalls, dataDir, lines };
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

test("a machine must be connected, Linux or Windows, with ocu; its desktop setup line runs before ocu", async () => {
    const { control } = make({
        machines: [
            SANDBOX,
            { id: "m2", name: "laptop", platform: "windows", connected: true, tools: { ocu: "1.1.2-pp.1" } },
            { id: "m3", name: "devbox", platform: "linux", connected: true, tools: {} },
            { id: "m4", name: "off", connected: false },
            { id: "m5", name: "mac", platform: "darwin", connected: true, tools: { ocu: "1.1.2-pp.1" } },
        ],
    });

    assert.equal(control.machine("TUANLH-SANDBOX-01").id, "m1");
    // Windows through pi-phone's task (PP-179, computer-windows.test.ts).
    assert.equal(control.machine("laptop").id, "m2");
    assert.throws(() => control.machine("mac"), /Computer control runs on Linux and Windows machines; mac is darwin/);
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

    await assert.rejects(control.act(session, undefined, { op: "set_value", index: 3, value: "hunter2" }), /\[3\] is a password field: Pi never types a password as text\. Fill it with a saved secret by name/);
    await control.act(session, undefined, { op: "press_key", key: "Tab" });
    await assert.rejects(control.act(session, undefined, { op: "type_text", text: "hunter2" }), /The field in focus is a password field: Pi never types a password as text/);
    await assert.rejects(control.act(session, undefined, { op: "press_key", key: "h" }), /a key at a time either/);
    assert.deepEqual(calls().slice(before).map((each) => each.tool), ["press_key"], "only Tab reached ocu");
    await control.act(session, undefined, { op: "press_key", key: "Return" });
    // Pi's own calls never tell ocu it may type into a password field: only a saved secret by name does (its name in
    // what Pi is told, its value in the field).
    assert.equal(calls().filter((each) => "allow_password_input" in each.args).length, 0);
    await control.screen(session, "demo_app.py");
    const filled = await control.act(session, undefined, { op: "set_value", index: 3, value: "s3cret-55", secret: "DEMO_PW" });

    assert.equal(filled.did, "Set [3] password text [password] to [secret DEMO_PW].");
    assert.deepEqual(calls().at(-1), { tool: "set_value", args: { app: "demo_app.py", element_index: "3", value: "s3cret-55", allow_password_input: true } });
    assert.ok(!filled.text.includes("s3cret-55"));
    assert.ok(!JSON.stringify(frames.map((each) => each.hit)).includes("s3cret-55"));

    // The ticker's numbers move with each read: after the panel read it again, Pi's [1] is no longer its [1].
    await control.screen(session, "ticker");
    await control.setTab(7, "ticker");
    await assert.rejects(control.act(session, "ticker", { op: "click", index: 1 }), /\[1\] in Ticker is no longer what you read \(the window changed\): read it again/);
    await control.end("m1", "test over");
});

test("while the owner has the computer, Pi waits; their taps and keys go through ocu, into a password field too, and nowhere else", async () => {
    const { control, calls, lines } = make();
    const panels: unknown[] = [];
    const frames: ComputerFrame[] = [];

    control.onPanel((panel) => panels.push(panel));
    control.onFrame((frame) => frames.push(frame));
    const session = await start(control);

    await control.screen(session, "demo_app.py");
    assert.equal(control.takeOver(7, true).takenOver, true);
    await assert.rejects(control.screen(session, "demo_app.py"), /The owner took the computer over: wait until they hand it back/);
    await control.input(7, { type: "tap", x: 200, y: 140 });
    // The owner's tap is a real click at that point: the one call that tells ocu headed (PP-270).
    assert.deepEqual(calls().at(-1), { tool: "click", args: { app: "demo_app.py", x: 200, y: 140, headed: true } });
    assert.equal((await control.input(7, { type: "text", text: "Tu" })).password, false);
    assert.deepEqual(calls().at(-1), { tool: "type_text", args: { app: "demo_app.py", text: "Tu", allow_password_input: true } });
    // Into the password field: the owner's own, so ocu is told this call may.
    assert.equal((await control.input(7, { type: "key", key: "Tab" })).password, true);
    assert.equal((await control.input(7, { type: "text", text: "owner-pass-42" })).password, true);
    assert.deepEqual(calls().at(-1), { tool: "type_text", args: { app: "demo_app.py", text: "owner-pass-42", allow_password_input: true } });
    await control.input(7, { type: "key", key: "Backspace" });
    assert.deepEqual(calls().at(-1), { tool: "press_key", args: { app: "demo_app.py", key: "BackSpace", allow_password_input: true } });
    await assert.rejects(control.input(7, { type: "key", key: "F13" }), /The keys are Enter/);
    control.takeOver(7, false);
    // What the owner typed into the password field: in ocu's calls only, never in what Pi reads, the panel or the log.
    const read = (await control.screen(session, "demo_app.py")).text;

    assert.match(read, /text {2}Value: Tu/);
    assert.ok(!read.includes("owner-pass-42"), read);
    assert.ok(!JSON.stringify([panels, frames.map((each) => each.hit)]).includes("owner-pass-42"));
    assert.ok(!lines.join("\n").includes("owner-pass-42"));
    // Pi's own calls never carry headed, nor the opt-out.
    assert.deepEqual(
        calls().filter((each) => each.args.headed !== undefined),
        [{ tool: "click", args: { app: "demo_app.py", x: 200, y: 140, headed: true } }],
    );
    assert.equal(calls().filter((each) => each.args.allow_password_input !== undefined && !["type_text", "press_key"].includes(each.tool)).length, 0);
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

// ─── ocu 1.1.2-pp.3 (PP-270): snapshot ids, states, covered windows, headed, Error lines ───

test("the outline of ocu 1.1.2-pp.3: states left out of what an element is, the snapshot, the window ids, what covers it, an Error line", () => {
    const outline = parseOutline(
        [
            "App=demo_app.py (pid 27702)",
            'Window: "Pi OCU Demo", App: demo_app.py.',
            "Snapshot: 7a6b3001",
            "Window id: 27702:6",
            'Other windows: 27702:9 "Help" (demo_app.py), 4242:6 "Pi OCU Demo \\"2\\"" (python3)',
            "Covered: [{x: 240, y: 90, width: 122, height: 173}, {x: 0, y: 0, width: 10, height: 10}] (other windows; blacked out in the screenshot)",
            "\t0 frame Pi OCU Demo Frame: {x: 0, y: 0, width: 420, height: 220}",
            "\t\t\t2 text  Value: Tuan Secondary Actions: activate States: focused Frame: {x: 12, y: 12, width: 396, height: 34}",
            "\t\t\t4 check box Shout Secondary Actions: click States: checked, focused Frame: {x: 12, y: 96, width: 396, height: 21}",
            "\t\t\t5 label States: of the union Frame: {x: 12, y: 167, width: 396, height: 17}",
        ].join("\n"),
    );

    assert.deepEqual(outline.elements[1], {
        index: 2,
        what: "text  Secondary Actions: activate",
        name: "text",
        value: "Tuan",
        frame: { x: 12, y: 12, width: 396, height: 34 },
        password: false,
        states: ["focused"],
    });
    assert.equal(outline.elements[2]!.what, "check box Shout Secondary Actions: click");
    assert.deepEqual(outline.elements[2]!.states, ["checked", "focused"]);
    // Words that are no states stay in the name.
    assert.equal(outline.elements[3]!.name, "label States: of the union");
    assert.equal(outline.elements[3]!.states, undefined);
    assert.equal(outline.snapshot, "7a6b3001");
    assert.equal(outline.windowId, "27702:6");
    assert.deepEqual(outline.otherWindows, [
        { id: "27702:9", title: "Help", app: "demo_app.py" },
        { id: "4242:6", title: 'Pi OCU Demo "2"', app: "python3" },
    ]);
    assert.equal(outline.cover, "partial");
    assert.deepEqual(outline.covered, [
        { x: 240, y: 90, width: 122, height: 173 },
        { x: 0, y: 0, width: 10, height: 10 },
    ]);

    const full = parseOutline('App=a\nWindow: "A", App: a.\nSnapshot: s1\nCovered: [{x: 0, y: 0, width: 420, height: 220}] (the whole window)\nScreenshot omitted: other windows cover the whole window. Bring it to the front, then read it again.');

    assert.equal(full.cover, "full");
    assert.equal(full.omitted, "Screenshot omitted: other windows cover the whole window. Bring it to the front, then read it again.");
    assert.equal(parseOutline('App=a\nWindow: "A", App: a.\nScreenshot omitted: the window is minimised. Restore it, then read it again.').cover, "minimized");
    assert.equal(parseOutline('App=a\nWindow: "A", App: a.\nCovered: unknown (the window stacking could not be read)').cover, "unknown");
    assert.equal(parseOutline('App=a\nWindow: "A", App: a.\nScreenshot omitted by include_screenshot=false').omitted, undefined);

    const refused = "Snapshot s1 of demo_app.py was replaced by s2.\nError: stale_ref retry=safe suggestion=Call get_app_state again and act on its element numbers and snapshot id.";

    assert.deepEqual(parseError(refused), { code: "stale_ref", retry: "safe", suggestion: "Call get_app_state again and act on its element numbers and snapshot id." });
    assert.equal(withoutErrorLine(refused), "Snapshot s1 of demo_app.py was replaced by s2.");
    assert.equal(parseError("input failed"), undefined);
});

const VIEWER = { label: "Viewer", name: "viewer" };
const NOTES = { label: "Notes", name: "notes" };

test("an element whose states changed (focus moved, a tick) is still the element Pi read", async () => {
    const { control, calls } = make();
    const session = await start(control);

    // Pi reads the name field [2] in focus; the owner then clicks into the password field.
    const { text } = await control.screen(session, "demo_app.py");

    assert.match(text, /2 text {2}Secondary Actions: activate States: focused/);
    control.takeOver(7, true);
    await control.input(7, { type: "tap", x: 100, y: 70 });
    control.takeOver(7, false);
    assert.doesNotMatch(control.outlineOf(session, DEMO)!.elements.find((each) => each.index === 2)!.what, /focused/);
    await control.act(session, undefined, { op: "set_value", index: 2, value: "Tuan" });
    assert.deepEqual(calls().at(-1), { tool: "set_value", args: { app: "demo_app.py", element_index: "2", value: "Tuan" } });
    // A tick shows as a state of the same element.
    const ticked = await control.act(session, undefined, { op: "click", index: 4 });

    assert.match(ticked.text, /4 check box Shout Secondary Actions: click States: checked/);
    assert.deepEqual(control.outlineOf(session, DEMO)!.elements.find((each) => each.index === 4)!.states, ["checked"]);
    await control.end("m1", "test over");
});

test("an action names the newest read of its app (the panel's too), and the window when its app has several", async () => {
    const { control, rawCalls } = make({ env: { FAKE_OCU_COVER: "1" } });
    const session = await start(control, { apps: [DEMO, VIEWER] });

    await control.screen(session, "demo_app.py");
    const pis = control.outlineOf(session, DEMO)!.snapshot;

    // The panel reads the window again: that read is ocu's newest, so the action names it (Pi's own read is no longer
    // ocu's latest), and pi-phone still checks [2] is what Pi read.
    await control.setTab(7, "demo_app.py");
    const newest = control.outlineOf(session, DEMO)!.snapshot;

    assert.ok(pis !== undefined && newest !== undefined && pis !== newest);
    await control.act(session, undefined, { op: "set_value", index: 2, value: "Tuan" });
    assert.deepEqual(rawCalls().at(-1), { tool: "set_value", args: { app: "demo_app.py", element_index: "2", value: "Tuan", snapshot_id: newest } });
    // Viewer's name matches two windows: the action names the one read.
    await control.screen(session, "viewer");
    await control.act(session, "viewer", { op: "click", index: 1 });
    assert.equal(rawCalls().at(-1)!.args.window_id, control.outlineOf(session, VIEWER)!.windowId);
    assert.match(String(rawCalls().at(-1)!.args.window_id), /^4242:\d+$/);
    // Reads name no snapshot.
    assert.ok(rawCalls().filter((each) => each.tool === "get_app_state").every((each) => each.args.snapshot_id === undefined));
    await control.end("m1", "test over");
});

test("ocu's stale_ref (the window changed under the read): Pi is told plainly to read it again, and nothing was done", async () => {
    const staleFile = join(root, `stale-${++made}`);
    const { control, calls } = make({ env: { FAKE_OCU_STALE: staleFile } });
    const session = await start(control);

    await control.screen(session, "demo_app.py");
    writeFileSync(staleFile, "");
    const refused = await control.act(session, undefined, { op: "click", index: 5 }).then(
        () => assert.fail("the click went through"),
        (error: Error) => error.message,
    );

    assert.equal(refused, "Pi OCU Demo changed since it was read (that element is no longer there as you read it, or its window was replaced): nothing was done. Read it again with computer_screen and use the new numbers.");
    assert.doesNotMatch((await control.screen(session, "demo_app.py")).text, /Hello/);
    assert.equal(calls().filter((each) => each.tool === "click").length, 1);
    await control.end("m1", "test over");
});

test("Pi's click at a point is refused before ocu (the real-mouse mode, PP-267); only the owner's Take over taps send headed", async () => {
    const { control, calls } = make();
    const session = await start(control);

    await control.screen(session, "demo_app.py");
    await assert.rejects(control.act(session, undefined, { op: "click", x: 200, y: 140 }), /Clicking a point \(200,140\) needs the real-mouse mode, which is not on yet \(PP-267\): click an element by its index/);
    assert.equal(calls().filter((each) => each.tool === "click").length, 0, "no click reached ocu");
    await control.act(session, undefined, { op: "click", index: 5 });
    assert.equal(calls().at(-1)!.args.headed, undefined);
    control.takeOver(7, true);
    await control.input(7, { type: "tap", x: 200, y: 140 });
    assert.equal(calls().at(-1)!.args.headed, true);
    await control.end("m1", "test over");
});

test("a covered window: black parts listed in the picture, the panel's note; a minimised one: ocu's reason, no picture", async () => {
    const { control } = make({ env: { FAKE_OCU_COVER: "1" } });
    const session = await start(control, { apps: [DEMO, VIEWER, NOTES] });

    assert.equal(control.panelOf("m1")!.cover, null);
    const shot = await control.picture(session, "viewer");

    assert.deepEqual(shot.covered, [{ x: 300, y: 0, width: 120, height: 80 }]);
    assert.equal(control.panelOf("m1")!.tab, "viewer");
    assert.equal(control.panelOf("m1")!.cover, "partial");
    await assert.rejects(control.picture(session, "notes"), /^Error: ocu sent no picture of Notes: Screenshot omitted: the window is minimised\. Restore it, then read it again\.$/);
    assert.equal(control.panelOf("m1")!.cover, "minimized");
    await control.setTab(7, "demo_app.py");
    assert.equal(control.panelOf("m1")!.cover, null);
    await control.end("m1", "test over");
});
