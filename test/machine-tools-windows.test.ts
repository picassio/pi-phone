// Tools on a Windows machine (machine-tools.ts): its own builds, checked by sha256; a .zip unpacked with unzip; the
// program keeps its .exe; the wrapper Git Bash runs execs it by its drive path. Checked by hand on a Windows 11 machine
// (fd 10.5.0, 2026-10-19); the scripts run there, not in this test.
import assert from "node:assert/strict";
import { test } from "node:test";
import { installScript, TOOLS } from "../src/server/machine-tools.ts";

const tool = (id: string) => TOOLS.find((each) => each.id === id)!;

test("each tool has Windows builds, x64 and arm64, with their sums", () => {
    for (const id of ["officecli", "rg", "fd"]) {
        for (const target of ["windows-x64", "windows-arm64"] as const) {
            const asset = tool(id).assets[target];

            assert.ok(asset, `${id} ${target}`);
            assert.match(asset.sha256, /^[0-9a-f]{64}$/);
        }
    }
});

test("a Windows tool from a .zip is unpacked with unzip, keeps its .exe, and its wrapper runs that", () => {
    const fd = tool("fd");
    const script = installScript(fd, fd.assets["windows-x64"]!, "C:/Users/me", true);

    assert.match(script, /unzip -p "\$tmp\/download" 'fd-v10\.5\.0-x86_64-pc-windows-msvc\/fd\.exe' > "\$T\/fd\/10\.5\.0"\/fd\.exe/);
    assert.match(script, /chmod 755 "\$T\/fd\/10\.5\.0"\/fd\.exe/);
    assert.match(script, /exec 'C:\/Users\/me\/\.pi\/mobile\/tools\/fd\/10\.5\.0\/fd\.exe' "\$@"/);
    assert.doesNotMatch(script, /tar -xzf "\$tmp\/download"/);
});

test("a Windows tool that is the download itself keeps its .exe; other systems' scripts are as before", () => {
    const officecli = tool("officecli");
    const windows = installScript(officecli, officecli.assets["windows-x64"]!, "C:/Users/me", true);

    assert.match(windows, /cp "\$tmp\/download" "\$T\/officecli\/1\.0\.157"\/officecli\.exe/);

    const rg = tool("rg");
    const linux = installScript(rg, rg.assets["linux-x64"]!, "/home/me");

    assert.match(linux, /tar -xzf "\$tmp\/download" -C "\$tmp"/);
    assert.match(linux, /exec '\/home\/me\/\.pi\/mobile\/tools\/rg\/15\.2\.0\/rg' "\$@"/);
    assert.doesNotMatch(linux, /\.exe/);
});
