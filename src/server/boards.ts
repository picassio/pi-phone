/**
 * The shared part of the boards (PP-38): projects, their members, tasks, links, comments, activity, and who worked on
 * what. Everything that reaches it goes through this async interface, so that it can live elsewhere: on the phone and on
 * a single-owner server it is the local store (`localBoards`, the same `pocket.sqlite`); on the team server, the
 * gateway's board service (PP-39), where one board is shared by its members' pi-phones.
 *
 * What stays personal is not here, and stays on `Projects` itself: where a project's code is (places), task runs and
 * their worktrees and branches, board mode in a session, and a project's main session.
 */
import type { Projects } from "./projects.ts";

/** The store's methods that make up the shared part: each answers asynchronously through `Boards`. */
export const SHARED = [
    "list",
    "create",
    "board",
    "update",
    "setMembers",
    "leave",
    "moveToTeam",
    "setOpen",
    "recordRun",
    "remove",
    "createTask",
    "task",
    "tasks",
    "updateTask",
    "comment",
    "link",
    "unlink",
    "removeTask",
    "sessionsOf",
    "linkSession",
    "taskById",
    "projectById",
    "allProjects",
    "project",
    "startWork",
] as const;

export type SharedMethod = (typeof SHARED)[number];

/** A store method as the shared part answers it: the same arguments, the answer later. */
type Later<F> = F extends (...args: infer A) => infer R ? (...args: A) => Promise<R> : never;

/**
 * The shared part of the boards. `onChange` and `onAssignedToPi` hear changes from wherever they are made: here, or by
 * another pi-phone on the same board.
 */
export type Boards = { [K in SharedMethod]: Later<Projects[K]> } & Pick<Projects, "onChange" | "onAssignedToPi">;

/** The shared part from the local store: the phone, and a single-owner server. */
export function localBoards(projects: Projects): Boards {
    const boards: Record<string, unknown> = {
        onChange: (listener: Parameters<Projects["onChange"]>[0]) => projects.onChange(listener),
        onAssignedToPi: (listener: Parameters<Projects["onAssignedToPi"]>[0]) => projects.onAssignedToPi(listener),
    };

    for (const name of SHARED) {
        const method = projects[name] as (...args: unknown[]) => unknown;

        // Asynchronous like a remote store's: a rule the store refuses rejects the promise, it does not throw.
        boards[name] = async (...args: unknown[]) => method.apply(projects, args);
    }

    return boards as Boards;
}
