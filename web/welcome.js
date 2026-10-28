// The first-run welcome (PP-234): three short steps the owner sees the first time pi-phone opens, each one skippable:
// the app's language, a model for Pi, and this phone's permissions (or, in a browser, notifications and installing the
// app). It needs no model: it is the app's own screens. Full screen on a phone, a card over the app on a wide screen.
// Where the person is with it is the server's (`user.welcome`: show, done, skipped); Menu › Getting started shows it again.
import { useEffect, useState } from "preact/hooks";
import { LANGUAGES, resolveLanguage, t } from "./i18n.js";
import { pushId, pushSupport, turnPushOn } from "./push.js";
import { actions, api, attempt, notify, openSheet, store } from "./store.js";
import { html, Icon } from "./ui.js";

/** The model sign-ins the welcome offers (owner's decision D): subscriptions people already have, then a key. */
const PROVIDERS = () => [
    { id: "anthropic", name: "Claude", detail: t("Claude Pro or Max subscription"), mark: "A", color: "#d97757" },
    { id: "openai-codex", name: "ChatGPT", detail: t("ChatGPT Plus or Pro: voice calls with Pi too"), mark: "O", color: "#10a37f" },
    { id: "github-copilot", name: "GitHub Copilot", detail: t("Copilot Pro or Business"), mark: "G", color: "#8b949e" },
    { id: "openrouter", name: "OpenRouter", detail: t("One account, many models, some free"), mark: "R", color: "#6467f2" },
];

/** A browser's own offer to install the app, kept from when it came (it comes once, early). */
let installPrompt = null;

addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    installPrompt = event;
});

const LOGO = html`<svg class="welcome-logo" viewBox="150 150 500 500" aria-hidden="true">
    <path fill="#F09082" d="M165.29 165.29H517.36V400H400V282.65H165.29Z" />
    <path fill="#4D9ABF" d="M165.29 282.65H282.65V400H400V517.36H282.65V634.72H165.29Z" />
    <path fill="#F1BE58" d="M517.36 400H634.72V634.72H517.36Z" />
</svg>`;

/** Leave the welcome: finished (`done`) or `skipped`. The server keeps it, and every tab of theirs hears it. */
export const leaveWelcome = (state) => attempt(() => api("me", { welcome: state }));

/** The welcome, while the server says it is to show. */
export function Welcome() {
    const [step, setStep] = useState(1);
    const phone = Boolean(window.PiPhoneApp);

    return html`<div class="welcome" data-part="welcome" role="dialog" aria-modal="true" aria-label=${t("Welcome to pi-phone")}>
        <div class="welcome-card">
            <div class="welcome-top">
                ${LOGO}<b>pi-phone</b>
                <div class="welcome-dots" aria-hidden="true">${[1, 2, 3].map((each) => html`<i class=${each === step ? "on" : ""}></i>`)}</div>
            </div>
            ${step === 1 && html`<${LanguageStep} next=${() => setStep(2)} />`}
            ${step === 2 && html`<${ModelStep} back=${() => setStep(1)} next=${() => setStep(3)} />`}
            ${step === 3 && (phone ? html`<${PhoneStep} back=${() => setStep(2)} />` : html`<${BrowserStep} back=${() => setStep(2)} />`)}
        </div>
    </div>`;
}

function StepLabel({ n, children }) {
    return html`<div class="welcome-step">${t("Step {n} of 3", { n })} · ${children}</div>`;
}

/** Step 1: the app's language. Choosing one switches the app (the page loads again in it, at this step). */
function LanguageStep({ next }) {
    const choice = store.state.me?.language ?? "auto";
    const auto = LANGUAGES.find((each) => each.id === resolveLanguage("auto", navigator.languages ?? [navigator.language]))?.name ?? "English";
    const pick = (id) => id !== choice && attempt(() => api("me", { language: id }));

    return html`<${StepLabel} n=${1}>${t("Language")}<//>
        <h1>${t("Welcome to pi-phone")}</h1>
        <p class="muted">${t("Pi is a coding agent that works for you here: it reads and writes files, runs commands, browses, and talks with you. First, the app's language.")}</p>
        <div class="welcome-list" role="radiogroup" aria-label=${t("Language")}>
            ${[{ id: "auto", name: t("Auto"), detail: t("Your phone's or browser's: {name}", { name: auto }) }, ...LANGUAGES].map(
                (each) => html`<button
                    class=${`welcome-row ${choice === each.id ? "on" : ""}`}
                    role="radio"
                    aria-checked=${choice === each.id}
                    lang=${each.id === "auto" ? undefined : each.id}
                    onClick=${() => pick(each.id)}
                >
                    <span class="grow"><span class="welcome-title">${each.name}</span>${each.detail && html`<span class="muted small">${each.detail}</span>`}</span>
                    <span class="welcome-radio" aria-hidden="true"></span>
                </button>`,
            )}
        </div>
        <p class="welcome-note">${t("Pi answers in your language too. Change it any time in Menu › Appearance.")}</p>
        <div class="welcome-actions">
            <button class="button ghost" onClick=${() => leaveWelcome("skipped")}>${t("Skip setup")}</button>
            <span class="grow"></span>
            <button class="button primary" onClick=${next}>${t("Continue")}</button>
        </div>`;
}

