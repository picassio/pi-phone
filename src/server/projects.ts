/**
 * Projects and their tasks (the Projects extension, `extensions/projects.ts`): the store, and every rule that must hold
 * whatever a model does. Pi's main session orchestrates the work (what runs next, closing parents, reviews); this file
 * only keeps the data right, and never moves a task or starts work by itself.
 *
 * In the app's database (`pocket.sqlite`, backed up with the rest). A project has a key (`PP`) and its tasks are
 * numbered within it (`PP-12`). Tasks have agent-board's five types and its parent rules (an Epic holds Stories, Tasks
 * and Bugs; a Story holds Tasks, Bugs and Sub-tasks; a Task or a Bug holds Sub-tasks; a Sub-task holds nothing), and its
 * eight states.
 *
 * Who may do what: the owner sees every project; anyone else sees the projects they are a member of (or made). Viewers
 * only read. Pi acts with the rights of the person it works for, and three rules more: it never moves a task that needs
 * a person's approval to Done, nor one it worked on (that session set it In Progress); and only a person clears the
 * need for approval. Anyone's Done waits for a Bug's fix to be verified, and for a parent's children to be done.
 *
 * Board mode (a session's consent to use the board): sessions where the person said yes, with the project they chose.
 */
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type { Role } from "./config.ts";
import { HttpError } from "./errors.ts";

const DATABASE = "pocket.sqlite";

export const STATES = ["inbox", "planning", "assigned", "in_progress", "blocked", "testing", "review", "done"] as const;
export type TaskState = (typeof STATES)[number];
export const STATE_NAMES: Record<TaskState, string> = {
    inbox: "Inbox",
    planning: "Planning",
    assigned: "Assigned",
    in_progress: "In Progress",
    blocked: "Blocked",
    testing: "Testing",
    review: "Review",
    done: "Done",
};

export const TYPES = ["epic", "story", "task", "bug", "subtask"] as const;
export type TaskType = (typeof TYPES)[number];
/** Which types may sit under which (agent-board's hierarchy); `top` is a task with no parent. */
const CHILDREN: Record<TaskType | "top", readonly TaskType[]> = {
    top: ["epic", "story", "task", "bug"],
    epic: ["story", "task", "bug"],
    story: ["task", "bug", "subtask"],
    task: ["subtask"],
    bug: ["subtask"],
    subtask: [],
};

export const LINK_KINDS = ["blocks", "relates"] as const;
export type LinkKind = (typeof LINK_KINDS)[number];

/** Priority: 0 none, 1 low, 2 medium, 3 high, 4 urgent. */
export const PRIORITIES = ["none", "low", "medium", "high", "urgent"] as const;

const KEY = /^[A-Z][A-Z0-9]{1,5}$/;
const REF = /^([A-Za-z][A-Za-z0-9]{1,5})-(\d+)$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const MAX_TITLE = 200;
const MAX_TEXT = 20_000;
const MAX_LABELS = 12;
const MAX_CHECKLIST = 60;

/** Who a project's rules see: a person, by their role. */
export interface Person {
    id: string;
    name: string;
    role: Role;
}

/** Who acts: a person in the app, or Pi working for one in a session. */
export type Actor = { kind: "person"; person: Person } | { kind: "pi"; person: Person; conversationId: string };

export interface ChecklistItem {
    text: string;
    done: boolean;
}

/** Where a project's tasks run: its repository's folder there (here, or `machine:<id>:<path>`), and how many at once. */
export interface ProjectPlace {
    folder: string;
    cap: number;
}

export const RUN_STATES = ["queued", "starting", "running", "done", "failed", "stopped", "cancelled"] as const;
export type RunState = (typeof RUN_STATES)[number];
/** Runs that hold a place, or wait for one. */
export const ACTIVE_RUNS: readonly RunState[] = ["queued", "starting", "running"];

/** A task's run: a task session in a git worktree on a branch of its own, at one of the project's places. */
export interface Run {
    id: string;
    taskId: string;
    projectId: string;
    state: RunState;
    /** The repository's folder at the place it runs (a project place's `folder`). */
    place: string | null;
    /** The worktree's folder, a session folder (here, or on a machine). */
    worktree: string | null;
    branch: string | null;
    /** The branch the worktree started from, which a merge goes back into. */
    base: string | null;
    conversationId: string | null;
    /** Why it ended as it did, or what it waits for. */
    note: string | null;
    createdAt: number;
    startedAt: number | null;
    endedAt: number | null;
}

export interface Project {
    id: string;
    key: string;
    name: string;
    /** The folder its work happens in, here or on a machine (a session folder, `machine:<id>:<path>` for one). */
    folder: string | null;
    /** Where its tasks run; none set, its folder with 2 at once. */
    places: ProjectPlace[];
    owner: string;
    members: string[];
    labels: string[];
    /** Whether a task assigned to Pi starts by itself; off, the main session asks first. */
    autoRuns: boolean;
    mainSession: string | null;
    createdAt: number;
    updatedAt: number;
}

export interface Task {
    id: string;
    ref: string;
    projectId: string;
    number: number;
    type: TaskType;
    title: string;
    description: string;
    state: TaskState;
    priority: number;
    labels: string[];
    /** "pi", or a person's id; null when nobody has it. */
    assignee: string | null;
    start: string | null;
    due: string | null;
    parent: string | null;
    checklist: ChecklistItem[];
    position: number;
    /** Only a person may move it to Done. */
    operatorReview: boolean;
    /** A Bug's fix was checked; its Done waits for this. */
    fixVerified: boolean;
    /** Why it is Blocked: what it waits for. */
    blockedReason: string | null;
    createdBy: string;
    createdAt: number;
    updatedAt: number;
}

export interface TaskLink {
    from: string;
    to: string;
    kind: LinkKind;
}

/** A task as the board shows it: its parent's and children's refs, what it waits on, and its progress. */
export interface BoardTask extends Task {
    /** Its latest run, if it ever ran. */
    run: Run | null;
    parentRef: string | null;
    children: string[];
    /** Open tasks that block this one: shown, never acted on. */
    waitingOn: string[];
    /** Children done of all, or checklist items done of all; null with neither. */
    progress: [number, number] | null;
}

export interface Comment {
    id: string;
    author: string;
    authorName: string;
    /** The session Pi wrote it from, when Pi did. */
    session: string | null;
    text: string;
    createdAt: number;
}

export interface Activity {
    actor: string;
    actorName: string;
    kind: string;
    data: Record<string, unknown>;
    createdAt: number;
}

export interface TaskSession {
    conversationId: string;
    role: "worker" | "main" | "linked";
    createdAt: number;
}

export type TaskInput = {
    title: string;
    type?: TaskType;
    description?: string;
    state?: TaskState;
    priority?: number;
    labels?: string[];
    assignee?: string | null;
    start?: string | null;
    due?: string | null;
    parent?: string | null;
    checklist?: ChecklistItem[];
    operatorReview?: boolean;
};

export type TaskPatch = Partial<Omit<TaskInput, "title">> & {
    title?: string;
    position?: number;
    fixVerified?: boolean;
    blockedReason?: string | null;
};

