// Pi's browser as a window on a machine (PP-274, the setting browser.machineMode): the launch script starts the
// machine's Chrome without --headless, with flags that keep a covered window drawing, in the desktop the machine's setup
// line names; it refuses without a display, and with only the headless shell. On Windows it starts Chrome in the signed-in
// desktop session through a one-shot scheduled task (sshd's session 0 has no screen), and says so when nobody is signed
// in or the screen is locked. macOS waits. A person's input in the window, which Pi did not send, shows in the panel.
import { cleanUp } from "./helpers.ts";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { LAUNCH_EXIT, launchScript, MachineEngine, WINDOW_FLAGS, WINDOWS_BROWSER_TASK } from "../src/server/browser/machine-engine.ts";
import { PiBrowser } from "../src/server/browser/pi-browser.ts";
import { FakeCdp } from "./support/fake-cdp.ts";

const fakes: FakeCdp[] = [];

after(async () => {
    for (const fake of fakes) {
        await fake.close();
    }

    cleanUp();
});

/**
 * A machine of the test's own: a home, and a PATH of the tools the launch script uses with a stand-in Chrome (it writes
 * the arguments it got and a DevTools port file, then waits), or the headless shell only.
 */
function machine(chrome: "chrome" | "shell"): { home: string; path: string; args: () => string } {
    const home = mkdtempSync(join(tmpdir(), "pi-window-home-"));
    const bin = join(home, "bin");
    const log = join(home, "chrome-args");

    mkdirSync(bin);

    for (const tool of ["sh", "printf", "mkdir", "head", "sleep", "kill", "rm", "find", "cat", "tail", "grep", "pkill", "id", "setsid", "tr", "dirname"]) {
        try {
            symlinkSync(execFileSync("sh", ["-c", `command -v ${tool}`]).toString().trim(), join(bin, tool));
        } catch {
            // Not on this computer: the script copes (setsid), or the test says what is missing.
        }
    }

    const fake = [
        `#!${join(bin, "sh")}`,
        `for a in "$@"; do echo "$a"; done > ${JSON.stringify(log)}`,
        'for a in "$@"; do case "$a" in --user-data-dir=*) D="${a#--user-data-dir=}";; esac; done',
        '{ echo 9333; echo /devtools/browser/x; } > "$D/DevToolsActivePort"',
        // Waits as Chrome does, under its own command line (stopped by it, as Chrome is).
        "i=0; while [ $i -lt 60 ]; do sleep 0.5; i=$((i+1)); done",
    ].join("\n");

    if (chrome === "chrome") {
        writeFileSync(join(bin, "google-chrome"), fake);
        chmodSync(join(bin, "google-chrome"), 0o755);
    } else {
        const shell = join(home, ".pi/mobile/tools/chrome/150/files/linux64/chrome-headless-shell");

        mkdirSync(join(shell, ".."), { recursive: true });
        writeFileSync(shell, fake);
        chmodSync(shell, 0o755);
    }

    return { home, path: bin, args: () => readFileSync(log, "utf8") };
}

const run = (script: string, home: string, path: string, env: Record<string, string> = {}): Promise<{ code: number; out: string }> =>
    new Promise((resolve) => {
        const child = spawn(join(path, "sh"), ["-c", script], { env: { HOME: home, PATH: path, ...env } });
        let out = "";

        child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString()));
        child.stderr.on("data", (chunk: Buffer) => (out += chunk.toString()));
        child.on("close", (code) => resolve({ code: code ?? 1, out }));
    });

test("window mode starts the machine's Chrome without --headless, with flags that keep a covered window drawing, in the desktop its setup line names", async () => {
    const box = machine("chrome");

    try {
        const started = await run(launchScript({ mode: "window", prepare: "export DISPLAY=:99" }), box.home, box.path);

        assert.equal(started.code, 0, started.out);
        assert.match(started.out, /^port 9333$/m);

        const args = box.args().split("\n");

        assert.ok(!args.some((each) => each.startsWith("--headless")), "no --headless");
        assert.ok(!args.includes("--disable-gpu"), "a window keeps its GPU");

        for (const flag of WINDOW_FLAGS.split(" ")) {
            assert.ok(args.includes(flag), `${flag} given`);
        }

        assert.ok(args.includes(`--user-data-dir=${box.home}/.pi/mobile/browser/profile`), "the same separate profile");
        assert.equal(readFileSync(join(box.home, ".pi/mobile/browser/mode"), "utf8").trim(), "window");
    } finally {
        await run("pkill -f -- \"$HOME/.pi/mobile/browser/profile\"; true", box.home, box.path);
    }
});

