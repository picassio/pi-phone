/**
 * The shared part of the boards from the team server's board service (PP-40), for a pi-phone behind its gateway: every
 * board call goes to `POST <gateway>/internal/boards` with this pi-phone's owner token, as its person or as Pi working
 * for them in a session (the gateway makes the actor; it never takes one from here).
 *
 * The boards this person sees are mirrored into the local store (`Projects.mirror`), so what is personal (runs, places,
 * board mode, a board's main session) finds its project and tasks as on the phone. The mirror follows the gateway: in
 * full on start (`sync`), and a board at a time after each change here or a push from the gateway (`received`). A board
 * no longer seen is unmirrored, which stops its runs. What is personal on a board (its folder, places, running Pi's
 * tasks by itself, main session) stays here and is laid over the gateway's answers.
 *
 * Sessions on the gateway are `<key>:<number>`: this pi-phone's own come back as plain numbers, others' stay as they are.
 */
import { HttpError } from "./errors.ts";
import { type Boards, SHARED, type SharedMethod } from "./boards.ts";
import type { Actor, Closer, Project, Projects, Run, Task, TaskLink } from "./projects.ts";

/** Methods whose first argument is not an actor. */
const ACTORLESS = new Set<SharedMethod>(["sessionsOf", "taskById", "projectById", "allProjects", "startWork"]);
/** Methods that change a board: its mirror follows. */
const WRITES = new Set<SharedMethod>(["create", "update", "setMembers", "leave", "moveToTeam", "setOpen", "remove", "createTask", "updateTask", "comment", "link", "unlink", "removeTask", "linkSession", "startWork"]);
/** What is personal on a board, kept here only. */
const PERSONAL = ["folder", "places", "autoRuns", "mainSession"] as const;

export type RemoteBoards = Boards & {
    /** The gateway says a board changed: its mirror follows; with `assigned`, a task was given to this person's Pi. */
    received(push: { projectId: string; assigned?: Task }): Promise<void>;
    /** Mirror every board this person sees, and forget the ones they no longer do. */
    sync(): Promise<void>;
};

export type RemoteBoardsOptions = {
    /** The gateway's internal address and this pi-phone's token there (`host.teamServer`). */
    url: string;
    token: string;
    /** The local store: the mirror, and what is personal. */
    projects: Projects;
    /** Runs a board no longer shared stopped: their sessions are told. */
    stopped: (runs: Run[], board: string) => void;
    fetch?: typeof fetch;
};

