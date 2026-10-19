/**
 * Projects: boards of tasks for people and Pi, as a backlog that keeps work from being forgotten. Pi uses a board only
 * where the person said yes (board mode, asked once on an inline card, or the session's switch), with the project tools
 * (project_list, task_create, task_update, task_comment, ...). Rules that must hold are kept by the app: who may see a
 * project, the task types' hierarchy, a person's approval before Done where a task needs it, and never approving your
 * own work. While this is off there is no board, no tools, and no board mode; projects stay saved.
 */
import { type Static, type TSchema, Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, section } from "@earendil-works/pi-durable";
import type { ExtensionWeb, PocketHost, WebRequest } from "../host.ts";
import { HttpError } from "../errors.ts";
import {
    type Actor,
    type BoardTask,
    LINK_KINDS,
    type LinkKind,
    type Person,
    Projects,
    STATE_NAMES,
    STATES,
    type TaskInput,
    type TaskPatch,
    type TaskState,
    TYPES,
} from "../projects.ts";

const reply = (text: string, isError = false) => ({
    output: [{ type: "text" as const, text }],
    ...(isError ? { isError: true } : {}),
});

/** How Pi works with a board once the person said yes (agent-board's task protocol, for these tools). */
const BOARD_RULES = `- Track this work as tasks: task_create (type epic, story, task, bug or subtask: an epic holds stories, tasks and bugs; a story holds tasks, bugs and subtasks; a task or bug holds subtasks). Create tasks first, link what blocks what, and only then assign them.
- Keep tasks current with task_update as you work: in_progress when you start, testing while you verify, review when it is done. Never move a task you worked on to done: the main session or a person approves it.
- Need an answer, an approval, or something you cannot do? Set the task blocked with blocked_reason, and say what you need. Never use review to ask a question.
- Destructive or risky work (migrations, infrastructure, security, secrets, production config, first deploys): set operator_review, so only a person moves it to done. A bug is done only after you verified its fix (fix_verified).
- Comment (task_comment) with results, questions, blockers, and decisions only: no acknowledgements or restated plans.
- Assigning a task to pi does not start any work by itself.`;

const PROJECT = Type.Optional(Type.String({ description: "The project's key (PP); default: this session's project" }));
const REF = Type.String({ description: "The task, like PP-12" });
const STATE = Type.Union(STATES.map((state) => Type.Literal(state)));
const KIND = Type.Union(TYPES.map((type) => Type.Literal(type)));
const LINK = Type.Union(LINK_KINDS.map((kind) => Type.Literal(kind)));
const CHECKLIST = Type.Array(Type.Object({ text: Type.String(), done: Type.Optional(Type.Boolean()) }));

/** One line for a task, as the tools list it. */
function line(task: BoardTask): string {
    const who = task.assignee === null ? "" : task.assignee === "pi" ? " · pi" : " · assigned";
    const waiting = task.waitingOn.length === 0 ? "" : ` · waiting on ${task.waitingOn.join(", ")}`;
    const progress = task.progress === null ? "" : ` · ${task.progress[0]}/${task.progress[1]}`;

    return `${task.ref} [${task.type}, ${STATE_NAMES[task.state]}${task.priority > 0 ? `, p${task.priority}` : ""}] ${task.title}${who}${progress}${waiting}${task.parentRef === null ? "" : ` · under ${task.parentRef}`}`;
}

