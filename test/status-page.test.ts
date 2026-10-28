// The app's failure screen (android/app/src/main/assets/status.html, shown by MainActivity): the log's last error is
// found for the top of the screen, a crash (a FATAL line from src/server/fatal.ts) before any other error, with the
// stack under it (PP-198: "server exited with code 1" with the error below the fold of a box showing the log's top).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { createContext, runInContext } from "node:vm";
import { fatalText } from "../src/server/fatal.ts";

const page = readFileSync(join(import.meta.dirname, "../android/app/src/main/assets/status.html"), "utf8");

/** The page's `lastError`, run as the page has it. */
const lastError = (() => {
    const script = /<\/main><script>([\s\S]*)<\/script>/.exec(page)![1]!;
    const context = createContext({ copy: {}, share: {}, window: {} });

    runInContext(script, context);

    return context.lastError as (log: string) => string;
})();

const crash = fatalText(new TypeError("Cannot read properties of undefined (reading 'data')"), "uncaughtException").replace(/\n$/, "");

test("a crash is the last error, with its stack, even with image guard lines and other errors after it", () => {
    const log = [
        "Pi Pocket is running.",
        "Unhandled rejection: Error: a tool failed",
        ...Array.from({ length: 40 }, () => "image guard: scaled 1/15 image(s) over 2000 px for anthropic/claude-opus-5-5"),
        crash,
        "Server error: Error: listen EADDRINUSE",
    ].join("\n");
    const found = lastError(log);

    assert.match(found, /^FATAL .*: pi-phone stopped on an uncaught exception:\nTypeError: Cannot read properties of undefined \(reading 'data'\)\n\s+at /);
    assert.ok(!found.includes("image guard"), found);
    assert.ok(!found.includes("EADDRINUSE"), "the crash, not what came after it");
});

test("without a crash, the last line that looks like an error, with what is indented under it", () => {
    const log = ["Error: the first", "image guard: scaled 2 image(s)", "Unhandled rejection: RangeError: WebAssembly.Memory(): could not allocate memory", "    at Photon.prepare (node.js:12:3)", "    at next (node.js:20:1)", "Pi Pocket is running."].join("\n");

    assert.equal(lastError(log), "Unhandled rejection: RangeError: WebAssembly.Memory(): could not allocate memory\n    at Photon.prepare (node.js:12:3)\n    at next (node.js:20:1)");
});

test("V8 running out of memory counts as a crash", () => {
    assert.match(lastError("Error: before\nFATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory\nimage guard: scaled 1 image(s)"), /^FATAL ERROR: Reached heap limit/);
});

test("a log with no error has none", () => {
    assert.equal(lastError("Pi Pocket is running.\nimage guard: scaled 15 image(s) over 2000 px for anthropic/claude-opus-5-5"), "");
});

test("the page has Copy log and Share log, and the log box scrolled to its end", () => {
    assert.match(page, /PiPhoneApp\.copyLog\(\)/);
    assert.match(page, /PiPhoneApp\.shareLog\(\)/);
    assert.match(page, /log\.scrollTop = log\.scrollHeight/);
});
