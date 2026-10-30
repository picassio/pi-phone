/**
 * Computer control on Windows (PP-179). Windows' sshd runs what the app starts in session 0, which has no desktop: ocu
 * started over ssh sees no windows. So ocu runs in the owner's signed-in desktop session, behind a small bridge:
 *
 * - The task: a per-user Scheduled Task, "pi-phone ocu", registered as the user with LogonType Interactive ("run only
 *   when the user is logged on", which needs no password) and RunLevel Limited (never SYSTEM, never elevated). It starts
 *   at the user's logon, and when pi-phone starts it (`Start-ScheduledTask`), and runs `bridge.ps1` with Windows
 *   PowerShell (on every Windows; no new runtime) in a console without a window (`conhost.exe --headless`).
 * - The bridge (`BRIDGE`): it listens on 127.0.0.1 alone, on a port the system picks, and writes the port and a new
 *   random token to `bridge.json` beside it, whose ACL gives only the user access. A connection's first line is JSON
 *   with the token; then either ocu's MCP (`ocu.exe mcp`, the machine tool's, a process per connection, its output and
 *   input passed through as they are) or the sign (a small topmost window that says Pi is using the computer, with
 *   Stop: the GTK window's protocol, `ready` and `stop`).
 * - The connection: pi-phone reads the port and token over ssh (`connectScript`, which starts the task first when the
 *   user is signed in and the bridge is not running), opens the port through the app's ssh forward (`forwards.ts`, as
 *   Pi's browser reaches Chrome's DevTools on a machine), and speaks to it (`connectBridge`). The token stays in
 *   memory: never logged, never in what Pi reads.
 *
 * Everything lives in `~/.pi/mobile/computer` on the machine (Git Bash's home, where the machine tools are).
 */
import { EventEmitter } from "node:events";
import { connect, type Socket } from "node:net";
import { PassThrough, type Writable } from "node:stream";
import type { OcuProcess } from "./ocu-client.ts";

/** The task's name, in the Task Scheduler's root folder. */
export const WINDOWS_TASK = "pi-phone ocu";

/** Where the bridge keeps its things on the machine, under its (Git Bash) home. */
export const WINDOWS_DIR = ".pi/mobile/computer";

/** How a Windows machine stands for computer control. */
export type WindowsState = {
    /** The task is registered. */
    task: boolean;
    /** The user is signed in to a desktop (their explorer runs in a session other than 0). */
    loggedOn: boolean;
    /** That desktop is locked (LogonUI runs in its session): ocu reads it, but input does not reach it. */
    locked: boolean;
    /** The bridge runs (its pid from bridge.json, a powershell in a desktop session). */
    running: boolean;
};

/** The state's word: ready, not set up, or not logged on. */
export function windowsStateWord(state: WindowsState): "ready" | "not set up" | "not logged on" {
    return !state.task ? "not set up" : !state.loggedOn ? "not logged on" : "ready";
}

/** How a Windows machine stands, in a line for Pi and Menu › Computer control. */
export function describeWindowsState(name: string, state: WindowsState): string {
    if (!state.task) {
        return `not set up: pi-phone's task "${WINDOWS_TASK}" is not on ${name} (computer_control setup with task: "install" asks the owner on a card, or the owner taps Set up in Menu › Computer control)`;
    }

    if (!state.loggedOn) {
        return `not logged on: nobody is signed in to ${name}'s desktop, so pi-phone's task (and ocu with it) cannot run there; the owner signs in on the computer first`;
    }

    return `ready${state.running ? "" : " (the task starts when a session does)"}${state.locked ? `; its screen is locked: ocu reads windows, but clicks and keys do not reach them until the owner unlocks it` : ""}`;
}

/**
 * The bridge, run by the task in the user's desktop session (Windows PowerShell 5.1; ASCII only, as it reads a file
 * without a BOM as ANSI). Each connection gets its own runspace (STA, for the sign's window).
 */
