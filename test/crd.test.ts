// Chrome Remote Desktop as a machine tool (PP-263, src/server/crd.ts), with a stand-in machine (`support/fake-crd.ts`):
// the install script checks Google's signature (no sha256: a rolling address) and runs msiexec silently with its log;
// the pasted command gives its code and redirect alone, a redirect off remotedesktop.google.com is refused; the PIN is
// 6+ digits, typed twice; the values reach the machine only as the command's variables and come back removed from every
// message; the status reads not installed / installed, not connected / connected; remove uninstalls by product code;
// only the owner's Windows x64 machines are offered it; the locked-screen note says how to unlock or to set it up.
import assert from "node:assert/strict";
import { test } from "node:test";
import { describeWindowsState, parseWindowsState } from "../src/server/computer-windows.ts";
import {
    ChromeRemoteDesktop,
    checkPin,
    connectScript,
    CRD_MSI_URL,
    CrdError,
    crdWord,
    extractHostCommand,
    installScript,
    parseCrdState,
    removeScript,
    statusScript,
} from "../src/server/crd.ts";
import type { Machine } from "../src/server/machines.ts";
import { CRD_TOOL, MachineTools, statusScript as toolsStatusScript, TOOLS, toolOffer } from "../src/server/machine-tools.ts";
import type { Places } from "../src/server/places.ts";
import { CONNECTED, fakeCrd, NOT_INSTALLED } from "./support/fake-crd.ts";

const CODE = `4/0AVG7fiQ${"x".repeat(60)}Zq9`;
const REDIRECT = "https://remotedesktop.google.com/_/oauthredirect";
const PIN = "48151623";
const COMMAND = `& "\${Env:PROGRAMFILES(X86)}\\Google\\Chrome Remote Desktop\\CurrentVersion\\remoting_start_host.exe" --code="${CODE}" --redirect-url="${REDIRECT}" --name=$Env:COMPUTERNAME`;

/** The PowerShell inside a script (its -EncodedCommand). */
const powershell = (script: string) => Buffer.from(/-EncodedCommand (\S+)/.exec(script)![1]!, "base64").toString("utf16le");

const machine = (over: Partial<Machine> = {}): Machine & { remote: NonNullable<Machine["remote"]> } =>
    ({ id: "w1", name: "tualh-laptop", host: "h", user: "Picassio", keyId: "k", createdAt: 0, remote: { platform: "windows", arch: "x64", home: "C:/Users/Picassio" }, ...over }) as Machine & { remote: NonNullable<Machine["remote"]> };

const crdOn = (found: ReturnType<typeof machine>, fake = fakeCrd()) => ({ fake, crd: new ChromeRemoteDesktop(() => found, fake.run) });

const noValues = (text: string) => {
    for (const value of [CODE, REDIRECT, PIN, COMMAND]) {
        assert.ok(!text.includes(value), `no value in: ${text}`);
    }
};

