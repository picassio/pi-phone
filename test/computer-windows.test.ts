// Computer control on Windows (PP-179), with a stand-in Windows machine and bridge (`test/support/fake-windows.ts`) and
// the stand-in ocu behind it: the task is registered as the user, run only while they are signed in, with no password;
// the bridge listens on 127.0.0.1 with a token only the user can read; a session speaks ocu's MCP and shows the sign
// through the bridge's connection, over the app's forward, with every check of Linux's; a machine says whether it is
// ready, not set up, or not logged on; Pi's setup waits for the owner's card; Linux runs as before.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { ComputerControl, type ComputerControlOptions, type ComputerMachine } from "../src/server/computer-control.ts";
import {
    BRIDGE,
    connectScript,
    describeWindowsState,
    installScript,
    parseWindowsState,
    registerCommands,
    removeScript,
    statusScript,
    taskPlan,
    WINDOWS_TASK,
    windowsStateWord,
} from "../src/server/computer-windows.ts";
import { type FakeWindows, fakeWindows } from "./support/fake-windows.ts";

const FAKE = join(import.meta.dirname, "support", "fake-ocu.ts");
const root = mkdtempSync(join(tmpdir(), "pi-phone-computer-windows-"));
const controls: ComputerControl[] = [];
const machines: FakeWindows[] = [];
let made = 0;