export const BRIDGE = String.raw`# pi-phone's bridge for computer control on Windows (PP-179). The scheduled task "pi-phone ocu" runs it in the
# signed-in desktop session, as the user. It listens on 127.0.0.1 only, on a port the system picks, and writes that port
# and a new random token to bridge.json beside it (only the user may read it). pi-phone reaches it through its ssh
# forward. A connection's first line is JSON {token, run, ...}; the answer is "ok", or "no <why>" and it closes. Then:
#   run "mcp", ocu "<version>": ocu's MCP (tools\ocu\<version>\ocu.exe mcp) over the connection, until either end closes.
#   run "sign", text "...": a small topmost window saying Pi is using this computer, with Stop. It sends "ready" once it
#   shows and "stop" when Stop is pressed; it goes when the connection closes.
param([Parameter(Mandatory = $true)][string]$Tools)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$Here = $PSScriptRoot
$Log = Join-Path $Here 'bridge.log'
$State = Join-Path $Here 'bridge.json'

function Say([string]$line) {
    try { Add-Content -LiteralPath $Log -Value ((Get-Date).ToString('u') + ' ' + $line) -Encoding ASCII } catch { }
}

$created = $false
$mutex = New-Object System.Threading.Mutex($true, 'Local\pi-phone-ocu-bridge', [ref]$created)
if (-not $created) { Say 'another bridge runs in this session: this one ends'; exit 0 }
Set-Content -LiteralPath $Log -Value ((Get-Date).ToString('u') + ' bridge starting, pid ' + $PID) -Encoding ASCII

$bytes = New-Object byte[] 32
[System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
$Token = -join ($bytes | ForEach-Object { $_.ToString('x2') })

$listener = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Loopback, 0)
$listener.Start()
$port = $listener.LocalEndpoint.Port

# bridge.json: made empty, given an ACL with the user alone (no inherited entries), then written and moved in place.
$fresh = $State + '.new'
if (Test-Path -LiteralPath $fresh) { Remove-Item -LiteralPath $fresh -Force }
[System.IO.File]::WriteAllText($fresh, '')
$acl = New-Object System.Security.AccessControl.FileSecurity
$acl.SetAccessRuleProtection($true, $false)
$me = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($me, 'FullControl', 'Allow')))
[System.IO.File]::SetAccessControl($fresh, $acl)
[System.IO.File]::WriteAllText($fresh, (ConvertTo-Json @{ port = $port; token = $Token; pid = $PID } -Compress))
Move-Item -LiteralPath $fresh -Destination $State -Force
Say ('listening on 127.0.0.1:' + $port)

$SignSource = @'
using System;
using System.Drawing;
using System.Windows.Forms;
public class PiPhoneSign : Form {
    public Button StopButton;
    public PiPhoneSign(string text) {
        Text = "pi-phone";
        FormBorderStyle = FormBorderStyle.None;
        ShowInTaskbar = false;
        TopMost = true;
        StartPosition = FormStartPosition.Manual;
        AutoSize = true;
        AutoSizeMode = AutoSizeMode.GrowAndShrink;
        BackColor = Color.FromArgb(30, 30, 46);
        Padding = new Padding(6);
        FlowLayoutPanel row = new FlowLayoutPanel();
        row.AutoSize = true;
        row.AutoSizeMode = AutoSizeMode.GrowAndShrink;
        row.WrapContents = false;
        Label label = new Label();
        label.Text = text;
        label.AutoSize = true;
        label.ForeColor = Color.White;
        label.Margin = new Padding(4, 9, 10, 4);
        StopButton = new Button();
        StopButton.Text = "Stop";
        StopButton.AutoSize = true;
        StopButton.FlatStyle = FlatStyle.Flat;
        StopButton.ForeColor = Color.White;
        StopButton.BackColor = Color.FromArgb(180, 50, 60);
        row.Controls.Add(label);
        row.Controls.Add(StopButton);
        Controls.Add(row);
    }
    protected override bool ShowWithoutActivation { get { return true; } }
    protected override CreateParams CreateParams {
        get {
            CreateParams p = base.CreateParams;
            p.ExStyle |= 0x08000000 | 0x00000080 | 0x00000008;
            return p;
        }
    }
    protected override void OnShown(EventArgs e) {
        Rectangle area = Screen.PrimaryScreen.WorkingArea;
        Location = new Point(area.Right - Width - 16, area.Top + 16);
        base.OnShown(e);
    }
}
'@

$Handler = {
    param($Client, $Token, $Tools, $Log, $SignSource)
    $ErrorActionPreference = 'Stop'
    function Say([string]$line) {
        try { Add-Content -LiteralPath $Log -Value ((Get-Date).ToString('u') + ' ' + $line) -Encoding ASCII } catch { }
    }
    $stream = $Client.GetStream()
    function Send([string]$text) {
        $b = [System.Text.Encoding]::UTF8.GetBytes($text + [char]10)
        $stream.Write($b, 0, $b.Length)
        $stream.Flush()
    }
    try {
        $Client.ReceiveTimeout = 10000
        $line = New-Object System.Collections.Generic.List[byte]
        while ($true) {
            $b = $stream.ReadByte()
            if ($b -lt 0) { return }
            if ($b -eq 10) { break }
            if ($line.Count -ge 8192) { Send 'no the first line is too long'; return }
            $line.Add([byte]$b)
        }
        $Client.ReceiveTimeout = 0
        $hello = [System.Text.Encoding]::UTF8.GetString($line.ToArray()) | ConvertFrom-Json
        $given = [string]$hello.token
        $diff = $given.Length -bxor $Token.Length
        for ($i = 0; $i -lt $Token.Length; $i++) {
            $c = 0
            if ($i -lt $given.Length) { $c = [int]$given[$i] }
            $diff = $diff -bor ($c -bxor [int]$Token[$i])
        }
        if ($diff -ne 0) { Say 'refused a connection with a wrong token'; Send 'no wrong token'; return }

        if ($hello.run -eq 'mcp') {
            $version = [string]$hello.ocu
            if ($version -notmatch '^[0-9A-Za-z][0-9A-Za-z.\-]*$') { Send 'no which ocu version?'; return }
            $exe = Join-Path $Tools ('ocu\' + $version + '\ocu.exe')
            if (-not (Test-Path -LiteralPath $exe)) { Send ('no ocu ' + $version + ' is not installed here (Settings > Machines > Install tools)'); return }
            $info = New-Object System.Diagnostics.ProcessStartInfo
            $info.FileName = $exe
            $info.Arguments = 'mcp'
            $info.UseShellExecute = $false
            $info.CreateNoWindow = $true
            $info.RedirectStandardInput = $true
            $info.RedirectStandardOutput = $true
            $info.RedirectStandardError = $true
            $process = [System.Diagnostics.Process]::Start($info)
            $null = $process.StandardError.BaseStream.CopyToAsync([System.IO.Stream]::Null)
            Say ('ocu ' + $version + ' started, pid ' + $process.Id)
            Send 'ok'
            $out = $process.StandardOutput.BaseStream.CopyToAsync($stream)
            $toOcu = $process.StandardInput.BaseStream
            $buffer = New-Object byte[] 65536
            try {
                while ($true) {
                    $read = $stream.ReadAsync($buffer, 0, $buffer.Length)
                    $first = [System.Threading.Tasks.Task]::WaitAny([System.Threading.Tasks.Task[]]@($read, $out))
                    if ($first -eq 1) { break }
                    $n = $read.Result
                    if ($n -le 0) { break }
                    $toOcu.Write($buffer, 0, $n)
                    $toOcu.Flush()
                }
            } finally {
                try { $toOcu.Close() } catch { }
                if (-not $process.WaitForExit(3000)) { try { $process.Kill() } catch { } }
                Say ('ocu ended, pid ' + $process.Id)
            }
            return
        }

        if ($hello.run -eq 'sign') {
            Add-Type -AssemblyName System.Windows.Forms, System.Drawing
            if (-not ('PiPhoneSign' -as [type])) { Add-Type -TypeDefinition $SignSource -ReferencedAssemblies System.Windows.Forms, System.Drawing }
            $form = New-Object PiPhoneSign([string]$hello.text)
            $box = @{ buffer = (New-Object byte[] 4096); read = $null }
            $box.read = $stream.ReadAsync($box.buffer, 0, 4096)
            $form.add_Shown({ try { Send 'ready' } catch { $form.Close() } })
            $form.StopButton.add_Click({ try { Send 'stop' } catch { }; $form.Close() })
            $timer = New-Object System.Windows.Forms.Timer
            $timer.Interval = 250
            $timer.add_Tick({
                if ($box.read.IsCompleted) {
                    if ($box.read.IsFaulted -or $box.read.IsCanceled -or $box.read.Result -le 0) { $form.Close() }
                    else { $box.read = $stream.ReadAsync($box.buffer, 0, 4096) }
                }
            })
            $timer.Start()
            Send 'ok'
            Say 'sign shown'
            [System.Windows.Forms.Application]::Run($form)
            $timer.Stop()
            Say 'sign gone'
            return
        }

        Send 'no run is mcp or sign'
    } catch {
        Say ('a connection failed: ' + $_.Exception.Message)
    } finally {
        try { $Client.Close() } catch { }
    }
}

$pool = [runspacefactory]::CreateRunspacePool(1, 16)
$pool.ApartmentState = [System.Threading.ApartmentState]::STA
$pool.Open()
$running = New-Object System.Collections.ArrayList

function Tidy {
    foreach ($each in @($running)) {
        if ($each.handle.IsCompleted) {
            try { $null = $each.shell.EndInvoke($each.handle) } catch { Say ('a connection ended badly: ' + $_.Exception.Message) }
            $each.shell.Dispose()
            $running.Remove($each)
        }
    }
}

try {
    while ($true) {
        $accept = $listener.AcceptTcpClientAsync()
        while (-not $accept.Wait(1000)) { Tidy }
        $shell = [powershell]::Create()
        $shell.RunspacePool = $pool
        $null = $shell.AddScript($Handler).AddArgument($accept.Result).AddArgument($Token).AddArgument($Tools).AddArgument($Log).AddArgument($SignSource)
        $null = $running.Add(@{ shell = $shell; handle = $shell.BeginInvoke() })
        Tidy
    }
} finally {
    Say 'bridge ending'
    try { Remove-Item -LiteralPath $State -Force } catch { }
}
`;

