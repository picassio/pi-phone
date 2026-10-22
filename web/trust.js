// Project trust gates .agents/skills and model defaults from .pi/settings.json. The bar asks the owner when a
// session's project has either and nobody decided yet; /trust shows and changes the decision shared with Pi's CLI.
// Trusting model defaults affects only later new sessions, never the open session.
import { useEffect } from "preact/hooks";
import { t } from "./i18n.js";
import { actions, attempt, closeSheet, notify, openSheet, store } from "./store.js";
import { html, Icon, Loader, Sheet, shortPath } from "./ui.js";

/** Only the owner decides which projects Pi trusts: the answer goes into Pi's own settings. */
export const trustAvailable = () => store.state.me?.role === "owner";

/** The folders whose question the owner put off in this tab ("Not now"): the sheet and `/trust` still answer it. */
const LATER_KEY = "pocket.trustLater";

function later() {
    try {
        return new Set(JSON.parse(sessionStorage.getItem(LATER_KEY) ?? "[]"));
    } catch {
        return new Set();
    }
}

function putOff(folder) {
    sessionStorage.setItem(LATER_KEY, JSON.stringify([...later(), folder]));
    store.set({});
}

/** What the server said about the open conversation's project, when it was for its folder now. */
export function currentTrust() {
    const { trust, conversationId, view } = store.state;

    return trust?.conversationId === conversationId && trust.cwd === view.agent?.cwd
        ? trust.info
        : null;
}

/** Fetch whether Pi trusts the open conversation's project, unless that is known for its folder (or `force`). */
export function loadTrust({ force = false } = {}) {
    const { conversationId, view, trust } = store.state;
    const cwd = view.agent?.cwd;
    const known = trust?.conversationId === conversationId && trust.cwd === cwd;

    if (conversationId === null || !cwd || (known && !force)) {
        return;
    }

    store.set({ trust: { conversationId, cwd, info: known ? trust.info : null } });
    actions.trust().then(
        (info) => {
            const now = store.state.trust;

            if (now?.conversationId === conversationId && now.cwd === cwd) {
                store.set({ trust: { ...now, info } });
            }
        },
        () => {},
    );
}

/** The skills' names, a few of them: "deploy, review, and 3 more". */
function skillNames(skills, most = 3) {
    const names = skills.map((skill) => skill.name);

    if (names.length <= most) {
        return names.join(", ");
    }

    return t("{names}, and {n} more", { names: names.slice(0, most).join(", "), n: names.length - most });
}

/** Save the owner's answer, and show it: the bar goes, and the skills join the slash commands. */
async function decide(choice) {
    const { conversationId, view, server } = store.state;
    const cwd = view.agent?.cwd;
    const info = await actions.setTrust(choice);

    // Saved for that session's folder; this tab shows another session now: its own trust stays as it is.
    if (store.state.conversationId !== conversationId || store.state.view.agent?.cwd !== cwd) {
        return;
    }

    store.set({ trust: { conversationId, cwd, info }, templates: null });

    if (!info.trusted) {
        notify(
            "info",
            t("Not trusted: project model defaults and its own skills stay off. /trust changes that."),
        );

        return;
    }

    const sentences = [
        choice === "trust-parent"
            ? t("Trusted {folder} and the folders in it.", { folder: shortPath(info.parent, server?.home) })
            : t("Trusted this project."),
    ];

    if (info.skills.length > 0) {
        sentences.push(t("Pi has its skills from now on: {names}.", { names: skillNames(info.skills) }));
    }

    if (info.settings) {
        sentences.push(t("Project model defaults apply only to later new sessions; this session will not change."));
    }

    notify("info", sentences.join(" "));
}

/** Above the message box, for the owner: this project's skills or settings wait for a trust decision. */
export function TrustBar() {
    const { conversationId } = store.state;
    const cwd = store.state.view.agent?.cwd;
    const mine = trustAvailable();

    useEffect(() => {
        if (mine) {
            loadTrust();
        }
    }, [conversationId, cwd, mine]);
    const info = currentTrust();

    if (!mine || !info?.ask || later().has(info.folder)) {
        return null;
    }

    return html`<div class="trust-bar">
        <span class="grow">
            <strong>${t("Trust this project?")}</strong>${" "}${
                info.settings
                    ? `${t("Its .pi/settings.json can set the model and thinking level of later new sessions. This session will not change.")}${info.skills.length > 0 ? ` ${t("Its skills in .agents/skills ({names}) also need trust.", { names: skillNames(info.skills) })}` : ""}`
                    : t("Its skills in .agents/skills ({names}) load only in a project Pi trusts.", { names: skillNames(info.skills) })
            }
        </span>
        <span class="trust-actions">
            <button class="link small" onClick=${() => attempt(() => decide("distrust"))}>
                ${t("Don't trust")}
            </button>
            <button class="button small primary" onClick=${() => openSheet({ type: "trust" })}>
                ${t("Review")}
            </button>
            <button
                class="icon-button"
                aria-label=${t("Not now")}
                title=${t("Not now: ask again in a new tab")}
                onClick=${() => putOff(info.folder)}
            >
                <${Icon} name="close" size=${13} />
            </button>
        </span>
    </div>`;
}