test("headless stays the default: --headless=new, and no window flags", () => {
    const script = launchScript();

    assert.match(script, /H="--headless=new --disable-gpu"/);
    assert.ok(!script.includes(WINDOW_FLAGS));
    assert.match(launchScript({ mode: "window" }), new RegExp(`H="${WINDOW_FLAGS}"`));
});

test("window mode refuses without a display, and with only the headless shell, saying what to do", async () => {
    const noDisplay = machine("chrome");
    const refused = await run(launchScript({ mode: "window" }), noDisplay.home, noDisplay.path);

    assert.equal(refused.code, LAUNCH_EXIT.noDisplay, refused.out);
    assert.match(refused.out, /^nodisplay$/m);

    const shell = machine("shell");
    const shellOnly = await run(launchScript({ mode: "window", prepare: "export DISPLAY=:99" }), shell.home, shell.path);

    assert.equal(shellOnly.code, LAUNCH_EXIT.shellOnly, shellOnly.out);

    const said = async (code: number, options: { platform?: string } = {}) => {
        const engine = new MachineEngine(
            { name: "sandbox", home: "/h", run: async () => ({ code, out: "" }), writeFile: async () => {}, forward: async () => ({ port: 1, close: () => {} }) },
            { mode: () => "window", ...options },
        );

        return engine.tabs().then(
            () => "",
            (error: Error) => error.message,
        );
    };

    assert.match(await said(LAUNCH_EXIT.noDisplay), /sandbox has no display for Pi's browser's window: give its desktop setup line in Menu › Computer control/);
    assert.match(await said(LAUNCH_EXIT.shellOnly), /only the headless Chrome .* cannot show a window: install Google Chrome, Chromium or Edge there/);

    // macOS: refused before anything runs there.
    let ran = 0;
    const mac = new MachineEngine(
        { name: "mac", home: "/Users/me", run: async () => ((ran += 1), { code: 0, out: "port 1" }), writeFile: async () => {}, forward: async () => ({ port: 1, close: () => {} }) },
        { mode: () => "window", platform: "darwin" },
    );

    await assert.rejects(mac.tabs(), /as a window on macOS is not built yet/);
    assert.equal(ran, 0);
});

/**
 * A Windows machine for the launch script (as `support/fake-windows.ts` stands in for computer control's): its
 * PowerShell, decoded from `-EncodedCommand`, is checked, and the machine answers as its desktop stands.
 */
function windowsMachine(cdp: FakeCdp, state: { loggedOn: boolean; locked: boolean }) {
    const seen: { script: string; powershell: string }[] = [];

    return {
        seen,
        access: {
            name: "tualh-laptop",
            home: "C:/Users/Picassio",
            run: async (script: string) => {
                const encoded = /-EncodedCommand (\S+)/.exec(script)?.[1];
                const powershell = encoded === undefined ? "" : Buffer.from(encoded, "base64").toString("utf16le");

                seen.push({ script, powershell });

                if (!state.loggedOn) {
                    return { code: LAUNCH_EXIT.notLoggedOn, out: "notloggedon\n" };
                }

                if (state.locked) {
                    return { code: LAUNCH_EXIT.locked, out: "locked\n" };
                }

                return { code: 0, out: `port ${cdp.port}\n` };
            },
            writeFile: async () => {},
            forward: async (port: number) => ({ port, close: () => {} }),
        },
    };
}