/** A PowerShell script as `-EncodedCommand` takes it: UTF-16LE, base64. */
export const encodePowerShell = (script: string) => Buffer.from(script, "utf16le").toString("base64");

/** The PowerShell lines that say how the machine stands; shared by the status and connect scripts. */
const LOOK = [
    "$ErrorActionPreference = 'Stop'",
    "$ProgressPreference = 'SilentlyContinue'",
    "$dir = $env:PI_COMPUTER",
    "$stateFile = Join-Path $dir 'bridge.json'",
    `$task = Get-ScheduledTask -TaskName '${WINDOWS_TASK}' -ErrorAction SilentlyContinue`,
    "$desks = @(Get-CimInstance Win32_Process -Filter \"Name='explorer.exe'\" | Where-Object { $_.SessionId -gt 0 -and (Invoke-CimMethod -InputObject $_ -MethodName GetOwner).User -eq $env:USERNAME })",
    "$sessions = @($desks | ForEach-Object { $_.SessionId })",
    "$locked = $sessions.Count -gt 0 -and @(Get-Process LogonUI -ErrorAction SilentlyContinue | Where-Object { $sessions -contains $_.SessionId }).Count -gt 0",
    "function Alive {",
    "  if (-not (Test-Path -LiteralPath $stateFile)) { return $null }",
    "  $s = Get-Content -Raw -LiteralPath $stateFile | ConvertFrom-Json",
    "  $p = Get-Process -Id $s.pid -ErrorAction SilentlyContinue",
    "  if ($p -and $p.ProcessName -eq 'powershell' -and $sessions -contains $p.SessionId) { return $s }",
    "  return $null",
    "}",
];

