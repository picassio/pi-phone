// Push notifications for the web UI (PP-127): this browser's subscription, kept by the server (`src/server/web-push.ts`),
// and the service worker that shows them (`web/sw.js`). The Android app has its own notifications, and no Push API.
import { t } from "./i18n.js";
import { api, navigate, PUSH_KEY, reportVisibility } from "./store.js";

/** This browser's subscription id on the server, while notifications are on here. */
export const pushId = () => localStorage.getItem(PUSH_KEY);

const appleTouch = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const homeScreen = () => matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;

/**
 * Whether this browser can get notifications, or why not: `ready`; `app` (the Android app, which has its own);
 * `space` (a shared space's page, not the app's); `insecure` (plain HTTP); `install` (an iPhone's Safari: only the
 * Home Screen app gets them); `denied` (blocked in the browser's settings); `unsupported`.
 */
export function pushSupport() {
    if (window.PiPhoneApp) {
        return "app";
    }

    if (document.querySelector('link[rel="manifest"]') === null) {
        return "space";
    }

    if (!isSecureContext) {
        return "insecure";
    }

    if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) {
        return appleTouch() && !homeScreen() ? "install" : "unsupported";
    }

    return Notification.permission === "denied" ? "denied" : "ready";
}

const keyBytes = (base64url) => Uint8Array.from(atob(base64url.replace(/-/g, "+").replace(/_/g, "/")), (char) => char.charCodeAt(0));

/** Turn notifications on here: the browser asks first (an iPhone only after a tap, so this runs in the tap). */
export async function turnPushOn() {
    const permission = await Notification.requestPermission();

    if (permission !== "granted") {
        throw new Error(t("Notifications are blocked for pi-phone in this browser: allow them in its site settings, then try again."));
    }

    const registration = await navigator.serviceWorker.register("sw.js", { scope: "./" });

    await navigator.serviceWorker.ready;

    const { publicKey } = await api("push");
    const subscription =
        (await registration.pushManager.getSubscription()) ??
        (await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) }));
    // Its language and time zone: what a notification says, and the clock a time in it is on.
    const { id } = await api("push", {
        subscription: subscription.toJSON(),
        language: navigator.language,
        zone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    });

    localStorage.setItem(PUSH_KEY, id);
    reportVisibility(true);

    return id;
}

/** Turn notifications off here: the server forgets this browser, and the browser its subscription. */
export async function turnPushOff() {
    const id = pushId();

    if (id !== null) {
        await api(`push/${id}`, undefined, { method: "DELETE" });
    }

    localStorage.removeItem(PUSH_KEY);

    const registration = await navigator.serviceWorker?.getRegistration();

    await (await registration?.pushManager.getSubscription())?.unsubscribe();
}

if ("serviceWorker" in navigator && !window.PiPhoneApp) {
    // A tapped notification, with a pi-phone tab open: this tab goes to its session.
    navigator.serviceWorker.addEventListener("message", (event) => {
        if (event.data?.type !== "pi-phone-open") {
            return;
        }

        const session = /\/s\/(\d+)/.exec(new URL(event.data.url).pathname)?.[1];

        navigate(session === undefined ? null : Number(session));
    });

    // Notifications on here, but the browser dropped its subscription (cleared site data): the server's is stale.
    if (pushId() !== null) {
        navigator.serviceWorker
            .getRegistration()
            .then((registration) => registration?.pushManager.getSubscription())
            .then((subscription) => {
                if (!subscription) {
                    localStorage.removeItem(PUSH_KEY);
                }
            })
            .catch(() => {});
    }
}