test("on Windows, window mode starts Chrome in the signed-in desktop session through a one-shot task as the user (no password, not elevated), removed once it runs", async () => {
    const script = launchScript({ mode: "window", windows: true });
    const encoded = /-EncodedCommand (\S+)/.exec(script)?.[1];

    assert.ok(encoded, "the PowerShell goes encoded, through Git Bash");

    const powershell = Buffer.from(encoded, "base64").toString("utf16le");

    assert.match(powershell, new RegExp(`Register-ScheduledTask -TaskName '${WINDOWS_BROWSER_TASK}'`));
    assert.match(powershell, /New-ScheduledTaskPrincipal -UserId \$user -LogonType Interactive -RunLevel Limited/);
    assert.match(powershell, /Start-ScheduledTask/);
    assert.match(powershell, new RegExp(`finally \\{\\n  Unregister-ScheduledTask -TaskName '${WINDOWS_BROWSER_TASK}' -Confirm:\\$false`));
    assert.ok(!/Password|Highest|SYSTEM/.test(powershell), "no password, not elevated, never SYSTEM");
    assert.match(powershell, /exit 21 \}/);
    assert.match(powershell, /LogonUI .* exit 23 \}/);
    assert.match(script, new RegExp(`PI_FLAGS="${WINDOW_FLAGS}"`));
    assert.match(script, /cygpath -w "\$P\/profile"/);
    // Not started by Git Bash itself, which runs in session 0.
    assert.ok(!script.includes('"$C" $H $F'), "no Chrome started from the ssh session");

    const cdp = new FakeCdp();

    fakes.push(cdp);
    await cdp.listen();
    const state = { loggedOn: false, locked: false };
    const laptop = windowsMachine(cdp, state);
    const engine = new MachineEngine(laptop.access, { mode: () => "window", platform: "windows" });

    await assert.rejects(engine.tabs(), /Nobody is signed in to tualh-laptop's desktop, so Pi's browser cannot open a window there/);
    state.loggedOn = true;
    state.locked = true;
    await assert.rejects(engine.tabs(), /tualh-laptop's screen is locked/);
    state.locked = false;

    const browser = new PiBrowser({ engine, place: "machine:w1", where: "tualh-laptop", changed: () => {}, frame: () => {}, log: () => {} });

    assert.match(await browser.open(1, "https://example.com/"), /example\.com/);
    assert.match(laptop.seen.at(-1)!.powershell, /Register-ScheduledTask/);
    assert.equal(engine.visibleOn, "tualh-laptop", "a window someone at the machine may use");
    await browser.close();
});

test("someone's input in the window on the machine, which Pi did not send, shows in the panel and Pi hears it once; Pi's own does not count", async () => {
    const cdp = new FakeCdp();

    fakes.push(cdp);
    await cdp.listen();
    const engine = new MachineEngine(
        { name: "sandbox", home: "/h", run: async () => ({ code: 0, out: `port ${cdp.port}\n` }), writeFile: async () => {}, forward: async (port) => ({ port, close: () => {} }) },
        { mode: () => "window", platform: "linux" },
    );
    const browser = new PiBrowser({ engine, place: "machine:m1", where: "sandbox", changed: () => {}, frame: () => {}, log: () => {} });

    await browser.open(1, "https://example.com/");

    const tab = [...cdp.targets.keys()][0]!;

    assert.ok(cdp.commands.some((each) => each.method === "Runtime.addBinding" && each.params.name === "__piPhoneInput"), "the page's input is watched");

    // Right after Pi's action: its own input, not someone's.
    cdp.emit(tab, "Runtime.bindingCalled", { name: "__piPhoneInput", payload: "pointerdown", executionContextId: 1 });
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(browser.state().windowInUse, false);

    await new Promise((resolve) => setTimeout(resolve, 1600));
    cdp.emit(tab, "Runtime.bindingCalled", { name: "__piPhoneInput", payload: "keydown", executionContextId: 1 });
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(browser.state().windowInUse, true);
    assert.match(await browser.snapshot(1), /^Someone is using this browser's window on sandbox \(input Pi did not send, just now\)/);
    assert.doesNotMatch(await browser.snapshot(1), /Someone is using/, "told once");
    await browser.close();
    assert.equal(browser.state().windowInUse, false);
});