/**
 * Git Bash (pi-env's daemon runs it: Windows' sshd's own shell may be cmd.exe, tualh-laptop 2026-10-31): the bridge's
 * folder and the machine tools' as Windows paths, for PowerShell, then the script.
 */
const shellFor = (kind: string, script: string, before: string[] = []) =>
    [
        `# pi-phone-computer ${kind}`,
        'if ! command -v cygpath >/dev/null 2>&1 || ! command -v powershell.exe >/dev/null 2>&1; then echo "Computer control on Windows runs through Git Bash and Windows PowerShell, which this machine lacks."; exit 9; fi',
        `D="$HOME/${WINDOWS_DIR}"`,
        ...before,
        'export PI_COMPUTER="$(cygpath -w "$D")" PI_TOOLS="$(cygpath -w "$HOME/.pi/mobile/tools")"',
        `exec powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ${encodePowerShell(script)}`,
    ].join("\n");

const stateLine = "Write-Output ('state ' + (ConvertTo-Json @{ task = [bool]$task; loggedOn = $sessions.Count -gt 0; locked = [bool]$locked; running = [bool](Alive) } -Compress))";

/** The script that says how the machine stands: its last line is `state {json}` (`parseWindowsState`). */
export function statusScript(): string {
    return shellFor("status", [...LOOK, stateLine].join("\n"));
}