after(async () => {
    for (const control of controls) {
        control.close();
    }

    await new Promise((resolve) => setTimeout(resolve, 300));

    for (const machine of machines) {
        await machine.close();
    }

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

const LAPTOP: ComputerMachine = { id: "w1", name: "tualh-laptop", platform: "windows", connected: true, tools: { ocu: "1.1.2-pp.2" }, user: "Picassio" };

/** The script PowerShell runs: `-EncodedCommand`'s UTF-16LE base64, decoded. */
const powershellOf = (script: string) => Buffer.from(/-EncodedCommand (\S+)/.exec(script)![1]!, "base64").toString("utf16le");

async function make(options: { sign?: string } = {}) {
    const ocuLog = join(root, `ocu-${++made}.log`);
    const windows = await fakeWindows({ ocuLog, ...(options.sign === undefined ? {} : { sign: options.sign }) });
    const lines: string[] = [];
    const control = new ComputerControl({
        dataDir: mkdtempSync(join(root, "data-")),
        gateway: false,
        machines: () => [LAPTOP],
        launch: windows.launch,
        run: windows.run,
        writeFile: windows.writeFile,
        forward: windows.forward,
        idleEndMs: 60_000,
        refreshMs: 60_000,
        log: (line) => lines.push(line),
    });
    // What ocu got, without the newest read's snapshot_id every action names (PP-270, computer-control.test.ts).
    const calls = () =>
        existsSync(ocuLog)
            ? readFileSync(ocuLog, "utf8")
                  .trim()
                  .split("\n")
                  .filter(Boolean)
                  .map((line) => {
                      const { tool, args } = JSON.parse(line) as { tool: string; args: Record<string, unknown> };
                      const { snapshot_id: _, ...rest } = args;

                      return { tool, args: rest };
                  })
            : [];

    controls.push(control);
    machines.push(windows);

    return { control, windows, calls, lines };
}

const DEMO = { label: "Pi OCU Demo", name: "demo_app.py" };
const start = (control: ComputerControl) =>
    control.start({ machine: "w1", machineName: "tualh-laptop", conversationId: 7, session: 7, approvedBy: "owner", apps: [DEMO], follow: false, reason: "greet", minutes: 15 });

test("the task: as the user, only while they are signed in, no password, never SYSTEM or elevated; at logon and on demand; on battery, with no time limit", () => {
    const register = registerCommands();

    assert.match(register, /New-ScheduledTaskPrincipal -UserId \$user -LogonType Interactive -RunLevel Limited/);
    assert.match(register, /\$user = \[System\.Security\.Principal\.WindowsIdentity\]::GetCurrent\(\)\.Name/);
    assert.match(register, /New-ScheduledTaskTrigger -AtLogOn -User \$user/);
    assert.match(register, /-AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit \(\[TimeSpan\]::Zero\) -MultipleInstances IgnoreNew/);
    assert.match(register, new RegExp(`Register-ScheduledTask -TaskName '${WINDOWS_TASK}' `));
    assert.match(register, /conhost\.exe'\) -Argument \('--headless "\{0\}" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "\{1\}" -Tools "\{2\}"'/);

    for (const never of [/-Password/i, /SYSTEM'/, /Highest/, /ServiceAccount/, /New-NetFirewall/i, /Set-ExecutionPolicy/i]) {
        assert.doesNotMatch(register, never);
    }

    // The install script: bridge.ps1 in ~/.pi/mobile/computer (written first), then the registration, then the state.
    const install = installScript();

    assert.match(install, /^# pi-phone-computer install\n/);
    assert.match(install, /D="\$HOME\/\.pi\/mobile\/computer"\nif \[ ! -s "\$D\/bridge\.ps1" \]; then echo "pi-phone's bridge\.ps1 is not in \$D: nothing was registered\."; exit 8; fi/);
    assert.match(install, /export PI_COMPUTER="\$\(cygpath -w "\$D"\)" PI_TOOLS="\$\(cygpath -w "\$HOME\/\.pi\/mobile\/tools"\)"/);
    assert.ok(powershellOf(install).includes(register));
    assert.match(powershellOf(install), /Start-ScheduledTask -TaskName 'pi-phone ocu'/);
    // Removing: the task, its bridge by its command line, and that folder alone.
    const remove = powershellOf(removeScript());

    assert.match(remove, /Unregister-ScheduledTask -TaskName 'pi-phone ocu' -Confirm:\$false/);
    assert.match(remove, /if \(\$dir -notlike '\*\\\.pi\\mobile\\computer'\) \{ throw/);
    assert.match(remove, /\$_\.CommandLine -like '\*\\\.pi\\mobile\\computer\\bridge\.ps1\*'/);
    // The card says what is made, for whom, and the registration whole.
    const plan = taskPlan("tualh-laptop", "Picassio", "install");

    assert.match(plan, /^On tualh-laptop, for Picassio \(no password: it runs only while Picassio is signed in, never as SYSTEM or elevated\):/);
    assert.match(plan, /listens on 127\.0\.0\.1 only, with a new random token in ~\/\.pi\/mobile\/computer\/bridge\.json that only Picassio can read/);
    assert.ok(plan.endsWith(register));
    assert.match(taskPlan("tualh-laptop", "Picassio", "remove"), /remove pi-phone's computer control:\n- the scheduled task "pi-phone ocu"/);
});

test("the bridge: 127.0.0.1 only, a new random token in a file only the user may read, a wrong token refused; ASCII, as Windows PowerShell reads it", () => {
    assert.ok(/^[\x09\x0a\x0d\x20-\x7e]*$/.test(BRIDGE), "bridge.ps1 is ASCII only");
    assert.match(BRIDGE, /New-Object System\.Net\.Sockets\.TcpListener\(\[System\.Net\.IPAddress\]::Loopback, 0\)/);
    assert.doesNotMatch(BRIDGE, /IPAddress\]::Any|0\.0\.0\.0/);
    assert.match(BRIDGE, /RandomNumberGenerator\]::Create\(\)\.GetBytes\(\$bytes\)/);
    assert.match(BRIDGE, /\$acl\.SetAccessRuleProtection\(\$true, \$false\)\n\$me = \[System\.Security\.Principal\.WindowsIdentity\]::GetCurrent\(\)\.User\n\$acl\.AddAccessRule\(\(New-Object System\.Security\.AccessControl\.FileSystemAccessRule\(\$me, 'FullControl', 'Allow'\)\)\)/);
    // The token goes into the file, never into the log.
    assert.doesNotMatch(BRIDGE, /Say[^\n]*\$Token/);
    assert.match(BRIDGE, /if \(\$diff -ne 0\) \{ Say 'refused a connection with a wrong token'; Send 'no wrong token'; return \}/);
    // ocu: the machine tool's, by a version that is only a version.
    assert.match(BRIDGE, /\$version -notmatch '\^\[0-9A-Za-z\]\[0-9A-Za-z\.\\-\]\*\$'/);
    assert.match(BRIDGE, /\$exe = Join-Path \$Tools \('ocu\\' \+ \$version \+ '\\ocu\.exe'\)/);
    // The sign: topmost, never taking the focus, named pi-phone (so ocu's list shows it as pi-phone's own).
    assert.match(BRIDGE, /Text = "pi-phone";[\s\S]*TopMost = true;[\s\S]*ShowWithoutActivation \{ get \{ return true; \} \}/);
    // Each run answers ok before its own lines (the sign's ready and stop), as connectBridge waits for it.
    assert.match(BRIDGE, /if \(\$hello\.run -eq 'mcp'\) \{[^]*?\$process = \[System\.Diagnostics\.Process\]::Start\(\$info\)[^]*?Send 'ok'[^]*?return\n        \}/);
    assert.match(BRIDGE, /if \(\$hello\.run -eq 'sign'\) \{[^]*?Send 'ok'[^]*?\[System\.Windows\.Forms\.Application\]::Run\(\$form\)/);
    // The connect script prints the token on its last line only, and starts the task when the user is signed in.
    const connect = powershellOf(connectScript());

    assert.match(connect, /if \(-not \$task\) \{ exit 20 \}\nif \(\$sessions\.Count -eq 0\) \{ exit 21 \}/);
    assert.match(connect, /Start-ScheduledTask -TaskName 'pi-phone ocu'/);
    assert.match(connect, /Write-Output \('bridge ' \+ \$s\.port \+ ' ' \+ \$s\.token\)$/);
    assert.match(powershellOf(statusScript()), /Write-Output \('state ' \+ \(ConvertTo-Json @\{ task = \[bool\]\$task; loggedOn = \$sessions\.Count -gt 0; locked = \[bool\]\$locked; running = \[bool\]\(Alive\); crd = \$\(if \(-not \$crdProduct\) \{ 'not installed' \} elseif \(\$crdService -and \[string\]\$crdService\.Status -eq 'Running' -and \$crdConfig\) \{ 'connected' \} else \{ 'installed, not connected' \}\) \} -Compress\)\)$/);
});

test("a machine is ready, not set up, or not logged on; without a signed-in desktop the bridge cannot run, and starting says so", async () => {
    const { control, windows } = await make();

    windows.state = { task: false, loggedOn: true, locked: false, running: false };
    assert.equal(windowsStateWord(await control.windowsState("tualh-laptop")), "not set up");
    await assert.rejects(control.apps("w1"), /not set up: pi-phone's task "pi-phone ocu" is not on tualh-laptop \(computer_control setup with task: "install"/);

    windows.state = { task: true, loggedOn: false, locked: false, running: false };
    assert.equal(windowsStateWord(await control.windowsState("w1")), "not logged on");
    await assert.rejects(control.apps("w1"), /not logged on: nobody is signed in to tualh-laptop's desktop, so pi-phone's task \(and ocu with it\) cannot run there/);

    windows.state = { task: true, loggedOn: true, locked: true, running: false };
    const state = await control.windowsState("w1");

    assert.equal(windowsStateWord(state), "ready");
    assert.match(describeWindowsState("tualh-laptop", state), /^ready \(the task starts when a session does\); its screen is locked/);
    assert.deepEqual(parseWindowsState('noise\nstate {"task":true,"loggedOn":true,"locked":false,"running":true,"crd":"connected"}\n'), { task: true, loggedOn: true, locked: false, running: true, crd: "connected" });
    assert.throws(() => parseWindowsState("Get-ScheduledTask : Access is denied"), /did not say how it stands: Get-ScheduledTask : Access is denied/);
    // No desktop setup line on Windows: ocu runs in the desktop already.
    assert.throws(() => control.setPrepare("w1", ". ~/env.sh"), /A desktop setup line is for Linux/);
});

test("a Windows session: ocu's MCP and the sign through the bridge, over the forward, with the token; every check as on Linux; the end closes them", async () => {
    const { control, windows, calls, lines } = await make();
    const apps = await control.apps("w1");

    assert.ok(apps.some((app) => app.name === "demo_app.py"));
    assert.ok(apps.find((app) => app.name === "1password")?.never === "a password manager or authenticator");
    await eventually(() => windows.open() === 0, "the listing's connection to close");
    assert.equal(windows.forwards.closed, 1, "its forward closes after its last connection");

    const session = await start(control);

    assert.deepEqual(
        windows.hellos.slice(-2).map((each) => each.run),
        ["sign", "mcp"],
    );
    assert.match(String(windows.hellos.at(-2)?.text), /^Pi is using this computer until \d\d:\d\d \(pi-phone\)$/);
    assert.equal(windows.hellos.at(-1)?.ocu, "1.1.2-pp.2");
    assert.equal(windows.open(), 2);
    assert.ok(windows.forwards.opened.every((port) => port === windows.port()));

    const read = await control.screen(session, "Pi OCU Demo");

    assert.match(read.text, /3 password text \[password\]/);
    await control.act(session, undefined, { op: "set_value", index: 2, value: "Tuan" });
    assert.deepEqual(calls().at(-1), { tool: "set_value", args: { app: "demo_app.py", element_index: "2", value: "Tuan" } });
    // Pi's guards hold: plain text into a password field, and an app outside the card.
    await assert.rejects(control.act(session, undefined, { op: "set_value", index: 3, value: "hunter2" }), /password field: Pi never types a password as text/);
    assert.throws(() => control.app(session, "1Password"), /is not in this session/);
    assert.ok(!calls().some((each) => each.args.value === "hunter2"));
    // What the owner types on a computer_sign_in card goes through the bridge too, into the field Pi named, and stays
    // out of what Pi reads.
    await control.screen(session, "Pi OCU Demo");
    await control.fill(session, "Pi OCU Demo", [{ name: "password", index: 3, value: "owner-secret-1" }]);
    assert.deepEqual(calls().at(-1), { tool: "set_value", args: { app: "demo_app.py", element_index: "3", value: "owner-secret-1", allow_password_input: true } });
    assert.ok(!(await control.screen(session, "Pi OCU Demo")).text.includes("owner-secret-1"));
    // The token reached the bridge alone: never a script, the log, or what Pi reads; nothing went through ssh's own shell.
    assert.ok(!windows.scripts.some((each) => each.script.includes(windows.token)));
    assert.ok(!lines.some((line) => line.includes(windows.token)));

    await control.end("w1", "Pi stopped it");
    await eventually(() => windows.open() === 0, "the session's connections to close");
    await eventually(() => windows.forwards.closed === 2, "the session's forward to close");
});

test("Stop on the Windows sign ends the session; a wrong token is refused", async () => {
    const stopped = await make({ sign: "stop" });

    // Stop may come while ocu still starts: then start says so, and it is stopped all the same.
    await start(stopped.control).catch((error: Error) => assert.match(error.message, /Stop was pressed on tualh-laptop as the session started/));
    await eventually(() => stopped.control.view().length === 0, "Stop to end it");
    assert.match(stopped.control.noSession("w1"), /Stop on the computer/);
    await eventually(() => stopped.windows.open() === 0, "its connections to close");

    const wrong = await make();

    wrong.windows.bridgeToken = "b".repeat(64);
    await assert.rejects(start(wrong.control), /pi-phone's bridge on tualh-laptop: it refused: wrong token/);
    assert.equal(wrong.control.view().length, 0);
});

test("Pi's setup makes or removes the task only after the owner's card, which shows what changes", async () => {
    const { control, windows } = await make();
    const asked: { tool: string; subject: string; reason: string }[] = [];

    windows.state = { task: false, loggedOn: true, locked: false, running: false };
    const denied = await control.setupTask("tualh-laptop", "install", "", async (request) => {
        asked.push(request);

        return { allow: false, by: "Tuan" };
    });

    assert.equal(denied, "Tuan said no: nothing changed on tualh-laptop.");
    assert.equal(asked[0]?.subject, taskPlan("tualh-laptop", "Picassio", "install"));
    assert.ok(!windows.scripts.some((each) => each.kind === "install"), "nothing ran before the yes");

    const made = await control.setupTask("tualh-laptop", "install", "", async () => ({ allow: true, by: "Tuan" }));

    assert.match(made, /^pi-phone's task is on tualh-laptop\. It is ready\.$/);
    assert.equal(windows.files.get(".pi/mobile/computer/bridge.ps1"), BRIDGE, "bridge.ps1 was written before the task was registered");

    const removed = await control.setupTask("tualh-laptop", "remove", "", async (request) => {
        asked.push(request);

        return { allow: true, by: "Tuan" };
    });

    assert.match(asked.at(-1)?.subject ?? "", /remove pi-phone's computer control/);
    assert.match(removed, /are gone from tualh-laptop \(ocu stays installed\)/);
    assert.equal(windows.state.task, false);
    // Linux machines have no task.
    const linux = new ComputerControl({ dataDir: mkdtempSync(join(root, "data-")), gateway: false, machines: () => [{ id: "m1", name: "box", platform: "linux", connected: true, tools: { ocu: "1" } }], launch: windows.launch });

    controls.push(linux);
    await assert.rejects(linux.setupTask("box", "install", "", async () => ({ allow: true, by: "x" })), /box is not a Windows machine/);
});

test("Linux as before: ocu and the sign over ssh's stdio, with the desktop setup line; never the bridge or a forward", async () => {
    const ocuLog = join(root, "linux.log");
    const scripts: string[] = [];
    let forwarded = 0;
    const launch: ComputerControlOptions["launch"] = (_machine, script) => {
        scripts.push(script);

        return spawn(process.execPath, [FAKE, script.includes("python3 -c") ? "sign" : "mcp"], { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, FAKE_OCU_LOG: ocuLog } });
    };
    const control = new ComputerControl({
        dataDir: mkdtempSync(join(root, "data-")),
        gateway: false,
        machines: () => [{ id: "m1", name: "sandbox", platform: "linux", connected: true, tools: { ocu: "1.1.2-pp.2" } }],
        launch,
        forward: async () => {
            forwarded += 1;

            throw new Error("not on Linux");
        },
        idleEndMs: 60_000,
        refreshMs: 60_000,
    });

    controls.push(control);
    control.setPrepare("m1", ". ~/tmp/ocu/env.sh");
    const session = await control.start({ machine: "m1", machineName: "sandbox", conversationId: 3, session: 3, approvedBy: "owner", apps: [DEMO], follow: false, reason: "", minutes: 5 });

    await control.screen(session, "Pi OCU Demo");
    assert.equal(forwarded, 0);
    assert.ok(!scripts.some((each) => each.startsWith("# pi-phone-computer")));
    assert.match(scripts.at(-1)!, /\n\. ~\/tmp\/ocu\/env\.sh\nexec "\$HOME\/\.pi\/mobile\/tools\/bin\/ocu" mcp$/);
    assert.match(scripts.at(-2)!, /exec python3 -c 'import sys, gi/);
    await assert.rejects(control.windowsState("m1"), /sandbox is not a Windows machine/);
    await control.end("m1", "done");
});
