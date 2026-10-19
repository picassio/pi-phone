import assert from "node:assert/strict";
import { test } from "node:test";
// @ts-expect-error: the web's plain JS has no types.
import { windowsSetupScript } from "../web/windows-setup.js";

const KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIB0eV1 pi-phone's key";

test("the Windows setup script turns on sshd, opens the firewall, adds the key, and checks Git Bash", () => {
    const script: string = windowsSetupScript(`${KEY}\n`);

    assert.match(script, /if \(-not \(Get-Service sshd -ErrorAction SilentlyContinue\)\) \{/, "Windows Update only when sshd is not there");
    assert.match(script, /Add-WindowsCapability -Online -Name \$cap\.Name/);
    assert.match(script, /5 to 15 minutes/);
    assert.match(script, /if \(\$PSVersionTable\.PSEdition -eq 'Core'\) \{ Import-Module Dism -UseWindowsPowerShell/, "PowerShell 7 too");
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

test("anything but a public key is refused", () => {
    assert.throws(() => windowsSetupScript("ssh-ed25519 AAAA'; Remove-Item C:\\"), /Not an SSH public key/);
    assert.throws(() => windowsSetupScript("-----BEGIN OPENSSH PRIVATE KEY-----"), /Not an SSH public key/);
    assert.throws(() => windowsSetupScript(`${KEY}\nRemove-Item C:\\`), /Not an SSH public key/);
});
