/**
 * Folder groups in the session list (PP-76): each person's own groups, kept on the server and sent to all their
 * devices, as favorite folders are. A group has a name, may be pinned (it shows under the pinned chats) or folded, and
 * the groups keep the person's order (and remember when each was last used). A session is in at most one group; groups do not nest. Deleting a group sends
 * its sessions back to Active: nothing is archived.
 */
import { randomUUID } from "node:crypto";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { PocketApp } from "./app.ts";
import type { User } from "./config.ts";
import { SessionGroupsDoc, type SessionGroupsOf } from "./docs.ts";
import { HttpError } from "./errors.ts";

const MAX_GROUPS = 100;
const MAX_NAME = 60;

/** `usedAt`: when it was made or last had sessions moved in (the Move sheet lists recent ones first). */
export type SessionGroup = { id: string; name: string; pinned: boolean; folded: boolean; usedAt: number };
export type SessionGroupsView = { groups: SessionGroup[]; members: Record<string, string> };

/** What can be asked: one action, with what it needs. */
export type SessionGroupsRequest = {
    action?: unknown;
    id?: unknown;
    name?: unknown;
    pinned?: unknown;
    folded?: unknown;
    order?: unknown;
    sessions?: unknown;
    group?: unknown;
};

const empty = (): SessionGroupsOf => ({ groups: [], members: {} });

export class SessionGroups {
    readonly #app: PocketApp;

    constructor(app: PocketApp) {
        this.#app = app;
    }

    async list(user: User): Promise<SessionGroupsView> {
        const doc = await this.#app.harness.snapshot(SessionGroupsDoc, BACKGROUND_CONTEXT);

        return view(doc?.users[user.id] ?? empty());
    }

    /**
     * One change to `user`'s groups: create (a name, and sessions to move in), rename, pin, fold, order (every group's id,
     * in the new order), move (sessions into a group, or out of every group with `group: null`), delete. Answers the
     * groups as they are after it, and the group made or changed.
     */
    async change(user: User, request: SessionGroupsRequest): Promise<SessionGroupsView & { group?: SessionGroup }> {
        const app = this.#app;

        app.requireSteer(user);

        if (user.sessions !== undefined) {
            throw new HttpError(403, "You were invited to one session: folder groups are for your own session list.");
        }

        const action = String(request.action ?? "");
        const sessions = request.sessions === undefined ? [] : this.#sessions(request.sessions);
        let touched: SessionGroup | undefined;

        const mine = await app.harness.commit(async (tx) => {
            const doc = await tx.doc(SessionGroupsDoc);
            const was = doc.users[user.id] ?? empty();
            // Groups made before `usedAt` count as used long ago.
            const groups: SessionGroup[] = was.groups.map((group) => ({ ...group, usedAt: group.usedAt ?? 0 }));
            const members = { ...was.members };
            const find = (id: unknown) => {
                const found = groups.find((group) => group.id === id);

                if (found === undefined) {
                    throw new HttpError(404, "No such folder group: it may have been deleted.");
                }

                return found;
            };

            switch (action) {
                case "create": {
                    if (groups.length >= MAX_GROUPS) {
                        throw new HttpError(409, `You can keep up to ${MAX_GROUPS} folder groups.`);
                    }

                    touched = { id: randomUUID().slice(0, 8), name: nameOf(request.name), pinned: false, folded: false, usedAt: Date.now() };
                    groups.push(touched);

                    for (const id of sessions) {
                        members[id] = touched.id;
                    }

                    break;
                }
                case "rename":
                    touched = find(request.id);
                    touched.name = nameOf(request.name);
                    break;
                case "pin":
                    touched = find(request.id);
                    touched.pinned = flag(request.pinned, "pinned");
                    break;
                case "fold":
                    touched = find(request.id);
                    touched.folded = flag(request.folded, "folded");
                    break;
                case "fold-all": {
                    const folded = flag(request.folded, "folded");

                    for (const group of groups) {
                        group.folded = folded;
                    }

                    break;
                }
                case "order": {
                    const order = Array.isArray(request.order) ? request.order.map(String) : [];

                    if (order.length !== groups.length || new Set(order).size !== order.length || order.some((id) => !groups.some((group) => group.id === id))) {
                        throw new HttpError(400, "The order lists every folder group's id once.");
                    }

                    groups.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
                    break;
                }
                case "move": {
                    if (sessions.length === 0) {
                        throw new HttpError(400, "Say which sessions to move.");
                    }

                    const into = request.group === null ? null : find(request.group);

                    if (into !== null) {
                        into.usedAt = Date.now();
                    }

                    for (const id of sessions) {
                        if (into === null) {
                            delete members[id];
                        } else {
                            members[id] = into.id;
                        }
                    }

                    touched = into ?? undefined;
                    break;
                }
                case "delete": {
                    const gone = find(request.id);

                    groups.splice(groups.indexOf(gone), 1);

                    for (const [id, group] of Object.entries(members)) {
                        if (group === gone.id) {
                            delete members[id];
                        }
                    }

                    touched = gone;
                    break;
                }
                default:
                    throw new HttpError(400, "A folder group change is create, rename, pin, fold, fold-all, order, move or delete.");
            }

            doc.users[user.id] = { groups, members };

            return { groups, members };
        }, BACKGROUND_CONTEXT);

        return { ...view(mine), ...(touched === undefined ? {} : { group: touched }) };
    }

    /** Only committed groups reach browsers, and only each person's own. */
    committed(value: { users: Record<string, SessionGroupsOf> } | null): void {
        for (const client of this.#app.clients) {
            client.send("session-groups", view(value?.users[client.user.id] ?? empty()));
        }
    }

    /** Sessions by id, each one a session here (a top-level one: subagents go where their session goes). */
    #sessions(value: unknown): string[] {
        if (!Array.isArray(value) || value.length > 500) {
            throw new HttpError(400, "Sessions are a list of session ids.");
        }

        const ids = [...new Set(value.map(String))];
        const unknown = ids.filter((id) => this.#app.sessionMeta(Number(id) as never) === undefined);

        if (unknown.length > 0) {
            throw new HttpError(404, `No session ${unknown.join(", ")}.`);
        }

        return ids;
    }
}

/** Members of groups that still exist only. */
function view(mine: SessionGroupsOf): SessionGroupsView {
    const ids = new Set(mine.groups.map((group) => group.id));

    return { groups: mine.groups.map((group) => ({ ...group, usedAt: group.usedAt ?? 0 })), members: Object.fromEntries(Object.entries(mine.members).filter(([, group]) => ids.has(group))) };
}

function nameOf(value: unknown): string {
    const name = typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";

    if (name === "" || name.length > MAX_NAME || /[\u0000-\u001f\u007f]/.test(name)) {
        throw new HttpError(400, `A folder group's name is 1 to ${MAX_NAME} characters.`);
    }

    return name;
}

function flag(value: unknown, what: string): boolean {
    if (typeof value !== "boolean") {
        throw new HttpError(400, `Say ${what}: true or false.`);
    }

    return value;
}
