/**
 * Chrome Remote Desktop as a machine tool (PP-263), Windows first: Google's host, so the owner can unlock a locked
 * Windows machine from their phone. Pi's computer use cannot pass the Windows lock screen (the secure desktop: ocu reads
 * windows there, but clicks and keys do not reach them); CRD's host is a service that can.
 *
 * - Install: the machine downloads Google's MSI itself (pi-phone never passes it on) into `~/.pi/mobile/crd`, checks its
 *   Authenticode signature (Status Valid, signer "CN=Google LLC, …"), and installs it with msiexec, silently, with its log
 *   beside it. The address is Google's rolling one (always the newest build), so a pinned sha256 would break with each
 *   release: the signature is the check instead, the one exception to the machine tools' sha256 rule.
 * - Connect: Google's headless flow (https://remotedesktop.google.com/headless) gives the owner a command with a
 *   single-use code (`--code`, minutes long) and a redirect address (`--redirect-url`). The owner pastes it on a card with a
 *   PIN of 6+ digits; the server takes the code and the redirect alone (the redirect only on remotedesktop.google.com) and
 *   runs remoting_start_host with the machine's Windows name. The values go to the machine as variables of pi-env's
 *   command (its protocol, never a command line), and the PIN to remoting_start_host's input (it asks for it twice when
 *   `--pin` is not given). The code and the redirect must be its arguments (it reads no other way): they are on its command
 *   line while it runs, a few seconds, and the code works once. Nothing is kept, logged, or shown to Pi; every message
 *   has them removed.
 * - Status: not installed, installed but not connected, connected (the `chromoting` service runs and a host config exists).
 * - Remove: the host stopped, the MSI removed by its product code (`msiexec /x`), and its host config deleted.
 *
 * Linux and macOS come later. Scripts run with Git Bash through pi-env's daemon, which starts Windows PowerShell (as
 * `computer-windows.ts` does: Windows' sshd's own shell may be cmd.exe).
 */
import type { Machine } from "./machines.ts";

/** Google's host installer: a rolling address, always the newest build. Checked by its signature, not a sum. */
export const CRD_MSI_URL = "https://dl.google.com/edgedl/chrome-remote-desktop/chromeremotedesktophost.msi";
/** The MSI's Authenticode signer: its subject is this, or starts with it and a comma. */
export const CRD_SIGNER = "CN=Google LLC";
/** Where the download and msiexec's logs go, under the machine's (Git Bash) home. */
export const CRD_DIR = ".pi/mobile/crd";
/** Google's page for connecting a host without its desktop. */
export const CRD_HEADLESS = "https://remotedesktop.google.com/headless";
/** The only host a pasted command's redirect may name. */
export const CRD_REDIRECT_HOST = "remotedesktop.google.com";
/** The installed product's name and publisher, as Windows lists it. */
export const CRD_PRODUCT = "Chrome Remote Desktop Host";
/** remoting_start_host's own rule: digits only, at least six (`pin_validator.cc`). */
export const CRD_PIN_MIN = 6;
const CRD_PIN_MAX = 32;

/** How a machine stands for Chrome Remote Desktop, as its status script says. */
export type CrdState = {
    installed: boolean;
    /** The installed version, or null. */
    version: string | null;
    /** The MSI's product code (`{GUID}`), or null. */
    productCode: string | null;
    /** The `chromoting` service's status (Running, Stopped, …), or null when there is none. */
    service: string | null;
    /** A host config exists (`%ProgramData%\Google\Chrome Remote Desktop\host.json`): it is registered to an account. */
    config: boolean;
};

export type CrdWord = "not installed" | "installed, not connected" | "connected";

export const crdConnected = (state: CrdState) => state.installed && state.service === "Running" && state.config;

export function crdWord(state: CrdState): CrdWord {
    return !state.installed ? "not installed" : crdConnected(state) ? "connected" : "installed, not connected";
}

/** The PowerShell lines that find the host: `$crdProduct`, `$crdService`, `$crdConfig`. Shared with `computer-windows.ts`. */
export const CRD_LOOK = [
    "$crdKeys = @('HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*', 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*')",
    `$crdProduct = @(Get-ItemProperty -Path $crdKeys -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -eq '${CRD_PRODUCT}' -and $_.Publisher -eq 'Google LLC' }) | Select-Object -First 1`,
    "$crdService = Get-Service -Name chromoting -ErrorAction SilentlyContinue",
    "$crdConfig = Test-Path -LiteralPath (Join-Path $env:ProgramData 'Google\\Chrome Remote Desktop\\host.json')",
];

