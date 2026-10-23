// Notifications for the web UI (PP-127): turned on per browser, from that browser; the other browsers that have them
// listed, each removable from here. What they say is what the Android app's notifications say (`phone-events.ts`).
// Laid out as the This phone sheet.
import { useEffect, useState } from "preact/hooks";
import { formatDate, t } from "../i18n.js";
import { pushId, pushSupport, turnPushOff, turnPushOn } from "../push.js";
import { api, attempt, closeSheet, notify } from "../store.js";
import { html, Sheet } from "../ui.js";

/** Why this browser gets no notifications, as the card says it; undefined when it can. */
function unavailable(support) {
    return {
        app: t("The app has its own notifications: Menu › This phone."),
        insecure: t("Notifications need pi-phone at an HTTPS address; this one is plain HTTP."),
        install: t("Safari sends notifications only to pi-phone on the Home Screen. Tap Share › Add to Home Screen, open pi-phone from there, and turn notifications on here."),
        denied: t("Notifications are blocked for pi-phone in this browser: allow them in its site settings, then come back here."),
        unsupported: t("This browser cannot get push notifications."),
        space: t("Notifications are turned on from the app's own page, not a shared space's."),
    }[support];
}

export function NotificationsSheet() {
    const support = pushSupport();
    const [subscriptions, setSubscriptions] = useState(null);
    const [mine, setMine] = useState(pushId());
    const [busy, setBusy] = useState(false);
    const load = () => api("push").then((answer) => setSubscriptions(answer.subscriptions), () => setSubscriptions([]));

    useEffect(() => {
        void load();
    }, []);

    const here = subscriptions?.find((each) => each.id === mine);
    const others = (subscriptions ?? []).filter((each) => each.id !== mine);
    // Notifications are on here when the server knows this browser's subscription.
    const on = mine !== null && (subscriptions === null || here !== undefined);
    const run = (work) =>
        attempt(async () => {
            setBusy(true);

            try {
                await work();
            } finally {
                setBusy(false);
                setMine(pushId());
                await load();
            }
        });
    const reason = support === "ready" ? undefined : unavailable(support);

    return html`<${Sheet} title=${t("Notifications")} onClose=${closeSheet}>
        <div class="sheet-list">
            <div class="provider" data-part="push-here">
                <div>
                    <div>${support === "install" ? t("On this iPhone") : t("On this device")} ${on && html`<span class="ok">✓</span>`}</div>
                    <div class="muted small">
                        ${
                            reason ??
                            (on
                                ? t("On: {device}. When Pi finishes, fails, or waits for you, unless pi-phone is open in front here.", { device: here?.name ?? t("this browser") })
                                : t("Off. Get a notification when Pi finishes, fails, or waits for you, even with pi-phone closed."))
                        }
                    </div>
                    ${here?.lastError && html`<div class="muted small">${t("The last one did not go: {why}", { why: here.lastError })}</div>`}
                </div>
                ${
                    reason === undefined &&
                    html`<div class="provider-actions">
                        ${
                            on
                                ? html`<button class="button small" disabled=${busy} onClick=${() => run(async () => {
                                          await api(`push/${mine}/test`, {});
                                          notify("info", t("Sent: it shows in a moment."));
                                      })}>${t("Send a test")}</button>
                                      <button class="button small ghost" disabled=${busy} onClick=${() => run(turnPushOff)}>${t("Turn off")}</button>`
                                : html`<button class="button small primary" disabled=${busy} onClick=${() => run(turnPushOn)}>${t("Turn on")}</button>`
                        }
                    </div>`
                }
            </div>
            <div class="provider" data-part="push-others">
                <div>
                    <div>${t("Other devices")}</div>
                    ${
                        subscriptions !== null && others.length === 0
                            ? html`<div class="muted small">${t("None yet.")}</div>`
                            : others.map(
                                  (each) => html`<div class="push-device">
                                      <div>
                                          <div class="small">${each.name}</div>
                                          <div class="muted small">${t("since {date}", { date: formatDate(each.createdAt, { month: "short", day: "numeric" }) })}</div>
                                      </div>
                                      <button class="button small ghost" disabled=${busy} onClick=${() => run(() => api(`push/${each.id}`, undefined, { method: "DELETE" }))}>${t("Remove")}</button>
                                  </div>`,
                              )
                    }
                </div>
            </div>
        </div>
    <//>`;
}
