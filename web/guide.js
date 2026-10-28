// Getting started (PP-235): the owner's session where Pi shows them around, and its checklist under the session's header
// (the `guide` tool keeps it: the topics they picked, ticked as Pi finishes each). On a phone the bar is one line, with
// the part Pi is on; it opens to the whole list. On a wide screen the whole list shows.
import { useState } from "preact/hooks";
import { currentLanguage, t } from "./i18n.js";
import { api, attempt, closeSheet, navigate, openSheet, store } from "./store.js";
import { html, Icon, WIDE } from "./ui.js";

/**
 * Open the owner's Getting started session: again when there is one, else a new one that Pi starts. With no model yet
 * Pi cannot guide: the welcome opens instead, at its model step's way. `whatsNew`: a version Pi then walks through.
 */
export function openGettingStarted({ whatsNew } = {}) {
    closeSheet();

    if (store.state.models.length === 0) {
        return attempt(() => api("me", { welcome: "show" }));
    }

    return attempt(async () => {
        const { session } = await api("getting-started", { language: currentLanguage(), ...(whatsNew === undefined ? {} : { whatsNew }) });

        navigate(session);
    });
}

/**
 * The screens Pi's `show_screen` opens (src/server/extensions/onboarding.ts `SCREENS`): their names, and how each
 * opens. Android's (`app: true`) open only in the pi-phone app on the phone, through its bridge.
 */
const SCREENS = () => ({
    providers: { name: t("Providers"), open: () => openSheet({ type: "providers" }) },
    "default-model": { name: t("Default model"), open: () => openSheet({ type: "model", id: "default", forDefault: true }) },
    appearance: { name: t("Appearance"), open: () => openSheet({ type: "appearance" }) },
    notifications: { name: t("Notifications"), open: () => openSheet({ type: window.PiPhoneApp ? "phone" : "notifications" }) },
    dictation: { name: t("Dictation"), open: () => openSheet({ type: "dictation" }) },
    voice: { name: t("Voice"), open: () => openSheet({ type: "voice" }) },
    assistant: { name: t("Assistant"), open: () => openSheet({ type: "assistant" }) },
    "this-phone": { name: t("This phone"), open: () => openSheet({ type: "phone" }) },
    "phone-control": { name: t("Phone control"), open: () => openSheet({ type: "phone-control" }) },
    "computer-control": { name: t("Computer control"), open: () => openSheet({ type: "computer-control" }) },
    machines: { name: t("Machines"), open: () => openSheet({ type: "machines" }) },
    "ssh-keys": { name: t("SSH keys"), open: () => openSheet({ type: "ssh-keys" }) },
    secrets: { name: t("Secrets"), open: () => openSheet({ type: "secrets" }) },
    "pi-browser": { name: t("Pi's browser"), open: () => openSheet({ type: "browser" }) },
    "web-access": { name: t("Web access"), open: () => openSheet({ type: "web-access" }) },
    spend: { name: t("Spend"), open: () => openSheet({ type: "spend" }) },
    github: { name: t("GitHub"), open: () => openSheet({ type: "github" }) },
    "android-notifications": { name: t("Android's notification settings"), app: true, open: () => window.PiPhoneApp.openNotificationSettings() },
    "android-battery": { name: t("Run with the screen off"), app: true, open: () => window.PiPhoneApp.runUnrestricted() },
    "android-accessibility": { name: t("Android's Accessibility settings"), app: true, open: () => window.PiPhoneApp.openSettings("accessibility") },
    "android-app-info": { name: t("pi's App info"), app: true, open: () => window.PiPhoneApp.openSettings("app-info") },
    "android-default-apps": { name: t("Android's default apps"), app: true, open: () => window.PiPhoneApp.openSettings("assistant") },
    microphone: { name: t("Microphone"), app: true, open: () => window.PiPhoneApp.askMic() },
});

/** Pi's `show_screen` card in the chat: what to do, and a button that opens the screen; nothing opens without the tap. */
export function ScreenCard({ args }) {
    const screen = SCREENS()[args.screen];

    if (screen === undefined) {
        return null;
    }

    const here = !screen.app || Boolean(window.PiPhoneApp);

    return html`<div class="screen-card" data-part="screen-card">
        <div class="grow">
            <div class="screen-card-title">${screen.name}</div>
            ${args.why && html`<div class="muted small">${args.why}</div>`}
            ${!here && html`<div class="muted small">${t("Open this in the pi-phone app on the phone.")}</div>`}
        </div>
        ${here && html`<button class="button small primary" type="button" onClick=${() => attempt(async () => screen.open())}>${t("Open")}</button>`}
    </div>`;
}

/** The checklist bar, in a session whose view has one. */
export function GuideBar() {
    const guide = store.state.view.guide;
    const [open, setOpen] = useState(false);

    if (!guide || guide.items.length === 0) {
        return null;
    }

    const done = guide.items.filter((item) => item.done).length;
    const now = guide.items.find((item) => !item.done);
    const full = open || WIDE.matches;

    return html`<section class=${`guide-bar ${full ? "open" : ""}`} data-part="guide-checklist" aria-label=${t("Getting started")}>
        <button class="guide-head" type="button" aria-expanded=${full} disabled=${WIDE.matches} onClick=${() => setOpen(!open)}>
            <b>${t("Getting started")}</b>
            <span class="muted small">${t("{done} of {n} done", { done, n: guide.items.length })}</span>
            <span class="guide-progress" aria-hidden="true"><i style=${`width:${Math.round((done / guide.items.length) * 100)}%`}></i></span>
            ${!WIDE.matches && html`<${Icon} name="chevron" size=${14} class=${open ? "guide-chevron up" : "guide-chevron"} />`}
        </button>
        ${
            !full &&
            html`<div class="guide-now muted small">
                ${guide.finished || now === undefined ? t("All done.") : html`${t("Now:")} <b>${now.text}</b>`}
            </div>`
        }
        ${
            full &&
            html`<ul class="guide-items">
                ${guide.items.map(
                    (item) => html`<li class=${item.done ? "done" : item === now && !guide.finished ? "now" : ""}>
                        <span class="guide-mark" role="img" aria-label=${item.done ? t("done") : t("to do")}>${item.done && html`<${Icon} name="check" size=${12} />`}</span>
                        ${item.text}
                    </li>`,
                )}
            </ul>`
        }
    </section>`;
}
