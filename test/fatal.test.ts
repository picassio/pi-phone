// The server's last words (src/server/fatal.ts, installed by main.ts): an exception nothing caught, or a start that
// failed, is written to the log with its stack under a FATAL line before the process exits with 1 (PP-198: a phone's
// "server exited with code 1" with the cause nowhere in view).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { fatalText } from "../src/server/fatal.ts";

const fatal = pathToFileURL(join(import.meta.dirname, "../src/server/fatal.ts")).href;

/** Run `body` as an ES module in a new Node after `installFatalLog()`: its exit code and what it wrote. */
const run = (body: string) => {
    const script = `import { installFatalLog } from ${JSON.stringify(fatal)};\ninstallFatalLog();\n${body}`;
    const ran = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", timeout: 60_000 });

    return { code: ran.status, out: `${ran.stdout}${ran.stderr}` };
};

test("an uncaught exception is logged with its stack under a FATAL line, and the process exits with 1", () => {
    const { code, out } = run(`setTimeout(() => { throw new Error("the Photon worker blew up", { cause: new RangeError("out of memory") }); }, 1);`);

    assert.equal(code, 1);
    assert.match(out, /^FATAL \d{4}-\d\d-\d\dT[\d:.]+Z: pi-phone stopped on an uncaught exception:$/m);
    assert.match(out, /Error: the Photon worker blew up\n\s+at /);
    assert.match(out, /Caused by: RangeError: out of memory/);
});

test("a start that fails (a top-level await rejected) is logged the same way", () => {
    const { code, out } = run(`await Promise.reject(new Error("cannot open the database"));`);

    assert.equal(code, 1);
    assert.match(out, /^FATAL .*: pi-phone stopped on an? (uncaught exception|unhandled rejection):$/m);
    assert.match(out, /Error: cannot open the database\n\s+at /);
});

test("the text for a value that is not an Error", () => {
    assert.equal(fatalText("plain", "uncaughtException", new Date(0)), "FATAL 1970-01-01T00:00:00.000Z: pi-phone stopped on an uncaught exception:\nplain\n");
});

test("the server installs it", () => {
    assert.match(readFileSync(join(import.meta.dirname, "../src/server/main.ts"), "utf8"), /^installFatalLog\(\);$/m);
});