export type TaskFilter = {
    state?: TaskState;
    type?: TaskType;
    assignee?: string;
    parent?: string;
    text?: string;
    limit?: number;
};

type Row = Record<string, SQLInputValue>;

const bad = (message: string) => new HttpError(400, message);
const isState = (value: unknown): value is TaskState => typeof value === "string" && (STATES as readonly string[]).includes(value);
const isType = (value: unknown): value is TaskType => typeof value === "string" && (TYPES as readonly string[]).includes(value);

export class Projects {
    readonly #db: DatabaseSync;
    readonly #people: () => Person[];
    readonly #now: () => number;
    readonly #listeners = new Set<(projectId: string) => void>();
    readonly #assigned = new Set<(task: Task) => void>();

    /** `people`: everyone in the app, as config has them now. */
    constructor(dataDir: string, people: () => Person[], now: () => number = Date.now) {
        this.#people = people;
        this.#now = now;
        this.#db = new DatabaseSync(join(dataDir, DATABASE), { timeout: 5000 });
        this.#db.exec(`
            CREATE TABLE IF NOT EXISTS pocket_projects (
                id TEXT PRIMARY KEY, key TEXT NOT NULL UNIQUE, name TEXT NOT NULL, folder TEXT, owner TEXT NOT NULL,
                labels TEXT NOT NULL DEFAULT '[]', auto_runs INTEGER NOT NULL DEFAULT 0, main_session TEXT,
                next_number INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
            ) STRICT;
            CREATE TABLE IF NOT EXISTS pocket_project_members (
                project_id TEXT NOT NULL, user_id TEXT NOT NULL, PRIMARY KEY (project_id, user_id)
            ) STRICT;
            CREATE TABLE IF NOT EXISTS pocket_tasks (
                id TEXT PRIMARY KEY, project_id TEXT NOT NULL, number INTEGER NOT NULL, type TEXT NOT NULL,
                title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', state TEXT NOT NULL,
                priority INTEGER NOT NULL DEFAULT 0, labels TEXT NOT NULL DEFAULT '[]', assignee TEXT,
                start TEXT, due TEXT, parent_id TEXT, checklist TEXT NOT NULL DEFAULT '[]', position REAL NOT NULL,
                operator_review INTEGER NOT NULL DEFAULT 0, fix_verified INTEGER NOT NULL DEFAULT 0,
                blocked_reason TEXT, created_by TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
                UNIQUE (project_id, number)
            ) STRICT;
            CREATE INDEX IF NOT EXISTS pocket_tasks_project ON pocket_tasks (project_id, state, position);
            CREATE TABLE IF NOT EXISTS pocket_task_links (
                from_id TEXT NOT NULL, to_id TEXT NOT NULL, kind TEXT NOT NULL, PRIMARY KEY (from_id, to_id, kind)
            ) STRICT;
            CREATE TABLE IF NOT EXISTS pocket_task_comments (
                id TEXT PRIMARY KEY, task_id TEXT NOT NULL, author TEXT NOT NULL, session TEXT, text TEXT NOT NULL,
                created_at INTEGER NOT NULL
            ) STRICT;
            CREATE TABLE IF NOT EXISTS pocket_task_sessions (
                task_id TEXT NOT NULL, conversation_id TEXT NOT NULL, role TEXT NOT NULL, created_at INTEGER NOT NULL,
                PRIMARY KEY (task_id, conversation_id)
            ) STRICT;
            CREATE TABLE IF NOT EXISTS pocket_task_activity (
                id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL, project_id TEXT NOT NULL, actor TEXT NOT NULL,
                kind TEXT NOT NULL, data TEXT NOT NULL, created_at INTEGER NOT NULL
            ) STRICT;
            CREATE TABLE IF NOT EXISTS pocket_task_runs (
                id TEXT PRIMARY KEY, task_id TEXT NOT NULL, project_id TEXT NOT NULL, state TEXT NOT NULL, place TEXT,
                worktree TEXT, branch TEXT, base TEXT, conversation_id TEXT, note TEXT, created_at INTEGER NOT NULL,
                started_at INTEGER, ended_at INTEGER
            ) STRICT;
            CREATE INDEX IF NOT EXISTS pocket_task_runs_task ON pocket_task_runs (task_id, created_at);
            CREATE TABLE IF NOT EXISTS pocket_board_sessions (
                conversation_id TEXT PRIMARY KEY, project_id TEXT, on_board INTEGER NOT NULL, decided_at INTEGER NOT NULL
            ) STRICT;
        `);
        this.#migrate();
    }

    close(): void {
        this.#db.close();
    }

    /** Columns added after a table was first made. */
    #migrate(): void {
        const columns = (this.#db.prepare("PRAGMA table_info(pocket_projects)").all() as Row[]).map((row) => String(row.name));

        if (!columns.includes("places")) {
            this.#db.exec("ALTER TABLE pocket_projects ADD COLUMN places TEXT NOT NULL DEFAULT '[]'");
        }
    }

    /** Call `listener` with a project's id whenever it or its tasks change; returns how to stop. */
    onChange(listener: (projectId: string) => void): () => void {
        this.#listeners.add(listener);

        return () => this.#listeners.delete(listener);
    }

    /** Call `listener` when a task is given to Pi (made assigned to it, or assigned to it later), while it is open. */
    onAssignedToPi(listener: (task: Task) => void): () => void {
        this.#assigned.add(listener);

        return () => this.#assigned.delete(listener);
    }

    // ---- Projects ------------------------------------------------------------------------------------------------

    /** The projects `actor` may see, with how many tasks are in each state. */
    list(actor: Actor): (Project & { counts: Record<TaskState, number> })[] {
        return this.#allProjects()
            .filter((project) => this.#sees(actor.person, project))
            .map((project) => ({ ...project, counts: this.#counts(project.id) }));
    }

    create(actor: Actor, input: { key: string; name: string; folder?: string | null }): Project {
        this.#requireEdit(actor.person);

        const key = String(input.key ?? "").trim().toUpperCase();
        const name = String(input.name ?? "").trim();

        if (!KEY.test(key)) {
            throw bad("A project's key is 2 to 6 letters or digits, starting with a letter (PP, WEB2).");
        }

        if (name === "" || name.length > 80) {
            throw bad("Give the project a name, up to 80 characters.");
        }

        if (this.#projectByKey(key) !== undefined) {
            throw new HttpError(409, `There is already a project ${key}.`);
        }

        const now = this.#now();
        const id = randomUUID();

        this.#db
            .prepare(
                "INSERT INTO pocket_projects (id, key, name, folder, owner, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
            )
            .run(id, key, name, folderOf(input.folder), actor.person.id, now, now);
        this.#changed(id);

        return this.#projectById(id)!;
    }

    /** A project and its board: every task, and the links between them. */
    board(actor: Actor, key: string): { project: Project; tasks: BoardTask[]; links: TaskLink[] } {
        const project = this.#see(actor, key);
        const tasks = this.#tasksOf(project.id);
        const links = this.#linksAmong(tasks.map((task) => task.id));

        return { project, tasks: this.#boardTasks(tasks, links), links };
    }

    update(
        actor: Actor,
        key: string,
        patch: {
            name?: string;
            folder?: string | null;
            labels?: string[];
            autoRuns?: boolean;
            mainSession?: string | null;
            places?: ProjectPlace[];
        },
    ): Project {
        const project = this.#edit(actor, key);
        const name = patch.name === undefined ? project.name : String(patch.name).trim();

        if (name === "" || name.length > 80) {
            throw bad("Give the project a name, up to 80 characters.");
        }

        this.#db
            .prepare(
                "UPDATE pocket_projects SET name = ?, folder = ?, labels = ?, auto_runs = ?, main_session = ?, places = ?, updated_at = ? WHERE id = ?",
            )
            .run(
                name,
                patch.folder === undefined ? project.folder : folderOf(patch.folder),
                JSON.stringify(patch.labels === undefined ? project.labels : labelsOf(patch.labels)),
                (patch.autoRuns ?? project.autoRuns) ? 1 : 0,
                patch.mainSession === undefined ? project.mainSession : patch.mainSession,
                JSON.stringify(patch.places === undefined ? project.places : placesOf(patch.places)),
                this.#now(),
                project.id,
            );
        this.#changed(project.id);

        return this.#projectById(project.id)!;
    }

    /** Who besides its owner may see the project: people's ids. The project's owner or the app's owner sets it. */
    setMembers(actor: Actor, key: string, userIds: string[]): Project {
        const project = this.#manage(actor, key);
        const known = new Set(this.#people().map((person) => person.id));
        const ids = [...new Set(userIds)].filter((id) => id !== project.owner);
        const unknown = ids.filter((id) => !known.has(id));

        if (unknown.length > 0) {
            throw bad(`No such person: ${unknown.join(", ")}.`);
        }

        this.#transaction(() => {
            this.#db.prepare("DELETE FROM pocket_project_members WHERE project_id = ?").run(project.id);

            for (const id of ids) {
                this.#db.prepare("INSERT INTO pocket_project_members (project_id, user_id) VALUES (?, ?)").run(project.id, id);
            }
        });
        this.#changed(project.id);

        return this.#projectById(project.id)!;
    }

    /** A project and all its tasks, for good. Its owner or the app's owner only. */
    remove(actor: Actor, key: string): void {
        const project = this.#manage(actor, key);
        const ids = this.#tasksOf(project.id).map((task) => task.id);

        this.#transaction(() => {
            for (const id of ids) {
                this.#deleteTaskRows(id);
            }

            this.#db.prepare("DELETE FROM pocket_project_members WHERE project_id = ?").run(project.id);
            this.#db.prepare("UPDATE pocket_board_sessions SET project_id = NULL WHERE project_id = ?").run(project.id);
            this.#db.prepare("DELETE FROM pocket_projects WHERE id = ?").run(project.id);
        });
        this.#changed(project.id);
    }

    // ---- Tasks ---------------------------------------------------------------------------------------------------

    createTask(actor: Actor, key: string, input: TaskInput): Task {
        const project = this.#edit(actor, key);
        const type = input.type ?? "task";
        const title = titleOf(input.title);

        if (!isType(type)) {
            throw bad(`A task's type is one of ${TYPES.join(", ")}.`);
        }

