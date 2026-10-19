// A PowerShell script that prepares a Windows PC as a machine (src/server/machines.ts, DESIGN.md "Windows"): OpenSSH
// Server installed, started, and started with Windows; the firewall letting SSH (TCP 22) in on every network profile;
// the machine's public key where Windows' sshd reads it (an administrator's in administrators_authorized_keys, with the
// access rights sshd demands); Git for Windows, whose Git Bash runs Pi's commands there; and the addresses to give
// pi-phone. Pasted into PowerShell (Windows PowerShell 5.1 or PowerShell 7) run as administrator; every step may run again, and a failed one stops it, saying why.
// No imports: the Machines sheet shows it, and the tests read it in Node.

/** A PowerShell single-quoted string. */
const quote = (text) => `'${String(text).replaceAll("'", "''")}'`;

/** The script for one public key (`ssh-ed25519 AAAA… comment`). */
export function windowsSetupScript(publicKey) {
    const key = String(publicKey).trim();

    if (!/^(ssh-[a-z0-9-]+|ecdsa-sha2-[a-z0-9-]+|sk-[a-z0-9@.-]+) [A-Za-z0-9+/]+={0,2}( [^\r\n]*)?$/.test(key)) {
        throw new Error("Not an SSH public key");
    }

    return `# pi-phone: prepare this PC as a machine. Paste into PowerShell run as administrator,
# signed in as the account pi-phone will use.
& {
$ErrorActionPreference = 'Stop'
$key = ${quote(key)}
$me = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
if (-not $me.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Run PowerShell as administrator, then paste this again.' }

Write-Host '1/5 OpenSSH Server'
if (-not (Get-Service sshd -ErrorAction SilentlyContinue)) {
    Write-Host '    Installing it from Windows Update: this often takes 5 to 15 minutes, with no progress shown.'
    Write-Host '    If Windows Update is blocked here (a work PC), stop this, run: winget install Microsoft.OpenSSH.Preview, then paste this again.'
    # PowerShell 7 cannot load the DISM module itself ("Class not registered"): it runs in Windows PowerShell for it.
    if ($PSVersionTable.PSEdition -eq 'Core') { Import-Module Dism -UseWindowsPowerShell -WarningAction SilentlyContinue }
    $cap = Get-WindowsCapability -Online -Name 'OpenSSH.Server*' | Select-Object -First 1
    if ($null -eq $cap) { throw 'This Windows has no OpenSSH Server to install (Windows 10 1809 or later has it): run winget install Microsoft.OpenSSH.Preview, then paste this again.' }
    if ($cap.State -ne 'Installed') { Add-WindowsCapability -Online -Name $cap.Name | Out-Null }
}
Set-Service -Name sshd -StartupType Automatic
Start-Service sshd

Write-Host '2/5 Firewall: SSH (TCP 22) in'
if (Get-NetFirewallRule -Name 'OpenSSH-Server-In-TCP' -ErrorAction SilentlyContinue) {
    Set-NetFirewallRule -Name 'OpenSSH-Server-In-TCP' -Enabled True -Direction Inbound -Action Allow -Profile Any
} else {
    New-NetFirewallRule -Name 'OpenSSH-Server-In-TCP' -DisplayName 'OpenSSH Server (sshd)' -Enabled True -Direction Inbound -Protocol TCP -LocalPort 22 -Action Allow -Profile Any | Out-Null
}

Write-Host "3/5 pi-phone's key"
$config = Join-Path $env:ProgramData 'ssh\\sshd_config'
$admins = (Test-Path $config) -and (Select-String -Path $config -Pattern '^\\s*Match\\s+Group\\s+administrators' -Quiet)
if ($admins) {
    $file = Join-Path $env:ProgramData 'ssh\\administrators_authorized_keys'
} else {
    $folder = Join-Path $env:USERPROFILE '.ssh'
    New-Item -ItemType Directory -Force -Path $folder | Out-Null
    $file = Join-Path $folder 'authorized_keys'
}
if (-not ((Test-Path $file) -and (Select-String -Path $file -SimpleMatch $key -Quiet))) {
    Add-Content -Path $file -Value $key -Encoding ascii
}
if ($admins) {
    # sshd ignores this file unless only Administrators and SYSTEM may change it.
    icacls.exe $file /inheritance:r /grant '*S-1-5-32-544:F' /grant '*S-1-5-18:F' | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Could not set the access rights of $file." }
}

Write-Host '4/5 Git for Windows (Git Bash runs Pi''s commands)'
$bash = @("$env:ProgramFiles\\Git\\bin\\bash.exe", "\${env:ProgramFiles(x86)}\\Git\\bin\\bash.exe") | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $bash) {
    if (-not (Get-Command winget -ErrorAction SilentlyContinue)) { throw 'Install Git for Windows from https://git-scm.com/download/win, then paste this again.' }
    winget install --id Git.Git --exact --source winget --silent --accept-package-agreements --accept-source-agreements
    if ($LASTEXITCODE -ne 0) { throw 'winget could not install Git for Windows: install it from https://git-scm.com/download/win, then paste this again.' }
}

Write-Host '5/5 Done. In pi-phone, add this PC with one of these addresses:'
Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' } | ForEach-Object { Write-Host ("    {0}@{1}   ({2})" -f $env:USERNAME, $_.IPAddress, $_.InterfaceAlias) }
}
`;
}
