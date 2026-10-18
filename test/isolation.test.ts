// Tests run on the owner's phone too, in the app's own home: an app a test opens without a home of its own takes the
// real one, and writes there (an empty ~/.ssh/pi-phone_config, once, which broke `ssh <machine>` on the phone).
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

test("every app a test opens has a home of its own", () => {
    const folder = import.meta.dirname;

    for (const file of readdirSync(folder).filter((name) => name.endsWith(".ts"))) {
        const source = readFileSync(join(folder, file), "utf8");

        for (const match of source.matchAll(/PocketApp\.open\(\{([^]*?)\n\s*\}\)/g)) {
            assert.match(match[1]!, /\bhome\b/, `${file}: PocketApp.open without home`);
        }

        // A server process a test starts gets a HOME of its own in its environment.
        if (/src\/server\/main\.ts/.test(source)) {
            assert.match(source, /\bHOME: /, `${file}: starts the server without a HOME of its own`);
        }
    }
});