        const state = input.state ?? "inbox";

        if (!isState(state)) {
            throw bad(`A task's state is one of ${STATES.join(", ")}.`);
        }

        if (state === "done") {
            throw bad("A new task cannot start Done.");
        }

        const parent = input.parent == null ? null : this.#taskInProject(project, input.parent);

        this.#checkParent(type, parent);

        const now = this.#now();
        const id = randomUUID();

        this.#transaction(() => {
            const number = Number(
                (this.#db.prepare("SELECT next_number FROM pocket_projects WHERE id = ?").get(project.id) as Row).next_number,
            );

            this.#db.prepare("UPDATE pocket_projects SET next_number = ?, updated_at = ? WHERE id = ?").run(number + 1, now, project.id);
            this.#db
                .prepare(
                    `INSERT INTO pocket_tasks (id, project_id, number, type, title, description, state, priority, labels, assignee,
                        start, due, parent_id, checklist, position, operator_review, created_by, created_at, updated_at)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                )
                .run(
                    id,
                    project.id,
                    number,
                    type,
                    title,
                    textOf(input.description ?? ""),
                    state,
                    priorityOf(input.priority ?? 0),
                    JSON.stringify(labelsOf(input.labels ?? [])),
                    this.#assigneeOf(project, input.assignee ?? null),
                    dayOf(input.start ?? null, "start"),
                    dayOf(input.due ?? null, "due"),
                    parent?.id ?? null,
                    JSON.stringify(checklistOf(input.checklist ?? [])),
                    this.#endOf(project.id, state),
                    input.operatorReview === true ? 1 : 0,
                    actor.person.id,
                    now,
                    now,
                );
            this.#record(actor, id, project.id, "created", { type, state });
        });
        this.#changed(project.id);

        const made = this.#taskById(id)!;

        if (made.assignee === "pi") {
            this.#toPi(made);
        }

        return made;
    }

    /** A task with its comments, activity, sessions, links, and board fields. */
    task(
        actor: Actor,
        ref: string,
    ): {
        project: Project;
        task: BoardTask;
        comments: Comment[];
        activity: Activity[];
        sessions: TaskSession[];
        links: { kind: LinkKind; direction: "out" | "in"; ref: string; title: string; state: TaskState }[];
    } {
        const { project, task } = this.#seeTask(actor, ref);
        const tasks = this.#tasksOf(project.id);
        const links = this.#linksAmong(tasks.map((each) => each.id));
        const byId = new Map(tasks.map((each) => [each.id, each]));
        const name = (id: string) => (id === "pi" ? "Pi" : (this.#people().find((person) => person.id === id)?.name ?? "Someone"));

        return {
            project,
            task: this.#boardTasks(tasks, links).find((each) => each.id === task.id)!,
            comments: (
                this.#db.prepare("SELECT * FROM pocket_task_comments WHERE task_id = ? ORDER BY created_at, id").all(task.id) as Row[]
            ).map((row) => ({
                id: String(row.id),
                author: String(row.author),
                authorName: name(String(row.author)),
                session: row.session === null ? null : String(row.session),
                text: String(row.text),
                createdAt: Number(row.created_at),
            })),
            activity: (
                this.#db.prepare("SELECT * FROM pocket_task_activity WHERE task_id = ? ORDER BY id").all(task.id) as Row[]
            ).map((row) => ({
                actor: String(row.actor),
                actorName: name(String(row.actor)),
                kind: String(row.kind),
                data: JSON.parse(String(row.data)) as Record<string, unknown>,
                createdAt: Number(row.created_at),
            })),
            sessions: this.sessionsOf(task.id),
            links: links
                .filter((link) => link.from === task.id || link.to === task.id)
                .map((link) => {
                    const other = byId.get(link.from === task.id ? link.to : link.from)!;

                    return {
                        kind: link.kind,
                        direction: link.from === task.id ? ("out" as const) : ("in" as const),
                        ref: other.ref,
                        title: other.title,
                        state: other.state,
                    };
                }),
        };
    }

    /** Tasks across the projects `actor` sees (or one project's), filtered; at most `limit`, newest first. */
    tasks(actor: Actor, key: string | undefined, filter: TaskFilter = {}): BoardTask[] {
        const projects = key === undefined ? this.list(actor) : [this.#see(actor, key)];
        const text = filter.text?.trim().toLowerCase();
        const assignee = filter.assignee === undefined ? undefined : this.#personRef(filter.assignee);

        if (filter.state !== undefined && !isState(filter.state)) {
            throw bad(`A state is one of ${STATES.join(", ")}.`);
        }

        if (filter.type !== undefined && !isType(filter.type)) {
            throw bad(`A type is one of ${TYPES.join(", ")}.`);
        }

        const all = projects.flatMap((project) => {
            const tasks = this.#tasksOf(project.id);

            return this.#boardTasks(tasks, this.#linksAmong(tasks.map((task) => task.id)));
        });

        return all
            .filter(
                (task) =>
                    (filter.state === undefined || task.state === filter.state) &&
                    (filter.type === undefined || task.type === filter.type) &&
                    (assignee === undefined || task.assignee === assignee) &&
                    (filter.parent === undefined || task.parentRef === filter.parent.toUpperCase()) &&
                    (text === undefined || text === "" || `${task.ref} ${task.title} ${task.description}`.toLowerCase().includes(text)),
            )
            .sort((a, b) => b.updatedAt - a.updatedAt)
            .slice(0, Math.min(Math.max(filter.limit ?? 50, 1), 200));
    }

    updateTask(actor: Actor, ref: string, patch: TaskPatch): Task {
        const { project, task } = this.#editTask(actor, ref);
        const next: Task = { ...task };
        const changes: Record<string, unknown> = {};
        const set = <K extends keyof Task>(field: K, value: Task[K]) => {
            if (JSON.stringify(next[field]) !== JSON.stringify(value)) {
                next[field] = value;
                changes[field] = value;
            }
        };

        if (patch.title !== undefined) set("title", titleOf(patch.title));
        if (patch.description !== undefined) set("description", textOf(patch.description));
        if (patch.priority !== undefined) set("priority", priorityOf(patch.priority));
        if (patch.labels !== undefined) set("labels", labelsOf(patch.labels));
        if (patch.assignee !== undefined) set("assignee", this.#assigneeOf(project, patch.assignee));
        if (patch.start !== undefined) set("start", dayOf(patch.start, "start"));
        if (patch.due !== undefined) set("due", dayOf(patch.due, "due"));
        if (patch.checklist !== undefined) set("checklist", checklistOf(patch.checklist));
        if (patch.position !== undefined) {
            if (typeof patch.position !== "number" || !Number.isFinite(patch.position)) {
                throw bad("A position is a number.");
            }

            set("position", patch.position);
        }

        if (patch.type !== undefined) {
            if (!isType(patch.type)) {
                throw bad(`A task's type is one of ${TYPES.join(", ")}.`);
            }

            set("type", patch.type);
        }

