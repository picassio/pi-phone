// Pi's browser on a machine (src/server/browser/machine-engine.ts): the launch script finds the machine's Chrome and
// starts it with a DevTools port (once: a second start finds it running), the engine drives it through the forward,
// and it may open the machine's own addresses, as a dev server there. Here the machine is this computer (CI has
// Chrome), its "forward" the port itself, and its home a folder of the test's own.
import { cleanUp } from "./helpers.ts";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { launchScript, MachineEngine, stopScript } from "../src/server/browser/machine-engine.ts";
import { PiBrowser } from "../src/server/browser/pi-browser.ts";
import { addressOf } from "../src/server/browser/page.ts";

after(() => cleanUp());

const chrome = ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"].find((name) => {
    try {
        execFileSync("which", [name], { stdio: "ignore" });

        return true;
    } catch {
        return false;
    }
});

test("a dev server as typed is an address, with plain http", () => {
    assert.equal(addressOf("localhost:3000"), "http://localhost:3000/");
    assert.equal(addressOf("localhost:5173/app?x=1"), "http://localhost:5173/app?x=1");
    assert.equal(addressOf("10.0.0.5:8080"), "http://10.0.0.5:8080/");
    assert.equal(addressOf("local host"), "https://duckduckgo.com/?q=local%20host");
});

test("the launch script starts Chrome once and says where its DevTools are, or that there is none", () => {
    const script = launchScript();

    assert.match(script, /--remote-debugging-port=0/);
    assert.match(script, /chrome\.pid/);
    // Running when its DevTools answer, not by a pid (Git Bash on Windows cannot see one an earlier shell started); a
    // Chrome holding the profile otherwise is stopped by its command line, on Windows too.
    assert.match(script, /curl -sf -m 3 "http:\/\/127\.0\.0\.1:\$D\/json\/version"/);
    assert.match(script, /powershell\.exe -NoProfile -Command 'Get-CimInstance Win32_Process/);
    assert.match(script, /pkill -f -- "user-data-dir=\$P\/profile"/);
    assert.match(stopScript(), /pkill -f -- "user-data-dir=\$P\/profile"/);
    assert.match(script, /echo nochrome; exit 5/);
    assert.match(script, /No usable sandbox/);
});

test("a forward Chrome does not answer through is closed and said so, not a bare socket hang up (tualh-laptop, 2026-10-26)", async () => {
    // What Windows' sshd gave when it took `localhost` for ::1: the forward takes the connection, and drops it.
    const hangUp = createServer((request) => request.socket.destroy());

    await new Promise<void>((resolve) => hangUp.listen(0, "127.0.0.1", resolve));
    let closed = 0;
    const engine = new MachineEngine({
        name: "win-box",
        home: "/h",
        run: async () => ({ code: 0, out: "port 52395\n" }),
        writeFile: async () => {},
        forward: async () => ({ port: (hangUp.address() as { port: number }).port, close: () => (closed += 1) }),
    });

    try {
        await assert.rejects(engine.tabs(), /Chrome runs on win-box \(DevTools port 52395\), but it did not answer through the ssh forward/);
        assert.equal(closed, 1, "the broken forward is closed, so the next call opens a new one");
    } finally {
        hangUp.close();
    }
});

let server: Server;
let port = 0;

before(async () => {
    server = createServer((_request, response) => {
        response.writeHead(200, { "content-type": "text/html" });
        response.end(`<!doctype html><title>Dev server</title><p>Hello from the machine</p><label>Attachment <input type="file" onchange="document.querySelector('p').textContent='Got ' + this.files[0].name"></label>`);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as { port: number }).port;
});

after(() => server?.close());

test("on a machine: Chrome there opens its own dev server, takes uploads there, prints, and stops when closed", { skip: chrome === undefined ? "no Chrome on this machine (CI runs it)" : false }, async () => {
    const home = mkdtempSync(join(tmpdir(), "pi-machine-home-"));
    const run = (script: string): Promise<{ code: number; out: string }> =>
        new Promise((resolve) => {
            const child = spawn("sh", ["-c", script], { env: { ...process.env, HOME: home } });
            let out = "";

            child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString()));
            child.stderr.on("data", (chunk: Buffer) => (out += chunk.toString()));
            child.on("close", (code) => resolve({ code: code ?? 1, out }));
        });
    let forwarded = 0;
    const engine = new MachineEngine({
        name: "test-box",
        home,
        run,
        writeFile: async (path, bytes) => {
            mkdirSync(dirname(path), { recursive: true });
            writeFileSync(path, bytes);
        },
        forward: async (remote) => {
            forwarded += 1;

            return { port: remote, close: () => {} };
        },
    });
    const browser = new PiBrowser({ engine, place: "machine:test", where: "test-box", changed: () => {}, frame: () => {}, log: () => {} });

    try {
        const page = await browser.open(1, `http://127.0.0.1:${port}/`);

        assert.match(page, /^Dev server — http:\/\/127\.0\.0\.1:/, "the machine's own address opens");
        assert.equal(browser.state().where, "test-box");

        const uploaded = await browser.upload(1, Number(/\[(\d+)\] file "Attachment"/.exec(page)![1]), [{ name: "notes.txt", bytes: new TextEncoder().encode("hi") }]);

        assert.match(uploaded, /Got notes\.txt/);

        const { pdf } = await browser.pdf(1);

        assert.equal(pdf.subarray(0, 5).toString(), "%PDF-");

        // Started once: a second launch finds it running.
        const again = await run(launchScript());

        assert.equal(again.code, 0);
        assert.equal(Number(/^port (\d+)/m.exec(again.out)?.[1]), Number(readFileSync(join(home, ".pi/mobile/browser/profile/DevToolsActivePort"), "utf8").split("\n")[0]));
        assert.equal(forwarded, 1);

        // Its port file lost while it runs (as a failed start on Windows once left it): the next launch stops it and starts
        // another, which answers, instead of a second Chrome that cannot take the profile.
        const first = Number(/^port (\d+)/m.exec(again.out)?.[1]);

        rmSync(join(home, ".pi/mobile/browser/profile/DevToolsActivePort"));
        const relaunched = await run(launchScript());
        const second = Number(/^port (\d+)/m.exec(relaunched.out)?.[1]);

        assert.equal(relaunched.code, 0, relaunched.out);
        assert.ok(second > 0 && second !== first, `a new Chrome: ${relaunched.out}`);
        assert.equal((await run(`curl -sf -m 5 http://127.0.0.1:${second}/json/version >/dev/null && echo answers`)).out.trim(), "answers");
    } finally {
        await browser.close();
    }

    assert.equal((await run(`P="$HOME/.pi/mobile/browser"; [ -f "$P/chrome.pid" ] && echo running || echo stopped`)).out.trim(), "stopped");
});
