// This phone: notifications from the app's background service (src/server/phone-events.ts), running with the screen
// off (Android's battery optimisation), and backup and restore (src/server/backup.ts). The first two are the Android
// shell's (`window.PiPhoneApp`, MainActivity's bridge), only inside the app. Laid out as the Providers sheet.
import { useState } from "preact/hooks";
import { downloadFile } from "../download.js";
import { api, attempt, closeSheet, notify } from "../store.js";
import { html, Sheet } from "../ui.js";

export function PhoneSheet() {
    const app = window.PiPhoneApp;
    const [, refresh] = useState(0);
    const [restoring, setRestoring] = useState(false);
    const notifications = app?.notificationsEnabled?.() ?? null;
    const unrestricted = app?.runsUnrestricted?.() ?? null;

    // Back from Android's settings, the answers may have changed.
    const thenLook = (open) => {
        open();
        addEventListener("focus", () => refresh((count) => count + 1), { once: true });
    };
    const backup = () =>
        attempt(() => downloadFile("/api/backup", `pi-phone-backup-${new Date().toISOString().slice(0, 10)}.tar.gz`));
    const restore = (event) => {
        const file = event.currentTarget.files[0];

        event.currentTarget.value = "";

        if (
            !file ||
            !confirm(
                `Restore from ${file.name}?\n\nSessions, settings, machines, SSH keys and sign-ins become the backup's. What is here now is set aside in ~/.pi-phone-before-restore, not deleted. The server restarts.`,
            )
        ) {
            return;
        }

        attempt(async () => {
            setRestoring(true);

            try {
                await api("restore", file);
                notify("info", "Restored. Starting again with the backup…");
                // The backup has its own owner sign-in: the app signs in again once the server is back.
                setTimeout(() => (app?.reload ? app.reload() : location.reload()), 1500);
            } finally {
                setRestoring(false);
            }
        });
    };

    return html`<${Sheet} title="This phone" onClose=${closeSheet}>
        <div class="sheet-list">
            ${
                app &&
                html`<div class="provider">
                    <div>
                        <div>Notifications ${notifications && html`<span class="ok">✓</span>`}</div>
                        <div class="muted small">
                            When the app is not in front: a session finished, failed, or asks you to approve a command. Tap one to open its session.
                        </div>
                    </div>
                    <div class="provider-actions">
                        <button class=${`button small ${notifications ? "ghost" : "primary"}`} onClick=${() => thenLook(() => app.openNotificationSettings())}>
                            ${notifications ? "Settings" : "Turn on"}
                        </button>
                    </div>
                </div>
                <div class="provider">
                    <div>
                        <div>Run with the screen off ${unrestricted && html`<span class="ok">✓</span>`}</div>
                        <div class="muted small">
                            ${
                                unrestricted
                                    ? "Android lets pi run and reach the network while the screen is off."
                                    : "Android may pause pi's network while the screen is off, which stops long runs and machines. Allow pi to run unrestricted."
                            }
                        </div>
                    </div>
                    <div class="provider-actions">
                        ${!unrestricted && html`<button class="button small primary" onClick=${() => thenLook(() => app.runUnrestricted())}>Allow</button>`}
                    </div>
                </div>`
            }
            <div class="provider">
                <div>
                    <div>Backup</div>
                    <div class="muted small">
                        Sessions, settings, machines, themes, SSH keys, and sign-ins (Claude, GitHub) in one file, for a new phone or a reinstall. Keep it private: it can sign in as you.
                    </div>
                </div>
                <div class="provider-actions">
                    <button class="button small" onClick=${backup}>Back up</button>
                    <label class=${`button small ghost ${restoring ? "disabled" : ""}`}>
                        ${restoring ? "Restoring…" : "Restore…"}
                        <input type="file" accept=".gz,.tgz,application/gzip" hidden disabled=${restoring} onChange=${restore} />
                    </label>
                </div>
            </div>
        </div>
    <//>`;
}
