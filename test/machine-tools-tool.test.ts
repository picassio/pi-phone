// Pi's machine_tools (PP-325) against a stand-in machine: status reads the tools as Settings › Machines does and names
// the updates; install, update and remove show the owner one card first (the machine, the tools, versions from and to,
// sizes); Deny runs nothing; Approve runs the very script Settings › Machines runs (`installScript`), on Linux and
// Windows; a failure says which step; a guest is refused before any card. And the scripts themselves, run here with
// sh: a wrong sum names its step, a right one answers the version line, and removing takes only pi-phone's wrapper.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import createMachines from "../src/server/extensions/machines.ts";
import type { ApprovalRequest } from "../src/server/host.ts";
import {
    installScript,
    MachineTools,
    OCU_TOOL,
    outdatedTools,
    removeScript,
    statusScript,
    type ToolSpec,
    TOOLS,
} from "../src/server/machine-tools.ts";
import type { Machine } from "../src/server/machines.ts";
import type { Places } from "../src/server/places.ts";
import { fakeCrd } from "./support/fake-crd.ts";

const tool = (id: string) => TOOLS.find((each) => each.id === id)!;

/**
 * A stand-in machine: what its status script answers (`seen`, by tool id: "installed <version>", "own <path>"), every
 * script it is given (`ran`), and how an install script ends (`installs`: exit code and output).
 */
function standIn(options: { platform?: "linux" | "windows"; arch?: "x64" | "arm64"; seen?: Record<string, string>; role?: string; allow?: boolean; installs?: { code: number; out: string } }) {
    const platform = options.platform ?? "linux";
    const home = platform === "windows" ? "C:/Users/me" : "/home/ubuntu";
    const seen: Record<string, string> = { ...(options.seen ?? {}) };
    const ran: { command: string | string[]; script: string }[] = [];
    const recorded: Record<string, string>[] = [];
    const cards: ApprovalRequest[] = [];
    const machine = (): Machine =>
        ({
            id: "m1",
            name: "tuanlh-devbox-01",
            user: "ubuntu",
            host: "192.168.1.61",
            remote: { platform, arch: options.arch ?? "x64", home },
            tools: recorded.at(-1) ?? Object.fromEntries(Object.entries(seen).filter(([, state]) => state.startsWith("installed ")).map(([id, state]) => [id, state.split(" ")[1]!])),
        }) as unknown as Machine;
    const places = {
        env: () => ({
            exec: async (command: string | string[], run: { onOutput: (text: string) => void }) => {
                const script = Array.isArray(command) ? command[2]! : command;

                ran.push({ command, script });

                if (script === statusScript(TOOLS)) {
                    run.onOutput(TOOLS.filter((each) => each.installer === undefined).map((each) => `${each.id} ${seen[each.id] ?? "none"}`).join("\n"));

                    return { ok: true, value: { exitCode: 0 } };
                }

                const installed = /^# pi-phone-tool (\S+) (\S+)$/m.exec(script);

                if (installed !== null) {
                    const outcome = options.installs ?? { code: 0, out: `${installed[1]} ${installed[2]}\n` };

                    if (outcome.code === 0) {
                        seen[installed[1]!] = `installed ${installed[2]}`;
                    }

                    run.onOutput(outcome.out);

                    return { ok: true, value: { exitCode: outcome.code } };
                }

                const removed = /^echo '(\S+) removed'$/m.exec(script);

                if (removed !== null) {
                    delete seen[removed[1]!];
                    run.onOutput(`${removed[1]} removed\n`);

                    return { ok: true, value: { exitCode: 0 } };
                }

                throw new Error(`An unexpected script: ${script.slice(0, 200)}`);
            },
        }),
    } as unknown as Places;
    const crd = fakeCrd();
    const machineTools = new MachineTools(places, machine, (_id, tools) => recorded.push(tools), TOOLS, crd.run);
    const host = {
        requesterOf: () => "p1",
        person: () => ({ role: options.role ?? "owner" }),
        machines: () => [{ id: "m1", name: "tuanlh-devbox-01", alias: "tuanlh-devbox-01", address: "ubuntu@192.168.1.61", home, windows: platform === "windows", askRun: false }],
        machineStore: { get: () => machine(), list: () => [machine()] },
        machineTools,
        approvals: {
            request: async (card: ApprovalRequest) => {
                cards.push(card);

                return { allow: options.allow ?? true, by: "Owner" };
            },
        },
    };
    const extension = createMachines(host as never);
    const machineToolsTool = extension.tools!.find((each) => each.name === "machine_tools")!;
    let call = 0;
    const run = async (args: Record<string, unknown>) => {
        const result = (await machineToolsTool.execute(args as never, { conversationId: 1, taskId: "t", callId: `c${++call}` } as never, {} as never)) as {
            output: { text: string }[];
            isError?: boolean;
        };

        return { text: result.output.map((part) => part.text).join(""), error: result.isError === true };
    };
    /** The scripts run besides reading the tools. */
    const changes = () => ran.filter((each) => each.script !== statusScript(TOOLS));

    return { run, cards, ran, changes, recorded, home, machine, crd };
}