        if (patch.parent !== undefined) {
            const parent = patch.parent === null ? null : this.#taskInProject(project, patch.parent);

            if (parent !== null && this.#ancestors(parent).includes(task.id)) {
                throw bad(`${parent.ref} is under ${task.ref}: a task cannot sit under its own child.`);
            }

            if (parent?.id === task.id) {
                throw bad("A task cannot be its own parent.");
            }

            set("parent", parent?.id ?? null);
        }

        if (patch.type !== undefined || patch.parent !== undefined) {
            this.#checkParent(next.type, next.parent === null ? null : this.#taskById(next.parent)!);

            for (const child of this.#childrenOf(task.id)) {
                if (!CHILDREN[next.type].includes(child.type)) {
                    throw bad(`${task.ref} has a ${child.type} under it (${child.ref}), which a ${next.type} cannot hold.`);
                }
            }
        }

        if (patch.operatorReview !== undefined) {
            if (patch.operatorReview === false && task.operatorReview && actor.kind === "pi") {
                throw new HttpError(403, `Only a person can lift ${task.ref}'s need for their approval.`);
            }

            set("operatorReview", patch.operatorReview === true);
        }

        if (patch.fixVerified !== undefined) set("fixVerified", patch.fixVerified === true);

        if (patch.state !== undefined) {
            if (!isState(patch.state)) {
                throw bad(`A task's state is one of ${STATES.join(", ")}.`);
            }

            if (patch.state === "done" && task.state !== "done") {
                this.#checkDone(actor, next);
            }

            if (patch.state !== task.state && patch.position === undefined) {
                set("position", this.#endOf(project.id, patch.state));
            }

            set("state", patch.state);
        }

        if (next.state === "blocked") {
            const reason = patch.blockedReason === undefined ? next.blockedReason : patch.blockedReason?.trim() || null;

            set("blockedReason", reason === null ? null : textOf(reason).slice(0, 500));
        } else {
            set("blockedReason", null);
        }

        if (Object.keys(changes).length === 0) {
            return task;
        }

        next.updatedAt = this.#now();

        this.#transaction(() => {
            this.#db
                .prepare(
                    `UPDATE pocket_tasks SET type = ?, title = ?, description = ?, state = ?, priority = ?, labels = ?, assignee = ?,
                        start = ?, due = ?, parent_id = ?, checklist = ?, position = ?, operator_review = ?, fix_verified = ?,
                        blocked_reason = ?, updated_at = ? WHERE id = ?`,
                )
                .run(
                    next.type,
                    next.title,
                    next.description,
                    next.state,
                    next.priority,
                    JSON.stringify(next.labels),
                    next.assignee,
                    next.start,
                    next.due,
                    next.parent,
                    JSON.stringify(next.checklist),
                    next.position,
                    next.operatorReview ? 1 : 0,
                    next.fixVerified ? 1 : 0,
                    next.blockedReason,
                    next.updatedAt,
                    task.id,
                );

            // The session that sets a task In Progress works on it: it may not move it to Done later.
            if (actor.kind === "pi" && changes.state === "in_progress") {
                this.#linkSession(task.id, actor.conversationId, "worker");
            }

            const { position: _position, ...said } = changes;

            if (Object.keys(said).length > 0) {
                this.#record(actor, task.id, project.id, "changed", said);
            }
        });
        this.#changed(project.id);

        const saved = this.#taskById(task.id)!;

        if (changes.assignee === "pi" && saved.state !== "done") {
            this.#toPi(saved);
        }

        return saved;
    }

    comment(actor: Actor, ref: string, text: string): Comment {
        const { project, task } = this.#editTask(actor, ref);
        const body = textOf(text).trim();

        if (body === "") {
            throw bad("A comment needs some text.");
        }

        const id = randomUUID();
        const now = this.#now();
        const session = actor.kind === "pi" ? actor.conversationId : null;

        this.#transaction(() => {
            this.#db
                .prepare("INSERT INTO pocket_task_comments (id, task_id, author, session, text, created_at) VALUES (?, ?, ?, ?, ?, ?)")
                .run(id, task.id, authorOf(actor), session, body, now);
            this.#db.prepare("UPDATE pocket_tasks SET updated_at = ? WHERE id = ?").run(now, task.id);
        });
        this.#changed(project.id);

        return {
            id,
            author: authorOf(actor),
            authorName: actor.kind === "pi" ? "Pi" : actor.person.name,
            session,
            text: body,
            createdAt: now,
        };
    }

    /** `ref` blocks or relates to `other`, in the same project. */
    link(actor: Actor, ref: string, other: string, kind: LinkKind): void {
        const { project, task } = this.#editTask(actor, ref);
        const target = this.#taskInProject(project, other);

        if (!(LINK_KINDS as readonly string[]).includes(kind)) {
            throw bad(`A link is one of ${LINK_KINDS.join(", ")}.`);
        }

        if (target.id === task.id) {
            throw bad("A task cannot link to itself.");
        }

        if (kind === "blocks" && this.#blocks(target.id, task.id)) {
            throw bad(`${target.ref} already waits, through its links, on ${task.ref}: that would be a circle.`);
        }

        this.#db.prepare("INSERT OR IGNORE INTO pocket_task_links (from_id, to_id, kind) VALUES (?, ?, ?)").run(task.id, target.id, kind);
        this.#record(actor, task.id, project.id, "linked", { kind, to: target.ref });
        this.#changed(project.id);
    }

    unlink(actor: Actor, ref: string, other: string, kind: LinkKind): void {
        const { project, task } = this.#editTask(actor, ref);
        const target = this.#taskInProject(project, other);

        this.#db.prepare("DELETE FROM pocket_task_links WHERE from_id = ? AND to_id = ? AND kind = ?").run(task.id, target.id, kind);
        this.#record(actor, task.id, project.id, "unlinked", { kind, to: target.ref });
        this.#changed(project.id);
    }

    /** A task with nothing under it, for good. */
    removeTask(actor: Actor, ref: string): void {
        const { project, task } = this.#editTask(actor, ref);
        const children = this.#childrenOf(task.id);

        if (children.length > 0) {
            throw new HttpError(409, `${task.ref} has tasks under it (${children.map((child) => child.ref).join(", ")}): move or remove them first.`);
        }

        this.#transaction(() => this.#deleteTaskRows(task.id));
        this.#changed(project.id);
    }

    /** The sessions a task is linked to, oldest first. */
    sessionsOf(taskId: string): TaskSession[] {
        return (
            this.#db.prepare("SELECT * FROM pocket_task_sessions WHERE task_id = ? ORDER BY created_at").all(taskId) as Row[]
        ).map((row) => ({
            conversationId: String(row.conversation_id),
            role: String(row.role) as TaskSession["role"],
            createdAt: Number(row.created_at),
        }));
    }

    /** Link a session to a task it works on (or leads, or only mentions); a stronger role replaces a weaker one. */
    linkSession(actor: Actor, ref: string, conversationId: string, role: TaskSession["role"]): void {
        const { project, task } = this.#editTask(actor, ref);

        this.#linkSession(task.id, conversationId, role);
        this.#changed(project.id);
    }

    // ---- Runs ----------------------------------------------------------------------------------------------------

    /** The places a project's tasks run at: its own, or its folder with 2 at once. */
    placesOf(project: Project): ProjectPlace[] {
        return project.places.length > 0 ? project.places : project.folder === null ? [] : [{ folder: project.folder, cap: 2 }];
    }

    /** Queue a run of a task: Pi works on it in a task session. A person's start, or Pi's after the person said yes. */
    queueRun(actor: Actor, ref: string): Run {
        const { project, task } = this.#editTask(actor, ref);

        if (task.state === "done") {
            throw new HttpError(409, `${task.ref} is done.`);
        }

        if (task.type === "epic") {
            throw new HttpError(409, `${task.ref} is an epic: run its stories or tasks instead.`);
        }

        if (this.placesOf(project).length === 0) {
            throw new HttpError(409, `${project.key} has no folder to run tasks in: set one in its settings.`);
        }

        const active = this.activeRun(task.id);

        if (active !== undefined) {
            throw new HttpError(409, `${task.ref} is already ${active.state === "queued" ? "waiting to run" : "running"}.`);
        }

        const id = randomUUID();
        const now = this.#now();

        this.#transaction(() => {
            this.#db
                .prepare("INSERT INTO pocket_task_runs (id, task_id, project_id, state, created_at) VALUES (?, ?, ?, 'queued', ?)")
                .run(id, task.id, project.id, now);

            if (task.assignee !== "pi") {
                this.#db.prepare("UPDATE pocket_tasks SET assignee = 'pi', updated_at = ? WHERE id = ?").run(now, task.id);
            }

            this.#record(actor, task.id, project.id, "run", { state: "queued" });
        });
        this.#changed(project.id);

        return this.#runById(id)!;
    }

    /** A queued run withdrawn, before it starts. */
    cancelRun(actor: Actor, ref: string): void {
        const { project, task } = this.#editTask(actor, ref);
        const active = this.activeRun(task.id);

        if (active?.state !== "queued") {
            throw new HttpError(409, `${task.ref} has no run waiting to start.`);
        }

        this.setRun(active.id, { state: "cancelled", endedAt: this.#now() });
        this.#record(actor, task.id, project.id, "run", { state: "cancelled" });
        this.#changed(project.id);
    }

    /** A run's progress, as the scheduler and the sessions' ends move it: no person's rights involved. */
    setRun(id: string, patch: Partial<Pick<Run, "state" | "place" | "worktree" | "branch" | "base" | "conversationId" | "note" | "startedAt" | "endedAt">>): Run {
        const run = this.#runById(id);

        if (run === undefined) {
            throw new HttpError(404, "No such run.");
        }

        const next = { ...run, ...patch };

        this.#db
            .prepare(
                "UPDATE pocket_task_runs SET state = ?, place = ?, worktree = ?, branch = ?, base = ?, conversation_id = ?, note = ?, started_at = ?, ended_at = ? WHERE id = ?",
            )
            .run(next.state, next.place, next.worktree, next.branch, next.base, next.conversationId, next.note, next.startedAt, next.endedAt, id);

        if (patch.state !== undefined && patch.state !== run.state) {
            this.#db
                .prepare("INSERT INTO pocket_task_activity (task_id, project_id, actor, kind, data, created_at) VALUES (?, ?, 'pi', 'run', ?, ?)")
                .run(run.taskId, run.projectId, JSON.stringify({ state: patch.state, ...(next.note === null ? {} : { note: next.note }) }), this.#now());
        }

        this.#changed(run.projectId);

        return this.#runById(id)!;
    }

    activeRun(taskId: string): Run | undefined {
        return this.#runs("SELECT * FROM pocket_task_runs WHERE task_id = ? AND state IN ('queued', 'starting', 'running') ORDER BY created_at DESC LIMIT 1", taskId)[0];
    }

    lastRun(taskId: string): Run | null {
        return this.#runs("SELECT * FROM pocket_task_runs WHERE task_id = ? ORDER BY created_at DESC LIMIT 1", taskId)[0] ?? null;
    }

    /** Runs in a state, oldest first: the queue, or what holds places. */
    runsIn(states: readonly RunState[]): Run[] {
        return this.#runs(`SELECT * FROM pocket_task_runs WHERE state IN (${states.map(() => "?").join(", ")}) ORDER BY created_at`, ...states);
    }

    /** The run a task session works in. */
    runOfSession(conversationId: string): Run | undefined {
        return this.#runs("SELECT * FROM pocket_task_runs WHERE conversation_id = ? ORDER BY created_at DESC LIMIT 1", conversationId)[0];
    }

    /** A task and its project, by id, for the scheduler (no person's rights). */
    taskById(id: string): { project: Project; task: Task } | undefined {
        const task = this.#taskById(id);

        return task === undefined ? undefined : { project: this.#projectById(task.projectId)!, task };
    }

    /** A project by id (no person's rights): the scheduler's, and the sessions'. */
    projectById(id: string): Project | undefined {
        return this.#projectById(id);
    }

    /** The project a session leads, if it is a project's main session. */
    projectLedBy(conversationId: string): Project | undefined {
        return this.#allProjects().find((project) => project.mainSession === conversationId);
    }

    /** Pi moves a task as a run does: In Progress when it starts (no person's rights; the run's session works on it). */
    startWork(taskId: string, conversationId: string): void {
        const task = this.#taskById(taskId);

        if (task === undefined) {
            return;
        }

        this.#transaction(() => {
            if (task.state !== "in_progress") {
                this.#db
                    .prepare("UPDATE pocket_tasks SET state = 'in_progress', blocked_reason = NULL, position = ?, updated_at = ? WHERE id = ?")
                    .run(this.#endOf(task.projectId, "in_progress"), this.#now(), taskId);
                this.#db
                    .prepare("INSERT INTO pocket_task_activity (task_id, project_id, actor, kind, data, created_at) VALUES (?, ?, 'pi', 'changed', ?, ?)")
                    .run(taskId, task.projectId, JSON.stringify({ state: "in_progress" }), this.#now());
            }

            this.#linkSession(taskId, conversationId, "worker");
        });
        this.#changed(task.projectId);
    }

    // ---- Board mode ----------------------------------------------------------------------------------------------

    /** Whether a session may use the board, and its project: undefined when nobody has decided there. */
    boardMode(conversationId: string): { on: boolean; project: Project | null } | undefined {
        const row = this.#db.prepare("SELECT * FROM pocket_board_sessions WHERE conversation_id = ?").get(conversationId) as Row | undefined;

        if (row === undefined) {
            return undefined;
        }

        return {
            on: Number(row.on_board) === 1,
            project: row.project_id === null ? null : (this.#projectById(String(row.project_id)) ?? null),
        };
    }

    /** A person turns board mode on or off for a session (a yes to Pi's question, or the session's switch). */
    setBoardMode(actor: Actor, conversationId: string, on: boolean, key: string | null): void {
        this.#requireEdit(actor.person);

        const project = key === null ? null : this.#see(actor, key);

        this.#db
            .prepare(
                `INSERT INTO pocket_board_sessions (conversation_id, project_id, on_board, decided_at) VALUES (?, ?, ?, ?)
                 ON CONFLICT (conversation_id) DO UPDATE SET project_id = excluded.project_id, on_board = excluded.on_board,
                 decided_at = excluded.decided_at`,
            )
            .run(conversationId, project?.id ?? null, on ? 1 : 0, this.#now());

        if (project !== null) {
            this.#changed(project.id);
        }
    }

    /** The project a key names, as `actor` may see it. */
    project(actor: Actor, key: string): Project {
        return this.#see(actor, key);
    }

    // ---- Rules ---------------------------------------------------------------------------------------------------

    #sees(person: Person, project: Project): boolean {
        return person.role === "owner" || project.owner === person.id || project.members.includes(person.id);
    }

    #see(actor: Actor, key: string): Project {
        const project = this.#projectByKey(String(key ?? "").toUpperCase());

        if (project === undefined || !this.#sees(actor.person, project)) {
            throw new HttpError(404, `There is no project ${key} shared with ${actor.kind === "pi" ? "the person you work for" : "you"}.`);
        }

        return project;
    }

    #requireEdit(person: Person): void {
        if (person.role === "viewer") {
            throw new HttpError(403, "You can view projects but not change them. Ask the owner for steering rights.");
        }
    }

    #edit(actor: Actor, key: string): Project {
        const project = this.#see(actor, key);

        this.#requireEdit(actor.person);

        return project;
    }

    #manage(actor: Actor, key: string): Project {
        const project = this.#edit(actor, key);

        if (actor.person.role !== "owner" && project.owner !== actor.person.id) {
            throw new HttpError(403, `Only ${project.key}'s owner can do that.`);
        }

        return project;
    }

    #seeTask(actor: Actor, ref: string): { project: Project; task: Task } {
        const match = REF.exec(String(ref ?? "").trim());

        if (match === null) {
            throw bad(`${ref} is not a task: tasks are named like PP-12.`);
        }

        const project = this.#see(actor, match[1]!);
        const task = this.#taskByNumber(project.id, Number(match[2]));

        if (task === undefined) {
            throw new HttpError(404, `There is no task ${project.key}-${match[2]}.`);
        }

        return { project, task };
    }

    #editTask(actor: Actor, ref: string): { project: Project; task: Task } {
        const found = this.#seeTask(actor, ref);

        this.#requireEdit(actor.person);

        return found;
    }

    /** A task named by its ref, in `project`: links and parents stay within one project. */
    #taskInProject(project: Project, ref: string): Task {
        const match = REF.exec(String(ref ?? "").trim());

        if (match === null || match[1]!.toUpperCase() !== project.key) {
            throw bad(`${ref} is not a task of ${project.key}.`);
        }

        const task = this.#taskByNumber(project.id, Number(match[2]));

        if (task === undefined) {
            throw new HttpError(404, `There is no task ${project.key}-${match[2]}.`);
        }

        return task;
    }

    #checkParent(type: TaskType, parent: Task | null): void {
        const allowed = CHILDREN[parent === null ? "top" : parent.type];

        if (!allowed.includes(type)) {
            throw bad(
                parent === null
                    ? `A ${type} sits under another task: give it a parent.`
                    : `A ${parent.type} (${parent.ref}) holds ${allowed.length === 0 ? "nothing" : allowed.join(", ")}, not a ${type}.`,
            );
        }
    }

    /** What must hold before a task is Done. */
    #checkDone(actor: Actor, task: Task): void {
        if (task.operatorReview && actor.kind === "pi") {
            throw new HttpError(403, `${task.ref} needs a person's approval: only a person moves it to Done. Set it to Review.`);
        }

        if (
            actor.kind === "pi" &&
            this.sessionsOf(task.id).some((session) => session.role === "worker" && session.conversationId === actor.conversationId)
        ) {
            throw new HttpError(
                403,
                `You worked on ${task.ref} in this session, so you cannot approve it: set it to Review for the main session or a person.`,
            );
        }

        if (task.type === "bug" && !task.fixVerified) {
            throw new HttpError(409, `${task.ref} is a Bug: verify the fix first (fix_verified), then move it to Done.`);
        }

        const open = this.#childrenOf(task.id).filter((child) => child.state !== "done");

        if (open.length > 0) {
            throw new HttpError(409, `${task.ref} still has open tasks under it: ${open.map((child) => child.ref).join(", ")}.`);
        }
    }

    #assigneeOf(project: Project, assignee: string | null): string | null {
        if (assignee === null || assignee === "") {
            return null;
        }

        const id = this.#personRef(assignee);

        if (id === "pi") {
            return id;
        }

        const person = this.#people().find((each) => each.id === id)!;

        if (!this.#sees(person, project)) {
            throw bad(`${person.name} cannot see ${project.key}: share the project with them first.`);
        }

        return id;
    }

    /** "pi", or a person's id from their id or name. */
    #personRef(ref: string): string {
        const text = String(ref).trim();

        if (text.toLowerCase() === "pi") {
            return "pi";
        }

        const people = this.#people();
        const found = people.find((person) => person.id === text) ?? people.find((person) => person.name.toLowerCase() === text.toLowerCase());

        if (found === undefined) {
            throw bad(`Nobody is called ${text}: an assignee is "pi" or a person's name.`);
        }

        return found.id;
    }

    /** Whether `from` blocks `to`, directly or through other blocks. */
    #blocks(from: string, to: string): boolean {
        const seen = new Set<string>();
        const queue = [from];

        while (queue.length > 0) {
            const at = queue.shift()!;

            if (at === to) {
                return true;
            }

            if (seen.has(at)) {
                continue;
            }

            seen.add(at);

            for (const row of this.#db.prepare("SELECT to_id FROM pocket_task_links WHERE from_id = ? AND kind = 'blocks'").all(at) as Row[]) {
                queue.push(String(row.to_id));
            }
        }

        return false;
    }

    #ancestors(task: Task): string[] {
        const chain: string[] = [];
        let at: Task | undefined = task;

        while (at?.parent != null && !chain.includes(at.parent)) {
            chain.push(at.parent);
            at = this.#taskById(at.parent);
        }

        return chain;
    }

    // ---- Reading rows --------------------------------------------------------------------------------------------

    #allProjects(): Project[] {
        return (this.#db.prepare("SELECT * FROM pocket_projects ORDER BY key").all() as Row[]).map((row) => this.#project(row));
    }

    #projectById(id: string): Project | undefined {
        const row = this.#db.prepare("SELECT * FROM pocket_projects WHERE id = ?").get(id) as Row | undefined;

        return row === undefined ? undefined : this.#project(row);
    }

    #projectByKey(key: string): Project | undefined {
        const row = this.#db.prepare("SELECT * FROM pocket_projects WHERE key = ?").get(key) as Row | undefined;

        return row === undefined ? undefined : this.#project(row);
    }

    #project(row: Row): Project {
        return {
            id: String(row.id),
            key: String(row.key),
            name: String(row.name),
            folder: row.folder === null ? null : String(row.folder),
            owner: String(row.owner),
            members: (this.#db.prepare("SELECT user_id FROM pocket_project_members WHERE project_id = ? ORDER BY user_id").all(row.id!) as Row[]).map(
                (member) => String(member.user_id),
            ),
            labels: JSON.parse(String(row.labels)) as string[],
            places: JSON.parse(String(row.places ?? "[]")) as ProjectPlace[],
            autoRuns: Number(row.auto_runs) === 1,
            mainSession: row.main_session === null ? null : String(row.main_session),
            createdAt: Number(row.created_at),
            updatedAt: Number(row.updated_at),
        };
    }

    #counts(projectId: string): Record<TaskState, number> {
        const counts = Object.fromEntries(STATES.map((state) => [state, 0])) as Record<TaskState, number>;

        for (const row of this.#db.prepare("SELECT state, COUNT(*) AS n FROM pocket_tasks WHERE project_id = ? GROUP BY state").all(projectId) as Row[]) {
            counts[String(row.state) as TaskState] = Number(row.n);
        }

        return counts;
    }

    #tasksOf(projectId: string): Task[] {
        const key = this.#projectById(projectId)!.key;

        return (this.#db.prepare("SELECT * FROM pocket_tasks WHERE project_id = ? ORDER BY state, position, number").all(projectId) as Row[]).map((row) =>
            taskOf(row, key),
        );
    }

    #taskById(id: string): Task | undefined {
        const row = this.#db.prepare("SELECT * FROM pocket_tasks WHERE id = ?").get(id) as Row | undefined;

        return row === undefined ? undefined : taskOf(row, this.#projectById(String(row.project_id))!.key);
    }

    #taskByNumber(projectId: string, number: number): Task | undefined {
        const row = this.#db.prepare("SELECT * FROM pocket_tasks WHERE project_id = ? AND number = ?").get(projectId, number) as Row | undefined;

        return row === undefined ? undefined : taskOf(row, this.#projectById(projectId)!.key);
    }

    #runById(id: string): Run | undefined {
        return this.#runs("SELECT * FROM pocket_task_runs WHERE id = ?", id)[0];
    }

    #runs(sql: string, ...params: SQLInputValue[]): Run[] {
        return (this.#db.prepare(sql).all(...params) as Row[]).map((row) => ({
            id: String(row.id),
            taskId: String(row.task_id),
            projectId: String(row.project_id),
            state: String(row.state) as RunState,
            place: row.place === null ? null : String(row.place),
            worktree: row.worktree === null ? null : String(row.worktree),
            branch: row.branch === null ? null : String(row.branch),
            base: row.base === null ? null : String(row.base),
            conversationId: row.conversation_id === null ? null : String(row.conversation_id),
            note: row.note === null ? null : String(row.note),
            createdAt: Number(row.created_at),
            startedAt: row.started_at === null ? null : Number(row.started_at),
            endedAt: row.ended_at === null ? null : Number(row.ended_at),
        }));
    }

    #toPi(task: Task): void {
        for (const listener of this.#assigned) {
            try {
                listener(task);
            } catch {
                // A listener's trouble is its own.
            }
        }
    }

    #childrenOf(id: string): Task[] {
        return (this.#db.prepare("SELECT id FROM pocket_tasks WHERE parent_id = ? ORDER BY number").all(id) as Row[]).map(
            (row) => this.#taskById(String(row.id))!,
        );
    }

    #linksAmong(ids: string[]): TaskLink[] {
        const set = new Set(ids);

        return (this.#db.prepare("SELECT * FROM pocket_task_links").all() as Row[])
            .filter((row) => set.has(String(row.from_id)) && set.has(String(row.to_id)))
            .map((row) => ({ from: String(row.from_id), to: String(row.to_id), kind: String(row.kind) as LinkKind }));
    }

    #boardTasks(tasks: Task[], links: TaskLink[]): BoardTask[] {
        const byId = new Map(tasks.map((task) => [task.id, task]));

        return tasks.map((task) => {
            const children = tasks.filter((each) => each.parent === task.id);
            const ticked = task.checklist.filter((item) => item.done).length;

            return {
                ...task,
                run: this.lastRun(task.id),
                parentRef: task.parent === null ? null : (byId.get(task.parent)?.ref ?? null),
                children: children.map((child) => child.ref),
                waitingOn: links
                    .filter((link) => link.kind === "blocks" && link.to === task.id && byId.get(link.from)?.state !== "done")
                    .map((link) => byId.get(link.from)!.ref),
                progress:
                    children.length > 0
                        ? [children.filter((child) => child.state === "done").length, children.length]
                        : task.checklist.length > 0
                          ? [ticked, task.checklist.length]
                          : null,
            };
        });
    }

    // ---- Writing rows --------------------------------------------------------------------------------------------

    /** Past the last task in `state`: where a task moved there goes. */
    #endOf(projectId: string, state: TaskState): number {
        const row = this.#db.prepare("SELECT MAX(position) AS last FROM pocket_tasks WHERE project_id = ? AND state = ?").get(projectId, state) as Row;

        return row.last === null ? 1 : Number(row.last) + 1;
    }

    #linkSession(taskId: string, conversationId: string, role: TaskSession["role"]): void {
        const strength = { linked: 0, worker: 1, main: 2 } as const;
        const existing = this.sessionsOf(taskId).find((session) => session.conversationId === conversationId);

        if (existing !== undefined && strength[existing.role] >= strength[role]) {
            return;
        }

        this.#db
            .prepare(
                `INSERT INTO pocket_task_sessions (task_id, conversation_id, role, created_at) VALUES (?, ?, ?, ?)
                 ON CONFLICT (task_id, conversation_id) DO UPDATE SET role = excluded.role`,
            )
            .run(taskId, conversationId, role, this.#now());
    }

    #record(actor: Actor, taskId: string, projectId: string, kind: string, data: Record<string, unknown>): void {
        this.#db
            .prepare("INSERT INTO pocket_task_activity (task_id, project_id, actor, kind, data, created_at) VALUES (?, ?, ?, ?, ?, ?)")
            .run(taskId, projectId, authorOf(actor), kind, JSON.stringify(data), this.#now());
    }

    #deleteTaskRows(id: string): void {
        this.#db.prepare("DELETE FROM pocket_task_links WHERE from_id = ? OR to_id = ?").run(id, id);

        for (const table of ["pocket_task_comments", "pocket_task_sessions", "pocket_task_activity", "pocket_task_runs"]) {
            this.#db.prepare(`DELETE FROM ${table} WHERE task_id = ?`).run(id);
        }

        this.#db.prepare("DELETE FROM pocket_tasks WHERE id = ?").run(id);
    }

    #transaction(work: () => void): void {
        this.#db.exec("BEGIN IMMEDIATE");

        try {
            work();
            this.#db.exec("COMMIT");
        } catch (error) {
            this.#db.exec("ROLLBACK");
            throw error;
        }
    }

    #changed(projectId: string): void {
        for (const listener of this.#listeners) {
            listener(projectId);
        }
    }
}