test("the install script downloads Google's MSI, checks its Authenticode signature (Valid, CN=Google LLC), and runs msiexec silently with its log; no sha256", () => {
    const script = installScript();
    const ps = powershell(script);

    assert.match(script, /^# pi-phone-crd install/);
    assert.match(script, /export PI_CRD="\$\(cygpath -w "\$HOME\/\.pi\/mobile\/crd"\)"/);
    assert.ok(ps.includes(`Invoke-WebRequest -UseBasicParsing -Uri '${CRD_MSI_URL}' -OutFile $msi`));
    assert.match(ps, /\$sig = Get-AuthenticodeSignature -LiteralPath \$msi/);
    assert.ok(ps.includes("[string]$sig.Status -ne 'Valid'"));
    assert.ok(ps.includes("$subject -eq 'CN=Google LLC' -or $subject.StartsWith('CN=Google LLC,')"));
    // A download not signed by Google is deleted before msiexec could run.
    assert.ok(ps.indexOf("fail signature") < ps.indexOf("Start-Process -FilePath msiexec.exe"));
    assert.ok(ps.includes("Start-Process -FilePath msiexec.exe -ArgumentList ('/i \"' + $msi + '\" /qn /norestart /l*v \"' + $log + '\"') -Wait -PassThru"));
    assert.ok(ps.includes("$log = Join-Path $env:PI_CRD 'install.log'"));
    assert.match(ps, /IsInRole\(\[Security\.Principal\.WindowsBuiltInRole\]::Administrator\)/);
    assert.match(ps, /if \(\$crdProduct\) \{ Write-Output 'already' \}/);
    assert.doesNotMatch(ps, /sha256|Get-FileHash/i);
    assert.match(powershell(statusScript()), /Get-Service -Name chromoting/);
});

test("connect and remove scripts: the values come as variables, taken out of the environment; the PIN goes to remoting_start_host's input; remove is msiexec /x by product code", () => {
    const ps = powershell(connectScript());

    assert.ok(ps.includes("$code = $env:PI_CRD_CODE; $redirect = $env:PI_CRD_REDIRECT; $pin = $env:PI_CRD_PIN"));
    assert.ok(ps.indexOf("$env:PI_CRD_PIN = $null") < ps.indexOf("[System.Diagnostics.Process]::Start($info)"));
    assert.ok(ps.includes("$p.StandardInput.WriteLine($pin)"));
    assert.doesNotMatch(ps, /--pin/);
    assert.ok(ps.includes("--name=\"' + $env:COMPUTERNAME + '\"'"));
    assert.ok(ps.includes(".Replace($pin, '[removed]')"));

    const remove = powershell(removeScript());

    assert.ok(remove.includes("Stop-Service -Name chromoting -Force"));
    assert.ok(remove.includes("('/x ' + $product + ' /qn /norestart /l*v \"' + $log + '\"')"));
    assert.ok(remove.includes("$product = [string]$crdProduct.PSChildName"));
});

test("the pasted command gives its code and redirect; a redirect off remotedesktop.google.com, or a bad code, is refused, and no error holds a value", () => {
    assert.deepEqual(extractHostCommand(COMMAND), { code: CODE, redirect: REDIRECT });
    assert.deepEqual(extractHostCommand(`DISPLAY= /opt/google/chrome-remote-desktop/start-host --code='${CODE}' --redirect-url=${REDIRECT} --name=$(hostname)`), { code: CODE, redirect: REDIRECT });

    const refused = (command: unknown, why: RegExp) => {
        assert.throws(
            () => extractHostCommand(command),
            (error: unknown) => {
                assert.ok(error instanceof CrdError);
                assert.match(error.message, why);
                noValues(error.message);

                return true;
            },
        );
    };

    for (const bad of ["https://evil.example/_/oauthredirect", "http://remotedesktop.google.com/_/oauthredirect", "https://remotedesktop.google.com.evil.example/x", "https://remotedesktop.google.com/_/oauthredirect?x=1", "https://u:p@remotedesktop.google.com/x", "https://remotedesktop.google.com:8443/x"]) {
        refused(COMMAND.replace(REDIRECT, bad), /redirect address is not (Google's|an address)/);
    }

    refused("", /Paste the command/);
    refused(42, /Paste the command/);
    refused(COMMAND.replace(/--code="[^"]*"/, ""), /no --code/);
    refused(COMMAND.replace(/--redirect-url="[^"]*"/, ""), /no --redirect-url/);
    refused(`${COMMAND} --code="${CODE}"`, /--code more than once/);
    refused(COMMAND.replace(CODE, "5/abc\"; rm -rf /"), /code is not one of Google's/);
});

test("the PIN is 6 to 32 digits, digits only, the same twice; errors never hold it", () => {
    assert.equal(checkPin(PIN, PIN), PIN);
    assert.equal(checkPin("123456", "123456"), "123456");

    for (const [pin, confirm, why] of [
        ["12345", "12345", /at least 6 digits/],
        ["12345a", "12345a", /digits only/],
        ["", "", /at least 6/],
        [123456, 123456, /at least 6/],
        ["1".repeat(33), "1".repeat(33), /at most 32/],
        [PIN, "48151624", /The two PINs differ/],
    ] as const) {
        assert.throws(() => checkPin(pin, confirm), (error: unknown) => error instanceof CrdError && why.test(error.message) && (pin === "" || !error.message.includes(String(pin))));
    }
});

test("the status reads not installed, installed but not connected, connected; an answer without it is an error", () => {
    assert.equal(crdWord(parseCrdState(`noise\ncrd ${JSON.stringify(NOT_INSTALLED)}\n`)), "not installed");
    assert.equal(crdWord(parseCrdState(`crd ${JSON.stringify({ ...CONNECTED, service: "Stopped" })}`)), "installed, not connected");
    assert.equal(crdWord(parseCrdState(`crd ${JSON.stringify({ ...CONNECTED, config: false })}`)), "installed, not connected");
    assert.deepEqual(parseCrdState(`crd ${JSON.stringify(CONNECTED)}`), CONNECTED);
    assert.equal(crdWord(CONNECTED), "connected");
    assert.throws(() => parseCrdState("Access is denied."), /did not say how Chrome Remote Desktop stands: Access is denied\./);
});

test("connect: the values reach the machine only as variables, never in the script; it is connected after; an expired code says to get a new one; output that repeats them is cleaned", async () => {
    const { fake, crd } = crdOn(machine(), fakeCrd({ ...CONNECTED, service: "Stopped", config: false }));
    const state = await crd.connect("w1", COMMAND, PIN, PIN);

    assert.equal(crdWord(state), "connected");
    const call = fake.calls.find((each) => each.kind === "connect")!;

    assert.deepEqual(call.env, { PI_CRD_CODE: CODE, PI_CRD_REDIRECT: REDIRECT, PI_CRD_PIN: PIN });
    noValues(call.script);
    noValues(powershell(call.script));

    fake.state = { ...fake.state, service: "Stopped", config: false };
    fake.startHost = "expired";
    await assert.rejects(crd.connect("w1", COMMAND, PIN, PIN), (error: unknown) => {
        assert.ok(error instanceof CrdError);
        assert.match(error.message, /Google refused the code: it has expired or was used already.*Get a new one at https:\/\/remotedesktop\.google\.com\/headless/);
        noValues(error.message);

        return true;
    });

    fake.startHost = "echo";
    await assert.rejects(crd.connect("w1", COMMAND, PIN, PIN), (error: unknown) => {
        assert.ok(error instanceof CrdError);
        assert.match(error.message, /Registration error\. \[removed\] \[removed\] \[removed\]/);
        noValues(error.message);

        return true;
    });

    // A bad PIN or redirect never reaches the machine.
    const before = fake.calls.length;

    await assert.rejects(crd.connect("w1", COMMAND, "123", "123"), /at least 6 digits/);
    await assert.rejects(crd.connect("w1", COMMAND.replace(REDIRECT, "https://evil.example/x"), PIN, PIN), /not Google's/);
    assert.equal(fake.calls.length, before);
});

test("connect on a machine where it is not installed says to install it; a run that fails is reported without the values", async () => {
    const { crd } = crdOn(machine(), fakeCrd(NOT_INSTALLED));

    await assert.rejects(crd.connect("w1", COMMAND, PIN, PIN), /not installed on tualh-laptop: install it first/);

    const failing = new ChromeRemoteDesktop(() => machine(), async () => {
        throw new Error(`daemon gone while running with ${PIN} and ${CODE}`);
    });

    await assert.rejects(failing.connect("w1", COMMAND, PIN, PIN), (error: unknown) => error instanceof CrdError && !error.message.includes(PIN) && !error.message.includes(CODE) && /daemon gone/.test(error.message));
});

test("install: installed counts as installed; no administrator, an unsigned download and msiexec's codes are said plainly", async () => {
    const { fake, crd } = crdOn(machine());

    const done = await crd.install("w1");

    assert.equal(done.ok, true);
    assert.match(done.said, /Chrome Remote Desktop 154\.0\.8037\.40 is installed on tualh-laptop \(Google's, its signature checked\): installed, not connected\./);
    assert.match((await crd.install("w1")).said, /was installed on tualh-laptop already/);

    fake.state = { ...NOT_INSTALLED };
    fake.installSays = { code: 30, out: "fail admin\n" };
    assert.match((await crd.install("w1")).said, /no administrator rights in this session \(it is not an administrator, or Windows' UAC withholds them\)/);
    fake.installSays = { code: 31, out: "fail signature NotSigned \n" };
    assert.match((await crd.install("w1")).said, /not signed by Google \(signature NotSigned\), so it was deleted and nothing was installed/);
    fake.installSays = { code: 32, out: "msiexec 1618\nfail msiexec 1618\n" };
    assert.match((await crd.install("w1")).said, /exit 1618, another installation is running on the machine: try again when it ends\. Its log is ~\/\.pi\/mobile\/crd\/install\.log/);
    fake.installSays = { code: 32, out: "fail msiexec 1925\n" };
    assert.match((await crd.install("w1")).said, /exit 1925, it needs administrator rights that Windows' UAC did not give this session/);
});

test("remove uninstalls it and says when it could not; status reads the machine", async () => {
    const { fake, crd } = crdOn(machine(), fakeCrd(CONNECTED));

    assert.equal(crdWord(await crd.status("w1")), "connected");
    assert.equal(crdWord(await crd.remove("w1")), "not installed");
    assert.deepEqual(
        fake.calls.map((each) => each.kind),
        ["status", "remove"],
    );

    fake.state = { ...CONNECTED };
    const failing = new ChromeRemoteDesktop(() => machine(), async () => ({ code: 32, out: "msiexec 1603\nfail msiexec 1603\n" }));

    await assert.rejects(failing.remove("w1"), /could not remove it on tualh-laptop: exit 1603, a fatal error during installation\. Its log is ~\/\.pi\/mobile\/crd\/remove\.log/);
});

test("only the owner's Windows x64 machines are offered it: Linux, macOS, Windows on Arm and team machines are refused before anything runs", async () => {
    for (const [found, why] of [
        [machine({ remote: { platform: "linux", arch: "x64", home: "/home/me" } }), /for Windows machines for now \(Linux and macOS come later\); tualh-laptop is linux/],
        [machine({ remote: { platform: "darwin", arch: "arm64", home: "/Users/me" } }), /tualh-laptop is darwin/],
        [machine({ remote: { platform: "windows", arch: "arm64", home: "C:/Users/me" } }), /Windows on x64 for now/],
        [machine({ team: { id: "t", manage: true, usable: true, roles: [], publicKey: "", createdBy: "", folder: "" } }), /not for a team machine/],
    ] as const) {
        const { fake, crd } = crdOn(found);

        assert.equal(ChromeRemoteDesktop.supports(found), false);
        await assert.rejects(crd.status("w1"), why);
        await assert.rejects(crd.install("w1"), why);
        await assert.rejects(crd.connect("w1", COMMAND, PIN, PIN), why);
        assert.equal(fake.calls.length, 0);
    }

    assert.equal(ChromeRemoteDesktop.supports(machine()), true);
});

/** A stand-in for the app's places: each machine's sh status script answers that no tool is there. */
const places = { env: () => ({ exec: async (_command: unknown, options: { onOutput: (text: string) => void }) => (options.onOutput("officecli none\n"), { ok: true, value: { exitCode: 0 } }) }) } as unknown as Places;

test("Chrome Remote Desktop is a machine tool, unticked: offered on a Windows machine without it, not on Linux; installed at any version counts; it is not in the sh status script", async () => {
    assert.ok(TOOLS.includes(CRD_TOOL));
    assert.deepEqual(toolOffer(CRD_TOOL), {
        id: "crd",
        name: "Chrome Remote Desktop",
        version: "Google's current",
        description: CRD_TOOL.description,
        size: "about 25 MB",
        onlyIfMissing: false,
        desktop: false,
        optIn: true,
        windowsOnly: true,
        signer: "CN=Google LLC",
    });
    assert.doesNotMatch(toolsStatusScript(TOOLS), /crd|remoting_start_host/);

    let found = machine();
    const recorded: Record<string, string>[] = [];
    const fake = fakeCrd();
    const tools = new MachineTools(places, () => found, (_id, tools) => recorded.push(tools), [CRD_TOOL], fake.run);
    const offered = (await tools.status("w1"))[0]!;

    assert.equal(offered.supported, true);
    assert.equal(offered.offered, true);
    assert.equal(offered.crd, "not installed");

    const installed = await tools.install("w1", ["crd"]);

    assert.equal(installed.results[0]!.ok, true);
    assert.equal(installed.results[0]!.version, "154.0.8037.40");
    assert.equal(installed.tools[0]!.offered, false);
    assert.equal(installed.tools[0]!.installed, "154.0.8037.40");
    assert.equal(installed.tools[0]!.crd, "installed, not connected");
    assert.deepEqual(recorded.at(-1), { crd: "154.0.8037.40" });

    found = machine({ remote: { platform: "linux", arch: "x64", home: "/home/me" } });
    const calls = fake.calls.length;
    const linux = (await tools.status("w1"))[0]!;

    assert.equal(linux.supported, false);
    assert.equal(linux.offered, false);
    assert.equal(linux.crd, undefined);
    assert.match((await tools.install("w1", ["crd"])).results[0]!.said, /for your own Windows x64 machines for now; tualh-laptop is linux x64/);
    assert.equal(fake.calls.length, calls, "nothing of CRD runs on Linux");
});

test("a locked Windows screen: Pi is told to unlock it with Chrome Remote Desktop when it is connected, else to offer to set it up", () => {
    const state = parseWindowsState(`state ${JSON.stringify({ task: true, loggedOn: true, locked: true, running: true, crd: "connected" })}`);

    assert.match(describeWindowsState("tualh-laptop", state), /its screen is locked.*Ask the owner to unlock it with Chrome Remote Desktop from their phone/);
    assert.match(describeWindowsState("tualh-laptop", { ...state, crd: "not installed" }), /Offer to set up Chrome Remote Desktop.*crd: "install", then crd: "connect"/);
    assert.match(describeWindowsState("tualh-laptop", { ...state, crd: "installed, not connected" }), /Offer to set up Chrome Remote Desktop.*installed but not connected: computer_control setup with crd: "connect"/);
    assert.doesNotMatch(describeWindowsState("tualh-laptop", { ...state, locked: false }), /Chrome Remote Desktop/);
    assert.throws(() => parseWindowsState(`state ${JSON.stringify({ task: true, loggedOn: true, locked: true, running: true })}`), /did not say how Chrome Remote Desktop stands/);
});