test("status shows each tool as Settings › Machines does, and names the update to offer", async () => {
    const machine = standIn({ seen: { ocu: "installed 1.1.2-pp.2", officecli: "installed 1.0.157", rg: "own /usr/bin/rg" } });
    const { text, error } = await machine.run({ action: "status" });

    assert.equal(error, false, text);
    assert.match(text, /^tuanlh-devbox-01 \(linux x64\):/);
    assert.match(text, /- ocu \(Computer use \(ocu\)\): installed, 1\.1\.2-pp\.2; 1\.1\.2-pp\.3 available \(update\)/);
    assert.match(text, /- officecli \(OfficeCLI\): installed, 1\.0\.157 \(current\)/);
    assert.match(text, /- rg \(ripgrep \(rg\)\): the machine's own \(\/usr\/bin\/rg\), not installed by pi-phone/);
    assert.match(text, /- ffmpeg \(ffmpeg\): not installed; 9\.0\.2, about 350 MB/);
    assert.match(text, /- crd \(Chrome Remote Desktop\): for Windows x64 only, for now/);
    assert.match(text, /Updates: ocu 1\.1\.2-pp\.2 → 1\.1\.2-pp\.3 on tuanlh-devbox-01\. Offer them to the owner/);
    assert.equal(machine.cards.length, 0, "status asks nothing");
    assert.deepEqual(machine.changes(), [], "status changes nothing");
    assert.deepEqual(outdatedTools(machine.machine()), [{ id: "ocu", name: "Computer use (ocu)", installed: "1.1.2-pp.2", version: "1.1.2-pp.3" }]);
});

test("update shows one card with the machine, versions from and to, and the size; Deny runs nothing", async () => {
    const machine = standIn({ seen: { ocu: "installed 1.1.2-pp.2" }, allow: false });
    const { text, error } = await machine.run({ action: "update", machine: "tuanlh-devbox-01", tools: ["ocu"], reason: "ocu is behind" });

    assert.equal(error, true);
    assert.match(text, /Owner said no: nothing changed on tuanlh-devbox-01/);
    assert.equal(machine.cards.length, 1);
    assert.equal(machine.cards[0]!.tool, "machine_tools");
    assert.equal(machine.cards[0]!.reason, "ocu is behind");
    assert.equal(machine.cards[0]!.subject, "Update on tuanlh-devbox-01: ocu 1.1.2-pp.2 → 1.1.2-pp.3 (about 2.5 MB)");
    assert.deepEqual(machine.cards[0]!.form, {
        type: "machine-tools",
        machine: "m1",
        machineName: "tuanlh-devbox-01",
        platform: "linux x64",
        action: "update",
        tools: [{ id: "ocu", name: "Computer use (ocu)", from: "1.1.2-pp.2", to: "1.1.2-pp.3", size: "about 2.5 MB" }],
    });
    assert.deepEqual(machine.changes(), [], "nothing ran on a no");
});

test("Approve runs the same script as Settings › Machines and says the version line; update without tools takes every update", async () => {
    const machine = standIn({ seen: { ocu: "installed 1.1.2-pp.2", officecli: "installed 1.0.157" } });
    const { text, error } = await machine.run({ action: "update", machine: "tuanlh-devbox-01" });

    assert.equal(error, false, text);
    assert.equal(machine.cards.length, 1);
    assert.deepEqual(
        (machine.cards[0]!.form as { tools: { id: string }[] }).tools.map((each) => each.id),
        ["ocu"],
    );
    assert.deepEqual(
        machine.changes().map((each) => each.command),
        [["sh", "-c", installScript(OCU_TOOL, OCU_TOOL.assets["linux-x64"]!, "/home/ubuntu", false)]],
    );
    assert.match(text, /Computer use \(ocu\): 1\.1\.2-pp\.3 installed; it says: ocu 1\.1\.2-pp\.3/);
    assert.match(text, /Settings › Machines now shows: ocu: installed, 1\.1\.2-pp\.3 \(current\)/);
    assert.equal(machine.recorded.at(-1)?.ocu, "1.1.2-pp.3", "the machine's record, as Settings › Machines and the prompt read it");

    const again = await machine.run({ action: "update", machine: "tuanlh-devbox-01" });

    assert.match(again.text, /is current: nothing to update/);
    assert.equal(machine.cards.length, 1, "no card when there is nothing to do");
});

test("on Windows the script is Settings' Windows one, run as a command line for Git Bash", async () => {
    const machine = standIn({ platform: "windows" });
    const { text, error } = await machine.run({ action: "install", machine: "tuanlh-devbox-01", tools: ["fd"] });

    assert.equal(error, false, text);
    assert.deepEqual(
        machine.changes().map((each) => each.command),
        [installScript(tool("fd"), tool("fd").assets["windows-x64"]!, "C:/Users/me", true)],
    );
    assert.equal((machine.cards[0]!.form as { platform: string }).platform, "windows x64");
    assert.match(text, /fd: 10\.5\.0 installed/);
});

test("Chrome Remote Desktop on Windows installs and removes by its own installer, each after a card", async () => {
    const machine = standIn({ platform: "windows" });
    const installed = await machine.run({ action: "install", machine: "tuanlh-devbox-01", tools: ["crd"] });

    assert.equal(installed.error, false, installed.text);
    assert.deepEqual((machine.cards[0]!.form as { tools: unknown[] }).tools, [{ id: "crd", name: "Chrome Remote Desktop", to: "Google's current (signed by Google LLC)", size: "about 25 MB" }]);
    assert.match(installed.text, /Chrome Remote Desktop: 154\.0\.8037\.40 installed/);
    assert.equal(machine.crd.calls.filter((each) => each.kind === "install").length, 1);

    const removed = await machine.run({ action: "remove", machine: "tuanlh-devbox-01", tools: ["crd"] });

    assert.equal(removed.error, false, removed.text);
    assert.equal(machine.cards.length, 2);
    assert.match(removed.text, /Chrome Remote Desktop: removed\./);
    assert.equal(machine.crd.state.installed, false);
});

test("install puts a tool's needs on the card, marked; a tool without a build or one already current is left out by name", async () => {
    const machine = standIn({ seen: { ocu: "installed 1.1.2-pp.3" }, allow: false });

    await machine.run({ action: "install", machine: "tuanlh-devbox-01", tools: ["hyperframes"] });
    assert.deepEqual(
        (machine.cards[0]!.form as { tools: { id: string; needed?: boolean }[] }).tools.map((each) => [each.id, each.needed === true]),
        [["chrome", true], ["ffmpeg", true], ["hyperframes", false]],
    );

    const none = await machine.run({ action: "install", machine: "tuanlh-devbox-01", tools: ["crd", "ocu"] });

    assert.equal(none.error, true);
    assert.match(none.text, /Nothing to install on tuanlh-devbox-01: Chrome Remote Desktop has no build for tuanlh-devbox-01 \(linux x64\): it is for Windows x64 only, for now\. Computer use \(ocu\) 1\.1\.2-pp\.3 is installed there already/);
    assert.equal(machine.cards.length, 1, "no card for nothing");

    const unknown = await machine.run({ action: "install", machine: "tuanlh-devbox-01", tools: ["nope"] });

    assert.match(unknown.text, /No tool nope\. The tools are officecli, rg, fd/);
});

test("remove takes only what pi-phone installed, after the card; the machine's own is left alone", async () => {
    const machine = standIn({ seen: { ocu: "installed 1.1.2-pp.3", rg: "own /usr/bin/rg" } });
    const { text, error } = await machine.run({ action: "remove", machine: "tuanlh-devbox-01", tools: ["ocu", "rg"] });

    assert.equal(error, false, text);
    assert.deepEqual((machine.cards[0]!.form as { tools: unknown[] }).tools, [{ id: "ocu", name: "Computer use (ocu)", from: "1.1.2-pp.3", size: "about 2.5 MB" }]);
    assert.deepEqual(machine.changes().map((each) => each.script), [removeScript(OCU_TOOL)]);
    assert.match(text, /Computer use \(ocu\): removed\./);
    assert.match(text, /Left out: ripgrep \(rg\) there is the machine's own \(\/usr\/bin\/rg\), not pi-phone's: left alone\./);
    assert.match(text, /ocu: not installed; 1\.1\.2-pp\.3/);
});

test("a failed install says which step failed, as an error", async () => {
    const machine = standIn({
        seen: { ocu: "installed 1.1.2-pp.2" },
        installs: { code: 4, out: "The download's sha256 is abc, not fcad: nothing was installed.\nFailed while checking the sha256 of https://x/ocu (exit 4).\n" },
    });
    const { text, error } = await machine.run({ action: "update", machine: "tuanlh-devbox-01", tools: ["ocu"] });

    assert.equal(error, true);
    assert.match(text, /Computer use \(ocu\): failed\. The download's sha256 is abc.*\nFailed while checking the sha256 of https:\/\/x\/ocu \(exit 4\)\./s);
});

test("only the owner: a guest is refused before any card, and nothing runs", async () => {
    const machine = standIn({ role: "guest", seen: { ocu: "installed 1.1.2-pp.2" } });

    for (const action of ["status", "update"]) {
        const { text, error } = await machine.run({ action, machine: "tuanlh-devbox-01" });

        assert.equal(error, true);
        assert.match(text, /Only the owner/);
    }

    assert.equal(machine.cards.length, 0);
    assert.deepEqual(machine.ran, []);
});

// The scripts themselves, run here by sh with a file:// download (curl reads it as it would a release's address).
const work = mkdtempSync(join(tmpdir(), "pi-phone-machine-tools-tool-"));

after(() => rmSync(work, { recursive: true, force: true }));

const curl = spawnSync("curl", ["--version"]).status === 0;

test("installScript names the step that failed, answers the version line, and removeScript takes only its own wrapper", { skip: curl ? false : "no curl here" }, () => {
    const program = join(work, "hello-bin");

    writeFileSync(program, "#!/bin/sh\necho hello 2.0\n");
    chmodSync(program, 0o755);
    const sha256 = createHash("sha256").update(readFileSync(program)).digest("hex");
    const target = `${process.platform === "android" ? "android" : process.platform === "darwin" ? "darwin" : "linux"}-${process.arch === "arm64" ? "arm64" : "x64"}`;
    const spec = (sum: string): ToolSpec => ({ id: "hello", name: "Hello", command: "hello", version: "2.0", description: "", size: "tiny", assets: { [target]: { url: `file://${program}`, sha256: sum } } });
    const home = join(work, "home");
    const sh = (script: string) => spawnSync("sh", ["-c", script], { env: { ...process.env, HOME: home }, encoding: "utf8" });

    mkdirSync(home);
    const wrong = sh(installScript(spec("0".repeat(64)), { url: `file://${program}`, sha256: "0".repeat(64) }, home));

    assert.equal(wrong.status, 4);
    assert.match(wrong.stderr, new RegExp(`Failed while checking the sha256 of file://${program} \\(exit 4\\)\\.`));
    assert.equal(existsSync(join(home, ".pi/mobile/tools/bin/hello")), false, "nothing kept");

    const right = sh(installScript(spec(sha256), { url: `file://${program}`, sha256 }, home));

    assert.equal(right.status, 0, right.stderr);
    assert.equal(right.stdout.trim(), "hello 2.0");
    assert.equal(right.stderr, "", "no failure line on success");

    // Another program's wrapper by the same name is not pi-phone's hello: left alone.
    writeFileSync(join(home, ".pi/mobile/tools/bin/other"), "#!/bin/sh\n# pi-phone-tool other 1\n");
    const removed = sh(removeScript({ ...spec(sha256), assets: { [target]: { url: "file:///x", sha256, more: [{ command: "other", member: "x" }] } } }));

    assert.equal(removed.status, 0, removed.stderr);
    assert.equal(removed.stdout.trim(), "hello removed");
    assert.equal(existsSync(join(home, ".pi/mobile/tools/bin/hello")), false);
    assert.equal(existsSync(join(home, ".pi/mobile/tools/hello")), false);
    assert.equal(existsSync(join(home, ".pi/mobile/tools/bin/other")), true, "not this tool's");
});
