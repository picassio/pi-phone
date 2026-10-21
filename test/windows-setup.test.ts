import assert from "node:assert/strict";
import { test } from "node:test";
// @ts-expect-error: the web's plain JS has no types.
import { windowsSetupScript } from "../web/windows-setup.js";

const KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIB0eV1 pi-phone's key";

test("the Windows setup script turns on sshd, opens the firewall, adds the key, and checks Git Bash", () => {
    const script: string = windowsSetupScript(`${KEY}\n`);

    assert.match(script, /if \(-not \(Get-Service sshd -ErrorAction SilentlyContinue\)\) \{/, "winget only when sshd is not there");
    assert.match(script, /winget install --id Microsoft\.OpenSSH\.Preview --exact/, "OpenSSH by winget, not Windows Update");
    assert.doesNotMatch(script, /Add-WindowsCapability/);
    assert.match(script, /Set-Service -Name sshd -StartupType Automatic/);
    assert.match(script, /New-NetFirewallRule -Name 'OpenSSH-Server-In-TCP' .* -LocalPort 22 -Action Allow -Profile Any/);
    assert.match(script, /administrators_authorized_keys/);
    assert.match(script, /icacls\.exe \$file \/inheritance:r \/grant '\*S-1-5-32-544:F' \/grant '\*S-1-5-18:F'/, "by SID: group names are localized");
    assert.match(script, /Add-Content -Path \$file -Value \$key -Encoding ascii/, "no byte-order mark, which sshd would not read");
    assert.match(script, /winget install --id Git\.Git/);
    assert.ok(script.includes("$key = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIB0eV1 pi-phone''s key'"), "the key, quoted for PowerShell");
    assert.ok(script.includes("Join-Path $env:ProgramData 'ssh\\sshd_config'"), "Windows paths with one backslash");
    assert.ok(script.includes("${env:ProgramFiles(x86)}\\Git\\bin\\bash.exe"));
});

test("OpenSSH installed but its services gone: registered, winget's 'already installed' no error, port 22 checked", () => {
    const script: string = windowsSetupScript(KEY);
    const step = script.slice(script.indexOf("1/5 OpenSSH Server"), script.indexOf("2/5 Firewall"));

    // The services are registered from winget's files when missing, before winget and after it.
    assert.ok(step.includes("$openssh = Join-Path $env:ProgramFiles 'OpenSSH'"));
    assert.match(step, /New-Service -Name sshd -DisplayName 'OpenSSH SSH Server' -BinaryPathName \('"' \+ \$sshd \+ '"'\) -StartupType Automatic/);
    assert.match(step, /sc\.exe privs sshd SeAssignPrimaryTokenPrivilege\/SeTcbPrivilege\/SeBackupPrivilege\/SeRestorePrivilege\/SeImpersonatePrivilege/);
    assert.match(step, /New-Service -Name ssh-agent .*ssh-agent\.exe|\$agent = Join-Path \$openssh 'ssh-agent\.exe'/);
    assert.match(step, /New-Service -Name ssh-agent -DisplayName 'OpenSSH Authentication Agent'/);
    assert.equal(step.match(/^\s*Register-OpenSsh$/gm)?.length, 2, "before winget, and again after it");
    // winget's exit code alone never stops it: only no sshd service after registering does.
    assert.doesNotMatch(step, /\$LASTEXITCODE -ne 0 -or/);
    assert.match(step, /\$wingetExit = \$LASTEXITCODE\n\s*Register-OpenSsh\n\s*if \(-not \(Get-Service sshd -ErrorAction SilentlyContinue\)\) \{ throw "winget could not install OpenSSH \(exit code \$wingetExit\)/);
    // Port 22 listening, else what sshd -t says, run by the service's own sshd.exe, its stderr not stopping the script.
    assert.match(step, /Get-NetTCPConnection -LocalPort 22 -State Listen -ErrorAction SilentlyContinue/);
    assert.ok(step.includes(`& { $ErrorActionPreference = 'Continue'; & $exe -t 2>&1 } | ForEach-Object { "$_" } | Out-String`), "stderr as plain lines");
    assert.match(step, /throw "\$why\. sshd -t says: /);
    assert.ok(!step.includes("\\\\"), "no doubled backslashes");
});

test("anything but a public key is refused", () => {
    assert.throws(() => windowsSetupScript("ssh-ed25519 AAAA'; Remove-Item C:\\"), /Not an SSH public key/);
    assert.throws(() => windowsSetupScript("-----BEGIN OPENSSH PRIVATE KEY-----"), /Not an SSH public key/);
    assert.throws(() => windowsSetupScript(`${KEY}\nRemove-Item C:\\`), /Not an SSH public key/);
});
