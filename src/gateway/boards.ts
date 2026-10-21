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
import { type Actor, type BoardRole, type Closer, CLOSERS, type Person, type Project, Projects, type Task } from "../server/projects.ts";
import type { GatewayStore, PersonBox } from "./store.ts";
import { ProjectWiki } from "./project-wiki.ts";

/** A call from a pi-phone: the store method, its arguments without the actor, and when Pi makes it, its session. */
export type BoardCall = { method: string; args: unknown[]; pi?: { conversationId: string; closer: Closer } };

/** The fields of a board that are each pi-phone's own. */
const PERSONAL = ["folder", "places", "mainSession", "autoRuns"];

export class BoardService {
    readonly #store: GatewayStore;
    readonly #projects: Projects;
    /** Each board's project wiki (PP-42). */
    readonly #wiki: ProjectWiki;
    readonly #changes = new Set<(projectId: string) => void>();
    readonly #removed = new Set<(projectId: string) => void>();

    constructor(store: GatewayStore, dir: string, now: () => number = Date.now) {
        this.#store = store;
        this.#projects = new Projects(dir, () => this.people(), now);
        this.#wiki = new ProjectWiki(dir, now);
        this.#projects.onChange((projectId) => this.#changed(projectId));
    }

    close(): void {
        this.#projects.close();
        this.#wiki.close();
    }

    #changed(projectId: string): void {
        for (const listener of this.#changes) {
            listener(projectId);
        }
    }

    /** Call `listener` with a board's id when it is deleted (its documents go too, PP-46). */
    onRemoved(listener: (projectId: string) => void): () => void {
        this.#removed.add(listener);

        return () => this.#removed.delete(listener);
    }

    /** A person's standing on a board they see, by its key; refused (404) when they don't see it. */
    standing(userId: string, key: string): { id: string; key: string; name: string; role: BoardRole } {
        const person = this.people().find((each) => each.id === userId);

        if (person === undefined) {
            throw new HttpError(403, "No such person here.");
        }

        const project = this.#projects.project({ kind: "person", person }, key);

        return { id: project.id, key: project.key, name: project.name, role: this.#projects.roleOn(person, project) ?? "viewer" };
    }

    /** The boards a person sees, with their standing on each. */
    seen(userId: string): { id: string; key: string; name: string; role: BoardRole }[] {
        const person = this.people().find((each) => each.id === userId);

        return person === undefined ? [] : this.#projects.list({ kind: "person", person }).map((project) => ({ id: project.id, key: project.key, name: project.name, role: this.#projects.roleOn(person, project) ?? "viewer" }));
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
        this.#changes.add(listener);

        return () => this.#changes.delete(listener);
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

        /** Sessions in someone's pi-phone (`<key>:<n>`) named with whose it is, so others see "in Binh's pi-phone". */
        const named = <T>(value: T): T => {
            const whose = (session: unknown) => {
                const key = typeof session === "string" ? /^([a-z0-9]+):\d+$/.exec(session)?.[1] : undefined;
                const box = key === undefined ? undefined : this.#store.boxByKey(key);

                return box === undefined ? undefined : this.people().find((each) => each.id === box.userId)?.name;
            };
            const shown = value as { sessions?: { conversationId: string; by?: string }[]; comments?: { session: string | null; by?: string }[]; activity?: { data: Record<string, unknown> }[] };

            for (const session of shown.sessions ?? []) {
                session.by = whose(session.conversationId);
            }

            for (const comment of shown.comments ?? []) {
                comment.by = whose(comment.session);
            }

            for (const event of shown.activity ?? []) {
                if (typeof event.data.session === "string") {
                    event.data.by = whose(event.data.session);
                }
            }

            return value;
        };

        const wiki = this.#wiki;
        /** A board whose wiki this person may write: its leads and members, not its viewers. */
        const writable = (project: Project) => {
            if (person.role === "viewer" || store.roleOn(person, project) === "viewer") {
                throw new HttpError(403, `You are a viewer on ${project.key}: its wiki is its members' to write.`);
            }

            return project;
        };
        const by = { id: person.id, name: call.pi === undefined ? person.name : `Pi (${person.name})` };

        switch (call.method) {
            // Who is on the team, to share boards with and give tasks to (names only), and who this person is (PP-43).
            case "people":
                return this.people().map(({ id, name, role }) => ({ id, name, role }));
            case "me": {
                const role = this.#store.roleOf(person.id, this.#store.users().find((user) => user.id === person.id)?.role).permissions as readonly string[];

                return { id: person.id, name: person.name, managesTeam: person.managesTeam === true, seesAll: person.seesAll === true, canCreate: role.includes("projects.create"), canShare: role.includes("projects.share"), canDelete: role.includes("projects.delete") };
            }
            case "wikiList":
                return wiki.list(looked({ project: store.project(actor, key) }).project.id);
            case "wikiRead":
                return wiki.read(looked({ project: store.project(actor, key) }).project.id, String(args[1] ?? ""));
            case "wikiSearch":
                return wiki.search(store.project(actor, key).id, String(args[1] ?? ""), Number(args[2] ?? 10));
            case "wikiWrite": {
                const project = writable(store.project(actor, key));
                const page = wiki.write(project.id, (args[1] ?? {}) as never, by);

                this.#changed(project.id);

                return page;
            }
            case "wikiEdit": {
                const project = writable(store.project(actor, key));
                const page = wiki.edit(project.id, String(args[1] ?? ""), (args[2] ?? []) as never, by);

                this.#changed(project.id);

                return page;
            }
            case "list":
                return store.list(actor);
            case "allProjects":
                return store.list(actor).map(({ counts: _counts, ...project }) => project);
            case "board":
                return looked(store.board(actor, key));
            case "project":
                return looked({ project: store.project(actor, key) }).project;
            case "task":
                return named(looked(store.task(actor, key)));
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

                return found !== undefined && visible(found.project.id) !== undefined ? named({ sessions: store.sessionsOf(key) }).sessions : [];
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

                {
                    const project = store.project(actor, key);

                    store.remove(actor, key);
                    wiki.forget(project.id);

                    for (const listener of this.#removed) {
                        listener(project.id);
                    }

                    return audited("board deleted", key.toUpperCase(), undefined);
                }
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
            case "recordRun": {
                const info = (args[1] ?? {}) as { state: never; branch: string | null; conversationId: string | null };

                // Marked with the pi-phone it ran in, with or without a session yet ("0": none), so the others see whose it is.
                return store.recordRun(actor, key, { state: info.state, branch: info.branch ?? null, conversationId: own(info.conversationId ?? "0") });
            }
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
