// Folder groups' sheets (PP-76): moving sessions to a group, and a group's own menu.
import { t, tn } from "../i18n.js";
import { useState } from "preact/hooks";
import { createGroup, deleteGroup, foldAllGroups, foldGroup, groupOf, moveGroup, moveToGroup, pinGroup, renameGroup } from "../session-groups.js";
import { closeSheet, store } from "../store.js";
import { html, Icon, item, Sheet } from "../ui.js";

const count = (group) => Object.values(store.state.sessionGroups.members).filter((each) => each === group.id).length;
const chats = (n) => tn(n, "{n} chat", "{n} chats");
/** What deleting a group does to its sessions, in words. */
const goBack = (n) => (n === 0 ? t("it's empty") : tn(n, "its chat goes back to Active", "its {n} chats go back to Active"));

/**
 * Move one session, or a selection, to a group, out of every group, or into a new group named here. One field finds a
 * group by name as you type (the recently used first) and offers to make one when no group has that name.
 */
export function MoveSheet({ ids }) {
    const [name, setName] = useState("");
    const typed = name.trim().toLowerCase().replace(/\s+/g, " ");
    const groups = store.state.sessionGroups.groups
        .filter((group) => typed === "" || group.name.toLowerCase().includes(typed))
        .sort((a, b) => b.usedAt - a.usedAt);
    const exact = store.state.sessionGroups.groups.find((group) => group.name.toLowerCase() === typed);
    const current = ids.length === 1 ? groupOf(ids[0]) : undefined;
    const done = (promise) => promise.then((answer) => answer !== undefined && closeSheet());
    const titled = ids.length === 1 ? (store.state.sessions.find((session) => session.id === ids[0])?.title ?? t("New session")) : null;

    // Enter takes the group of that name, or the only one found; else it makes the one typed.
    const create = async (event) => {
        event.preventDefault();

        const match = exact ?? (typed !== "" && groups.length === 1 ? groups[0] : undefined);

        if (match !== undefined) {
            void done(moveToGroup(ids, match.id));
        } else if (typed !== "") {
            await makeNew();
        }
    };
    const makeNew = async () => {
        if ((await createGroup(name.trim(), ids)) !== undefined) {
            closeSheet();
        }
    };

    return html`<${Sheet} title=${titled === null ? t("Move {n} sessions to a group", { n: ids.length }) : t("Move {title} to a group", { title: titled })} onClose=${closeSheet}>
        <form class="sg-create sg-find" onSubmit=${create}>
            <input
                value=${name}
                placeholder=${store.state.sessionGroups.groups.length === 0 ? t("New group's name") : t("Find a group, or name a new one")}
                aria-label=${t("Find a group, or name a new one")}
                maxlength="60"
                autofocus
                onInput=${(event) => setName(event.currentTarget.value)}
            />
        </form>
        ${
            html`<div class="sheet-list">
                ${typed !== "" && !exact && html`<button class="list-item sg-new-item" onClick=${makeNew}><span>${t("Create “{name}”", { name: name.trim() })}</span><span class="muted small">${ids.length === 1 ? t("and move it there") : t("and move them there")}</span></button>`}
                ${groups.map(
                    (group) => html`<button
                        class=${`list-item sg-pick ${current?.id === group.id ? "on" : ""}`}
                        aria-current=${current?.id === group.id ? "true" : undefined}
                        onClick=${() => done(moveToGroup(ids, group.id))}
                    >
                        <span><${Icon} name="folder" size=${14} />${group.name}</span>
                        ${current?.id === group.id ? html`<span class="sg-check"><${Icon} name="check" size=${14} /></span>` : html`<span class="muted small">${chats(count(group))}</span>`}
                    </button>`,
                )}
                ${typed === "" && item("No group", () => done(moveToGroup(ids, null)), "back to Active")}
            </div>`
        }
    <//>`;
}

/** A group's menu: pin, rename, fold, move up or down, delete. */
export function GroupSheet({ id }) {
    const { groups } = store.state.sessionGroups;
    const group = groups.find((each) => each.id === id);
    // Up and down among the groups shown with it: the pinned ones, or the others.
    const near = groups.filter((each) => each.pinned === group.pinned);
    const at = near.indexOf(group);
    const [naming, setNaming] = useState(false);
    const [name, setName] = useState(group.name);
    const then = (run) => () => {
        closeSheet();
        void run();
    };

    const rename = async (event) => {
        event.preventDefault();

        if ((await renameGroup(id, name)) !== undefined) {
            closeSheet();
        }
    };

    return html`<${Sheet} title=${group.name} onClose=${closeSheet}>
        ${
            naming
                ? html`<form class="sg-create" onSubmit=${rename}>
                      <input value=${name} aria-label=${t("The group's name")} maxlength="60" autofocus onInput=${(event) => setName(event.currentTarget.value)} />
                      <button class="button primary" disabled=${name.trim() === ""}>${t("Rename")}</button>
                  </form>`
                : html`<div class="sheet-list">
                      ${item(group.pinned ? "Unpin from the top" : "Pin to the top", then(() => pinGroup(id, !group.pinned)), group.pinned ? "pinned on every device" : "under the pinned chats, on every device")}
                      ${item("Rename", () => setNaming(true))}
                      ${item(group.folded ? "Unfold" : "Fold", then(() => foldGroup(id, !group.folded)), group.folded ? "show its chats" : "show only its name and count")}
                      ${groups.length > 1 && item("Fold all groups", then(() => foldAllGroups(true)), "every device")}
                      ${groups.length > 1 && item("Unfold all groups", then(() => foldAllGroups(false)), "every device")}
                      ${at > 0 && item("Move up", then(() => moveGroup(id, near[at - 1].id)), t("above {name}", { name: near[at - 1].name }))}
                      ${at < near.length - 1 && item("Move down", then(() => moveGroup(id, near[at + 1].id)), t("below {name}", { name: near[at + 1].name }))}
                      <button
                          class="list-item sg-danger"
                          onClick=${async () => {
                              // Asked first: the menu stays open if the answer is no.
                              if ((await deleteGroup(group)) !== undefined) {
                                  closeSheet();
                              }
                          }}
                      >
                          <span>${t("Delete the group")}</span>
                          <span class="muted small">${goBack(count(group))}</span>
                      </button>
                  </div>`
        }
    <//>`;
}
