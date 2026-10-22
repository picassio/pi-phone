// Folder groups' sheets (PP-76): moving sessions to a group, and a group's own menu.
import { useState } from "preact/hooks";
import { createGroup, deleteGroup, foldGroup, groupOf, moveGroup, moveToGroup, pinGroup, renameGroup } from "../session-groups.js";
import { closeSheet, store } from "../store.js";
import { html, Icon, item, Sheet } from "../ui.js";

const count = (group) => Object.values(store.state.sessionGroups.members).filter((each) => each === group.id).length;
const chats = (n) => (n === 1 ? "1 chat" : `${n} chats`);
/** What deleting a group does to its sessions, in words. */
const goBack = (n) => (n === 0 ? "it's empty" : n === 1 ? "its chat goes back to Active" : `its ${n} chats go back to Active`);

/** Move one session, or a selection, to a group, out of every group, or into a new group named here. */
export function MoveSheet({ ids }) {
    const { groups } = store.state.sessionGroups;
    const [name, setName] = useState("");
    const current = ids.length === 1 ? groupOf(ids[0]) : undefined;
    const done = (promise) => promise.then((answer) => answer !== undefined && closeSheet());
    const titled = ids.length === 1 ? (store.state.sessions.find((session) => session.id === ids[0])?.title ?? "New session") : `${ids.length} sessions`;

    const create = async (event) => {
        event.preventDefault();

        if (name.trim() !== "" && (await createGroup(name.trim(), ids)) !== undefined) {
            closeSheet();
        }
    };

    return html`<${Sheet} title=${`Move ${titled} to a group`} onClose=${closeSheet}>
        ${
            groups.length > 0 &&
            html`<div class="sheet-list">
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
                ${item("No group", () => done(moveToGroup(ids, null)), "back to Active")}
            </div>`
        }
        <form class="sg-create" onSubmit=${create}>
            <input
                value=${name}
                placeholder="New group's name"
                aria-label="New group's name"
                maxlength="60"
                autofocus=${groups.length === 0}
                onInput=${(event) => setName(event.currentTarget.value)}
            />
            <button class="button primary" disabled=${name.trim() === ""}>Create</button>
        </form>
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
                      <input value=${name} aria-label="The group's name" maxlength="60" autofocus onInput=${(event) => setName(event.currentTarget.value)} />
                      <button class="button primary" disabled=${name.trim() === ""}>Rename</button>
                  </form>`
                : html`<div class="sheet-list">
                      ${item(group.pinned ? "Unpin from the top" : "Pin to the top", then(() => pinGroup(id, !group.pinned)), group.pinned ? "pinned on every device" : "under the pinned chats, on every device")}
                      ${item("Rename", () => setNaming(true))}
                      ${item(group.folded ? "Unfold" : "Fold", then(() => foldGroup(id, !group.folded)), group.folded ? "show its chats" : "show only its name and count")}
                      ${at > 0 && item("Move up", then(() => moveGroup(id, near[at - 1].id)), `above ${near[at - 1].name}`)}
                      ${at < near.length - 1 && item("Move down", then(() => moveGroup(id, near[at + 1].id)), `below ${near[at + 1].name}`)}
                      <button
                          class="list-item sg-danger"
                          onClick=${async () => {
                              // Asked first: the menu stays open if the answer is no.
                              if ((await deleteGroup(group)) !== undefined) {
                                  closeSheet();
                              }
                          }}
                      >
                          <span>Delete the group</span>
                          <span class="muted small">${goBack(count(group))}</span>
                      </button>
                  </div>`
        }
    <//>`;
}
