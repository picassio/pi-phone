// Computer use (ocu) as a machine tool (PP-177): our fork's release, pinned to its SHA256SUMS, for Linux x64 and arm64
// and Windows x64; marked as needing a desktop session on Linux in every list; installed as the download itself with a
// wrapper named ocu. And which ticked tools a machine just connected installs (`toolsToInstall`).
import assert from "node:assert/strict";
import { test } from "node:test";
import { installScript, OCU_TOOL, type ToolStatus, TOOLS, toolOffer, toolsToInstall } from "../src/server/machine-tools.ts";

test("ocu is a machine tool: the fork's v1.1.2-pp.2 builds (allow_password_input per call) with the release's sums, needing a desktop session", () => {
    const ocu = TOOLS.find((tool) => tool.id === "ocu");

    assert.equal(ocu, OCU_TOOL);
    assert.equal(ocu?.command, "ocu");
    assert.equal(ocu?.version, "1.1.2-pp.2");
    assert.deepEqual(Object.keys(ocu!.assets).sort(), ["linux-arm64", "linux-x64", "windows-x64"]);
    assert.deepEqual(
        Object.fromEntries(Object.entries(ocu!.assets).map(([target, asset]) => [target, asset!.sha256])),
        {
            "linux-x64": "a1550551f64e5fd4fb68501dc6edca977519c888ec8d5e5d7742fcd93902eb70",
            "linux-arm64": "4bd5f231a1416445db2eaf383c641fe773d65b46e0fa7b86b838e1a7723b6d5c",
            "windows-x64": "abfda45584dbde65b5b4dfce115f3bde619ebdd17dc2ecb3dee98b100f57e960",
        },
    );

    for (const asset of Object.values(ocu!.assets)) {
        assert.match(asset!.url, /^https:\/\/github\.com\/picassio\/open-computer-use\/releases\/download\/v1\.1\.2-pp\.2\/open-computer-use-/);
    }

    assert.equal(toolOffer(ocu!).desktop, true);
    assert.equal(toolOffer(TOOLS.find((tool) => tool.id === "rg")!).desktop, false);
});

test("ocu installs as the download itself, checked, with a wrapper named ocu that answers its version", () => {
    const script = installScript(OCU_TOOL, OCU_TOOL.assets["linux-x64"]!, "/home/me");

    assert.match(script, /fetch 'https:\/\/github\.com\/picassio\/open-computer-use\/releases\/download\/v1\.1\.2-pp\.2\/open-computer-use-linux-x64'/);
    assert.match(script, /a1550551f64e5fd4fb68501dc6edca977519c888ec8d5e5d7742fcd93902eb70/);
    assert.match(script, /cp "\$tmp\/download" "\$T\/ocu\/1\.1\.2-pp\.2"\/ocu/);
    assert.match(script, /exec '\/home\/me\/\.pi\/mobile\/tools\/ocu\/1\.1\.2-pp\.2\/ocu' "\$@"/);
    assert.match(script, /"\$T\/bin\/ocu" --version/);

    const windows = installScript(OCU_TOOL, OCU_TOOL.assets["windows-x64"]!, "C:/Users/me", true);

    assert.match(windows, /cp "\$tmp\/download" "\$T\/ocu\/1\.1\.2-pp\.2"\/ocu\.exe/);
});

test("a machine just connected installs the ticked tools it offers; an id that is no tool is refused", () => {
    const status = (id: string, offered: boolean): ToolStatus => ({ id, name: id, version: "1", description: "", size: "", desktop: false, supported: true, offered });
    const statuses = [status("officecli", true), status("rg", false), status("fd", true), status("ocu", true)];

    assert.deepEqual(toolsToInstall(statuses, ["ocu", "rg", "officecli"]), ["officecli", "ocu"]);
    assert.deepEqual(toolsToInstall(statuses, []), []);
    assert.throws(() => toolsToInstall(statuses, ["ocu", "nope"]), /No tool nope/);
});
