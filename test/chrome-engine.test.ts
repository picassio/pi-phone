// Starting Chrome for Pi's browser (`ChromeEngine`, Build APK #347): Chrome makes its DevToolsActivePort before it writes
// it, and a read in between found it empty, which was taken for port 0 and sent to port 80 ("The browser answered
// /json/new?about:blank with no JSON"); the port is taken only once it is all there. And a Chrome nobody closed (a test
// that failed before its cleanup) never keeps its process running: npm test waited 28 minutes on one. A stand-in Chrome
// (`support/fake-chrome.ts`) writes its port late, as Chrome does on a busy computer.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { activePort, ChromeEngine } from "../src/server/browser/pi-browser.ts";

const dir = mkdtempSync(join(tmpdir(), "pi-chrome-engine-"));
const pidFile = join(dir, "chrome.pid");
/** The stand-in Chrome as a program: a shell script that runs it with this Node. */
const chrome = join(dir, "chrome");

writeFileSync(chrome, `#!${execFileSync("sh", ["-c", "command -v sh"]).toString().trim()}\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(join(import.meta.dirname, "support", "fake-chrome.ts"))} "$@"\n`);
chmodSync(chrome, 0o755);
process.env.FAKE_CHROME_PIDFILE = pidFile;

const alive = (pid: number) => {
    try {
        process.kill(pid, 0);

        return true;
    } catch {
        return false;
    }
};

after(() => {
    try {
        process.kill(Number(readFileSync(pidFile, "utf8")), "SIGKILL");
    } catch {
        // Gone already, as it should be.
    }

    rmSync(dir, { recursive: true, force: true });
});

test("a DevToolsActivePort is read only once it is all there: empty, a port without its newline, or no port is none yet", () => {
    const file = join(dir, "DevToolsActivePort");

    assert.equal(activePort(join(dir, "missing")), undefined);
    writeFileSync(file, "");
    assert.equal(activePort(file), undefined, "made, not yet written");
    writeFileSync(file, "4123");
    assert.equal(activePort(file), undefined, "its line not ended yet");
    writeFileSync(file, "0\n/devtools/browser/x\n");
    assert.equal(activePort(file), undefined);
    writeFileSync(file, "70000\n");
    assert.equal(activePort(file), undefined);
    writeFileSync(file, "41237\n/devtools/browser/x\n");
    assert.equal(activePort(file), 41237);
});

test("a Chrome that writes its port late is reached at that port, never at port 0 (Build APK #347)", async () => {
    const engine = new ChromeEngine(chrome);

    try {
        assert.equal(await engine.newTab(), "fake-tab");
        assert.deepEqual(await engine.tabs(), []);
    } finally {
        await engine.close();
    }
});

test("a process that never closes its Chrome still ends, and its Chrome with it (Build APK #347)", async () => {
    rmSync(pidFile, { force: true });

    // Its port written at once: the start works, and only the Chrome left running could keep the process.
    const child = spawn(process.execPath, [join(import.meta.dirname, "support", "leave-chrome.ts"), chrome], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, FAKE_CHROME_WRITE_MS: "0" } });
    let said = "";

    child.stdout.on("data", (chunk: Buffer) => (said += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (said += chunk.toString()));

    const code = await new Promise<number | string>((resolve) => {
        const timer = setTimeout(() => {
            child.kill("SIGKILL");
            resolve("still running after 15 s");
        }, 15_000);

        child.once("exit", (exitCode) => {
            clearTimeout(timer);
            resolve(exitCode ?? -1);
        });
    });

    assert.equal(code, 0, said);
    assert.match(said, /^tab fake-tab$/m);

    const pid = Number(readFileSync(pidFile, "utf8"));
    const until = Date.now() + 5000;

    while (alive(pid) && Date.now() < until) {
        await new Promise((resolve) => setTimeout(resolve, 50));
    }

    assert.equal(alive(pid), false, "its Chrome ended with it");
});