/** The state's word in PowerShell, from `CRD_LOOK`'s variables (for `computer-windows.ts`'s state line). */
export const CRD_WORD_PS =
    "$(if (-not $crdProduct) { 'not installed' } elseif ($crdService -and [string]$crdService.Status -eq 'Running' -and $crdConfig) { 'connected' } else { 'installed, not connected' })";

/** The line a script ends with: `crd {json}` (`parseCrdState`). The look is done afresh first. */
const STATE = [
    ...CRD_LOOK,
    "Write-Output ('crd ' + (ConvertTo-Json @{ installed = [bool]$crdProduct; version = $(if ($crdProduct) { [string]$crdProduct.DisplayVersion } else { $null }); productCode = $(if ($crdProduct) { [string]$crdProduct.PSChildName } else { $null }); service = $(if ($crdService) { [string]$crdService.Status } else { $null }); config = [bool]$crdConfig } -Compress))",
];

export function parseCrdState(out: string): CrdState {
    const line = /^crd (\{.*\})\s*$/m.exec(out)?.[1];

    if (line === undefined) {
        throw new Error(`the machine did not say how Chrome Remote Desktop stands: ${out.trim().split("\n").slice(-3).join(" ") || "no answer"}`);
    }

    const state = JSON.parse(line) as Record<string, unknown>;
    const text = (value: unknown) => (typeof value === "string" && value !== "" ? value : null);

    return { installed: state.installed === true, version: text(state.version), productCode: text(state.productCode), service: text(state.service), config: state.config === true };
}

/** A PowerShell script as `-EncodedCommand` takes it: UTF-16LE, base64. */
const encode = (script: string) => Buffer.from(script, "utf16le").toString("base64");

/** Whether pi-phone's account there has administrator rights now (an elevated token: ssh gives an administrator one). */
const ADMIN = "$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)";

/** How the scripts end when they do not do it (the reason is on a `fail …` line before). */
export const CRD_EXIT = { notAdmin: 30, unsigned: 31, msiexec: 32, download: 33, product: 34, values: 40, notInstalled: 41, noProgram: 42, timeout: 43 } as const;

/**
 * Git Bash, through pi-env's daemon: the folder for the download and logs as a Windows path, then Windows PowerShell with
 * the script. Its first line names the script (`# pi-phone-crd <kind>`).
 */
const shellFor = (kind: string, lines: string[]) =>
    [
        `# pi-phone-crd ${kind}`,
        'if ! command -v cygpath >/dev/null 2>&1 || ! command -v powershell.exe >/dev/null 2>&1; then echo "Chrome Remote Desktop is set up through Git Bash and Windows PowerShell, which this machine lacks."; exit 9; fi',
        `export PI_CRD="$(cygpath -w "$HOME/${CRD_DIR}")"`,
        `exec powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ${encode(["$ErrorActionPreference = 'Stop'", "$ProgressPreference = 'SilentlyContinue'", ...lines].join("\n"))}`,
    ].join("\n");

/** The status script: its last line is `crd {json}`. Reads only. */
export function statusScript(): string {
    return shellFor("status", STATE);
}

/**
 * The install script: nothing when it is installed already (`already`); else, with administrator rights, the MSI
 * downloaded, its signature checked, and msiexec run silently with its log in `~/.pi/mobile/crd/install.log`. The
 * download goes after (msiexec keeps its own copy). Its last line is `crd {json}`.
 */