function taskOf(row: Row, key: string): Task {
    return {
        id: String(row.id),
        ref: `${key}-${Number(row.number)}`,
        projectId: String(row.project_id),
        number: Number(row.number),
        type: String(row.type) as TaskType,
        title: String(row.title),
        description: String(row.description),
        state: String(row.state) as TaskState,
        priority: Number(row.priority),
        labels: JSON.parse(String(row.labels)) as string[],
        assignee: row.assignee === null ? null : String(row.assignee),
        start: row.start === null ? null : String(row.start),
        due: row.due === null ? null : String(row.due),
        parent: row.parent_id === null ? null : String(row.parent_id),
        checklist: JSON.parse(String(row.checklist)) as ChecklistItem[],
        position: Number(row.position),
        operatorReview: Number(row.operator_review) === 1,
        fixVerified: Number(row.fix_verified) === 1,
        blockedReason: row.blocked_reason === null ? null : String(row.blocked_reason),
        createdBy: String(row.created_by),
        createdAt: Number(row.created_at),
        updatedAt: Number(row.updated_at),
    };
}

const authorOf = (actor: Actor) => (actor.kind === "pi" ? "pi" : actor.person.id);

function titleOf(title: unknown): string {
    const text = String(title ?? "").trim();

    if (text === "" || text.length > MAX_TITLE) {
        throw bad(`A task's title is 1 to ${MAX_TITLE} characters.`);
    }

    return text;
}

