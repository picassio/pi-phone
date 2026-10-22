// An update the Android app found (MainActivity's check): offered here, in the app's own sheet, rather than in Android's
// dialog. The app hands it over with `globalThis.__piPhoneUpdate(offer)` (or the page asks for one waiting with
// `PiPhoneApp.pendingUpdate()` once it starts); Update now and Later go back through the bridge.
import { t } from "../i18n.js";
import { closeSheet, openSheet } from "../store.js";
import { html, Sheet } from "../ui.js";

/** Take an offer from the app: open the sheet with it. */
const offered = (offer) => {
    if (offer && typeof offer === "object" && (offer.kind === "runtime" || offer.kind === "apk")) {
        openSheet({ type: "update", offer });
    }
};

/** In the Android app: listen for updates it finds, and show one it found before this page started. */
export function installAppUpdates() {
    const app = globalThis.PiPhoneApp;

    globalThis.__piPhoneUpdate = offered;

    if (typeof app?.pendingUpdate === "function") {
        const waiting = app.pendingUpdate();

        if (waiting) {
            offered(JSON.parse(waiting));
        }
    }
}

export function UpdateSheet({ offer }) {
    const app = globalThis.PiPhoneApp;
    const later = () => {
        app?.dismissUpdate?.();
        closeSheet();
    };
    const apk = offer.kind === "apk";

    return html`<${Sheet} title=${apk ? t("App update available") : t("Update available")} onClose=${later}>
        <div class="pu-version">
            <span class="pu-name">pi-phone</span>
            <span class="mono pu-tag">${offer.version}</span>
        </div>
        <p class="muted small">
            ${
                apk
                    ? t("A new version of the app needs installing: Android asks you to confirm. Your sessions and sign-ins stay.")
                    : t("Updating restarts the server for a few seconds. A run in progress continues after it.")
            }
        </p>
        ${
            apk &&
            !offer.canInstall &&
            html`<p class="small pu-note">
                ${t("First allow pi-phone to install apps: turn on “Allow from this source”, then come back and tap Install.")}
            </p>`
        }
        <div class="sheet-actions">
            <button class="button" onClick=${later}>${t("Later")}</button>
            ${
                apk && !offer.canInstall
                    ? html`<button class="button primary" onClick=${() => app?.openInstallSettings?.()}>${t("Open settings")}</button>`
                    : html`<button
                          class="button primary"
                          onClick=${() => {
                              app?.applyUpdate?.();
                              closeSheet();
                          }}
                      >
                          ${apk ? t("Install") : t("Update now")}
                      </button>`
            }
        </div>
    <//>`;
}