export function installScript(): string {
    return shellFor("install", [
        ...CRD_LOOK,
        "if ($crdProduct) { Write-Output 'already' } else {",
        `  ${ADMIN}`,
        `  if (-not $admin) { Write-Output 'fail admin'; exit ${CRD_EXIT.notAdmin} }`,
        "  New-Item -ItemType Directory -Force -Path $env:PI_CRD | Out-Null",
        "  $msi = Join-Path $env:PI_CRD 'chromeremotedesktophost.msi'",
        "  $log = Join-Path $env:PI_CRD 'install.log'",
        "  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12",
        `  try { Invoke-WebRequest -UseBasicParsing -Uri '${CRD_MSI_URL}' -OutFile $msi } catch { Write-Output ('fail download ' + $_.Exception.Message); exit ${CRD_EXIT.download} }`,
        "  $sig = Get-AuthenticodeSignature -LiteralPath $msi",
        "  $subject = $(if ($sig.SignerCertificate) { [string]$sig.SignerCertificate.Subject } else { '' })",
        `  if ([string]$sig.Status -ne 'Valid' -or -not ($subject -eq '${CRD_SIGNER}' -or $subject.StartsWith('${CRD_SIGNER},'))) {`,
        "    Remove-Item -LiteralPath $msi -Force",
        `    Write-Output ('fail signature ' + [string]$sig.Status + ' ' + $subject); exit ${CRD_EXIT.unsigned}`,
        "  }",
        "  $p = Start-Process -FilePath msiexec.exe -ArgumentList ('/i \"' + $msi + '\" /qn /norestart /l*v \"' + $log + '\"') -Wait -PassThru",
        "  Remove-Item -LiteralPath $msi -Force",
        "  Write-Output ('msiexec ' + $p.ExitCode)",
        `  if ($p.ExitCode -ne 0 -and $p.ExitCode -ne 3010) { Write-Output ('fail msiexec ' + $p.ExitCode); exit ${CRD_EXIT.msiexec} }`,
        "}",
        ...STATE,
    ]);
}

/**
 * The connect script. The code, the redirect and the PIN come as variables of the command (`PI_CRD_CODE`,
 * `PI_CRD_REDIRECT`, `PI_CRD_PIN`), taken out of the environment before anything starts; the PIN goes to
 * remoting_start_host's input, twice (its prompt and its confirmation), the code and the redirect as its arguments (it
 * takes them no other way), with `--name` the machine's Windows name. Its output comes back with the values removed,
 * then `crd {json}`.
 */
export function connectScript(): string {
    return shellFor("connect", [
        "$code = $env:PI_CRD_CODE; $redirect = $env:PI_CRD_REDIRECT; $pin = $env:PI_CRD_PIN",
        "$env:PI_CRD_CODE = $null; $env:PI_CRD_REDIRECT = $null; $env:PI_CRD_PIN = $null",
        `if (-not $code -or -not $redirect -or -not $pin) { Write-Output 'fail values'; exit ${CRD_EXIT.values} }`,
        ...CRD_LOOK,
        `if (-not $crdProduct) { Write-Output 'fail not-installed'; exit ${CRD_EXIT.notInstalled} }`,
        "$exe = Join-Path ${env:ProgramFiles(x86)} 'Google\\Chrome Remote Desktop\\CurrentVersion\\remoting_start_host.exe'",
        `if (-not (Test-Path -LiteralPath $exe)) { Write-Output 'fail no-program'; exit ${CRD_EXIT.noProgram} }`,
        "$info = New-Object System.Diagnostics.ProcessStartInfo",
        "$info.FileName = $exe",
        "$info.Arguments = '--code=\"' + $code + '\" --redirect-url=\"' + $redirect + '\" --name=\"' + $env:COMPUTERNAME + '\"'",
        "$info.UseShellExecute = $false",
        "$info.CreateNoWindow = $true",
        "$info.RedirectStandardInput = $true",
        "$info.RedirectStandardOutput = $true",
        "$info.RedirectStandardError = $true",
        "$p = [System.Diagnostics.Process]::Start($info)",
        "$said = $p.StandardOutput.ReadToEndAsync()",
        "$err = $p.StandardError.ReadToEndAsync()",
        "$p.StandardInput.WriteLine($pin)",
        "$p.StandardInput.WriteLine($pin)",
        "$p.StandardInput.Close()",
        `if (-not $p.WaitForExit(120000)) { try { $p.Kill() } catch { }; Write-Output 'fail timeout'; exit ${CRD_EXIT.timeout} }`,
        "$text = ($said.Result + [char]10 + $err.Result).Replace($code, '[removed]').Replace($redirect, '[removed]').Replace($pin, '[removed]')",
        "$code = $null; $redirect = $null; $pin = $null",
        "Write-Output ('start-host ' + $p.ExitCode)",
        "Write-Output $text",
        ...STATE,
    ]);
}