export function parseWindowsState(out: string): WindowsState {
    const line = /^state (\{.*\})\s*$/m.exec(out)?.[1];

    if (line === undefined) {
        throw new Error(`the machine did not say how it stands: ${out.trim().split("\n").slice(-3).join(" ") || "no answer"}`);
    }

    const state = JSON.parse(line) as Partial<WindowsState>;

    return { task: state.task === true, loggedOn: state.loggedOn === true, locked: state.locked === true, running: state.running === true };
}

/** How the connect script ends when the bridge cannot be reached. */
export const CONNECT_EXIT = { notSetUp: 20, notLoggedOn: 21, notStarted: 22 } as const;

/**
 * The script that finds the bridge's port and token: it starts the task first when the user is signed in and the bridge
 * is not running. Its last line is `bridge <port> <token>`; or it exits with one of `CONNECT_EXIT`.
 */
export function connectScript(): string {
    return shellFor(
        "connect",
        [
            ...LOOK,
            `if (-not $task) { exit ${CONNECT_EXIT.notSetUp} }`,
            `if ($sessions.Count -eq 0) { exit ${CONNECT_EXIT.notLoggedOn} }`,
            "$s = Alive",
            "if (-not $s) {",
            `  Start-ScheduledTask -TaskName '${WINDOWS_TASK}'`,
            "  for ($i = 0; $i -lt 40 -and -not $s; $i++) { Start-Sleep -Milliseconds 500; $s = Alive }",
            "}",
            "if (-not $s) {",
            "  $info = Get-ScheduledTaskInfo -TaskName '" + WINDOWS_TASK + "' -ErrorAction SilentlyContinue",
            "  Write-Output ('The task did not start the bridge in 20 s (its last result: ' + $info.LastTaskResult + ').')",
            "  if (Test-Path -LiteralPath (Join-Path $dir 'bridge.log')) { Get-Content -Tail 5 -LiteralPath (Join-Path $dir 'bridge.log') }",
            `  exit ${CONNECT_EXIT.notStarted}`,
            "}",
            "Write-Output ('bridge ' + $s.port + ' ' + $s.token)",
        ].join("\n"),
    );
}

