// Pi asks before it changes the owner's library of skills and slash commands (PP-468, src/server/extensions/library.ts,
// `form: { type: "library" }`): a save shows the whole content, and the change for an edit; a pin, an undo or a delete
// says what and where. Approve is the owner's alone; anyone who can steer may deny.
import { useState } from "preact/hooks";
import { DiffBlock } from "./diff.js";
import { t, tn } from "./i18n.js";
import { actions, attempt, canSteer, store } from "./store.js";
import { html, Icon } from "./ui.js";

/** A pin in the owner's words: a session by its number and title, a board by its key and name, or every session. */
function pinWords(pin) {
    if (pin.scope === "all") {
        return t("Every session");
    }

    if (pin.gone) {
        return pin.scope === "session" ? t("Session {id} (no longer there)", { id: pin.target }) : t("Board {key} (no longer there)", { key: pin.target });
    }

    return pin.scope === "session"
        ? t("Session {id}: {title}", { id: pin.target, title: pin.label ?? "" })
        : t("Board {key}: {name}", { key: pin.target, name: pin.label ?? "" });
}

/** What the card asks, by action and kind: whole sentences, so each language can order them. */
function asked(form) {
    const skill = form.kind === "skill";
    const name = form.name;

    switch (form.action) {
        case "save":
            return form.from === undefined
                ? skill
                    ? t("Save the new skill {name}?", { name })
                    : t("Save the new command /{name}?", { name })
                : skill
                  ? t("Save the skill {name} as a new version?", { name })
                  : t("Save the command /{name} as a new version?", { name });
        case "pin":
            return form.pin.pinned
                ? skill
                    ? t("Pin the skill {name}?", { name })
                    : t("Pin the command /{name}?", { name })
                : skill
                  ? t("Unpin the skill {name}?", { name })
                  : t("Unpin the command /{name}?", { name });
        case "undo":
            return skill ? t("Take the skill {name} back to version {n}?", { name, n: form.to }) : t("Take the command /{name} back to version {n}?", { name, n: form.to });
        default:
            return skill ? t("Delete the skill {name}?", { name }) : t("Delete the command /{name}?", { name });
    }
}

/** What Approve does, in a line. */
function reason(form) {
    switch (form.action) {
        case "save":
            return form.from === undefined
                ? t("Nothing is saved until you approve. Only sessions you pin it to get it.")
                : t("Nothing changes until you approve. Version {n} is kept, so this can be undone.", { n: form.from });
        case "pin":
            return form.pin.pinned ? t("Sessions there get it from their next message.") : t("Sessions there no longer get it from their next message.");
        case "undo":
            return t("Version {n} is kept, so this can be undone too.", { n: form.from });
        default:
            return tn(form.versions, "Its kept version and its pins go too. This cannot be undone.", "Its {n} kept versions and its pins go too. This cannot be undone.", { n: form.versions });
    }
}

const ICON = { save: "pencil", pin: "pin", undo: "undo", delete: "alert" };

/** The files as they will be, each whole. */
function Files({ files }) {
    return files.map(
        (file) => html`<div class="library-file">
            <div class="mono small">${file.path}</div>
            <pre class="output">${file.text}</pre>
        </div>`,
    );
}

export function LibraryCard({ approval }) {
    const { me } = store.state;
    const form = approval.form;
    const [busy, setBusy] = useState(false);
    const [whole, setWhole] = useState(false);
    const owner = me?.role === "owner";
    const answer = (allow) => {
        setBusy(true);
        attempt(() => actions.approve(approval.id, allow)).finally(() => setBusy(false));
    };
    const approve = { save: t("Save"), pin: form.pin?.pinned === false ? t("Unpin") : t("Pin"), undo: t("Undo"), delete: t("Delete") }[form.action];
    const edit = form.action === "save" && form.from !== undefined;

    return html`<div class="approval library-card" data-part="approval" data-library=${form.action}>
        <div class="approval-head">
            <span class="approval-shield" aria-hidden="true"><${Icon} name=${form.action === "save" && !edit ? "plus" : ICON[form.action]} size=${16} /></span>
            <div class="approval-title">
                <span class="approval-ask">${asked(form)}</span>
                <span class="approval-reason">${reason(form)}</span>
            </div>
        </div>
        <dl class="machine-add-facts">
            ${form.action === "pin" && html`<dt>${form.pin.pinned ? t("Pin to") : t("Unpin from")}</dt><dd>${pinWords(form.pin)}</dd>`}
            ${form.action === "undo" && html`<dt>${t("Version")}</dt><dd>${t("{from} → {to}", { from: form.from, to: form.to })}</dd>`}
            <dt>${t("Pinned now")}</dt>
            <dd>${form.pins.length === 0 ? t("Nowhere") : form.pins.map((pin) => html`<div>${pinWords(pin)}</div>`)}</dd>
            ${form.note && html`<dt>${t("Note")}</dt><dd>${form.note}</dd>`}
        </dl>
        ${(edit || form.action === "undo") && (form.diff ? html`<${DiffBlock} text=${form.diff} />` : html`<div class="muted small">${t("No change to its files.")}</div>`)}
        ${form.action === "save" &&
        (edit
            ? html`<div class="library-whole">
                  <button type="button" class="library-whole-toggle" aria-expanded=${whole ? "true" : "false"} onClick=${() => setWhole(!whole)}>
                      <${Icon} name="down" size=${16} /><span>${t("Whole content after the change")}</span>
                  </button>
                  ${whole && html`<${Files} files=${form.files} />`}
              </div>`
            : html`<${Files} files=${form.files} />`)}
        ${
            !canSteer()
                ? html`<div class="muted small">${t("Waiting for someone who can steer to answer.")}</div>`
                : html`${!owner && html`<div class="muted small">${t("The library is the owner's: only they approve this. You can deny it.")}</div>`}
                      <div class="approval-actions">
                          <button class="button deny" disabled=${busy} onClick=${() => answer(false)}>${t("Deny")}</button>
                          ${owner && html`<button class="button primary" disabled=${busy} onClick=${() => answer(true)}>${approve}</button>`}
                      </div>`
        }
    </div>`;
}