/**
 * The remove script: with administrator rights, the host stopped, the MSI removed by its product code from the registry
 * (`msiexec /x`, its log in `~/.pi/mobile/crd/remove.log`), and the host config deleted. Nothing when it is not
 * installed (`already-gone`). Its last line is `crd {json}`.
 */
export function removeScript(): string {
    return shellFor("remove", [
        ...CRD_LOOK,
        "if (-not $crdProduct) { Write-Output 'already-gone' } else {",
        `  ${ADMIN}`,
        `  if (-not $admin) { Write-Output 'fail admin'; exit ${CRD_EXIT.notAdmin} }`,
        "  $product = [string]$crdProduct.PSChildName",
        `  if ($product -notmatch '^\\{[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}\\}$') { Write-Output 'fail product'; exit ${CRD_EXIT.product} }`,
        "  if ($crdService -and [string]$crdService.Status -ne 'Stopped') { Stop-Service -Name chromoting -Force }",
        "  New-Item -ItemType Directory -Force -Path $env:PI_CRD | Out-Null",
        "  $log = Join-Path $env:PI_CRD 'remove.log'",
        "  $p = Start-Process -FilePath msiexec.exe -ArgumentList ('/x ' + $product + ' /qn /norestart /l*v \"' + $log + '\"') -Wait -PassThru",
        "  Write-Output ('msiexec ' + $p.ExitCode)",
        `  if ($p.ExitCode -ne 0 -and $p.ExitCode -ne 3010) { Write-Output ('fail msiexec ' + $p.ExitCode); exit ${CRD_EXIT.msiexec} }`,
        "  foreach ($name in @('host.json', 'host_unprivileged.json')) {",
        "    $file = Join-Path $env:ProgramData ('Google\\Chrome Remote Desktop\\' + $name)",
        "    if (Test-Path -LiteralPath $file) { Remove-Item -LiteralPath $file -Force }",
        "  }",
        "}",
        ...STATE,
    ]);
}

/** What msiexec's exit code means, for a person. */
export function msiexecMeaning(code: number): string {
    switch (code) {
        case 1602:
        case 1223:
            return "it was cancelled (a Windows UAC prompt was declined)";
        case 1603:
            return "a fatal error during installation";
        case 1618:
            return "another installation is running on the machine: try again when it ends";
        case 1619:
            return "the package could not be opened";
        case 1625:
        case 1643:
            return "Windows' policy forbids this installation";
        case 1633:
            return "the package does not support this Windows";
        case 740:
        case 1925:
        case 1730:
            return "it needs administrator rights that Windows' UAC did not give this session";
        default:
            return "see its log";
    }
}

/** A `fail …` line of a script's output: its kind and the rest. */
function failure(out: string): { kind: string; rest: string } | undefined {
    const found = /^fail (\S+) ?(.*)$/m.exec(out);

    return found === null ? undefined : { kind: found[1]!, rest: found[2]!.trim() };
}

/** Each value in `values` replaced in `text` (longest first, so a value inside another goes with it). */
export function scrub(text: string, values: readonly string[]): string {
    let clean = text;

    for (const value of [...values].filter((each) => each.length > 0).sort((a, b) => b.length - a.length)) {
        clean = clean.split(value).join("[removed]");
    }

    return clean;
}

/** An error whose message is already without the owner's values (`ChromeRemoteDesktop.connect`). */
export class CrdError extends Error {}

/** One `--name=value` of a pasted command: quoted with " or ', or a bare word. Exactly one. */
function option(command: string, name: string, missing: string): string {
    const found = [...command.matchAll(new RegExp(`(?:^|\\s)--${name}=(?:"([^"]*)"|'([^']*)'|([^\\s"']+))`, "g"))];

    if (found.length !== 1) {
        throw new CrdError(found.length === 0 ? missing : `The command has --${name} more than once: copy it again from ${CRD_HEADLESS}.`);
    }

    return found[0]![1] ?? found[0]![2] ?? found[0]![3]!;
}

/**
 * The code and the redirect address of the command Google's headless page shows (`--code="4/…"`,
 * `--redirect-url="https://remotedesktop.google.com/…"`), checked: the code as Google's, the redirect on
 * remotedesktop.google.com alone, over https, with a plain path. Nothing else of the command is used. Errors never hold
 * them.
 */
