// What pi-phone says and offers for folders on machines, Windows ones above all: Pi is told cmd //c, which Git Bash
// passes on as written (PP-101), and the folder picker offers to make a missing folder on a machine (PP-103).
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";
import { WINDOWS_SHELL } from "../src/server/extensions/prompt.ts";

// place.js names machines from the store; these checks need none of it.
registerHooks({
    resolve(specifier, context, next) {
        return specifier === "./store.js" && context.parentURL?.endsWith("/web/place.js")
            ? { url: `data:text/javascript,${encodeURIComponent("export const store = { state: {} };")}`, shortCircuit: true }
            : next(specifier, context);
    },
});

// @ts-expect-error: plain JS, no types.
const { missingFolder } = await import("../web/place.js");

test("Pi on a Windows machine is told cmd //c, never cmd /c, which Git Bash turns into C:/ (PP-101)", () => {
    assert.match(WINDOWS_SHELL, /cmd \/\/c/);
    assert.doesNotMatch(WINDOWS_SHELL, /cmd \/c\b/);
});

test("the folder picker offers to make a missing folder here or on a machine, and nothing else (PP-103)", () => {
    const here = { status: 404, message: "~/work/new isn't there." };
    const there = { status: 404, message: "There is no folder C:/Users/me/new on laptop." };

    assert.equal(missingFolder(here, "~/work/new"), true);
    assert.equal(missingFolder(here, "/data/new"), true);
    assert.equal(missingFolder(there, "machine:abc:C:/Users/me/new"), true);
    assert.equal(missingFolder({ status: 404, message: "There is no folder /srv/x on box." }, "machine:abc:/srv/x"), true);
    // Not a whole path, not missing, or a machine that does not answer: nothing to make.
    assert.equal(missingFolder(here, "work/new"), false);
    assert.equal(missingFolder({ status: 400, message: "C:/a.txt on laptop is a file, not a folder." }, "machine:abc:C:/a.txt"), false);
    assert.equal(missingFolder({ status: 502, message: "laptop does not answer: the machine is not reachable" }, "machine:abc:C:/x"), false);
});
