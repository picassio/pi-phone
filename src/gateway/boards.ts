/**
 * The team server's board service (PP-39): the shared part of every board (`src/server/boards.ts`), kept here so that a
 * board is shared by its members' pi-phones while each member's own Pi works on it in their own pi-phone, clone and
 * providers. It is the same store and rules as on the phone (`Projects`), on a database of the gateway's own.
 *
 * Pi-phones call it on the gateway's internal port with their own owner token, so a pi-phone can only act as its own
 * person, or as their Pi: the actor is made here, never taken from the call. Its rights are the person's, live: their
 * team role (projects.create, projects.share, projects.delete, projects.team; projects.view_all to see every board,
 * each look logged) and their standing on each board. Sessions are a pi-phone's own numbers, so they are kept here as
 * `<key>:<number>`. What is personal (a board's folder and places, its main session, whether it runs Pi's tasks by
 * itself) is never kept here: each pi-phone keeps its own.
 */
import { HttpError } from "../server/errors.ts";
import { type Actor, type Closer, CLOSERS, type Person, type Project, Projects, type Task } from "../server/projects.ts";
import type { GatewayStore, PersonBox } from "./store.ts";

/** A call from a pi-phone: the store method, its arguments without the actor, and when Pi makes it, its session. */
export type BoardCall = { method: string; args: unknown[]; pi?: { conversationId: string; closer: Closer } };

/** The fields of a board that are each pi-phone's own. */
const PERSONAL = ["folder", "places", "mainSession", "autoRuns"];

export class BoardService {
    readonly #store: GatewayStore;
    readonly #projects: Projects;

    constructor(store: GatewayStore, dir: string, now: () => number = Date.now) {
        this.#store = store;
        this.#projects = new Projects(dir, () => this.people(), now);
    }

    close(): void {
        this.#projects.close();
    }

