/**
 * A project's agent team (the Projects extension): its tasks run in task sessions, each in a git worktree on a branch of
 * its own (`task/PP-12`), at one of the project's places (here, or on a machine), as many at once as each place allows;
 * the rest wait in a queue. A task session's end is reported to the project's main session, which decides what comes
 * next (owner's decision of 2026-10-19: the main session orchestrates; nothing here moves a task on by itself beyond
 * In Progress when its run starts). Merging a task's branch is a person's call.
 *
 * No daemon: the server already knows when a session's run ends, fails, or waits for approval (`host.onSessionEvent`),
 * and the queue is in the database, so it starts again where it was after a restart.
 */
import type { PocketHost } from "./host.ts";
import { HttpError } from "./errors.ts";
import { parsePlace, formatPlace } from "./places.ts";
import { type Actor, type Person, type Project, type ProjectPlace, type Run, STATE_NAMES, type Task, type Projects } from "./projects.ts";

/** A string as one argument to a POSIX shell (Git Bash on Windows too). */
const quote = (text: string) => `'${text.replace(/'/g, `'\\''`)}'`;

/** What the main session is, in its prompt: agent-board's delegation, review, and planning, for these tools. */
export const LEAD_RULES = `You lead this project's team: you plan, delegate, ask, and review; you never write code or change files yourself, however small the change.
- Planning: for work bigger than one task, research, ask the person 2 or 3 targeted questions (interview), write a phased plan, and wait for their approval before making tasks.
- Delegating: create every task first (task_create, with real values and an acceptance checklist in its description), link what blocks what, and only then give them to Pi. A task runs only through task_run, which asks the person first unless the project runs tasks by itself.
- Reports from task sessions come to you as messages. Done: review the task's branch with a 3-dot diff in the repository (git diff <base>...task/<ref>), not by reading the base branch; if the base moved on, that is drift, not the task's work. Then move it to done with a short comment, or back to assigned with what to fix. Needs you or stopped or failed: decide (answer, ask the person, run it again), and say what you decided.
- After a task is done, look at what waited on it, and ask to run what can go now.
- Merging a branch is the person's (a button in the task). Close an epic or story when everything under it is done.
- Keep your messages short: what changed, what you decided, what you need.`;

/** What a task session is, in its prompt. */
export function taskRules(task: Task, run: Run): string {
    return `You are the task session for ${task.ref}, in a git worktree on branch ${run.branch} (from ${run.base}). Work only on this task.