export default function createProjects(host: PocketHost, web: ExtensionWeb) {
    const people = (): Person[] => host.people();
    const projects = new Projects(host.dataDir, people);
    const view = { access: "view" as const };
    const steer = { access: "steer" as const };

    web.onDispose(() => projects.close());
    // Open boards follow changes as they happen.
    projects.onChange((projectId) => web.send("changed", { projectId }));

    // ---- Routes: /api/x/projects/... -----------------------------------------------------------------------------

    const personOf = (request: WebRequest): Actor => ({ kind: "person", person: { ...request.user } });
    /** A route whose store errors answer with their status and words. */
    const route = (
        method: Parameters<ExtensionWeb["route"]>[0],
        path: string,
        handle: (request: WebRequest, actor: Actor) => unknown,
        access: { access: "view" | "steer" },
    ) =>
        web.route(
            method,
            path,
            (request) => {
                try {
                    return handle(request, personOf(request));
                } catch (error) {
                    throw error instanceof HttpError ? web.error(error.status, error.message) : error;
                }
            },
            access,
        );
    /** The JSON a browser sent, checked field by field by the store. */
    const body = (request: WebRequest) => request.body as never;

    route("GET", "projects", (_request, actor) => ({ projects: projects.list(actor), states: STATES, types: TYPES }), view);
    route("POST", "projects", (request, actor) => projects.create(actor, body(request)), steer);
    route("GET", "projects/:key", (request, actor) => projects.board(actor, request.params.key!), view);
    route("PATCH", "projects/:key", (request, actor) => projects.update(actor, request.params.key!, body(request)), steer);
    route(
        "DELETE",
        "projects/:key",
        (request, actor) => {
            projects.remove(actor, request.params.key!);

            return {};
        },
        steer,
    );
    route(
        "PUT",
        "projects/:key/members",
        (request, actor) => {
            const members = request.body.members;

            if (!Array.isArray(members) || members.some((member) => typeof member !== "string")) {
                throw new HttpError(400, "Send members: a list of people's ids.");
            }

            return projects.setMembers(actor, request.params.key!, members as string[]);
        },
        steer,
    );
    route("POST", "projects/:key/tasks", (request, actor) => projects.createTask(actor, request.params.key!, body(request)), steer);
    route("GET", "tasks/:ref", (request, actor) => projects.task(actor, request.params.ref!), view);
    route("PATCH", "tasks/:ref", (request, actor) => projects.updateTask(actor, request.params.ref!, body(request)), steer);
    route(
        "DELETE",
        "tasks/:ref",
        (request, actor) => {
            projects.removeTask(actor, request.params.ref!);

            return {};
        },
        steer,
    );
    route("POST", "tasks/:ref/comments", (request, actor) => projects.comment(actor, request.params.ref!, String(request.body.text ?? "")), steer);
    route(
        "POST",
        "tasks/:ref/links",
        (request, actor) => {
            projects.link(actor, request.params.ref!, String(request.body.to ?? ""), request.body.kind as LinkKind);

            return projects.task(actor, request.params.ref!);
        },
        steer,
    );
    route(
        "DELETE",
        "tasks/:ref/links/:kind/:to",
        (request, actor) => {
            projects.unlink(actor, request.params.ref!, request.params.to!, request.params.kind as LinkKind);

            return projects.task(actor, request.params.ref!);
        },
        steer,
    );
    /** A session's board mode: its switch in the session menu. Only people who can see the session. */
    const session = (request: WebRequest) => {
        const id = request.params.conversation!;

        if (!/^\d+$/.test(id) || !host.canSee(request.user.id, Number(id) as never)) {
            throw new HttpError(404, "This session is not shared with you.");
        }

        return id;
    };
    const modeOf = (id: string) => {
        const mode = projects.boardMode(id);

        return { on: mode?.on ?? false, decided: mode !== undefined, project: mode?.project?.key ?? null };
    };

    route("GET", "board-mode/:conversation", (request) => modeOf(session(request)), view);
    route(
        "PUT",
        "board-mode/:conversation",
        (request, actor) => {
            const id = session(request);
            const { on, project } = request.body;

            if (typeof on !== "boolean" || (project !== null && project !== undefined && typeof project !== "string")) {
                throw new HttpError(400, "Send on (true or false), and the project's key.");
            }

            projects.setBoardMode(actor, id, on, (project as string | undefined) ?? projects.boardMode(id)?.project?.key ?? null);

            return modeOf(id);
        },
        steer,
    );

    // ---- Tools ---------------------------------------------------------------------------------------------------

    /** Pi, working for the person whose message led to this work in this session. */
    const piOf = (conversationId: string): Actor => {
        // Conversation ids are numbers to the app; the board keeps them as text.
        const id = host.requesterOf(Number(conversationId) as never);
        const person = id === undefined ? undefined : people().find((each) => each.id === id);

        if (person === undefined) {
            throw new HttpError(403, "Nobody asked for this work, so there is nobody to act for on the board.");
        }

        return { kind: "pi", person, conversationId };
    };
    /** Board tools work only where the person said yes. */
    const onBoard = (conversationId: string): { actor: Actor; project: string | null } => {
        const mode = projects.boardMode(conversationId);

        if (mode?.on !== true) {
            throw new HttpError(
                409,
                mode === undefined
                    ? "Board mode is off in this session: ask the person first with board_mode."
                    : "The person turned board mode off in this session: work without the board.",
            );
        }

        return { actor: piOf(conversationId), project: mode.project?.key ?? null };
    };
    const projectOf = (given: string | undefined, fallback: string | null): string => {
        const key = given ?? fallback;

        if (key === null) {
            throw new HttpError(400, "Say which project (its key): this session has none of its own.");
        }

        return key;
    };
    const tool = <P extends TSchema>(
        name: string,
        description: string,
        parameters: P,
        run: (args: Static<P>, conversationId: string, api: { taskId: unknown; callId?: string }, context: never) => string | Promise<string>,
    ) =>
        defineTool({
            name,
            description,
            parameters: parameters as never,
            execute: async (args, api, context) => {
                try {
                    return reply(await run(args as Static<P>, String(api.conversationId), api, context as never));
                } catch (error) {
                    if (error instanceof HttpError) {
                        return reply(error.message, true);
                    }

                    throw error;
                }
            },
        });
    const patchOf = (args: Record<string, unknown>): TaskPatch => {
        const patch: TaskPatch = {};
        const map: Record<string, keyof TaskPatch> = {
            title: "title",
            type: "type",
            description: "description",
            state: "state",
            priority: "priority",
            labels: "labels",
            assignee: "assignee",
            start: "start",
            due: "due",
            parent: "parent",
            checklist: "checklist",
            operator_review: "operatorReview",
            fix_verified: "fixVerified",
            blocked_reason: "blockedReason",
        };

        for (const [from, to] of Object.entries(map)) {
            if (args[from] !== undefined) {
                (patch as Record<string, unknown>)[to] = args[from];
            }
        }

        return patch;
    };

    const tools = [
        tool(
            "board_mode",
            "Ask the person once whether to track this session's work on a project board (an inline card they answer). Needed before any other board tool here. Name an existing project's key, or a new key with a name to create it.",
            Type.Object({
                project: Type.String({ description: "The project's key (PP); a new one is made when the person agrees" }),
                name: Type.Optional(Type.String({ description: "A new project's name" })),
                reason: Type.String({ description: "What you would track, in a sentence: shown on the card" }),
            }),
            async (args, conversationId, api, context) => {
                const mode = projects.boardMode(conversationId);

                if (mode?.on === true) {
                    return `Board mode is already on here${mode.project === null ? "" : `, with ${mode.project.key}`}.`;
                }

                if (mode !== undefined) {
                    throw new HttpError(409, "The person said no to the board in this session: do not ask again. They can turn it on from the session menu.");
                }

                const actor = piOf(conversationId);
                const key = args.project.trim().toUpperCase();
                const existing = projects.list(actor).find((project) => project.key === key);

                if (existing === undefined && (args.name ?? "").trim() === "") {
                    throw new HttpError(400, `There is no project ${key}: give a name to make it, or pick one from project_list.`);
                }

                const answer = await host.approvals.request(
                    {
                        id: `board-mode-${conversationId}-${String(api.callId)}`,
                        conversationId: Number(conversationId) as never,
                        taskId: api.taskId as never,
                        ...(api.callId === undefined ? {} : { callId: api.callId }),
                        tool: "board_mode",
                        subject:
                            existing === undefined
                                ? `Track this on a new board: ${key} · ${args.name!.trim()}`
                                : `Track this on the board: ${key} · ${existing.name}`,
                        reason: args.reason,
                        createdAt: Date.now(),
                    },
                    context,
                );
                const person: Actor = { kind: "person", person: actor.person };

                if (!answer.allow) {
                    projects.setBoardMode(person, conversationId, false, existing === undefined ? null : key);

                    return `${answer.by === "superseded" ? "The question was replaced" : `${answer.by} said no`}: work without the board in this session, and do not ask again.`;
                }

                if (existing === undefined) {
                    projects.create(person, { key, name: args.name!.trim() });
                }

                projects.setBoardMode(person, conversationId, true, key);

                return `Board mode is on, with ${key}. Track this work there.`;
            },
        ),
        tool(
            "project_list",
            "The project boards the person you work for can see, with how many tasks are in each state, and this session's board mode.",
            Type.Object({}),
            (_args, conversationId) => {
                const list = projects.list(piOf(conversationId));
                const mode = projects.boardMode(conversationId);
                const said =
                    mode?.on === true
                        ? `Board mode is on here${mode.project === null ? "" : `, with ${mode.project.key}`}.`
                        : mode === undefined
                          ? "Board mode is off here: ask with board_mode before using a board."
                          : "The person said no to the board in this session.";

                if (list.length === 0) {
                    return `No projects yet. ${said}`;
                }

                return `${list
                    .map((project) => {
                        const open = STATES.filter((state) => state !== "done" && project.counts[state] > 0)
                            .map((state) => `${project.counts[state]} ${STATE_NAMES[state]}`)
                            .join(", ");

                        return `${project.key} · ${project.name}${project.folder === null ? "" : ` (${project.folder})`}: ${open === "" ? "nothing open" : open}; ${project.counts.done} done`;
                    })
                    .join("\n")}\n${said}`;
            },
        ),
        tool(
            "project_create",
            "Make a project board: a key of 2 to 6 letters or digits (PP), a name, and the folder its work happens in.",
            Type.Object({
                key: Type.String(),
                name: Type.String(),
                folder: Type.Optional(Type.String({ description: "Where its work happens: a folder here, or machine:<id>:<path>" })),
            }),
            (args, conversationId) => {
                const { actor } = onBoard(conversationId);
                const made = projects.create(actor, { key: args.key, name: args.name, folder: args.folder ?? null });

                return `Made ${made.key} · ${made.name}.`;
            },
        ),
        tool(
            "task_list",
            "Tasks on a board, filtered: by state, type, assignee (pi or a name), parent, or words. Newest first.",
            Type.Object({
                project: PROJECT,
                state: Type.Optional(STATE),
                type: Type.Optional(KIND),
                assignee: Type.Optional(Type.String()),
                parent: Type.Optional(Type.String()),
                text: Type.Optional(Type.String()),
                limit: Type.Optional(Type.Number()),
            }),
            (args, conversationId) => {
                const { actor, project } = onBoard(conversationId);
                const { project: _project, ...filter } = args;
                const found = projects.tasks(actor, args.project ?? project ?? undefined, filter as never);

                return found.length === 0 ? "No tasks match." : found.map(line).join("\n");
            },
        ),
        tool(
            "task_get",
            "A task in full: its fields, description, checklist, links, comments, activity, and sessions.",
            Type.Object({ task: REF }),
            (args, conversationId) => {
                const { actor } = onBoard(conversationId);
                const { task, comments, links, sessions } = projects.task(actor, args.task);
                const parts = [
                    line(task),
                    task.description === "" ? "" : `\n${task.description}`,
                    task.checklist.length === 0 ? "" : `\nChecklist:\n${task.checklist.map((item) => `- [${item.done ? "x" : " "}] ${item.text}`).join("\n")}`,
                    task.blockedReason === null ? "" : `\nBlocked: ${task.blockedReason}`,
                    task.operatorReview ? "\nNeeds a person's approval before Done." : "",
                    task.type === "bug" ? `\nFix verified: ${task.fixVerified ? "yes" : "no"}` : "",
                    task.start === null && task.due === null ? "" : `\nDates: ${task.start ?? "?"} → ${task.due ?? "?"}`,
                    task.children.length === 0 ? "" : `\nUnder it: ${task.children.join(", ")}`,
                    links.length === 0
                        ? ""
                        : `\nLinks: ${links.map((link) => (link.kind === "blocks" ? (link.direction === "out" ? `blocks ${link.ref}` : `waits on ${link.ref}`) : `relates to ${link.ref}`)).join(", ")}`,
                    sessions.length === 0 ? "" : `\nSessions: ${sessions.map((each) => `#${each.conversationId} (${each.role})`).join(", ")}`,
                    comments.length === 0
                        ? ""
                        : `\nComments:\n${comments.map((comment) => `- ${comment.authorName}: ${host.text.defang(comment.text)}`).join("\n")}`,
                ];

                return parts.join("");
            },
        ),
        tool(
            "task_create",
            "Add a task to a board. Create tasks before assigning them, and link what blocks what.",
            Type.Object({
                project: PROJECT,
                title: Type.String(),
                type: Type.Optional(KIND),
                description: Type.Optional(Type.String({ description: "What to do, with real values and an acceptance checklist" })),
                state: Type.Optional(STATE),
                priority: Type.Optional(Type.Number({ description: "0 none, 1 low, 2 medium, 3 high, 4 urgent" })),
                labels: Type.Optional(Type.Array(Type.String())),
                assignee: Type.Optional(Type.String({ description: "pi, or a person's name" })),
                start: Type.Optional(Type.String({ description: "YYYY-MM-DD" })),
                due: Type.Optional(Type.String({ description: "YYYY-MM-DD" })),
                parent: Type.Optional(Type.String({ description: "The task it sits under, like PP-3" })),
                checklist: Type.Optional(CHECKLIST),
                operator_review: Type.Optional(Type.Boolean({ description: "Only a person may move it to Done" })),
                blocks: Type.Optional(Type.Array(Type.String(), { description: "Tasks that wait on this one" })),
            }),
            (args, conversationId) => {
                const { actor, project } = onBoard(conversationId);
                const key = projectOf(args.project, project);
                const { project: _project, blocks, operator_review, checklist, ...rest } = args;
                const made = projects.createTask(actor, key, {
                    ...(rest as Record<string, unknown> as TaskInput),
                    ...(operator_review === undefined ? {} : { operatorReview: operator_review }),
                    ...(checklist === undefined ? {} : { checklist: checklist.map((item) => ({ text: item.text, done: item.done === true })) }),
                });

                for (const other of blocks ?? []) {
                    projects.link(actor, made.ref, other, "blocks");
                }

                return `Made ${made.ref}: ${made.title}.`;
            },
        ),
        tool(
            "task_update",
            "Change a task: its state, fields, checklist, links. Moving it to in_progress marks this session as working on it.",
            Type.Object({
                task: REF,
                title: Type.Optional(Type.String()),
                type: Type.Optional(KIND),
                description: Type.Optional(Type.String()),
                state: Type.Optional(STATE),
                priority: Type.Optional(Type.Number()),
                labels: Type.Optional(Type.Array(Type.String())),
                assignee: Type.Optional(Type.String({ description: "pi, a person's name, or empty for nobody" })),
                start: Type.Optional(Type.String()),
                due: Type.Optional(Type.String()),
                parent: Type.Optional(Type.String({ description: "A task's ref, or empty to move it to the top" })),
                checklist: Type.Optional(CHECKLIST),
                operator_review: Type.Optional(Type.Boolean()),
                fix_verified: Type.Optional(Type.Boolean()),
                blocked_reason: Type.Optional(Type.String({ description: "With state blocked: what it waits for" })),
                link: Type.Optional(Type.Object({ to: Type.String(), kind: LINK })),
                unlink: Type.Optional(Type.Object({ to: Type.String(), kind: LINK })),
            }),
            (args, conversationId) => {
                const { actor } = onBoard(conversationId);
                const patch = patchOf(args as Record<string, unknown>);

                if (patch.parent === "") patch.parent = null;
                if (patch.assignee === "") patch.assignee = null;
                if (args.checklist !== undefined) patch.checklist = args.checklist.map((item) => ({ text: item.text, done: item.done === true }));

                const task = projects.updateTask(actor, args.task, patch);

                if (args.link !== undefined) projects.link(actor, task.ref, args.link.to, args.link.kind);
                if (args.unlink !== undefined) projects.unlink(actor, task.ref, args.unlink.to, args.unlink.kind);

                return `${task.ref} is ${STATE_NAMES[task.state as TaskState]}.`;
            },
        ),
        tool(
            "task_comment",
            "Comment on a task: a result, a question, a blocker, or a decision.",
            Type.Object({ task: REF, text: Type.String() }),
            (args, conversationId) => {
                const { actor } = onBoard(conversationId);

                projects.comment(actor, args.task, args.text);

                return `Commented on ${args.task.toUpperCase()}.`;
            },
        ),
    ];

    return defineExtension({
        name: "pocket-projects",
        tools,
        sections: [
            section("projects", (input) => {
                const mode = projects.boardMode(String(input.conversationId));

                if (mode?.on === true) {
                    return `Board mode is on in this session${mode.project === null ? "" : `, with project ${mode.project.key} · ${mode.project.name}`}: track this work on the board.\n${BOARD_RULES}`;
                }

                if (mode !== undefined) {
                    return "Projects: the person said no to a board in this session. Work without it and do not ask again; they can turn it on from the session menu.";
                }

                return "Projects: the person keeps project boards (project_list). When work here has several parts worth tracking, or they ask you to track or remember something, ask once with board_mode before using any board tool. Do not ask for one-off questions or small changes.";
            }),
        ],
    });
}
