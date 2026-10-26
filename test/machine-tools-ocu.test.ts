// Computer use (ocu) as a machine tool (PP-177): our fork's release, pinned to its SHA256SUMS, for Linux x64 and arm64
// and Windows x64; marked as needing a desktop session on Linux in every list; installed as the download itself with a
// wrapper named ocu. And which ticked tools a machine just connected installs (`toolsToInstall`).
import assert from "node:assert/strict";
import { test } from "node:test";
import { installScript, OCU_TOOL, type ToolStatus, TOOLS, toolOffer, toolsToInstall } from "../src/server/machine-tools.ts";

test("ocu is a machine tool: the fork's v1.1.2-pp.1 builds with the release's sums, needing a desktop session", () => {
    const ocu = TOOLS.find((tool) => tool.id === "ocu");

    assert.equal(ocu, OCU_TOOL);
    assert.equal(ocu?.command, "ocu");
    assert.equal(ocu?.version, "1.1.2-pp.1");
    assert.deepEqual(Object.keys(ocu!.assets).sort(), ["linux-arm64", "linux-x64", "windows-x64"]);
    assert.deepEqual(
        Object.fromEntries(Object.entries(ocu!.assets).map(([target, asset]) => [target, asset!.sha256])),
        {
            "linux-x64": "baeeee2694eb9d7745bdff040416ce25bd82540ba6cc16d7f17b6b111eedd311",
            "linux-arm64": "0ab801f327839d4713ef356a2544217bbd1ce7a5fd7b2efad1b34212a78d2a88",
            "windows-x64": "601980f7cc0a6259aff3ae32cde3a3b6e0946db5382e7f4c028bae1dd2231d18",
        },
    );

    for (const asset of Object.values(ocu!.assets)) {
        assert.match(asset!.url, /^https:\/\/github\.com\/picassio\/open-computer-use\/releases\/download\/v1\.1\.2-pp\.1\/open-computer-use-/);
    }

    assert.equal(toolOffer(ocu!).desktop, true);
    assert.equal(toolOffer(TOOLS.find((tool) => tool.id === "rg")!).desktop, false);
});

test("ocu installs as the download itself, checked, with a wrapper named ocu that answers its version", () => {
    const script = installScript(OCU_TOOL, OCU_TOOL.assets["linux-x64"]!, "/home/me");

    assert.match(script, /fetch 'https:\/\/github\.com\/picassio\/open-computer-use\/releases\/download\/v1\.1\.2-pp\.1\/open-computer-use-linux-x64'/);
    assert.match(script, /baeeee2694eb9d7745bdff040416ce25bd82540ba6cc16d7f17b6b111eedd311/);
    assert.match(script, /cp "\$tmp\/download" "\$T\/ocu\/1\.1\.2-pp\.1"\/ocu/);
    assert.match(script, /exec '\/home\/me\/\.pi\/mobile\/tools\/ocu\/1\.1\.2-pp\.1\/ocu' "\$@"/);
    assert.match(script, /"\$T\/bin\/ocu" --version/);

    const windows = installScript(OCU_TOOL, OCU_TOOL.assets["windows-x64"]!, "C:/Users/me", true);

    assert.match(windows, /cp "\$tmp\/download" "\$T\/ocu\/1\.1\.2-pp\.1"\/ocu\.exe/);
});

test("a machine just connected installs the ticked tools it offers; an id that is no tool is refused", () => {
    const status = (id: string, offered: boolean): ToolStatus => ({ id, name: id, version: "1", description: "", size: "", desktop: false, supported: true, offered });
    const statuses = [status("officecli", true), status("rg", false), status("fd", true), status("ocu", true)];

    assert.deepEqual(toolsToInstall(statuses, ["ocu", "rg", "officecli"]), ["officecli", "ocu"]);
    assert.deepEqual(toolsToInstall(statuses, []), []);
    assert.throws(() => toolsToInstall(statuses, ["ocu", "nope"]), /No tool nope/);
});