export function extractHostCommand(command: unknown): { code: string; redirect: string } {
    if (typeof command !== "string" || command.trim() === "") {
        throw new CrdError(`Paste the command Google shows under "Windows (PowerShell)" at ${CRD_HEADLESS}.`);
    }

    if (command.length > 4000) {
        throw new CrdError(`That is longer than Google's command: copy the one under "Windows (PowerShell)" at ${CRD_HEADLESS}.`);
    }

    const code = option(command, "code", `The command has no --code: copy the whole command under "Windows (PowerShell)" at ${CRD_HEADLESS}.`);
    const redirect = option(command, "redirect-url", `The command has no --redirect-url: copy the whole command under "Windows (PowerShell)" at ${CRD_HEADLESS}.`);

    if (!/^4\/[A-Za-z0-9_-]{20,512}$/.test(code)) {
        throw new CrdError(`The command's code is not one of Google's (4/…): copy the whole command again from ${CRD_HEADLESS}.`);
    }

    let url: URL;

    try {
        url = new URL(redirect);
    } catch {
        throw new CrdError(`The command's redirect address is not an address: copy the whole command again from ${CRD_HEADLESS}.`);
    }

    if (url.protocol !== "https:" || url.hostname !== CRD_REDIRECT_HOST || url.port !== "" || url.username !== "" || url.password !== "" || redirect !== `${url.origin}${url.pathname}` || !/^\/[A-Za-z0-9_./-]*$/.test(url.pathname)) {
        throw new CrdError(`The command's redirect address is not Google's (https://${CRD_REDIRECT_HOST}/…), so it was refused: copy the command from ${CRD_HEADLESS} itself.`);
    }

    return { code, redirect };
}

/** The PIN, checked as remoting_start_host checks it (6+ digits) and against its confirmation. Errors never hold them. */
export function checkPin(pin: unknown, confirm: unknown): string {
    if (typeof pin !== "string" || !/^[0-9]+$/.test(pin) || pin.length < CRD_PIN_MIN) {
        throw new CrdError(`Choose a PIN of at least ${CRD_PIN_MIN} digits, digits only.`);
    }

    if (pin.length > CRD_PIN_MAX) {
        throw new CrdError(`Choose a PIN of at most ${CRD_PIN_MAX} digits.`);
    }

    if (confirm !== pin) {
        throw new CrdError("The two PINs differ: type the same PIN twice.");
    }

    return pin;
}

/** What the card shows before installing it on a machine (Pi's `computer_control setup` with crd: install). */
export function installPlan(name: string): string {
    return [
        `On ${name}, install Chrome Remote Desktop's host (Google's), so you can unlock and see it from your phone:`,
        `- ${name} downloads Google's installer itself (${CRD_MSI_URL}) into ~/${CRD_DIR}, and checks it is signed by Google (Authenticode, signer ${CRD_SIGNER}); a download not signed by Google is deleted and nothing is installed;`,
        `- msiexec installs it silently, for the whole machine (it needs administrator rights), with its log in ~/${CRD_DIR}/install.log. It adds the service "Chrome Remote Desktop Service" (chromoting).`,
        "It is not connected to any account until you connect it on another card (your Google account, a code from Google and a PIN you choose).",
    ].join("\n");
}

/** What the card shows before removing it. */
export function removePlan(name: string): string {
    return [
        `On ${name}, remove Chrome Remote Desktop:`,
        "- the host is stopped, and msiexec removes it by its product code (msiexec /x), with its log in ~/" + `${CRD_DIR}/remove.log;`,
        "- its host config (the connection to your Google account) is deleted from the machine.",
        "The machine stays in your list at https://remotedesktop.google.com/access, offline, until you delete it there.",
    ].join("\n");
}

/** How a machine is run on: its script with Git Bash, the variables given set for it alone; its exit code and output. */
export type CrdRun = (machine: Machine & { remote: NonNullable<Machine["remote"]> }, script: string, timeoutSeconds: number, env?: Record<string, string>) => Promise<{ code: number; out: string }>;

export type CrdInstallResult = { ok: boolean; said: string; state?: CrdState };

export class ChromeRemoteDesktop {
    readonly #machine: (id: string) => Machine & { remote: NonNullable<Machine["remote"]> };
    readonly #run: CrdRun;

    constructor(machine: (id: string) => Machine & { remote: NonNullable<Machine["remote"]> }, run: CrdRun) {
        this.#machine = machine;
        this.#run = run;
    }