/** An answer in the sheet: what it does, the folder it is about when that is not this one, and whether it is saved. */
function Choice({ label, detail, current, onClick }) {
    return html`<button class=${`list-item trust-choice ${current ? "active" : ""}`} onClick=${onClick}>
        <span class="trust-radio" aria-hidden="true"></span>
        <span class="trust-choice-text">
            <span>${label}</span>
            ${detail && html`<span class="muted small mono">${detail}</span>`}
        </span>
        ${current && html`<span class="trust-current">${t("✓ current")}</span>`}
    </button>`;
}

/**
 * Whether Pi was told not to trust the project: a saved "no", or its setting for undecided projects. A trust store that
 * cannot be read decides nothing (as on the server, `skills.ts`), so the project's .pi/skills load.
 */
const distrusted = (info) =>
    !info.trusted &&
    !info.unreadable &&
    (info.saved?.trusted === false ||
        (info.saved === null && info.defaultProjectTrust === "never"));

/** What the project's own skills do here, a sentence for each place they are in. */
function ownSkillsText(info) {
    const list = (skills) => skillNames(skills, 8);
    const texts = [];

    if (info.skills.length > 0) {
        texts.push(
            info.trusted
                ? t("In .agents/skills: {names}. Pi has them.", { names: list(info.skills) })
                : t("In .agents/skills: {names}. They load once you trust it.", { names: list(info.skills) }),
        );
    }

    if (info.ownSkills.length > 0) {
        texts.push(
            distrusted(info)
                ? t("In .pi/skills: {names}. They stay off while it is not trusted.", { names: list(info.ownSkills) })
                : t("In .pi/skills: {names}. They load unless you choose Don't trust.", { names: list(info.ownSkills) }),
        );
    }

    return texts.length > 0
        ? texts
        : [
              info.settings
                  ? t("It has no skills of its own.")
                  : t("It has no skills of its own, so this changes nothing in pi-phone here."),
          ];
}

/** Where the decision comes from, in a sentence. */
function status(info, short) {
    if (info.unreadable) {
        return t("Pi's trust store (~/.pi/agent/trust.json) cannot be read, so no project is trusted, and no answer can be saved until it is mended or deleted.");
    }

    if (info.saved === null) {
        if (info.defaultProjectTrust === "always") {
            return t("Trusted: no decision is saved for it, and Pi's defaultProjectTrust setting trusts every project.");
        }

        if (info.defaultProjectTrust === "never") {
            return t("Not trusted: no decision is saved for it, and Pi's defaultProjectTrust setting trusts no project.");
        }

        return info.skills.length > 0
            ? t("No decision yet. Until there is one, pi-phone leaves its skills in .agents/skills off.")
            : t("No decision yet.");
    }

    if (info.saved.path === info.folder) {
        return info.saved.trusted ? t("Trusted.") : t("Not trusted.");
    }

    const path = short(info.saved.path);

    return info.saved.trusted
        ? t("Trusted, as the folder it is in: {path}.", { path })
        : t("Not trusted, as the folder it is in: {path}.", { path });
}

/** The project's trust, and the three answers Pi's `/trust` offers. */
export function TrustSheet() {
    const { server } = store.state;
    const short = (path) => shortPath(path, server?.home);

    useEffect(() => loadTrust({ force: true }), []);
    const info = currentTrust();

    if (!info) {
        return html`<${Sheet} title=${t("Project trust")} onClose=${closeSheet}>
            <${Loader} label=${t("Loading")} />
        <//>`;
    }

    const choose = (choice) =>
        attempt(async () => {
            await decide(choice);
            closeSheet();
        });
    const saved = (path, trusted) => info.saved?.path === path && info.saved.trusted === trusted;

    return html`<${Sheet} title=${t("Project trust")} onClose=${closeSheet}>
        <p class="mono small">${short(info.folder)}</p>
        <p>${status(info, short)}</p>
        ${ownSkillsText(info).map((text) => html`<p>${text}</p>`)}
        ${
            info.settings &&
            html`<p>
                ${t("In .pi/settings.json: model and thinking defaults apply only to later new sessions, after trust. This session will not change. The owner's Default model still wins; clear it in Menu → Default model to use project defaults. No project setting can grant trust to itself. Extra skill and prompt paths and per-project run policy are not supported yet.")}
            </p>`
        }
        <p class="muted small">
            ${t("Pi's CLI goes by the same decision, saved in ~/.pi/agent/trust.json. There, trusting a project also loads its .pi settings, extensions, and packages, which run code on this machine. Trust only folders whose contents you trust.")}
        </p>
        ${
            !trustAvailable()
                ? html`<p class="muted small">${t("Only the owner can change this.")}</p>`
                : !info.unreadable &&
                  html`<div class="group">
                      <${Choice}
                          label=${t("Trust this folder")}
                          current=${saved(info.folder, true)}
                          onClick=${() => choose("trust")}
                      />
                      ${
                          info.parent &&
                          html`<${Choice}
                              label=${t("Trust the folder above it")}
                              detail=${short(info.parent)}
                              current=${saved(info.parent, true)}
                              onClick=${() => choose("trust-parent")}
                          />`
                      }
                      <${Choice}
                          label=${t("Don't trust")}
                          current=${saved(info.folder, false)}
                          onClick=${() => choose("distrust")}
                      />
                  </div>`
        }
    <//>`;
}