/** The registration, as the owner reads it on the card and the install script runs it. */
export function registerCommands(): string {
    return [
        "$user = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name",
        "$shell = Join-Path $env:SystemRoot 'System32\\WindowsPowerShell\\v1.0\\powershell.exe'",
        "$bridge = Join-Path $env:PI_COMPUTER 'bridge.ps1'",
        "$action = New-ScheduledTaskAction -Execute (Join-Path $env:SystemRoot 'System32\\conhost.exe') -Argument ('--headless \"{0}\" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File \"{1}\" -Tools \"{2}\"' -f $shell, $bridge, $env:PI_TOOLS) -WorkingDirectory $env:PI_COMPUTER",
        "$trigger = New-ScheduledTaskTrigger -AtLogOn -User $user",
        "$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited",
        "$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -Priority 5",
        `Register-ScheduledTask -TaskName '${WINDOWS_TASK}' -Description 'pi-phone: computer control (ocu) in your desktop session, on 127.0.0.1 only. Remove it in pi-phone, Menu > Computer control.' -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null`,
    ].join("\n");
}

/** Where bridge.ps1 goes, under the machine's home. */
export const BRIDGE_FILE = `${WINDOWS_DIR}/bridge.ps1`;

/**
 * The install script, once bridge.ps1 (`BRIDGE`) is in `~/.pi/mobile/computer`: the task is registered
 * (`registerCommands`) and, with the user signed in, started. Its last line is `state {json}`.
 */
export function installScript(): string {
    return shellFor(
        "install",
        [
            ...LOOK,
            registerCommands(),
            "$task = Get-ScheduledTask -TaskName '" + WINDOWS_TASK + "'",
            "if ($sessions.Count -gt 0 -and -not (Alive)) {",
            `  Start-ScheduledTask -TaskName '${WINDOWS_TASK}'`,
            "  for ($i = 0; $i -lt 40 -and -not (Alive); $i++) { Start-Sleep -Milliseconds 500 }",
            "}",
            stateLine,
        ].join("\n"),
        [`if [ ! -s "$D/bridge.ps1" ]; then echo "pi-phone's bridge.ps1 is not in $D: nothing was registered."; exit 8; fi`],
    );
}

/** The remove script: the task, its bridge (and the ocu it runs, whose input then ends), and the folder go. */
export function removeScript(): string {
    return shellFor(
        "remove",
        [
            ...LOOK,
            "if ($dir -notlike '*\\.pi\\mobile\\computer') { throw ('not the bridge folder: ' + $dir) }",
            `if ($task) { Stop-ScheduledTask -TaskName '${WINDOWS_TASK}' -ErrorAction SilentlyContinue; Unregister-ScheduledTask -TaskName '${WINDOWS_TASK}' -Confirm:$false }`,
            "Get-CimInstance Win32_Process -Filter \"Name='powershell.exe'\" | Where-Object { $_.CommandLine -like '*\\.pi\\mobile\\computer\\bridge.ps1*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }",
            "Start-Sleep -Milliseconds 500",
            "if (Test-Path -LiteralPath $dir) { Remove-Item -LiteralPath $dir -Recurse -Force }",
            "$task = $null",
            stateLine,
        ].join("\n"),
    );
}

