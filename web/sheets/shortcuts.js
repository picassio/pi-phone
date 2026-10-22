// The keyboard shortcuts, as a list. The keys themselves are handled in app.js.
import { closeSheet } from "../store.js";
import { html, Keys, Sheet } from "../ui.js";
import { t, tx } from "../i18n.js";

// Each row: its keys, and what they do. An "or" between keys means either one, and a "…" a run from one to the other.
// A function, so its words are in the person's language (chosen after this module loads).
const SHORTCUTS = () => [
    [
        t("Sessions"),
        [
            ["Mod K", t("Launcher: sessions, actions, themes")],
            ["Alt 1 … Alt 9", t("Jump to a session, like a workspace")],
            ["Alt ↑ or Alt ↓", t("Previous or next session")],
            ["Alt N", t("New session")],
            ["Mod 1 … Mod 9", t("In New session: start in a favorite folder")],
            ["Alt", t("Hold to see session numbers")],
            ["Mod B", t("Fold or unfold the sidebar")],
            ["Mod Click", t("In the sidebar: select a session; drag to select every one you pass")],
            ["Shift Click", t("In the sidebar: select a run of sessions")],
        ],
    ],
    [
        t("Panels"),
        [
            ["Alt B", t("Open or close the browser")],
            ["Alt E", t("Open or close the Files tile: the folder's files, and what changed")],
            ["Alt A", t("Open or close PiP, your assistant")],
            ["Alt P", t("Show or hide peek tiles")],
            ["Alt T", t("Show thinking: turn the live disclosure on or off")],
            ["Mod F", t("Find in this session")],
        ],
    ],
    [
        t("Message box"),
        [
            ["/", t("Commands")],
            ["@", t("Mention a file or folder")],
            ["!", t("Run a command (!! keeps it from Pi)")],
            ["↑", t("In an empty box: what you sent before")],
            ["Ctrl R", t("Search what you sent before")],
            ["Alt V", t("Dictate into the message box, or stop (where the browser can)")],
            ["Esc Esc", t("Stop Pi while it works")],
        ],
    ],
    [
        t("Changes"),
        [
            ["j or k", t("The next or previous file")],
            ["n or p", t("The next or previous change")],
            ["v", t("Mark the file viewed, or not")],
            ["s", t("The layout: auto, split, or unified")],
            ["w", t("Wrap long lines, or not")],
        ],
    ],
    [
        t("Anywhere"),
        [
            ["?", t("This list")],
            ["Esc", t("Close what is open")],
        ],
    ],
];

/** Keys as chips, each key of a chord in its own, with the "or" and "…" between chords left plain. */
function Chords({ keys }) {
    return keys
        .split(" ")
        .map((key) =>
            key === "or" || key === "…"
                ? html`<span class="muted">${key === "or" ? t("or") : key}</span>`
                : html`<${Keys} keys=${key} />`,
        );
}

export function ShortcutsSheet() {
    return html`<${Sheet} title=${t("Keyboard shortcuts")} onClose=${closeSheet}>
        ${SHORTCUTS().map(
            ([title, rows]) => html`<div class="group" key=${title}>
                <div class="group-title">${title}</div>
                <dl class="shortcuts">
                    ${rows.map(
                        ([keys, text]) => html`<dt><${Chords} keys=${keys} /></dt>
                        <dd>${text}</dd>`,
                    )}
                </dl>
            </div>`,
        )}
        <p class="muted small">
            ${tx("In the launcher, start with {actions} for actions, {sessions} for sessions, or {themes} for themes. Arrowing onto colors shows them; Enter keeps them.", {
                actions: html`<kbd>></kbd>`,
                sessions: html`<kbd>@</kbd>`,
                themes: html`<kbd>#</kbd>`,
            })}
        </p>
    <//>`;
}
