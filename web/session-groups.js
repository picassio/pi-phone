// Folder groups in the session list (PP-76): the person's own, from the server (`src/server/session-groups.ts`), the same
// on every device. Each change goes to the server, and its answer (and the `session-groups` event every tab hears)
// redraws the list.
import { api, attempt, store } from "./store.js";

/** The group a session is in, or undefined. */
export function groupOf(id, groups = store.state.sessionGroups) {
    const group = groups.members[String(id)];

    return group === undefined ? undefined : groups.groups.find((each) => each.id === group);
}

async function change(body) {
    const answer = await attempt(() => api("session-groups", body));

    if (answer !== undefined) {
        store.set({ sessionGroups: { groups: answer.groups, members: answer.members } });
    }

    return answer;
}

/** A new group, with `ids` moved into it: the group, or undefined when it was refused. */
export const createGroup = async (name, ids = []) => (await change({ action: "create", name, sessions: ids }))?.group;
/** Into a group, or out of every group with `group` null. */
export const moveToGroup = (ids, group) => change({ action: "move", sessions: ids, group });
export const renameGroup = (id, name) => change({ action: "rename", id, name });
export const pinGroup = (id, pinned) => change({ action: "pin", id, pinned });
export const foldGroup = (id, folded) => change({ action: "fold", id, folded });
export const foldAllGroups = (folded) => change({ action: "fold-all", folded });

/** Where another group is: before it when it was above, after it when it was below (a swap with a neighbour). */
export function moveGroup(id, other) {
    const order = store.state.sessionGroups.groups.map((group) => group.id);
    const from = order.indexOf(id);
    const to = order.indexOf(other);

    order.splice(from, 1);
    order.splice(to, 0, id);

    return change({ action: "order", order });
}

/** Before another group (`before`), or at the end (null). */
export function placeGroup(id, before) {
    const order = store.state.sessionGroups.groups.map((group) => group.id).filter((each) => each !== id);

    order.splice(before === null ? order.length : Math.max(0, order.indexOf(before)), 0, id);

    return change({ action: "order", order });
}

/** Asks first; its sessions go back to Active. */
export function deleteGroup(group) {
    const count = Object.values(store.state.sessionGroups.members).filter((each) => each === group.id).length;

    if (!confirm(`Delete the group “${group.name}”? ${count === 0 ? "It's empty." : `Its ${count === 1 ? "chat goes" : `${count} chats go`} back to Active; nothing is archived.`}`)) {
        return undefined;
    }

    return change({ action: "delete", id: group.id });
}