/** What the card shows before the task is made or removed: what changes on the machine, and the commands. */
export function taskPlan(name: string, user: string, what: "install" | "remove"): string {
    if (what === "remove") {
        return [
            `On ${name}, remove pi-phone's computer control:`,
            `- the scheduled task "${WINDOWS_TASK}" (Unregister-ScheduledTask), and its bridge if it runs;`,
            `- the folder ~/${WINDOWS_DIR} (bridge.ps1, bridge.json, bridge.log).`,
            "ocu (the machine tool) stays installed.",
        ].join("\n");
    }

    return [
        `On ${name}, for ${user} (no password: it runs only while ${user} is signed in, never as SYSTEM or elevated):`,
        `- a file: ~/${WINDOWS_DIR}/bridge.ps1, pi-phone's bridge (Windows PowerShell);`,
        `- a scheduled task "${WINDOWS_TASK}": at ${user}'s sign-in, and when pi-phone starts it, it runs the bridge in a window-less console. The bridge listens on 127.0.0.1 only, with a new random token in ~/${WINDOWS_DIR}/bridge.json that only ${user} can read; pi-phone reaches it through its ssh.`,
        "No system setting, firewall rule or service changes. Remove it in Menu › Computer control, or with computer_control setup (task: remove).",
        "",
        "The task, as PowerShell registers it:",
        registerCommands(),
    ].join("\n");
}

/**
 * A connection to the bridge, as a process (`OcuProcess`): what it says is its output; its input is the connection;
 * killing it closes the connection; it exits when the connection closes.
 */
class BridgeConnection extends EventEmitter {
    readonly stdin: Writable;
    readonly stdout = new PassThrough();
    readonly stderr = new PassThrough();
    readonly #socket: Socket;

    constructor(socket: Socket, rest: Buffer, label: string) {
        super();
        this.#socket = socket;
        this.stdin = socket;

        if (rest.length > 0) {
            this.stdout.write(rest);
        }

        let said = "";

        socket.on("data", (chunk: Buffer) => this.stdout.write(chunk));
        socket.on("error", (error) => {
            said = error.message;
        });
        socket.once("close", () => {
            this.stdout.end();
            this.stderr.write(`${label} closed the connection${said === "" ? "" : `: ${said}`}\n`);
            // The line reaches the stderr listeners before the exit does.
            setImmediate(() => this.emit("exit", null, null));
        });
    }

    kill(): boolean {
        this.#socket.destroy();

        return true;
    }
}

/**
 * Connect to the bridge on `port` (here: the ssh forward's end) and say what to run (`hello`, with its token): the
 * connection once the bridge says ok, or why not. The token goes only into the connection.
 */
export function connectBridge(port: number, hello: { token: string; run: "mcp"; ocu: string } | { token: string; run: "sign"; text: string }, label: string, timeoutMs = 15_000): Promise<OcuProcess> {
    return new Promise((resolve, reject) => {
        const socket = connect({ host: "127.0.0.1", port });
        let buffer = Buffer.alloc(0);
        let done = false;
        const timer = setTimeout(() => fail(`it did not answer in ${Math.round(timeoutMs / 1000)} s`), timeoutMs);
        const fail = (why: string) => {
            if (!done) {
                done = true;
                clearTimeout(timer);
                socket.destroy();
                reject(new Error(`${label}: ${why}`));
            }
        };
        const heard = (chunk: Buffer) => {
            buffer = Buffer.concat([buffer, chunk]);
            const end = buffer.indexOf(10);

            if (end === -1) {
                if (buffer.length > 4096) {
                    fail("it answered something else");
                }

                return;
            }

            const line = buffer.subarray(0, end).toString("utf8").trim();
            const rest = buffer.subarray(end + 1);

            if (line !== "ok") {
                fail(line.startsWith("no ") ? `it refused: ${line.slice(3)}` : "it answered something else");

                return;
            }

            done = true;
            clearTimeout(timer);
            socket.off("data", heard);
            socket.off("close", closed);
            resolve(new BridgeConnection(socket, rest, label));
        };
        const closed = () => fail("it closed the connection");

        socket.once("connect", () => socket.write(`${JSON.stringify(hello)}\n`));
        socket.on("data", heard);
        socket.once("error", (error) => fail(error.message));
        socket.once("close", closed);
    });
}