- Commit as you go, on this branch. Do not merge it, push it, or switch branches.
- When it is done: commit, task_comment a summary on ${task.ref} (what changed, how you checked it), then set it to review. Never set it to done.
- Need the person (an answer, an approval, something you cannot do)? Set it blocked with blocked_reason, and stop.
- Noticed a problem outside this task? Say so in a comment for the main session; do not fix it here.`;
}

export class Team {
    readonly #projects: Projects;
    readonly #host: PocketHost;
    readonly #stops: (() => void)[] = [];
    /** Pumps run one at a time: two at once could give one place's last room to two runs. */
    #pumping: Promise<void> = Promise.resolve();

    constructor(projects: Projects, host: PocketHost) {
        this.#projects = projects;
        this.#host = host;
    }

    /** Hear sessions and assignments, keep task and main sessions' ends from the phone, and start what is queued. */
    start(): void {
        // Runs a restart cut off while they were being prepared: their worktree may be half made.
        for (const run of this.#projects.runsIn(["starting"])) {
            this.#projects.setRun(run.id, { state: "failed", note: "The server restarted while it was being prepared.", endedAt: Date.now() });
        }

        // The rest needs the app's sessions, which are read back after extensions load.
        void this.#host
            .ready()
            .then(() => this.#started())
            .catch((error: unknown) => this.#warn(error));
    }

    #started(): void {
        if (this.#stopped) {
            return;
        }

        this.#stops.push(
            this.#host.onSessionEvent((event) => void this.#ended(event).catch((error: unknown) => this.#warn(error))),
            this.#host.quietSessions((session) => this.#projects.runOfSession(String(session)) !== undefined || this.#projects.projectLedBy(String(session)) !== undefined),
            this.#projects.onAssignedToPi((task) => void this.#assigned(task).catch((error: unknown) => this.#warn(error))),
        );
        this.pump();
        // Sessions of teams from before groups, and any whose project was renamed while this was off.
        void (async () => {
            for (const project of this.#projects.allProjects()) {
                await this.regroup(project);
            }
        })().catch((error: unknown) => this.#warn(error));
    }

    /** Put a project's main session and its task sessions in the project's group, named as the project is now. */
    async regroup(project: Project): Promise<void> {
        if (project.mainSession !== null && this.#host.sessionTitle(Number(project.mainSession)) !== undefined) {
            await this.#host.groupSession(Number(project.mainSession), this.#group(project, "lead"));
        }

        for (const run of this.#projects.runsOf(project.id)) {
            if (run.conversationId !== null && this.#host.sessionTitle(Number(run.conversationId)) !== undefined) {
                await this.#host.groupSession(Number(run.conversationId), this.#group(project, "task"));

                // Runs that ended before sessions could settle: their sessions settle now, once.
                if (["done", "failed", "stopped"].includes(run.state) && !this.#settledOnce.has(run.id)) {
                    this.#settledOnce.add(run.id);
                    await this.#host.settleSession(Number(run.conversationId), run.state === "done" ? "its run finished" : run.state === "failed" ? "its run failed" : "it stopped", true);
                }
            }
        }
    }

    /** Runs whose sessions this process settled already, so a regroup does not settle them again after an Un-settle. */
    readonly #settledOnce = new Set<string>();

    #group(project: Project, role: "lead" | "task"): { id: string; title: string; role: "lead" | "task" } {
        return { id: `project:${project.key}`, title: `${project.key} · ${project.name}`, role };
    }

    #stopped = false;

    stop(): void {
        this.#stopped = true;

        for (const stop of this.#stops.splice(0)) {
            stop();
        }
    }

    /** Start the main session of a project: in its folder, as `person`, leading its board. */
    async startLead(person: Person, key: string): Promise<number> {
        const actor: Actor = { kind: "person", person };
        const project = this.#projects.project(actor, key);

        if (project.mainSession !== null && this.#host.sessionTitle(Number(project.mainSession)) !== undefined) {
            throw new HttpError(409, `${project.key} has a main session already: #${project.mainSession}.`);
        }

        if (project.folder === null) {
            throw new HttpError(409, `Give ${project.key} a folder first: its main session works there.`);
        }

        const session = await this.#host.startSession({
            userId: person.id,
            cwd: project.folder,
            title: `${project.key} · lead`,
            via: `project ${project.key}`,
            message: `You are the main session of project ${project.key} · ${project.name}. Look at its board (task_list), and say in a few lines what is open, what waits on what, and what you would run first. Then wait: reports from task sessions and tasks given to Pi come here.`,
        });

        this.#projects.update(actor, key, { mainSession: String(session) });
        this.#projects.setBoardMode(actor, String(session), true, project.key);
        await this.#host.groupSession(session, this.#group(project, "lead"));

        return session;
    }

    /** Start queued runs where there is room; one pump at a time. */
    pump(): void {
        this.#pumping = this.#pumping.then(() => this.#pump()).catch((error: unknown) => this.#warn(error));
    }

    /** What a task's branch changed, against where it started: the stat, then the patch (cut at 200 KB). */
    async diff(run: Run): Promise<string> {
        const { place, branch, base } = this.#readyRun(run);
        const result = await this.#host.run(
            place,
            `git diff --stat ${quote(`${base}...${branch}`)} && echo && git diff ${quote(`${base}...${branch}`)} | head -c 200000`,
        );

        if (result.code !== 0) {
            throw new HttpError(409, `The diff could not be made: ${(result.stderr || result.stdout).trim().slice(0, 500)}`);
        }

        return result.stdout;
    }

    /**
     * Merge a task's branch into the branch it started from, in the repository at its place (which must be on that
     * branch, with nothing uncommitted), then remove its worktree and branch. A person's.
     */
    async merge(run: Run, task: Task): Promise<string> {
        const { place, branch, base } = this.#readyRun(run);
        const script = [
            "set -e",
            `current=$(git rev-parse --abbrev-ref HEAD)`,
            `[ "$current" = ${quote(base)} ] || { echo "The repository is on $current, not ${base}: switch it to ${base} first." >&2; exit 3; }`,
            `git diff --quiet && git diff --cached --quiet || { echo "The repository has uncommitted changes: commit or stash them first." >&2; exit 3; }`,
            `git merge --no-ff -m ${quote(`Merge ${branch}: ${task.title}`)} ${quote(branch)}`,
            run.worktree === null ? "true" : `git worktree remove --force ${quote(parsePlace(run.worktree).path)} || true`,
            `git branch -d ${quote(branch)} || true`,
        ].join("\n");
        const result = await this.#host.run(place, script, 300);

        if (result.code !== 0) {
            throw new HttpError(409, (result.stderr || result.stdout).trim().slice(0, 1000) || "The merge failed.");
        }

        if (run.conversationId !== null) {
            await this.#host.settleSession(Number(run.conversationId), "its branch was merged");
        }

        return result.stdout.trim();
    }

    // ---- The queue ------------------------------------------------------------------------------------------------

    async #pump(): Promise<void> {
        for (const run of this.#projects.runsIn(["queued"])) {
            const found = this.#projects.taskById(run.taskId);

            if (found === undefined) {
                continue;
            }

            const place = this.#roomAt(found.project);

            if (place !== undefined) {
                await this.#launch(run, found.project, found.task, place);
            }
        }
    }

    /** The project's place with the most room, or undefined when every one is full. */
    #roomAt(project: Project): ProjectPlace | undefined {
        const busy = this.#projects.runsIn(["starting", "running"]).filter((run) => run.projectId === project.id);
        const free = this.#projects
            .placesOf(project)
            .map((place) => ({ place, room: place.cap - busy.filter((run) => run.place === place.folder).length }))
            .filter((each) => each.room > 0)
            .sort((a, b) => b.room - a.room);

        return free[0]?.place;
    }

    async #launch(run: Run, project: Project, task: Task, place: ProjectPlace): Promise<void> {
        this.#projects.setRun(run.id, { state: "starting", place: place.folder });

        let worktree: { folder: string; branch: string; base: string };

        try {
            worktree = await this.#worktree(place.folder, task.ref);
        } catch (error) {
            const note = error instanceof Error ? error.message : String(error);

            this.#projects.setRun(run.id, { state: "failed", note, endedAt: Date.now() });
            await this.#report(project, `Failed to start ${task.ref} (${task.title}) at ${place.folder}: ${note}`, "the team");

            return;
        }

        const owner = this.#person(project.owner);
        let session: number;

        try {
            session = await this.#host.startSession({
                userId: owner.id,
                cwd: worktree.folder,
                title: `${task.ref} · ${task.title}`.slice(0, 80),
                via: `project ${project.key}`,
                message: this.#brief(project, task, worktree),
            });
        } catch (error) {
            const note = `Its session could not start: ${error instanceof Error ? error.message : String(error)}`;

            this.#projects.setRun(run.id, { state: "failed", note, worktree: worktree.folder, branch: worktree.branch, base: worktree.base, endedAt: Date.now() });
            await this.#report(project, `Failed to start ${task.ref} (${task.title}): ${note}`, "the team");

            return;
        }

        this.#projects.setRun(run.id, {
            state: "running",
            worktree: worktree.folder,
            branch: worktree.branch,
            base: worktree.base,
            conversationId: String(session),
            startedAt: Date.now(),
        });
        this.#projects.setBoardMode({ kind: "person", person: owner }, String(session), true, project.key);
        this.#projects.startWork(task.id, String(session));
        await this.#host.groupSession(session, this.#group(project, "task"));
    }

    /** A worktree for a task in the repository at `place`, on `task/<ref>` (made, or found from before). */
    async #worktree(place: string, ref: string): Promise<{ folder: string; branch: string; base: string }> {
        const top = await this.#host.run(place, "git rev-parse --show-toplevel && git rev-parse --abbrev-ref HEAD && git rev-parse HEAD");

        if (top.code !== 0) {
            throw new Error(`${place} is not in a git repository with a commit: a task runs in a worktree of one.`);
        }

        const [root, head, commit] = top.stdout.trim().split(/\r?\n/);
        const branch = `task/${ref}`;
        const path = `${root}/.worktrees/${ref}`;
        const base = head === "HEAD" ? commit! : head!;
        const script = [
            "set -e",
            `cd ${quote(root!)}`,
            // Kept out of the repository's own status, without changing a tracked file.
            `exclude="$(git rev-parse --git-common-dir)/info/exclude"`,
            `mkdir -p "$(dirname "$exclude")"`,
            `grep -qxF '.worktrees/' "$exclude" 2>/dev/null || echo '.worktrees/' >> "$exclude"`,
            `if [ -d ${quote(path)} ]; then true`,
            `elif git show-ref --verify --quiet ${quote(`refs/heads/${branch}`)}; then git worktree add -q ${quote(path)} ${quote(branch)}`,
            `else git worktree add -q -b ${quote(branch)} ${quote(path)} HEAD; fi`,
        ].join("\n");
        const made = await this.#host.run(place, script, 300);

        if (made.code !== 0) {
            throw new Error(`The worktree could not be made: ${(made.stderr || made.stdout).trim().slice(0, 500)}`);
        }

        const { machineId } = parsePlace(place);

        return { folder: formatPlace(machineId === undefined ? { path } : { machineId, path }), branch, base };
    }

    /** A task session's first message: the task, and how it works. */
    #brief(project: Project, task: Task, worktree: { branch: string; base: string }): string {
        const board = this.#projects.board({ kind: "person", person: this.#person(project.owner) }, project.key);
        const here = board.tasks.find((each) => each.id === task.id)!;
        const parent = here.parentRef === null ? undefined : board.tasks.find((each) => each.ref === here.parentRef);

        return [
            `Work on ${task.ref} of project ${project.key} · ${project.name}: ${task.title} (${task.type}${task.priority > 0 ? `, priority ${task.priority}` : ""}).`,
            task.description.trim() === "" ? "" : `\n${this.#host.text.defang(task.description)}`,
            task.checklist.length === 0 ? "" : `\nChecklist:\n${task.checklist.map((item) => `- [${item.done ? "x" : " "}] ${item.text}`).join("\n")}`,
            parent === undefined ? "" : `\nIt is part of ${parent.ref}: ${parent.title}.`,
            here.waitingOn.length === 0 ? "" : `\nIt waits on ${here.waitingOn.join(", ")}, which are not done yet: check what you need from them.`,
            `\nYou are in a git worktree of the repository on branch ${worktree.branch}, from ${worktree.base}. Commit your work there. When it is done, comment a summary on ${task.ref} and set it to review; if you need the person, set it blocked with blocked_reason.`,
        ].join("");
    }

    // ---- Ends and reports -------------------------------------------------------------------------------------------

    async #ended(event: { kind: string; session: number; text: string }): Promise<void> {
        const run = this.#projects.runOfSession(String(event.session));

        if (run === undefined || run.state !== "running") {
            return;
        }

        const found = this.#projects.taskById(run.taskId);

        if (found === undefined) {
            return;
        }

        const { project, task } = found;
        // The report shows as from the task, not from the person the run works for.
        const from = `${task.ref} · task session #${event.session}`;
        const where = `branch ${run.branch} (from ${run.base}) at ${run.place}`;

        if (event.kind === "failed") {
            this.#projects.setRun(run.id, { state: "failed", note: "Its session's run failed.", endedAt: Date.now() });
            await this.#host.settleSession(event.session, "its run failed");
            await this.#report(project, `Failed: ${task.ref} (${task.title}). Its session #${event.session} failed; open it to see why. Work so far is on ${where}.`, from);
        } else if (event.kind === "approval") {
            await this.#report(project, `Needs the person: ${task.ref} (${task.title}). Its session #${event.session} waits for an approval: ${event.text}`, from);

            return;
        } else if (event.kind === "done") {
            if (task.state === "review" || task.state === "done") {
                this.#projects.setRun(run.id, { state: "done", endedAt: Date.now() });
                await this.#host.settleSession(event.session, "its run finished");
                await this.#report(
                    project,
                    `Done: ${task.ref} (${task.title}) is in ${STATE_NAMES[task.state]}. ${this.#summary(task, run, event.text)}\nIts work is on ${where}. Review it, then move it on.`,
                    from,
                );
            } else if (task.state === "blocked") {
                await this.#report(
                    project,
                    `Needs the person: ${task.ref} (${task.title}) is blocked: ${task.blockedReason ?? "no reason given"}. Its session #${event.session} waits.`,
                    from,
                );

                return;
            } else {
                this.#projects.setRun(run.id, { state: "stopped", note: `Its session stopped with the task still ${STATE_NAMES[task.state]}.`, endedAt: Date.now() });
                await this.#host.settleSession(event.session, "it stopped");
                await this.#report(
                    project,
                    `Stopped: ${task.ref} (${task.title}) is still ${STATE_NAMES[task.state]}, but its session #${event.session} stopped. Its last words: ${this.#host.text.quoted(event.text, 300)}. Work so far is on ${where}. Decide: message that session to go on, run it again, or ask the person.`,
                    from,
                );
            }
        }

        this.pump();
    }

    /** What a finished task's session said: its last comment on the task, else its last answer. */
    #summary(task: Task, run: Run, text: string): string {
        const comments = this.#projects.task({ kind: "person", person: this.#person(this.#projects.projectById(task.projectId)!.owner) }, task.ref).comments;
        const last = comments.findLast((comment) => comment.session === run.conversationId);

        return `Its summary: ${this.#host.text.quoted(last?.text ?? text, 600)}.`;
    }

    async #assigned(task: Task): Promise<void> {
        const project = this.#projects.projectById(task.projectId);

        if (project === undefined || this.#projects.activeRun(task.id) !== undefined) {
            return;
        }

        if (project.autoRuns) {
            this.#projects.queueRun({ kind: "person", person: this.#person(project.owner) }, task.ref);
            this.pump();

            return;
        }

        await this.#report(project, `${task.ref} (${task.title}) was given to Pi. Ask the person whether to run it now: task_run with task ${task.ref}.`, "the board");
    }

    /** Tell the project's main session, after its current work; nothing when it has none. */
    async #report(project: Project, message: string, from: string): Promise<void> {
        if (project.mainSession === null || this.#host.sessionTitle(Number(project.mainSession)) === undefined) {
            return;
        }

        await this.#host.sendToSession({ userId: project.owner, session: Number(project.mainSession), message, via: from });
    }

    #readyRun(run: Run): { place: string; branch: string; base: string } {
        if (run.place === null || run.branch === null || run.base === null) {
            throw new HttpError(409, "This run never got a branch.");
        }

        return { place: run.place, branch: run.branch, base: run.base };
    }

    #person(id: string): Person {
        const person = this.#host.people().find((each) => each.id === id);

        if (person === undefined) {
            throw new HttpError(409, "The project's owner is no longer in the app.");
        }

        return person;
    }

    #warn(error: unknown): void {
        this.#host.notice("warning", `Projects: ${error instanceof Error ? error.message : String(error)}`);
    }
}
