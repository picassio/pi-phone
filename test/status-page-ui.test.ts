// The app's failure screen in a real browser at a phone's width (android/app/src/main/assets/status.html, PP-198): the
// last error shows at the top, Copy log and Share log call the app (window.PiPhoneApp), the log box is scrolled to its
// end (the newest lines), and nothing is wider than the screen. A screen without a log has neither. With PHONE_SHOTS
// set to a folder, a screenshot goes there.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { pathToFileURL } from "node:url";
import type { Cdp } from "../src/server/browser/cdp.ts";
import { ChromeEngine } from "../src/server/browser/pi-browser.ts";
import { fatalText } from "../src/server/fatal.ts";

const chrome = ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"].find((name) => {
    try {
        execFileSync("which", [name], { stdio: "ignore" });

        return true;
    } catch {
        return false;
    }
});
const real = { skip: chrome === undefined ? "no Chrome on this machine" : false } as const;
const page = pathToFileURL(join(import.meta.dirname, "../android/app/src/main/assets/status.html")).href;

let engine: ChromeEngine;
let cdp: Cdp;

async function inPage<T>(expression: string): Promise<T> {
    const answer = await cdp.send<{ result: { value?: unknown }; exceptionDetails?: { exception?: { description?: string } } }>("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });

    if (answer.exceptionDetails !== undefined) {
        throw new Error(answer.exceptionDetails.exception?.description ?? "the page threw");
    }

    return answer.result.value as T;
}

/** Open the page as MainActivity does, then show `state`. */
async function open(state: Record<string, unknown>): Promise<void> {
    await cdp.send("Page.navigate", { url: page });
    await new Promise((resolve) => setTimeout(resolve, 300));
    await inPage(`show(${JSON.stringify(state)})`);
}

before(async () => {
    if (real.skip) {
        return;
    }

    engine = new ChromeEngine(chrome!, ["--no-sandbox", "--allow-file-access-from-files"]);
    cdp = await engine.connect(await engine.newTab());
    await cdp.send("Page.enable");
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    // The app's bridge, as MainActivity adds it.
    await cdp.send("Page.addScriptToEvaluateOnNewDocument", {
        source: "window.asked = []; window.PiPhoneApp = { copyLog: () => asked.push('copy'), shareLog: () => asked.push('share') };",
    });
});

after(async () => {
    cdp?.close();
    await engine?.close();
});

const labels = { lastError: "Last error", log: "End of the log", copy: "Copy log", share: "Share log" };

test("a runtime failure shows the last error on top, Copy and Share log, and the log's end", real, async () => {
    const lines = Array.from({ length: 400 }, (_, at) => `image guard: scaled 15 image(s) over 2000 px for anthropic/claude-opus-5-5 (${at})`);
    const crash = fatalText(new RangeError("WebAssembly.Memory(): could not allocate memory"), "uncaughtException");

    await open({ title: "The runtime failed", note: "java.io.IOException: server exited with code 1; see /data/user/0/io.piphone/files/log/server.log", log: `${lines.join("\n")}\n${crash}`, labels, failed: true });

    const seen = await inPage<{ error: string; errorTop: number; logTop: number; actionsTop: number; scrolled: number; width: number; buttons: string[] }>(`(() => {
        const box = (id) => document.getElementById(id).getBoundingClientRect();
        const log = document.getElementById("log");
        return {
            error: document.getElementById("error").innerText,
            errorTop: box("error").top,
            actionsTop: box("actions").top,
            logTop: box("log").top,
            scrolled: log.scrollHeight - log.clientHeight - log.scrollTop,
            width: document.documentElement.scrollWidth,
            buttons: [...document.querySelectorAll("#actions button")].map((each) => each.innerText),
        };
    })()`);

    assert.match(seen.error, /^FATAL .*\nRangeError: WebAssembly\.Memory\(\): could not allocate memory\n\s+at /);
    assert.ok(seen.errorTop < seen.actionsTop && seen.actionsTop < seen.logTop, `last error, then the buttons, then the log: ${JSON.stringify(seen)}`);
    assert.ok(seen.scrolled <= 1, `the log box shows its end: ${seen.scrolled} px left below`);
    assert.ok(seen.width <= 390, `nothing wider than the screen: ${seen.width}`);
    assert.deepEqual(seen.buttons, ["Copy log", "Share log"]);

    await inPage(`document.getElementById("copy").click(); document.getElementById("share").click();`);
    assert.deepEqual(await inPage<string[]>("asked"), ["copy", "share"]);

    if (process.env.PHONE_SHOTS !== undefined) {
        mkdirSync(process.env.PHONE_SHOTS, { recursive: true });
        const { data } = await cdp.send<{ data: string }>("Page.captureScreenshot", { format: "png" });

        writeFileSync(join(process.env.PHONE_SHOTS, "status-failure.png"), Buffer.from(data, "base64"));
    }
});

test("a failure without a log has no last error and no buttons; progress has neither", real, async () => {
    await open({ title: "The update failed", note: "java.io.IOException: no network\n\nThe version before it is still installed: close and open the app.", log: "", labels, failed: true });
    assert.deepEqual(await inPage<boolean[]>(`["error", "actions", "log"].map((id) => document.getElementById(id).hidden)`), [true, true, true]);

    await open({ title: "Starting the server…", note: "" });
    assert.deepEqual(await inPage<boolean[]>(`["error", "actions", "log", "spin"].map((id) => document.getElementById(id).hidden)`), [true, true, true, false]);
});