export function remoteBoards(options: RemoteBoardsOptions): RemoteBoards {
    const { projects } = options;
    const send = options.fetch ?? fetch;
    const assigned = new Set<(task: Task) => void>();

    /** One call to the board service: its answer, with this pi-phone's own sessions as plain numbers. */
    const call = async (method: string, args: unknown[], pi?: { conversationId: string; closer: Closer }): Promise<unknown> => {
        const response = await send(`${options.url}/internal/boards`, {
            method: "POST",
            headers: { authorization: `Bearer ${options.token}`, "content-type": "application/json" },
            body: JSON.stringify({ method, args, ...(pi === undefined ? {} : { pi }) }),
            signal: AbortSignal.timeout(20_000),
        });
        const body = (await response.json()) as { value?: unknown; key?: string; error?: string };

        if (!response.ok) {
            throw new HttpError(response.status, body.error ?? `The team's boards answered ${response.status}.`);
        }

        return body.key === undefined ? body.value : own(body.value, new RegExp(`^${body.key}:(\\d+)$`));
    };

    /** `value` with this pi-phone's sessions (`<key>:<n>`) as plain numbers, deep. */
    const own = (value: unknown, mine: RegExp): unknown => {
        if (typeof value === "string") {
            return value.replace(mine, "$1");
        }

        if (Array.isArray(value)) {
            return value.map((each) => own(each, mine));
        }

        if (value !== null && typeof value === "object") {
            return Object.fromEntries(Object.entries(value).map(([name, each]) => [name, own(each, mine)]));
        }

        return value;
    };

    /** `value` with what is personal laid over each board in it, deep. */
    const personal = (value: unknown): unknown => {
        if (Array.isArray(value)) {
            return value.map(personal);
        }

        if (value !== null && typeof value === "object") {
            const object = value as Record<string, unknown>;
            const laid = Object.fromEntries(Object.entries(object).map(([name, each]) => [name, personal(each)]));

            if (typeof object.id === "string" && typeof object.key === "string" && Array.isArray(object.members)) {
                return { ...laid, ...(projects.personalOf(object.id) ?? { folder: null, places: [], autoRuns: false, mainSession: null }) };
            }

            return laid;
        }

        return value;
    };

    /** The mirror of one board follows the gateway; a board no longer seen is forgotten here, and its runs stopped. */
    const refresh = async (key: string): Promise<void> => {
        try {
            projects.mirror((await call("board", [key])) as { project: Project; tasks: Task[]; links: TaskLink[] });
        } catch (error) {
            if (!(error instanceof HttpError) || error.status !== 404) {
                throw error;
            }

            const here = projects.allProjects().find((project) => project.key === key.toUpperCase());

            if (here !== undefined) {
                options.stopped(projects.unmirror(here.id), here.key);
            }
        }
    };

    /** The key of the board a write was about. */
    const keyOf = (method: SharedMethod, args: unknown[], value: unknown): string | undefined => {
        if (method === "create") {
            return (value as Project).key;
        }

        if (method === "startWork") {
            return projects.taskById(String(args[0]))?.project.key;
        }

        return String(args[0] ?? "").split("-")[0];
    };

    const boards: Record<string, unknown> = {
        onChange: (listener: Parameters<Projects["onChange"]>[0]) => projects.onChange(listener),
        onAssignedToPi: (listener: (task: Task) => void) => {
            assigned.add(listener);

            return () => assigned.delete(listener);
        },
        received: async (push: { projectId: string; assigned?: Task }) => {
            const here = projects.projectById(String(push.projectId));
            const there = here === undefined ? ((await call("projectById", [push.projectId])) as Project | null) : here;

            if (there !== null && there !== undefined) {
                await refresh(there.key);
            }

            if (push.assigned !== undefined) {
                for (const listener of assigned) {
                    listener(push.assigned);
                }
            }
        },
        sync: async () => {
            const seen = (await call("allProjects", [])) as Project[];

            for (const project of seen) {
                await refresh(project.key);
            }

            for (const id of projects.mirrored().filter((id) => !seen.some((project) => project.id === id))) {
                const gone = projects.projectById(id)!;

                options.stopped(projects.unmirror(id), gone.key);
            }
        },
    };

    for (const name of SHARED) {
        boards[name] = async (...given: unknown[]) => {
            const actor = ACTORLESS.has(name) ? undefined : (given[0] as Actor);
            const args = actor === undefined ? given : given.slice(1);
            const pi = actor?.kind === "pi" ? { conversationId: actor.conversationId, closer: actor.closer } : undefined;

            // What is personal on a board stays here; the rest goes to the gateway.
            if (name === "update") {
                const patch = (args[1] ?? {}) as Record<string, unknown>;
                const mine = Object.fromEntries(Object.entries(patch).filter(([field]) => (PERSONAL as readonly string[]).includes(field)));
                const shared = Object.fromEntries(Object.entries(patch).filter(([field]) => !(PERSONAL as readonly string[]).includes(field)));
                const key = String(args[0]);

                if (Object.keys(shared).length > 0) {
                    await call("update", [key, shared], pi);
                }

                await refresh(key);

                const here = projects.allProjects().find((project) => project.key === key.toUpperCase());

                if (here === undefined) {
                    throw new HttpError(404, `There is no project ${key} shared with you.`);
                }

                if (Object.keys(mine).length > 0) {
                    projects.setPersonal(here.id, mine);
                }

                return personal(projects.projectById(here.id));
            }

            if (name === "create") {
                const input = (args[0] ?? {}) as { key: string; name: string; folder?: string | null; team?: boolean };
                const made = (await call("create", [{ key: input.key, name: input.name, ...(input.team === true ? { team: true } : {}) }], pi)) as Project;

                await refresh(made.key);

                if (input.folder !== undefined && input.folder !== null) {
                    projects.setPersonal(made.id, { folder: input.folder });
                }

                return personal(projects.projectById(made.id));
            }

            const value = await call(name, args, pi);

            if (WRITES.has(name)) {
                const key = keyOf(name, args, value);

                if (key !== undefined && key !== "") {
                    await refresh(key);
                }
            }

            return personal(value);
        };
    }

    return boards as RemoteBoards;
}