    /** Call `listener` when a task is given to a person's own Pi (`pi:<person>`), to start their pi-phone on it (PP-40). */
    onAssignedToPi(listener: (task: Task) => void): () => void {
        return this.#projects.onAssignedToPi((task) => {
            if (task.assignee?.startsWith("pi:") === true) {
                listener(task);
            }
        });
    }

    /** Call `listener` with a board's id whenever it changes, to tell its members' pi-phones (PP-40). */
    onChange(listener: (projectId: string) => void): () => void {
        return this.#projects.onChange(listener);
    }

    /** Everyone with an account, as the boards' rules see them: by their team role, live. */
    people(): Person[] {
        return this.#store.users().map((user) => {
            const role = this.#store.roleOf(user.id, user.role);
            const can = (permission: string) => (role.permissions as readonly string[]).includes(permission);

            return { id: user.id, name: user.name, role: can("pi.use") ? "guest" : "viewer", seesAll: can("projects.view_all"), managesTeam: can("projects.team") };
        });
    }

    /** The board ids a person is on, made, or sees as open: whose pi-phones hear of a change (PP-40). */
    membersOf(projectId: string): string[] {
        const project = this.#projects.projectById(projectId);

        if (project === undefined) {
            return [];
        }

        return this.people()
            .filter((person) => person.role !== "viewer" && (project.owner === person.id || project.members.includes(person.id) || project.open || (project.team && person.managesTeam === true)))
            .map((person) => person.id);
    }

    /** Someone's account is gone: off every board; boards they made become the team's. */
    forgetPerson(userId: string): void {
        this.#projects.forgetPerson(userId);
    }

    /** One call from the pi-phone `box`, as its person or their Pi. Refusals throw `HttpError`s with the rule's words. */
    call(box: PersonBox, call: BoardCall): unknown {
        const person = this.people().find((each) => each.id === box.userId);

        if (person === undefined) {
            throw new HttpError(403, "This pi-phone's person has no account here anymore.");
        }

        if (call.pi !== undefined && !(CLOSERS as readonly string[]).includes(call.pi.closer)) {
            throw new HttpError(400, `Who closes tasks is ${CLOSERS.join(" or ")}.`);
        }

        const own = (conversationId: unknown) => `${box.key}:${String(conversationId)}`;
        const actor: Actor = call.pi === undefined ? { kind: "person", person } : { kind: "pi", person, conversationId: own(call.pi.conversationId), closer: call.pi.closer };
        const args = Array.isArray(call.args) ? call.args : [];
        const store = this.#projects;
        const permitted = (permission: string, what: string) => {
            if (!(this.#store.roleOf(person.id, this.#store.users().find((user) => user.id === person.id)?.role).permissions as readonly string[]).includes(permission)) {
                throw new HttpError(403, `${what} is not part of your role.`);
            }
        };
        const audited = <T>(action: string, target: string, value: T): T => {
            this.#store.audit(person.id, action, undefined, { board: target, by: call.pi === undefined ? "person" : "pi" });

            return value;
        };
        /** A look at a board its person sees only through projects.view_all: logged. */
        const looked = <T extends { project: Project }>(value: T): T => {
            const project = value.project;

            if (person.seesAll === true && !(project.owner === person.id || project.members.includes(person.id) || project.open || (project.team && person.managesTeam === true))) {
                this.#store.audit(person.id, "viewed board (view_all)", undefined, { board: project.key });
            }

            return value;
        };
        const visible = (projectId: string) => {
            const project = store.projectById(projectId);

            return project !== undefined && store.list(actor).some((each) => each.id === project.id) ? project : undefined;
        };
        const key = String(args[0] ?? "");
        // "pi" on the team server is the person's own Pi (their pi-phone runs it), never someone else's.
        const ownPi = (input: unknown) => {
            const given = (input ?? {}) as Record<string, unknown>;

            return typeof given.assignee === "string" && given.assignee.trim().toLowerCase() === "pi" ? { ...given, assignee: `pi:${person.id}` } : given;
        };

        switch (call.method) {
            case "list":
                return store.list(actor);
            case "allProjects":
                return store.list(actor).map(({ counts: _counts, ...project }) => project);
            case "board":
                return looked(store.board(actor, key));
            case "project":
                return looked({ project: store.project(actor, key) }).project;
            case "task":
                return looked(store.task(actor, key));
            case "tasks":
                return store.tasks(actor, args[0] === undefined || args[0] === null ? undefined : key, (args[1] ?? {}) as never);
            case "projectById":
                return visible(key);
            case "taskById": {
                const found = store.taskById(key);

                return found !== undefined && visible(found.project.id) !== undefined ? found : undefined;
            }
            case "sessionsOf": {
                const found = store.taskById(key);

                return found !== undefined && visible(found.project.id) !== undefined ? store.sessionsOf(key) : [];
            }
            case "create": {
                const input = (args[0] ?? {}) as { key: string; name: string; team?: boolean };

                permitted("projects.create", "Making boards");

                // Where its code is stays with each pi-phone: never kept here.
                return audited("board created", String(input.key).toUpperCase(), store.create(actor, { key: input.key, name: input.name, ...(input.team === true ? { team: true } : {}) }));
            }
            case "update": {
                const patch = (args[1] ?? {}) as Record<string, unknown>;
                const personal = Object.keys(patch).filter((field) => PERSONAL.includes(field));

                if (personal.length > 0) {
                    throw new HttpError(400, `A board's ${personal.join(", ")} are each person's own, in their pi-phone.`);
                }

                return store.update(actor, key, patch);
            }
            case "setMembers":
                permitted("projects.share", "Sharing boards");

                return audited("board shared", key.toUpperCase(), store.setMembers(actor, key, (args[1] ?? []) as string[], (args[2] ?? {}) as never));
            case "leave":
                return audited("board left", key.toUpperCase(), store.leave(actor, key));
            case "moveToTeam":
                return audited("board moved to the team", key.toUpperCase(), store.moveToTeam(actor, key));
            case "setOpen":
                return audited(args[1] === true ? "board opened to the team" : "board closed to its members", key.toUpperCase(), store.setOpen(actor, key, args[1] === true));
            case "remove":
                permitted("projects.delete", "Deleting boards");

                return audited("board deleted", key.toUpperCase(), store.remove(actor, key));
            case "createTask":
                return store.createTask(actor, key, ownPi(args[1]) as never);
            case "updateTask":
                return store.updateTask(actor, key, ownPi(args[1]) as never);
            case "comment":
                return store.comment(actor, key, String(args[1] ?? ""));
            case "link":
                return store.link(actor, key, String(args[1] ?? ""), args[2] as never);
            case "unlink":
                return store.unlink(actor, key, String(args[1] ?? ""), args[2] as never);
            case "removeTask":
                return store.removeTask(actor, key);
            case "linkSession":
                return store.linkSession(actor, key, own(args[1]), args[2] as never);
            case "startWork": {
                const found = store.taskById(key);

                // Only on a board this person may change.
                if (found === undefined || visible(found.project.id) === undefined || store.roleOn(person, found.project) === "viewer") {
                    throw new HttpError(404, `There is no task ${key} you may work on.`);
                }

                return store.startWork(key, own(args[1]));
            }
            default:
                throw new HttpError(400, `${call.method} is not something the board service does.`);
        }
    }
}
