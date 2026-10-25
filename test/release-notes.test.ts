import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { releaseNotes } from "../scripts/release-notes.ts";

test("release notes group the commits as their prefixes say, with the comparison", () => {
    const notes = releaseNotes(
        [
            { sha: "c3", subject: "fix(machines): a Windows machine's terminal through Windows' own sshd" },
            { sha: "c2", subject: "feat(people): Signed in now: the owner sees every open tab" },
            { sha: "c1", subject: "docs: release notes" },
            { sha: "c0", subject: "Merge branch 'x'" },
        ],
        { repo: "picassio/pi-phone", sha: "c3", previous: "build-104" },
    );

    assert.equal(
        notes,
        [
            "## New",
            "",
            "- **people:** Signed in now: the owner sees every open tab",
            "",
            "## Fixes",
            "",
            "- **machines:** A Windows machine's terminal through Windows' own sshd",
            "",
            "## Other changes",
            "",
            "- Release notes",
            "",
            "All changes since build-104: https://github.com/picassio/pi-phone/compare/build-104...c3",
            "",
        ].join("\n"),
    );
    assert.match(releaseNotes([], { repo: "a/b", sha: "c9" }), /^No changes since the previous release\.\n\nCommit c9\.\n$/);
});

test("a commit with a Thanks: trailer credits them on its line, from git's own log", () => {
    const notes = releaseNotes(
        [{ sha: "c4", subject: "feat(assistant): pi-phone is the phone's assistant", thanks: "@yichan002, #3" }],
        { repo: "picassio/pi-phone", sha: "c4" },
    );

    assert.match(notes, /^## New\n\n- \*\*assistant:\*\* Pi-phone is the phone's assistant \(thanks @yichan002, #3\)\n/);

    // The trailer as the release job reads it: a commit in a scratch repository, through the script.
    const repo = mkdtempSync(join(tmpdir(), "notes-"));
    const git = (...args: string[]) => execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", ...args], { encoding: "utf8" });

    git("init", "-q");
    git("commit", "-q", "--allow-empty", "-m", "feat(assistant): the side key's sheet\n\nThe sheet.\n\nThanks: @yichan002, #3");
    git("commit", "-q", "--allow-empty", "-m", "fix(web): a plain one");

    const out = execFileSync("node", [join(import.meta.dirname, "../scripts/release-notes.ts"), "a/b", "HEAD"], { cwd: repo, encoding: "utf8", env: { ...process.env, PATH: process.env.PATH ?? "", GH_TOKEN: "" } });

    assert.match(out, /- \*\*assistant:\*\* The side key's sheet \(thanks @yichan002, #3\)/);
    assert.match(out, /- \*\*web:\*\* A plain one\n/);
});
