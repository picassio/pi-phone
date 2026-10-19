import assert from "node:assert/strict";
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