function textOf(text: unknown): string {
    const value = String(text ?? "");

    if (value.length > MAX_TEXT) {
        throw bad(`Text is at most ${MAX_TEXT} characters.`);
    }

    return value;
}

function priorityOf(priority: unknown): number {
    if (typeof priority !== "number" || !Number.isInteger(priority) || priority < 0 || priority > 4) {
        throw bad("A priority is 0 (none) to 4 (urgent).");
    }

    return priority;
}

function labelsOf(labels: unknown): string[] {
    if (!Array.isArray(labels) || labels.some((label) => typeof label !== "string")) {
        throw bad("Labels are a list of words.");
    }

    const clean = [...new Set(labels.map((label: string) => label.trim().toLowerCase()).filter((label) => label !== ""))];

    if (clean.length > MAX_LABELS || clean.some((label) => label.length > 30)) {
        throw bad(`At most ${MAX_LABELS} labels, of up to 30 characters.`);
    }

    return clean;
}

function checklistOf(items: unknown): ChecklistItem[] {
    if (!Array.isArray(items) || items.length > MAX_CHECKLIST) {
        throw bad(`A checklist is a list of at most ${MAX_CHECKLIST} items.`);
    }

    return items.map((item: unknown) => {
        const { text, done } = (item ?? {}) as { text?: unknown; done?: unknown };

        if (typeof text !== "string" || text.trim() === "" || text.length > 300) {
            throw bad("Each checklist item has a text of up to 300 characters.");
        }

        return { text: text.trim(), done: done === true };
    });
}