    /** Whether it is offered on a machine: its own (not a team machine), Windows x64. */
    static supports(machine: Pick<Machine, "remote" | "team">): boolean {
        return machine.team === undefined && machine.remote?.platform === "windows" && machine.remote.arch === "x64";
    }

    /** A connected Windows machine of the owner's, or why not. */
    #windows(id: string): Machine & { remote: NonNullable<Machine["remote"]> } {
        let machine: Machine & { remote: NonNullable<Machine["remote"]> };

        try {
            machine = this.#machine(id);
        } catch (error) {
            throw new CrdError(error instanceof Error ? error.message : String(error));
        }

        if (machine.team !== undefined) {
            throw new CrdError(`Chrome Remote Desktop connects a machine to your own Google account: not for a team machine (${machine.name}).`);
        }

        if (machine.remote.platform !== "windows") {
            throw new CrdError(`Chrome Remote Desktop is for Windows machines for now (Linux and macOS come later); ${machine.name} is ${machine.remote.platform}.`);
        }

        if (machine.remote.arch !== "x64") {
            throw new CrdError(`Chrome Remote Desktop is for Windows on x64 for now; ${machine.name} is Windows on ${machine.remote.arch}.`);
        }

        return machine;
    }

    async status(id: string): Promise<CrdState> {
        const machine = this.#windows(id);
        const { out } = await this.#run(machine, statusScript(), 60);

        try {
            return parseCrdState(out);
        } catch (error) {
            throw new CrdError(`${machine.name}: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    /** Install it (installed already counts): what happened, said for a person. */
    async install(id: string): Promise<CrdInstallResult> {
        const machine = this.#windows(id);
        const { code, out } = await this.#run(machine, installScript(), 900);
        const failed = failure(out);

        if (code !== 0 || failed !== undefined) {
            return { ok: false, said: this.#installFailure(machine.name, code, out, failed) };
        }

        const state = parseCrdState(out);

        if (!state.installed) {
            return { ok: false, said: `msiexec ended, but Windows does not list ${CRD_PRODUCT} on ${machine.name}: see ~/${CRD_DIR}/install.log there.`, state };
        }

        const reboot = /^msiexec 3010\s*$/m.test(out) ? " Windows asks for a restart to finish it." : "";

        return {
            ok: true,
            state,
            said: /^already\s*$/m.test(out)
                ? `Chrome Remote Desktop ${state.version ?? ""} was installed on ${machine.name} already: ${crdWord(state)}.`.replace("  ", " ")
                : `Chrome Remote Desktop ${state.version ?? ""} is installed on ${machine.name} (Google's, its signature checked): ${crdWord(state)}.${reboot}`.replace("  ", " "),
        };
    }

    #installFailure(name: string, code: number, out: string, failed: { kind: string; rest: string } | undefined): string {
        switch (failed?.kind) {
            case "admin":
                return `pi-phone's account on ${name} has no administrator rights in this session (it is not an administrator, or Windows' UAC withholds them): Chrome Remote Desktop's host installs for the whole machine, which needs them. Nothing was installed.`;
            case "download":
                return `${name} could not download Google's installer (${CRD_MSI_URL}): ${failed.rest}. Nothing was installed.`;
            case "signature":
                return `The download on ${name} is not signed by Google (signature ${failed.rest || "missing"}), so it was deleted and nothing was installed.`;
            case "msiexec": {
                const exit = Number(failed.rest);

                return `msiexec could not install it on ${name}: exit ${failed.rest}, ${msiexecMeaning(exit)}. Its log is ~/${CRD_DIR}/install.log there.`;
            }
            default:
                return `Chrome Remote Desktop was not installed on ${name}: ${out.trim().split("\n").slice(-3).join(" ") || `exit ${code}`}`;
        }
    }

    /**
     * Connect it to the owner's Google account with Google's pasted command and a PIN (checked first): its state then.
     * Throws a `CrdError` that never holds the command, the code, the redirect or the PIN.
     */
    async connect(id: string, command: unknown, pin: unknown, confirm: unknown): Promise<CrdState> {
        const machine = this.#windows(id);
        const { code, redirect } = extractHostCommand(command);
        const checked = checkPin(pin, confirm);
        const values = [typeof command === "string" ? command.trim() : "", code, redirect, checked];
        const clean = (text: string) => scrub(text, values);
        let result: { code: number; out: string };

        try {
            result = await this.#run(machine, connectScript(), 180, { PI_CRD_CODE: code, PI_CRD_REDIRECT: redirect, PI_CRD_PIN: checked });
        } catch (error) {
            throw new CrdError(clean(`${machine.name}: ${error instanceof Error ? error.message : String(error)}`));
        }

        const out = clean(result.out);
        const failed = failure(out);

        if (failed?.kind === "not-installed") {
            throw new CrdError(`Chrome Remote Desktop is not installed on ${machine.name}: install it first (Settings › Machines › Install tools).`);
        }

        if (failed?.kind === "no-program") {
            throw new CrdError(`remoting_start_host.exe is not where Chrome Remote Desktop's installer puts it on ${machine.name}: remove it and install it again.`);
        }

        if (failed?.kind === "timeout") {
            throw new CrdError(`remoting_start_host did not finish on ${machine.name} in 2 minutes: it was stopped. Get a new code at ${CRD_HEADLESS} and try again.`);
        }

        if (failed !== undefined || result.code !== 0) {
            throw new CrdError(`Chrome Remote Desktop could not be connected on ${machine.name}: ${out.trim().split("\n").slice(-3).join(" ") || `exit ${result.code}`}`);
        }

        let state: CrdState;

        try {
            state = parseCrdState(out);
        } catch (error) {
            throw new CrdError(clean(`${machine.name}: ${error instanceof Error ? error.message : String(error)}`));
        }

        if (/Host started successfully/.test(out) && crdConnected(state)) {
            return state;
        }

        if (/OAuth error/i.test(out)) {
            throw new CrdError(
                `Google refused the code: it has expired or was used already (each works once, for a few minutes). Get a new one at ${CRD_HEADLESS} (Begin, Next, Authorize), copy the "Windows (PowerShell)" command again, and paste it.`,
            );
        }

        if (/network error/i.test(out)) {
            throw new CrdError(`${machine.name} could not reach Google to register the host (a network error). Check its internet connection, then get a new code at ${CRD_HEADLESS}.`);
        }

        if (/Permission denied/i.test(out)) {
            throw new CrdError(`remoting_start_host was denied on ${machine.name}: pi-phone's account there needs administrator rights.`);
        }

        if (/Host started successfully/.test(out)) {
            throw new CrdError(`remoting_start_host said the host started on ${machine.name}, but it is ${crdWord(state)} (service ${state.service ?? "missing"}, host config ${state.config ? "present" : "missing"}).`);
        }

        const said = out
            .split("\n")
            .filter((line) => line.trim() !== "" && !line.startsWith("crd ") && !line.startsWith("start-host ") && !/^Enter (a|the same) PIN/.test(line.trim()))
            .slice(-3)
            .join(" ");

        throw new CrdError(`remoting_start_host did not connect ${machine.name}: ${said || "it said nothing"}`);
    }

    /** Stop and remove it, and its host config: its state then. */
    async remove(id: string): Promise<CrdState> {
        const machine = this.#windows(id);
        const { code, out } = await this.#run(machine, removeScript(), 600);
        const failed = failure(out);

        if (failed?.kind === "admin") {
            throw new CrdError(`pi-phone's account on ${machine.name} has no administrator rights in this session, which removing Chrome Remote Desktop needs. Nothing was removed.`);
        }

        if (failed?.kind === "product") {
            throw new CrdError(`Windows lists Chrome Remote Desktop on ${machine.name} without a product code msiexec can remove it by. Nothing was removed.`);
        }

        if (failed?.kind === "msiexec") {
            throw new CrdError(`msiexec could not remove it on ${machine.name}: exit ${failed.rest}, ${msiexecMeaning(Number(failed.rest))}. Its log is ~/${CRD_DIR}/remove.log there.`);
        }

        if (code !== 0 || failed !== undefined) {
            throw new CrdError(`Chrome Remote Desktop was not removed from ${machine.name}: ${out.trim().split("\n").slice(-3).join(" ") || `exit ${code}`}`);
        }

        const state = parseCrdState(out);

        if (state.installed) {
            throw new CrdError(`msiexec ended, but Windows still lists ${CRD_PRODUCT} on ${machine.name}: see ~/${CRD_DIR}/remove.log there.`);
        }

        return state;
    }
}
