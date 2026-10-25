// Menu › Assistant (PP-146): pi-phone as the phone's digital assistant. Setting the phone up (the steps open Android's
// settings through the app's shell, `window.PiPhoneApp`, only inside the app), where the side key's words go, whether
// they wait for Send, and whether the message says the app that was in front. The choices are the server's
// (`src/server/assistant.ts`), so Pi can change them too, through the settings tools, after the owner says yes.
import { useEffect, useState } from "preact/hooks";
import { t } from "../i18n.js";
import { api, attempt, closeSheet, store } from "../store.js";
import { html, Icon, Sheet, shortPath, Switch } from "../ui.js";

const DEFAULTS = { opens: "last", folder: null, session: null, send: "tap", from: true };

function Step({ number, done, title, text, open, action = t("Open") }) {
    return html`<li class=${`phone-step ${done ? "done" : ""}`} data-part="assistant-step">
        <span class="phone-step-mark" role="img" aria-label=${done ? t("done") : number}>${done ? html`<${Icon} name="check" size=${14} />` : number}</span>
        <div class="phone-step-text">
            <div>${title}</div>
            <div class="muted small">${text}</div>
        </div>
        ${open && html`<button class=${`button small ${done ? "ghost" : "primary"}`} onClick=${open}>${action}</button>`}
    </li>`;
}

export function AssistantSheet() {
    const app = window.PiPhoneApp;
    const { server, sessions } = store.state;
    const settings = server?.assistant ?? DEFAULTS;
    // Android's answers, read again when the person comes back from its settings.
    const read = () => ({
        held: typeof app?.assistantHeld === "function" ? app.assistantHeld() : null,
        mic: typeof app?.micAllowed === "function" ? app.micAllowed() : null,
    });
    const [phone, setPhone] = useState(read);
    const [folder, setFolder] = useState(settings.folder ?? "");

    useEffect(() => {
        const again = () => setPhone(read());

        addEventListener("focus", again);
        document.addEventListener("visibilitychange", again);

        return () => {
            removeEventListener("focus", again);
            document.removeEventListener("visibilitychange", again);
        };
    }, []);

    const change = (patch) => attempt(() => api("settings", { assistant: patch }));
    const live = sessions.filter((each) => !each.archived).sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
    const opens = [
        ["last", t("The last session")],
        ["new", t("A new session")],
        ["session", t("One session")],
    ];

    return html`<${Sheet} title=${t("Assistant")} onClose=${closeSheet} className="phone-control-sheet assistant-sheet">
        <p class="muted small">${t("Hold the side key in any app: pi comes up over it, listening. What you say goes to a session as a message.")}</p>

        <div class="phone-section-title">${t("Set up this phone")}</div>
        ${!app && html`<p class="muted small">${t("Open this in the pi-phone app on the phone to set it up.")}</p>`}
        <ol class="phone-steps sheet-list">
            <${Step}
                number="1"
                done=${phone.held === true}
                title=${t("Make pi-phone the digital assistant")}
                text=${t("In Default apps, open Digital assistant app and pick pi.")}
                open=${app?.openSettings && (() => app.openSettings("assistant"))}
            />
            <${Step}
                number="2"
                done=${false}
                title=${t("Hold the side key for it")}
                text=${t("Samsung: Settings › Advanced features › Side button › Press and hold › Digital assistant. Other phones: hold the power button, or swipe up from a bottom corner.")}
            />
            <${Step}
                number="3"
                done=${phone.mic === true}
                title=${t("Allow the microphone")}
                text=${t("The sheet over other apps can't ask for it: allow it here once.")}
                open=${phone.mic === false && app?.askMic && (() => app.askMic())}
                action=${t("Allow")}
            />
        </ol>

        <div class="phone-section-title">${t("Opens")}</div>
        <div class="assistant-choice" data-part="assistant-opens">
            <div class="segmented" role="group" aria-label=${t("Where your words go")}>
                ${opens.map(
                    ([value, label]) => html`<button
                        class=${settings.opens === value ? "on" : ""}
                        aria-pressed=${settings.opens === value}
                        onClick=${() =>
                            value === "session" && settings.session === null
                                ? live[0] && change({ opens: "session", session: live[0].id })
                                : change({ opens: value })}
                    >
                        ${label}
                    </button>`,
                )}
            </div>
            ${settings.opens === "last" && html`<p class="muted small">${t("Where you were last in pi-phone on this phone.")}</p>`}
            ${
                settings.opens === "new" &&
                html`<label class="assistant-field">
                    <span class="muted small">${t("Each time, in this folder:")}</span>
                    <input
                        value=${folder}
                        placeholder=${shortPath(server?.defaultCwd ?? "", server?.home)}
                        aria-label=${t("Folder of new sessions")}
                        onInput=${(event) => setFolder(event.currentTarget.value)}
                        onChange=${() => change({ folder: folder.trim() === "" ? null : folder.trim() })}
                    />
                </label>`
            }
            ${
                settings.opens === "session" &&
                html`<label class="assistant-field">
                    <span class="muted small">${t("Always this session:")}</span>
                    <select aria-label=${t("The session")} onChange=${(event) => change({ session: Number(event.currentTarget.value) })}>
                        ${live.map((each) => html`<option value=${each.id} selected=${each.id === settings.session}>${each.title ?? t("New session")} · #${each.id}</option>`)}
                    </select>
                </label>`
            }
        </div>

        <div class="phone-section-title">${t("When you stop speaking")}</div>
        <div class="assistant-choice" data-part="assistant-send">
            <div class="segmented" role="group" aria-label=${t("When you stop speaking")}>
                <button class=${settings.send === "tap" ? "on" : ""} aria-pressed=${settings.send === "tap"} onClick=${() => change({ send: "tap" })}>${t("I tap Send")}</button>
                <button class=${settings.send === "auto" ? "on" : ""} aria-pressed=${settings.send === "auto"} onClick=${() => change({ send: "auto" })}>${t("Send by itself")}</button>
            </div>
            <p class="muted small">${settings.send === "auto" ? t("After 3 seconds; tap the words to stop it.") : t("Read it first; fix a misheard word.")}</p>
        </div>

        <div class="phone-section-title">${t("What pi sees")}</div>
        <div class="limit-wait-notice" data-part="assistant-from">
            <div>
                <div class="small">${t("The app you're in")}</div>
                <div class="muted small">${t("Its name only (\"From Chrome\"), so pi can offer to use it. Nothing on its screen.")}</div>
            </div>
            <${Switch} on=${settings.from !== false} label=${t("The app you're in")} onChange=${() => change({ from: settings.from === false })} />
        </div>
    <//>`;
}