/**
 * Step 2: a model for Pi. Sign in to one of the usual subscriptions, or a key in Providers. On a team server whose
 * accounts give this person models, pick the one Pi starts with instead (their own sign-in still possible).
 */
function ModelStep({ back, next }) {
    const [providers, setProviders] = useState(null);
    const { models, server } = store.state;

    useEffect(() => {
        attempt(async () => setProviders(await api("providers")));
    }, [models]);

    const team = (providers ?? []).filter((provider) => provider.team && provider.configured && provider.models > 0);
    const teamModels = models.filter((model) => team.some((provider) => provider.id === model.provider));
    const login = (id) => attempt(() => api(`providers/${encodeURIComponent(id)}/login`, { type: "oauth" }));
    const chosen = server?.defaultModel;
    const hasModel = models.length > 0;

    if (server?.gateway && teamModels.length > 0) {
        return html`<${StepLabel} n=${2}>${t("A model for Pi")}<//>
            <h1>${t("Your team's models")}</h1>
            <p class="muted">${t("Your team server has models signed in for you. Pick the one Pi starts with; you can add your own sign-in too.")}</p>
            <div class="welcome-list" role="radiogroup" aria-label=${t("The model Pi starts with")}>
                ${teamModels.slice(0, 8).map((model) => {
                    const on = chosen?.provider === model.provider && chosen?.modelId === model.id;

                    return html`<button
                        class=${`welcome-row ${on ? "on" : ""}`}
                        role="radio"
                        aria-checked=${on}
                        onClick=${() => attempt(() => actions.setDefaultModel({ provider: model.provider, modelId: model.id, thinkingLevel: "off" }))}
                    >
                        <span class="grow"><span class="welcome-title">${model.name ?? model.id}</span><span class="muted small">${team.find((provider) => provider.id === model.provider)?.name ?? model.provider}</span></span>
                        <span class="welcome-radio" aria-hidden="true"></span>
                    </button>`;
                })}
                <div class="welcome-row">
                    <span class="grow"><span class="welcome-title">${t("Your own sign-in")}</span><span class="muted small">${t("Claude, ChatGPT, GitHub Copilot, OpenRouter, or an API key")}</span></span>
                    <button class="button small ghost" onClick=${() => openSheet({ type: "providers" })}>${t("Add")}</button>
                </div>
            </div>
            <div class="welcome-actions">
                <button class="button ghost" onClick=${back}>${t("Back")}</button>
                <span class="grow"></span>
                <button class="button primary" onClick=${next}>${t("Continue")}</button>
            </div>`;
    }

    const offered = PROVIDERS().filter((each) => providers === null || providers.some((provider) => provider.id === each.id && provider.oauth));

    return html`<${StepLabel} n=${2}>${t("A model for Pi")}<//>
        <h1>${t("Sign in to a model")}</h1>
        <p class="muted">${t("Pi thinks with a large language model. Sign in with an account you already have; a subscription is usually the cheapest. The sign-in stays with your pi-phone.")}</p>
        <div class="welcome-list">
            ${offered.map((each) => {
                const provider = providers?.find((one) => one.id === each.id && !one.account);
                const signedIn = provider?.configured === true && provider.needsSignIn === undefined;

                return html`<div class="welcome-row" data-provider=${each.id}>
                    <span class="welcome-mark" style=${`background:${each.color}`} aria-hidden="true">${each.mark}</span>
                    <span class="grow"><span class="welcome-title">${each.name}</span><span class="muted small">${each.detail}</span></span>
                    ${
                        signedIn
                            ? html`<span class="welcome-done"><${Icon} name="check" size=${14} /> ${t("Signed in")}</span>`
                            : html`<button class="button small primary" disabled=${providers === null} onClick=${() => login(each.id)}>${t("Sign in")}</button>`
                    }
                </div>`;
            })}
            <div class="welcome-row">
                <span class="welcome-mark welcome-mark-more" aria-hidden="true">⋯</span>
                <span class="grow"><span class="welcome-title">${t("An API key")}</span><span class="muted small">${t("OpenAI, Anthropic, Google, DeepSeek, and more")}</span></span>
                <button class="button small ghost" onClick=${() => openSheet({ type: "providers" })}>${t("Choose")}</button>
            </div>
        </div>
        <p class="welcome-note">${hasModel ? t("Pi has {n} models to work with.", { n: models.length }) : t("Without a model you can still look around; Pi answers once one is signed in. More in Menu › Providers.")}</p>
        <div class="welcome-actions">
            <button class="button ghost" onClick=${back}>${t("Back")}</button>
            <span class="grow"></span>
            ${!hasModel && html`<button class="button ghost" onClick=${next}>${t("Later")}</button>`}
            <button class="button primary" disabled=${!hasModel} onClick=${next}>${t("Continue")}</button>
        </div>`;
}

