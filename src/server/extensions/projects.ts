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
import { LEAD_RULES, Team, taskRules } from "../project-runs.ts";
import {
    type Actor,
    BOARD_RULE_LEVELS,
    type BoardRules,
    type BoardTask,
    CLOSERS,
    type Closer,
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

/**
 * How Pi works with a board once the person said yes (agent-board's task protocol, for these tools): `full`, or
 * `light` (track the work and keep it current, nothing more). `closer`: who moves a task Pi worked on to Done, a person
 * on the board, or Pi itself once the person approves in chat (a session's setting).
 */
export function boardRules(level: BoardRules, closer: Closer): string {
    const track =
        "- Track this work as tasks: task_create (type epic, story, task, bug or subtask: an epic holds stories, tasks and bugs; a story holds tasks, bugs and subtasks; a task or bug holds subtasks). Create tasks first, link what blocks what, and only then assign them.";
    const done =
        closer === "pi"
            ? "When a task is done, move it to review and tell the person in this chat what changed and how you checked it; when they say it is good, move it to done yourself (task_update). A task with operator_review still waits for a person to move it."
            : "Never move a task you worked on to done: the main session or a person approves it.";

    if (level === "light") {
        return [track, `- Keep tasks current with task_update as you work: in_progress when you start, review when it is done. ${done}`].join("\n");
    }

    return [
        track,
        `- Keep tasks current with task_update as you work: in_progress when you start, testing while you verify, review when it is done. ${done}`,
        "- Need an answer, an approval, or something you cannot do? Set the task blocked with blocked_reason, and say what you need. Never use review to ask a question.",
        "- Destructive or risky work (migrations, infrastructure, security, secrets, production config, first deploys): set operator_review, so only a person moves it to done. A bug is done only after you verified its fix (fix_verified).",
        "- Comment (task_comment) with results, questions, blockers, and decisions only: no acknowledgements or restated plans.",
        "- Giving a task to pi does not start it: task_run does, after the person says yes (unless the project runs tasks by itself).",
    ].join("\n");
}

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

    // The agent team: runs in worktrees at the project's places, and reports to its main session (`project-runs.ts`).
    const team = new Team(projects, host);

    team.start();
    web.onDispose(() => {
        team.stop();
        projects.close();
    });
    // The Projects page, the task sheet, and the session menu's board switch (`projects-web/`).
    web.client("projects-web", view);
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
                const convert = (error: unknown) => {
                    throw error instanceof HttpError ? web.error(error.status, error.message) : error;
                };

                try {
                    const result = handle(request, personOf(request));

                    return result instanceof Promise ? result.catch(convert) : result;
                } catch (error) {
                    return convert(error);
                }
            },
            access,
        );
    /** The JSON a browser sent, checked field by field by the store. */
    const body = (request: WebRequest) => request.body as never;

    route("GET", "projects", (_request, actor) => ({ projects: projects.list(actor), states: STATES, types: TYPES }), view);
    // People to share a project with and assign tasks to: names only.
    route("GET", "people", () => ({ people: people().map(({ id, name, role }) => ({ id, name, role })) }), view);
    route("POST", "projects", (request, actor) => projects.create(actor, body(request)), steer);
    route(
        "GET",
        "projects/:key",
        (request, actor) => {
            const board = projects.board(actor, request.params.key!);
            const lead = board.project.mainSession;
            const title = lead === null ? undefined : host.sessionTitle(Number(lead));

            return { ...board, lead: title === undefined ? null : { session: Number(lead), title }, places: projects.placesOf(board.project) };
        },
        view,
    );
    route("POST", "projects/:key/team", async (request, actor) => ({ session: await team.startLead(actor.person, request.params.key!) }), steer);
    route(
        "PATCH",
        "projects/:key",
        (request, actor) => {
            const saved = projects.update(actor, request.params.key!, body(request));

            // Its sessions' group is named after it.
            team.regroup(saved).catch((error: unknown) => host.notice("warning", `Projects: ${String(error)}`));

            return saved;
        },
        steer,
    );
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
    // With every run of the task, and its sessions' titles and where their work is (the sheet's run card and rows).
    route(
        "GET",
        "tasks/:ref",
        (request, actor) => {
            const seen = projects.task(actor, request.params.ref!);

            return {
                ...seen,
                runs: projects.runsOfTask(seen.task.id),
                sessions: seen.sessions.map((session) => {
                    const id = Number(session.conversationId);

                    return { ...session, title: host.sessionTitle(id) ?? null, state: host.sessionState(id) ?? null };
                }),
            };
        },
        view,
    );
    route(
        "GET",
        "tasks/:ref/stat",
        async (request, actor) => {
            const { task } = projects.task(actor, request.params.ref!);

            if (task.run === null || task.run.merged !== null) {
                throw new HttpError(409, `${task.ref} has no branch to read.`);
            }

            return { stat: await team.stat(task.run) };
        },
        view,
    );
    route(
        "POST",
        "tasks/:ref/run",
        (request, actor) => {
            const run = projects.queueRun(actor, request.params.ref!);

            team.pump();

            return run;
        },
        steer,
    );
    route(
        "DELETE",
        "tasks/:ref/run",
        (request, actor) => {
            projects.cancelRun(actor, request.params.ref!);

            return {};
        },
        steer,
    );
    route(
        "GET",
        "tasks/:ref/diff",
        async (request, actor) => {
            const { task } = projects.task(actor, request.params.ref!);

            if (task.run === null) {
                throw new HttpError(404, `${task.ref} has not run yet.`);
            }

            return { diff: await team.diff(task.run), branch: task.run.branch, base: task.run.base };
        },
        view,
    );
    route(
        "POST",
        "tasks/:ref/merge",
        async (request, actor) => {
            const { task } = projects.task(actor, request.params.ref!);

            if (task.run === null) {
                throw new HttpError(404, `${task.ref} has not run yet.`);
            }

            if (task.run.state === "running" || task.run.state === "starting") {
                throw new HttpError(409, `${task.ref} is still running.`);
            }

            const said = await team.merge(task.run, task, actor);

            // Merged by a person: the task is done, where its rules allow (a Bug waits for its verified fix).
            try {
                projects.updateTask(actor, task.ref, { state: "done" });
            } catch {
                // Left as it is; the sheet says why when the person moves it.
            }

            return { said };
        },
        steer,
    );
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

        return {
            on: mode?.on ?? false,
            decided: mode !== undefined,
            project: mode?.project?.key ?? null,
            closer: mode?.closer ?? "person",
            rules: mode?.rules ?? null,
            projectRules: mode?.project?.rules ?? "full",
        };
    };

    route("GET", "board-mode/:conversation", (request) => modeOf(session(request)), view);
    route(
        "PUT",
        "board-mode/:conversation",
        (request, actor) => {
            const id = session(request);
            const { on, project, closer, rules } = request.body;

            // Who closes tasks and the rules here, on their own; or board mode on or off, and its project.
            if (on === undefined && (closer !== undefined || rules !== undefined)) {
                projects.setBoardSettings(actor, id, {
                    ...(closer === undefined ? {} : { closer: closer as Closer }),
                    ...(rules === undefined ? {} : { rules: rules as BoardRules | null }),
                });

                return modeOf(id);
            }

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
            "board_settings",
            "How board mode works in this session, set by the person on a card: who moves tasks you worked on to Done (person: a person on the board; pi: you, once the person approves in this chat), and the board rules here (full, light, or project for the project's).",
            Type.Object({
                closer: Type.Optional(Type.Union(CLOSERS.map((closer) => Type.Literal(closer)))),
                rules: Type.Optional(Type.Union([...BOARD_RULE_LEVELS, "project"].map((level) => Type.Literal(level)))),
            }),
            async (args, conversationId, api, context) => {
                const { actor } = onBoard(conversationId);
                const mode = projects.boardMode(conversationId)!;

                if (args.closer === undefined && args.rules === undefined) {
                    return `Here: ${mode.closer === "pi" ? "you move tasks to done once the person approves in chat" : "a person moves tasks to done"}; ${mode.rules ?? `the project's (${mode.project?.rules ?? "full"})`} board rules.`;
                }

                const said = [
                    args.closer === undefined ? "" : args.closer === "pi" ? "Pi moves tasks to Done once you approve in chat" : "only a person moves tasks to Done",
                    args.rules === undefined ? "" : args.rules === "project" ? "the project's board rules" : `${args.rules} board rules`,
                ].filter(Boolean);
                const answer = await host.approvals.request(
                    {
                        id: `board-settings-${conversationId}-${String(api.callId)}`,
                        conversationId: Number(conversationId) as never,
                        taskId: api.taskId as never,
                        ...(api.callId === undefined ? {} : { callId: api.callId }),
                        tool: "board_settings",
                        subject: `In this session: ${said.join("; ")}`,
                        reason: "Board mode settings for this session; the session menu changes them too.",
                        createdAt: Date.now(),
                    },
                    context,
                );

                if (!answer.allow) {
                    return `${answer.by} said no: the settings stay.`;
                }

                projects.setBoardSettings({ kind: "person", person: actor.person }, conversationId, {
                    ...(args.closer === undefined ? {} : { closer: args.closer }),
                    ...(args.rules === undefined ? {} : { rules: args.rules === "project" ? null : args.rules }),
                });

                return `Set: ${said.join("; ")}.`;
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
            "project_update",
            "Change a project: its name, folder, its board rules (full or light), whether tasks given to Pi run by themselves, and where its tasks run (places: each the repository's folder there, here or machine:<id>:<path>, with how many run at once).",
            Type.Object({
                project: PROJECT,
                name: Type.Optional(Type.String()),
                folder: Type.Optional(Type.String()),
                auto_runs: Type.Optional(Type.Boolean({ description: "Tasks given to Pi start by themselves; off, the main session asks the person first" })),
                places: Type.Optional(Type.Array(Type.Object({ folder: Type.String(), cap: Type.Number({ description: "1 to 8 at once" }) }))),
                rules: Type.Optional(Type.Union(BOARD_RULE_LEVELS.map((level) => Type.Literal(level)), { description: "The board rules in Pi's prompt: full, or light (track work, keep it current)" })),
            }),
            (args, conversationId) => {
                const { actor, project } = onBoard(conversationId);
                const key = projectOf(args.project, project);
                const saved = projects.update(actor, key, {
                    ...(args.rules === undefined ? {} : { rules: args.rules }),
                    ...(args.name === undefined ? {} : { name: args.name }),
                    ...(args.folder === undefined ? {} : { folder: args.folder || null }),
                    ...(args.auto_runs === undefined ? {} : { autoRuns: args.auto_runs }),
                    ...(args.places === undefined ? {} : { places: args.places }),
                });

                team.regroup(saved).catch((error: unknown) => host.notice("warning", `Projects: ${String(error)}`));

                return `${saved.key} · ${saved.name}: ${saved.rules} board rules; folder ${saved.folder ?? "none"}; tasks given to Pi ${saved.autoRuns ? "run by themselves" : "run after the person says yes"}; places: ${projects.placesOf(saved).map((place) => `${place.folder} (${place.cap} at once)`).join(", ") || "none"}.`;
            },
        ),
        tool(
            "project_team",
            "Start a project's main session: it leads the project's team (plans, asks before runs, gets the task sessions' reports, reviews) in the project's folder. Answers its session id.",
            Type.Object({ project: PROJECT }),
            async (args, conversationId) => {
                const { actor, project } = onBoard(conversationId);
                const key = projectOf(args.project, project);
                const session = await team.startLead(actor.person, key);

                return `Started ${key}'s main session, #${session}. Reports from task sessions and tasks given to Pi go there.`;
            },
        ),
        tool(
            "task_link_session",
            "Link a session to a task, so the task lists it: this session, or another one you can see. The project's main session is linked as leading it.",
            Type.Object({ task: REF, session: Type.Optional(Type.Number({ description: "Another session's id; default: this one" })) }),
            (args, conversationId) => {
                const { actor } = onBoard(conversationId);
                const session = args.session === undefined ? conversationId : String(args.session);

                if (!host.canSee(actor.person.id, Number(session) as never) || host.sessionTitle(Number(session)) === undefined) {
                    throw new HttpError(404, `There is no session #${session} the person you work for can see.`);
                }

                const { project } = projects.task(actor, args.task);

                projects.linkSession(actor, args.task, session, project.mainSession === session ? "main" : "linked");

                return `Linked session #${session} to ${args.task.toUpperCase()}.`;
            },
        ),
        tool(
            "project_share",
            "Share a project with people (by name): they see its board and, unless they are viewers, change it. Replaces who it is shared with; the project's owner or the app's owner only.",
            Type.Object({ project: PROJECT, people: Type.Array(Type.String({ description: "A person's name" })) }),
            (args, conversationId) => {
                const { actor, project } = onBoard(conversationId);
                const key = projectOf(args.project, project);
                const everyone = people();
                const ids = args.people.map((name) => {
                    const found = everyone.find((person) => person.name.toLowerCase() === name.trim().toLowerCase());

                    if (found === undefined) {
                        throw new HttpError(400, `Nobody is called ${name}. People: ${everyone.map((person) => person.name).join(", ")}.`);
                    }

                    return found.id;
                });
                const saved = projects.setMembers(actor, key, ids);

                return `${saved.key} is shared with ${saved.members.map((id) => everyone.find((person) => person.id === id)?.name ?? id).join(", ") || "nobody else"}.`;
            },
        ),
        tool(
            "project_delete",
            "Delete a project and all its tasks, for good. Asks the person on a card first.",
            Type.Object({ project: Type.String({ description: "The project's key" }) }),
            async (args, conversationId, api, context) => {
                const { actor } = onBoard(conversationId);
                const project = projects.project(actor, args.project);
                const total = Object.values(projects.list(actor).find((each) => each.id === project.id)?.counts ?? {}).reduce((sum, n) => sum + n, 0);
                const answer = await host.approvals.request(
                    {
                        id: `project-delete-${conversationId}-${String(api.callId)}`,
                        conversationId: Number(conversationId) as never,
                        taskId: api.taskId as never,
                        ...(api.callId === undefined ? {} : { callId: api.callId }),
                        tool: "project_delete",
                        subject: `Delete ${project.key} · ${project.name} and its ${total} task${total === 1 ? "" : "s"}`,
                        reason: "For good: its tasks, comments, and runs go. Worktrees and branches in the repository stay.",
                        createdAt: Date.now(),
                    },
                    context,
                );

                if (!answer.allow) {
                    return `${answer.by} said no: ${project.key} stays.`;
                }

                projects.remove({ kind: "person", person: actor.person }, project.key);

                return `Deleted ${project.key}.`;
            },
        ),
        tool(
            "task_delete",
            "Delete a task with nothing under it, for good. Asks the person on a card first.",
            Type.Object({ task: REF }),
            async (args, conversationId, api, context) => {
                const { actor } = onBoard(conversationId);
                const { task } = projects.task(actor, args.task);
                const answer = await host.approvals.request(
                    {
                        id: `task-delete-${conversationId}-${String(api.callId)}`,
                        conversationId: Number(conversationId) as never,
                        taskId: api.taskId as never,
                        ...(api.callId === undefined ? {} : { callId: api.callId }),
                        tool: "task_delete",
                        subject: `Delete ${task.ref} · ${task.title}`,
                        reason: "For good: its comments and activity go too.",
                        createdAt: Date.now(),
                    },
                    context,
                );

                if (!answer.allow) {
                    return `${answer.by} said no: ${task.ref} stays.`;
                }

                projects.removeTask({ kind: "person", person: actor.person }, task.ref);

                return `Deleted ${task.ref}.`;
            },
        ),
        tool(
            "task_cancel_run",
            "Withdraw a task's run that waits for a place, before it starts.",
            Type.Object({ task: REF }),
            (args, conversationId) => {
                const { actor } = onBoard(conversationId);

                projects.cancelRun(actor, args.task);

                return `${args.task.toUpperCase()}'s run is withdrawn.`;
            },
        ),
        tool(
            "task_diff",
            "What a task's branch changed against the branch it started from (a 3-dot diff): the stat, then the patch, cut at 200 KB.",
            Type.Object({ task: REF }),
            async (args, conversationId) => {
                const { actor } = onBoard(conversationId);
                const { task } = projects.task(actor, args.task);

                if (task.run === null) {
                    throw new HttpError(404, `${task.ref} has not run yet.`);
                }

                const diff = await team.diff(task.run);

                return `${task.run.base}...${task.run.branch} at ${task.run.place}:\n${diff.trim() === "" ? "No changes." : diff}`;
            },
        ),
        tool(
            "task_merge",
            "Merge a task's branch into the branch it started from (the repository there must be on it, with nothing uncommitted), then remove its worktree and branch. Merging is the person's call: asks on a card first.",
            Type.Object({ task: REF }),
            async (args, conversationId, api, context) => {
                const { actor } = onBoard(conversationId);
                const { task } = projects.task(actor, args.task);

                if (task.run?.branch == null || task.run.state === "running" || task.run.state === "starting" || task.run.state === "queued") {
                    throw new HttpError(409, `${task.ref} has no finished run with a branch to merge.`);
                }

                const answer = await host.approvals.request(
                    {
                        id: `task-merge-${conversationId}-${String(api.callId)}`,
                        conversationId: Number(conversationId) as never,
                        taskId: api.taskId as never,
                        ...(api.callId === undefined ? {} : { callId: api.callId }),
                        tool: "task_merge",
                        subject: `Merge ${task.run.branch} into ${task.run.base} (${task.ref} · ${task.title})`,
                        reason: `At ${task.run.place}. Its worktree and branch go after.`,
                        createdAt: Date.now(),
                    },
                    context,
                );

                if (!answer.allow) {
                    return `${answer.by} said not now: ${task.run.branch} is not merged.`;
                }

                const person: Actor = { kind: "person", person: actor.person };
                const said = await team.merge(task.run, task, person);

                try {
                    projects.updateTask(person, task.ref, { state: "done" });
                } catch {
                    // Left as it is (a Bug waits for its verified fix).
                }

                return `Merged ${task.run.branch} into ${task.run.base}.${said === "" ? "" : `\n${said.slice(-1500)}`}`;
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
                    task.run === null
                        ? ""
                        : `\nRun: ${task.run.state}${task.run.place === null ? "" : ` at ${task.run.place}`}${task.run.branch === null ? "" : `, branch ${task.run.branch} from ${task.run.base}`}${task.run.conversationId === null ? "" : `, session #${task.run.conversationId}`}${task.run.note === null ? "" : ` (${task.run.note})`}`,
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
            "task_run",
            "Run a task: Pi works on it in a task session of its own, in a git worktree on branch task/<ref>, at one of the project's places. Asks the person first unless the project runs tasks by itself. Reports come to the project's main session.",
            Type.Object({ task: REF }),
            async (args, conversationId, api, context) => {
                const { actor } = onBoard(conversationId);
                const ref = args.task.trim().toUpperCase();
                const { project, task } = projects.task(actor, ref);

                if (!project.autoRuns) {
                    const answer = await host.approvals.request(
                        {
                            id: `task-run-${conversationId}-${String(api.callId)}`,
                            conversationId: Number(conversationId) as never,
                            taskId: api.taskId as never,
                            ...(api.callId === undefined ? {} : { callId: api.callId }),
                            tool: "task_run",
                            subject: `${task.ref} · ${task.title}`,
                            reason: `Run it now: a task session works on it in a git worktree on branch task/${task.ref}, at the place of ${project.key} with the most room.`,
                            createdAt: Date.now(),
                        },
                        context,
                    );

                    if (!answer.allow) {
                        return `${answer.by === "superseded" ? "The question was replaced" : `${answer.by} said not now`}: ${task.ref} does not run.`;
                    }
                }

                const run = projects.queueRun({ kind: "person", person: actor.person }, ref);

                team.pump();

                return `${task.ref} is queued (run ${run.id.slice(0, 8)}); it starts at the first place with room. Its session reports here when it ends.`;
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
                const id = String(input.conversationId);
                const led = projects.projectLedBy(id);

                if (led !== undefined) {
                    return `You are the main session of project ${led.key} · ${led.name}${led.autoRuns ? " (it runs tasks given to Pi by itself)" : ""}.\n${LEAD_RULES}\n${boardRules(led.rules, "person")}`;
                }

                const run = projects.runOfSession(id);
                const found = run === undefined ? undefined : projects.taskById(run.taskId);

                if (run !== undefined && found !== undefined) {
                    return `${taskRules(found.task, run)}\n${boardRules(found.project.rules, "person")}`;
                }

                const mode = projects.boardMode(id);

                if (mode?.on === true) {
                    return `Board mode is on in this session${mode.project === null ? "" : `, with project ${mode.project.key} · ${mode.project.name}`}: track this work on the board.\n${boardRules(mode.rules ?? mode.project?.rules ?? "full", mode.closer)}`;
                }

                if (mode !== undefined) {
                    return "Projects: the person said no to a board in this session. Work without it and do not ask again; they can turn it on from the session menu.";
                }

                return "Projects: the person keeps project boards (project_list). When work here has several parts worth tracking, or they ask you to track or remember something, ask once with board_mode before using any board tool. Do not ask for one-off questions or small changes.";
            }),
        ],
    });
}
