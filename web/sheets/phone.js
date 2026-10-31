// This phone: notifications from the app's background service (src/server/phone-events.ts), running with the screen
// off (Android's battery optimisation), and backup and restore (src/server/backup.ts). The first two are the Android
// shell's (`window.PiPhoneApp`, MainActivity's bridge), only inside the app. Laid out as the Providers sheet.
import { useState } from "preact/hooks";
import { downloadFile } from "../download.js";
import { t } from "../i18n.js";
import { api, attempt, closeSheet, notify, store } from "../store.js";
import { html, Sheet, Switch } from "../ui.js";

/**
 * While Pi works (PP-283): the progress board in the pi notification, the floating bubble over other apps (Android asks
 * once for Display over other apps), and hiding the bubble when nothing runs. The server keeps them; the app's service
 * reads them with the board.
 */
function ProgressBoardSettings({ app, thenLook }) {
    const settings = store.state.server?.progressBoard;

    if (settings === undefined) {
        return null;
    }

    const set = (part, on) => attempt(() => api("settings", { progressBoard: { part, on } }));
    // The bubble needs Android's Display over other apps: asked first, turned on once it is allowed.
    const setBubble = (on) => {
        if (!on || app.overlayAllowed?.() !== false) {
            return set("bubble", on);
        }

        thenLook(() => app.askOverlay());
        addEventListener(
            "focus",
            () => {
                if (app.overlayAllowed?.()) {
                    void set("bubble", true);
                } else {
                    notify("warning", t("Android did not allow pi to display over other apps: the bubble stays off."));
                }
            },
            { once: true },
        );

        return undefined;
    };
    const row = (title, detail, on, change, part) => html`<div class="provider" data-part=${`progress-${part}`}>
        <div>
            <div>${title}</div>
            <div class="muted small">${detail}</div>
        </div>
        <div class="provider-actions"><${Switch} on=${on} label=${title} onChange=${() => change(!on)} /></div>
    </div>`;

    return html`<div class="group-title">${t("While Pi works")}</div>
        ${row(t("Progress in the notification"), t("Which sessions run and what each does, in the pi notification."), settings.notification, (on) => set("notification", on), "notification")}
        ${row(t("Floating board over other apps"), t("A pi bubble with how many work, and a badge when one waits for you; tap it for the board. Android asks once to let pi display over other apps."), settings.bubble, setBubble, "bubble")}
        ${settings.bubble && row(t("Hide it when nothing runs"), t("A minute after the last run ends; it comes back when one starts."), settings.hideIdle, (on) => set("hideIdle", on), "hideIdle")}`;
}

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
        attempt(() => downloadFile("api/backup", `pi-phone-backup-${new Date().toISOString().slice(0, 10)}.tar.gz`));
    const restore = (event) => {
        const file = event.currentTarget.files[0];

        event.currentTarget.value = "";

        if (
            !file ||
            !confirm(
                t("Restore from {name}?\n\nSessions, settings, machines, SSH keys and sign-ins become the backup's. What is here now is set aside in ~/.pi-phone-before-restore, not deleted. The server restarts.", { name: file.name }),
            )
        ) {
            return;
        }

        attempt(async () => {
            setRestoring(true);

            try {
                await api("restore", file);
                notify("info", t("Restored. Starting again with the backup…"));
                // The backup has its own owner sign-in: the app signs in again once the server is back.
                setTimeout(() => (app?.reload ? app.reload() : location.reload()), 1500);
            } finally {
                setRestoring(false);
            }
        });
    };

    // On the team server there is no phone: only the backup, named for what it is (PP-62).
    const gateway = store.state.server?.gateway === true;

    return html`<${Sheet} title=${gateway ? t("Backup") : t("This phone")} onClose=${closeSheet}>
        <div class="sheet-list">
            ${
                app &&
                html`<div class="provider">
                    <div>
                        <div>${t("Notifications")} ${notifications && html`<span class="ok">✓</span>`}</div>
                        <div class="muted small">
                            ${t("When the app is not in front: a session finished, failed, or asks you to approve a command. Tap one to open its session.")}
                        </div>
                    </div>
                    <div class="provider-actions">
                        <button class=${`button small ${notifications ? "ghost" : "primary"}`} onClick=${() => thenLook(() => app.openNotificationSettings())}>
                            ${notifications ? t("Settings") : t("Turn on")}
                        </button>
                    </div>
                </div>
                <${ProgressBoardSettings} app=${app} thenLook=${thenLook} />
                <div class="provider">
                    <div>
                        <div>${t("Run with the screen off")} ${unrestricted && html`<span class="ok">✓</span>`}</div>
                        <div class="muted small">
                            ${
                                unrestricted
                                    ? t("Android lets pi run and reach the network while the screen is off.")
                                    : t("Android may pause pi's network while the screen is off, which stops long runs and machines. Allow pi to run unrestricted.")
                            }
                        </div>
                    </div>
                    <div class="provider-actions">
                        ${!unrestricted && html`<button class="button small primary" onClick=${() => thenLook(() => app.runUnrestricted())}>${t("Allow")}</button>`}
                    </div>
                </div>`
            }
            <div class="provider">
                <div>
                    <div>${t("Backup")}</div>
                    <div class="muted small">
                        ${
                            gateway
                                ? t("Sessions, settings, machines, themes, SSH keys, and sign-ins (Claude, GitHub) in one file, to keep or to move. Keep it private: it can sign in as you.")
                                : t("Sessions, settings, machines, themes, SSH keys, and sign-ins (Claude, GitHub) in one file, for a new phone or a reinstall. Keep it private: it can sign in as you.")
                        }
                    </div>
                </div>
                <div class="provider-actions">
                    <button class="button small" onClick=${backup}>${t("Back up")}</button>
                    <label class=${`button small ghost ${restoring ? "disabled" : ""}`}>
                        ${restoring ? t("Restoring…") : t("Restore…")}
                        <input type="file" accept=".gz,.tgz,application/gzip" hidden disabled=${restoring} onChange=${restore} />
                    </label>
                </div>
            </div>
        </div>
    <//>`;
}