/** One permission: its state, what it is for, and the button that opens Android's or the browser's own screen. */
function Permission({ n, done, title, text, button, onClick }) {
    return html`<li class=${`phone-step ${done ? "done" : ""}`} data-part="welcome-permission">
        <span class="phone-step-mark" role="img" aria-label=${done ? t("done") : String(n)}>${done ? html`<${Icon} name="check" size=${14} />` : n}</span>
        <div class="phone-step-text">
            <div>${title}</div>
            <div class="muted small">${text}</div>
        </div>
        ${onClick && html`<button class=${`button small ${done ? "ghost" : "primary"}`} onClick=${onClick}>${button}</button>`}
    </li>`;
}

/** The end of the welcome: finished. */
function Finish({ back }) {
    return html`<div class="welcome-actions welcome-actions-end">
        <button class="button primary" onClick=${() => leaveWelcome("done")}>${t("Go to the app")}</button>
        <div class="welcome-actions"><button class="button ghost" onClick=${back}>${t("Back")}</button></div>
    </div>`;
}

/** What Android says now of each permission (the app's bridge); read again when the person comes back from its screen. */
function usePhoneState() {
    const app = window.PiPhoneApp;
    const read = () => ({
        notifications: app.notificationsEnabled?.() === true,
        unrestricted: app.runsUnrestricted?.() === true,
        mic: app.micAllowed?.() === true,
        sideKey: app.assistantHeld?.() === true,
    });
    const [state, setState] = useState(read);

    useEffect(() => {
        const again = () => document.visibilityState === "visible" && setState(read());

        document.addEventListener("visibilitychange", again);
        addEventListener("focus", again);

        return () => {
            document.removeEventListener("visibilitychange", again);
            removeEventListener("focus", again);
        };
    }, []);

    return state;
}

/** Step 3 in the pi-phone app: Android's permissions, each through Android's own screen. */
function PhoneStep({ back }) {
    const app = window.PiPhoneApp;
    const state = usePhoneState();

    return html`<${StepLabel} n=${3}>${t("This phone")}<//>
        <h1>${t("Let Pi work well on this phone")}</h1>
        <p class="muted">${t("Each is optional. Android asks you to confirm; you can change them later in Menu › This phone.")}</p>
        <ol class="phone-steps welcome-list">
            <${Permission} n=${1} done=${state.notifications} title=${t("Notifications")} text=${t("When a session finishes, fails, or asks you to approve something.")} button=${state.notifications ? t("Settings") : t("Turn on")} onClick=${() => app.openNotificationSettings()} />
            <${Permission} n=${2} done=${state.unrestricted} title=${t("Run with the screen off")} text=${t("Long runs and machines keep going while the phone sleeps.")} button=${t("Allow")} onClick=${state.unrestricted ? null : () => app.runUnrestricted()} />
            <${Permission} n=${3} done=${state.mic} title=${t("Microphone")} text=${t("For dictation and voice calls with Pi.")} button=${t("Allow")} onClick=${state.mic || !app.askMic ? null : () => app.askMic()} />
            <${Permission} n=${4} done=${state.sideKey} title=${t("Side key")} text=${t("Hold the side key in any app to talk to Pi.")} button=${t("Open")} onClick=${state.sideKey || !app.openSettings ? null : () => app.openSettings("assistant")} />
        </ol>
        <p class="welcome-note">${t("Phone control, where Pi uses apps on this phone, is in Menu › Phone control.")}</p>
        <${Finish} back=${back} />`;
}

/** Step 3 in a browser (Docker, the team server): notifications here, and installing the app. */
function BrowserStep({ back }) {
    const [, redraw] = useState(0);
    const support = pushSupport();
    const pushing = pushId() !== null;
    const installed = matchMedia("(display-mode: standalone)").matches;
    const install = async () => {
        const prompt = installPrompt;

        installPrompt = null;
        await prompt?.prompt();
        redraw((n) => n + 1);
    };

    return html`<${StepLabel} n=${3}>${t("This browser")}<//>
        <h1>${t("Keep up from this browser")}</h1>
        <p class="muted">${t("Both are optional; you can change them later in Menu › Notifications.")}</p>
        <ol class="phone-steps welcome-list">
            <${Permission}
                n=${1}
                done=${pushing}
                title=${t("Notifications")}
                text=${support === "ready" || pushing ? t("When a session finishes, fails, or asks you to approve something.") : support === "denied" ? t("Blocked in this browser: allow them in its site settings.") : support === "insecure" ? t("This browser needs pi-phone over HTTPS for notifications.") : t("This browser cannot show notifications from pi-phone.")}
                button=${t("Turn on")}
                onClick=${support === "ready" && !pushing ? () => attempt(async () => (await turnPushOn(), redraw((n) => n + 1), notify("info", t("Notifications are on in this browser.")))) : null}
            />
            <${Permission}
                n=${2}
                done=${installed}
                title=${t("Install as an app")}
                text=${installed ? t("pi-phone runs as an app here.") : t("Its own window and icon. In a browser that offers no button, use its menu: Install app, or Add to Home Screen.")}
                button=${t("Install")}
                onClick=${!installed && installPrompt !== null ? install : null}
            />
        </ol>
        <${Finish} back=${back} />`;
}
