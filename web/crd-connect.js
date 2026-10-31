// Connecting Chrome Remote Desktop on a Windows machine to the owner's Google account (PP-263, src/server/crd.ts): Google's
// headless steps, a hidden field for the command Google shows, and a PIN typed twice. Shown on the machine's row in
// Settings › Machines and on Pi's card (computer_control setup with crd: connect). What is typed stays in this form until
// it is sent to the server, which takes the code and the redirect from the command and runs Google's host setup on the
// machine; nothing is kept, and Pi never sees it.
import { useState } from "preact/hooks";
import { t, tx } from "./i18n.js";
import { notify } from "./store.js";
import { copyText, html, Icon } from "./ui.js";

/** Google's page that gives the command. */
export const CRD_HEADLESS = "https://remotedesktop.google.com/headless";

/** remoting_start_host's PIN rule: digits only, at least six (and at most 32, the server's limit). */
const PIN = /^[0-9]{6,32}$/;

/**
 * The steps and fields. `onSubmit({ command, pin, confirm })` sends them (a promise); `onCancel` (optional) is the other
 * button; `actionsClass` is the class of the buttons' row (a card's or a sheet's).
 */
export function CrdConnectForm({ machineName, busy, onSubmit, onCancel, cancelLabel, actionsClass = "sheet-actions" }) {
    const [command, setCommand] = useState("");
    const [pin, setPin] = useState("");
    const [confirm, setConfirm] = useState("");
    const pinOk = PIN.test(pin);
    const same = pin === confirm;
    const ready = command.includes("--code=") && pinOk && same;
    const submit = (event) => {
        event.preventDefault();

        if (ready && !busy) {
            onSubmit({ command, pin, confirm });
        }
    };
    const copy = () =>
        copyText(CRD_HEADLESS).then(
            () => notify("info", t("Link copied.")),
            () => notify("error", t("Could not copy.")),
        );

    return html`<form class="crd-connect" onSubmit=${submit}>
        <ol class="crd-steps small">
            <li>
                ${t("On this phone, open Google's page and sign in with the Google account you will connect from:")}
                <div class="crd-link">
                    <a class="linked" href=${CRD_HEADLESS} target="_blank" rel="noopener noreferrer" onClick=${(event) => event.stopPropagation()}>${CRD_HEADLESS}</a>
                    <button type="button" class="button small" onClick=${copy}><${Icon} name="copy" size=${14} /> ${t("Copy link")}</button>
                </div>
            </li>
            <li>${tx("Tap {begin}, then {next}, then {authorize}.", { begin: html`<b>${t("Begin")}</b>`, next: html`<b>${t("Next")}</b>`, authorize: html`<b>${t("Authorize")}</b>` })}</li>
            <li>${tx("Copy the command under {windows} and paste it below. It works once, for a few minutes.", { windows: html`<b>${t("Windows (PowerShell)")}</b>` })}</li>
            <li>${t("Choose a PIN of at least 6 digits: you type it in the Chrome Remote Desktop app to unlock {machine}.", { machine: machineName })}</li>
        </ol>
        <input
            class="crd-command"
            type="password"
            autocomplete="off"
            autocapitalize="off"
            spellcheck="false"
            aria-label=${t("Google's command")}
            placeholder=${t("Paste Google's command")}
            value=${command}
            onInput=${(event) => setCommand(event.currentTarget.value)}
        />
        <div class="crd-pins">
            <input
                type="password"
                inputmode="numeric"
                autocomplete="new-password"
                aria-label=${t("PIN")}
                placeholder=${t("PIN, 6+ digits")}
                value=${pin}
                onInput=${(event) => setPin(event.currentTarget.value)}
            />
            <input
                type="password"
                inputmode="numeric"
                autocomplete="new-password"
                aria-label=${t("The PIN again")}
                placeholder=${t("The PIN again")}
                value=${confirm}
                onInput=${(event) => setConfirm(event.currentTarget.value)}
            />
        </div>
        ${pin !== "" && !pinOk && html`<div class="warn small">${t("A PIN is 6 to 32 digits, digits only.")}</div>`}
        ${pinOk && confirm !== "" && !same && html`<div class="warn small">${t("The two PINs differ.")}</div>`}
        <p class="muted small">${t("The command and the PIN go only to {machine}: they are not kept or logged, and Pi never sees them.", { machine: machineName })}</p>
        <div class=${actionsClass}>
            ${onCancel && html`<button type="button" class="button deny" disabled=${busy} onClick=${onCancel}>${cancelLabel ?? t("Cancel")}</button>`}
            <button type="submit" class="button primary" disabled=${busy || !ready}>${busy ? t("Connecting…") : t("Connect")}</button>
        </div>
    </form>`;
}
