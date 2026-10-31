// Computer use (ocu) as a machine tool (PP-177): our fork's release, pinned to its SHA256SUMS, for Linux x64 and arm64
// and Windows x64; marked as needing a desktop session on Linux in every list; installed as the download itself with a
// wrapper named ocu. And which ticked tools a machine just connected installs (`toolsToInstall`).
import assert from "node:assert/strict";
import { test } from "node:test";
import { installScript, OCU_TOOL, type ToolStatus, TOOLS, toolOffer, toolsToInstall } from "../src/server/machine-tools.ts";

test("ocu is a machine tool: the fork's v1.1.2-pp.3 builds (snapshot ids, states, covered windows, headed) with the release's sums, needing a desktop session", () => {
    const ocu = TOOLS.find((tool) => tool.id === "ocu");

    assert.equal(ocu, OCU_TOOL);
    assert.equal(ocu?.command, "ocu");
    assert.equal(ocu?.version, "1.1.2-pp.3");
    assert.deepEqual(Object.keys(ocu!.assets).sort(), ["linux-arm64", "linux-x64", "windows-x64"]);
    assert.deepEqual(
        Object.fromEntries(Object.entries(ocu!.assets).map(([target, asset]) => [target, asset!.sha256])),
        {
            "linux-x64": "fcadd7212dab95dab3f825ad5a78cc4b2caf328dee6468dfd60095d91410c0bf",
            "linux-arm64": "a385a5d38586a73f4a0d53a825b9eefedfa0cb7830c493ff2887b7a388891370",
            "windows-x64": "d36fe1017a79ed2226ddf5bdf09ab51a91e31f1398933eb44f3a3be5a6ecf42f",
        },
    );

    for (const asset of Object.values(ocu!.assets)) {
        assert.match(asset!.url, /^https:\/\/github\.com\/picassio\/open-computer-use\/releases\/download\/v1\.1\.2-pp\.3\/open-computer-use-/);
    }

    assert.equal(toolOffer(ocu!).desktop, true);
    assert.equal(toolOffer(TOOLS.find((tool) => tool.id === "rg")!).desktop, false);
});

test("ocu installs as the download itself, checked, with a wrapper named ocu that answers its version", () => {
    const script = installScript(OCU_TOOL, OCU_TOOL.assets["linux-x64"]!, "/home/me");

    assert.match(script, /fetch 'https:\/\/github\.com\/picassio\/open-computer-use\/releases\/download\/v1\.1\.2-pp\.3\/open-computer-use-linux-x64'/);
    assert.match(script, /fcadd7212dab95dab3f825ad5a78cc4b2caf328dee6468dfd60095d91410c0bf/);
    assert.match(script, /cp "\$tmp\/download" "\$T\/ocu\/1\.1\.2-pp\.3"\/ocu/);
    assert.match(script, /exec '\/home\/me\/\.pi\/mobile\/tools\/ocu\/1\.1\.2-pp\.3\/ocu' "\$@"/);
    assert.match(script, /"\$T\/bin\/ocu" --version/);

    const windows = installScript(OCU_TOOL, OCU_TOOL.assets["windows-x64"]!, "C:/Users/me", true);

    assert.match(windows, /cp "\$tmp\/download" "\$T\/ocu\/1\.1\.2-pp\.3"\/ocu\.exe/);
});

test("a machine just connected installs the ticked tools it offers; an id that is no tool is refused", () => {
    const status = (id: string, offered: boolean): ToolStatus => ({ id, name: id, version: "1", description: "", size: "", desktop: false, optIn: false, supported: true, offered });
    const statuses = [status("officecli", true), status("rg", false), status("fd", true), status("ocu", true)];

    assert.deepEqual(toolsToInstall(statuses, ["ocu", "rg", "officecli"]), ["officecli", "ocu"]);
    assert.deepEqual(toolsToInstall(statuses, []), []);
    assert.throws(() => toolsToInstall(statuses, ["ocu", "nope"]), /No tool nope/);
});