function dayOf(day: unknown, what: string): string | null {
    if (day === null || day === undefined || day === "") {
        return null;
    }

    if (typeof day !== "string" || !DAY.test(day) || Number.isNaN(Date.parse(`${day}T00:00:00Z`))) {
        throw bad(`A ${what} date is written YYYY-MM-DD.`);
    }

    return day;
}

function placesOf(places: unknown): ProjectPlace[] {
    if (!Array.isArray(places) || places.length > 10) {
        throw bad("Places are a list of at most 10.");
    }

    const seen = new Set<string>();

    return places.map((place: unknown) => {
        const { folder, cap } = (place ?? {}) as { folder?: unknown; cap?: unknown };
        const path = folderOf(folder);

        if (path === null) {
            throw bad("Each place has the folder of the project's repository there.");
        }

        if (seen.has(path)) {
            throw bad(`${path} is listed twice.`);
        }

        seen.add(path);

        if (typeof cap !== "number" || !Number.isInteger(cap) || cap < 1 || cap > 8) {
            throw bad("A place runs 1 to 8 tasks at once.");
        }

        return { folder: path, cap };
    });
}

function folderOf(folder: unknown): string | null {
    if (folder === null || folder === undefined || folder === "") {
        return null;
    }

    if (typeof folder !== "string" || folder.length > 500) {
        throw bad("A project's folder is a path.");
    }

    return folder.trim();
}
