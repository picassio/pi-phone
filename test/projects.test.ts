// Projects (the Projects extension): boards of tasks, kept right by the app whatever a model does. The store's rules:
// who sees a project, agent-board's task types and their hierarchy, what Done waits for (a person's approval where a
// task needs it, a Bug's verified fix, a parent's children), never approving your own work, links that never circle.
// Then the extension in a running app: off until the owner turns it on; Pi asks once before using a board (an inline
// card), its tools refuse until the person says yes, and the board's routes answer only the people it is shared with.
import { type App, cleanUp, context, lastText, modelTexts, newSession, openApp, owner, root, scriptedModel, until } from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createHandler } from "../src/server/http.ts";
import { type Actor, type Person, Projects } from "../src/server/projects.ts";
import { ownRequest } from "../src/server/requests.ts";

const OWNER: Person = { id: "u-owner", name: "Owner", role: "owner" };
const TUAN: Person = { id: "u-tuan", name: "Tuan", role: "guest" };
const VIEW: Person = { id: "u-view", name: "Vi", role: "viewer" };
const people = () => [OWNER, TUAN, VIEW];
const as = (person: Person): Actor => ({ kind: "person", person });
const pi = (conversationId: string, person = OWNER): Actor => ({ kind: "pi", person, conversationId });

function store(): Projects {
    return new Projects(mkdtempSync(join(root, "projects-")), people);
}

test("a project has a key; the owner sees every project, others only the ones shared with them; viewers only read", () => {
    const projects = store();

    assert.throws(() => projects.create(as(OWNER), { key: "p", name: "x" }), /2 to 6 letters/);
    const made = projects.create(as(OWNER), { key: "pp", name: "pi-phone", folder: "~/work/pi-phone" });

    assert.equal(made.key, "PP");
    assert.throws(() => projects.create(as(OWNER), { key: "PP", name: "again" }), /already a project PP/);
    assert.deepEqual(projects.list(as(TUAN)), [], "not shared with Tuan yet");
    assert.throws(() => projects.board(as(TUAN), "PP"), /no project PP shared with you/);

    projects.setMembers(as(OWNER), "PP", [TUAN.id, VIEW.id]);
    assert.equal(projects.list(as(TUAN))[0]!.key, "PP");
    assert.throws(() => projects.setMembers(as(TUAN), "PP", []), /Only PP's owner/);
    assert.throws(() => projects.createTask(as(VIEW), "PP", { title: "x" }), /view projects but not change/);
    assert.equal(projects.board(as(VIEW), "PP").project.name, "pi-phone", "a viewer reads");

    const ours = projects.create(as(TUAN), { key: "TU", name: "Tuan's" });

    assert.equal(ours.owner, TUAN.id);
    assert.ok(projects.list(as(OWNER)).some((project) => project.key === "TU"), "the owner sees it too");
    projects.close();
});

test("tasks are numbered per project, and follow agent-board's hierarchy of types", () => {
    const projects = store();

    projects.create(as(OWNER), { key: "PP", name: "pi-phone" });
    projects.create(as(OWNER), { key: "QA", name: "other" });

    const epic = projects.createTask(as(OWNER), "PP", { title: "Projects", type: "epic" });
    const story = projects.createTask(as(OWNER), "PP", { title: "Data", type: "story", parent: epic.ref });
    const task = projects.createTask(as(OWNER), "PP", { title: "Schema", type: "task", parent: story.ref });
    const sub = projects.createTask(as(OWNER), "PP", { title: "Indexes", type: "subtask", parent: task.ref });

    assert.deepEqual([epic.ref, story.ref, task.ref, sub.ref], ["PP-1", "PP-2", "PP-3", "PP-4"]);
    assert.equal(projects.createTask(as(OWNER), "QA", { title: "x" }).ref, "QA-1", "each project counts on its own");
    assert.throws(() => projects.createTask(as(OWNER), "PP", { title: "x", type: "subtask" }), /sits under another task/);
    assert.throws(() => projects.createTask(as(OWNER), "PP", { title: "x", type: "story", parent: task.ref }), /holds subtask, not a story/);
    assert.throws(() => projects.createTask(as(OWNER), "PP", { title: "x", type: "task", parent: sub.ref }), /holds nothing/);
    assert.throws(() => projects.createTask(as(OWNER), "PP", { title: "x", parent: "QA-1" }), /not a task of PP/);
    assert.throws(() => projects.updateTask(as(OWNER), story.ref, { type: "subtask" }), /sits under|holds/);
    assert.throws(() => projects.updateTask(as(OWNER), task.ref, { type: "epic" }), /sits under|holds/);
    assert.throws(() => projects.updateTask(as(OWNER), epic.ref, { parent: story.ref }), /its own child/);
    assert.throws(() => projects.removeTask(as(OWNER), story.ref), /has tasks under it/);

    const board = projects.board(as(OWNER), "PP");
    const byRef = new Map(board.tasks.map((each) => [each.ref, each]));

    assert.deepEqual(byRef.get("PP-1")!.children, ["PP-2"]);
    assert.equal(byRef.get("PP-4")!.parentRef, "PP-3");
    assert.deepEqual(byRef.get("PP-2")!.progress, [0, 1]);
    projects.close();
});

test("Done waits: for a person where the task needs one, for a Bug's verified fix, for the children; and never your own work", () => {
    const projects = store();

    projects.create(as(OWNER), { key: "PP", name: "pi-phone" });

    // Pi works on a task in one session: it may not approve it there; the main session (another) may.
    const work = projects.createTask(as(OWNER), "PP", { title: "Build it", assignee: "pi" });

    projects.updateTask(pi("worker"), work.ref, { state: "in_progress" });
    assert.deepEqual(projects.sessionsOf(work.id).map((each) => [each.conversationId, each.role]), [["worker", "worker"]]);
    projects.updateTask(pi("worker"), work.ref, { state: "review" });
    assert.throws(() => projects.updateTask(pi("worker"), work.ref, { state: "done" }), /cannot approve it/);
    assert.equal(projects.updateTask(pi("main"), work.ref, { state: "done" }).state, "done");

    // Risky work: only a person moves it to Done, and only a person lifts that.
    const risky = projects.createTask(as(OWNER), "PP", { title: "Migrate", operatorReview: true });

    assert.throws(() => projects.updateTask(pi("main"), risky.ref, { state: "done" }), /needs a person's approval/);
    assert.throws(() => projects.updateTask(pi("main"), risky.ref, { operatorReview: false }), /Only a person can lift/);
    assert.equal(projects.updateTask(as(OWNER), risky.ref, { state: "done" }).state, "done");

    // A Bug: Done after its fix is verified.
    const bug = projects.createTask(as(OWNER), "PP", { title: "Crash", type: "bug" });

    assert.throws(() => projects.updateTask(as(OWNER), bug.ref, { state: "done" }), /verify the fix first/);
    assert.equal(projects.updateTask(pi("main"), bug.ref, { fixVerified: true, state: "done" }).state, "done");

    // A parent: Done once everything under it is.
    const story = projects.createTask(as(OWNER), "PP", { title: "Story", type: "story" });
    const child = projects.createTask(as(OWNER), "PP", { title: "Part", parent: story.ref });

    assert.throws(() => projects.updateTask(as(OWNER), story.ref, { state: "done" }), /still has open tasks under it: PP-5/);
    projects.updateTask(as(OWNER), child.ref, { state: "done" });
    assert.equal(projects.updateTask(as(OWNER), story.ref, { state: "done" }).state, "done");
    assert.throws(() => projects.createTask(as(OWNER), "PP", { title: "x", state: "done" }), /cannot start Done/);
    projects.close();
});

test("blocks are shown, never acted on; links never circle; a blocked task says why, until it is not", () => {
    const projects = store();

    projects.create(as(OWNER), { key: "PP", name: "pi-phone" });
    const first = projects.createTask(as(OWNER), "PP", { title: "API" });
    const second = projects.createTask(as(OWNER), "PP", { title: "Screen" });
    const third = projects.createTask(as(OWNER), "PP", { title: "QA" });

    projects.link(as(OWNER), first.ref, second.ref, "blocks");
    projects.link(as(OWNER), second.ref, third.ref, "blocks");
    assert.throws(() => projects.link(as(OWNER), third.ref, first.ref, "blocks"), /would be a circle/);
    assert.throws(() => projects.link(as(OWNER), first.ref, first.ref, "relates"), /itself/);

    const waiting = () => projects.board(as(OWNER), "PP").tasks.find((each) => each.ref === second.ref)!;

    assert.deepEqual(waiting().waitingOn, ["PP-1"]);
    projects.updateTask(as(OWNER), first.ref, { state: "done" });
    assert.deepEqual(waiting().waitingOn, [], "done blockers no longer hold it");
    assert.equal(waiting().state, "inbox", "and nothing moved it");

    const blocked = projects.updateTask(as(OWNER), third.ref, { state: "blocked", blockedReason: "Need the API key" });

    assert.equal(blocked.blockedReason, "Need the API key");
    assert.equal(projects.updateTask(as(OWNER), third.ref, { state: "assigned" }).blockedReason, null);

    projects.comment(pi("s1"), third.ref, "Found the key in Settings.");
    const detail = projects.task(as(OWNER), third.ref);

    assert.deepEqual(detail.comments.map((comment) => [comment.authorName, comment.session, comment.text]), [["Pi", "s1", "Found the key in Settings."]]);
    assert.deepEqual(detail.links.map((link) => [link.direction, link.ref]), [["in", "PP-2"]]);
    assert.ok(detail.activity.some((each) => each.kind === "changed" && each.data.state === "blocked"));
    projects.close();
});

test("projects survive a restart, and a session's board mode is kept", () => {
    const dir = mkdtempSync(join(root, "projects-"));
    const first = new Projects(dir, people);

    first.create(as(OWNER), { key: "PP", name: "pi-phone" });
    first.createTask(as(OWNER), "PP", { title: "Keep me", labels: ["UI", "ui", " server "], checklist: [{ text: "a", done: true }, { text: "b", done: false }] });
    first.setBoardMode(as(OWNER), "c-1", true, "PP");
    first.close();

    const again = new Projects(dir, people);
    const task = again.board(as(OWNER), "PP").tasks[0]!;

    assert.deepEqual(task.labels, ["ui", "server"]);
    assert.deepEqual(task.progress, [1, 2]);
    assert.deepEqual(again.boardMode("c-1")?.on, true);
    assert.equal(again.boardMode("c-1")?.project?.key, "PP");
    assert.equal(again.boardMode("c-2"), undefined);
    assert.equal(again.createTask(as(OWNER), "PP", { title: "next" }).ref, "PP-2");
    again.close();
});

// ---- The extension, in a running app ------------------------------------------------------------------------------

const calls: Record<string, [string, Record<string, unknown>]> = {
    "add a task": ["task_create", { project: "PP", title: "Write the API", type: "story", priority: 3 }],
    "ask for the board": ["board_mode", { project: "pp", name: "pi-phone", reason: "Three parts to build and track" }],
    "list projects": ["project_list", {}],
    "start it": ["task_update", { task: "PP-1", state: "in_progress" }],
    "approve it": ["task_update", { task: "PP-1", state: "done" }],
};
let prompt = "";
const route: FauxResponseStep = (request) => {
    for (const message of (request as { messages: { role: string; sections?: Record<string, string | null> }[] }).messages) {
        if (message.role === "system" && message.sections?.projects !== undefined) {
            prompt = message.sections.projects ?? "";
        }
    }

    const { role, text } = lastText(request as never);

    for (const [ask, [tool, args]] of Object.entries(calls)) {
        if (role === "user" && text.endsWith(ask)) {
            return fauxAssistantMessage([fauxToolCall(tool, args as never)], { stopReason: "toolUse" });
        }
    }

    return fauxAssistantMessage([fauxText(role === "toolResult" ? `tool said: ${text}` : `heard: ${text}`)]);
};

let app: App;
let server: Server;
let base: string;

before(async () => {
    app = await openApp(scriptedModel(route), join(root, "projects-app"));
    server = createServer(createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

after(async () => {
    server?.closeAllConnections();
    server?.close();
    await app?.close();
    cleanUp();
});

async function turn(id: Parameters<App["commands"]["submit"]>[0], text: string): Promise<string> {
    const { submissionId } = await app.commands.submit(id, owner(app), { text, requestId: ownRequest(owner(app).id, crypto.randomUUID()) });

    await (await app.harness.submission(submissionId, context))!.wait(context);
    await app.harness.waitForIdle(context);

    return (await modelTexts(app, id)).at(-1)!;
}

const call = (token: string, method: string, path: string, body?: unknown) =>
    fetch(`${base}/api/x/projects/${path}`, {
        method,
        headers: { authorization: `Bearer ${token}`, "x-pocket": "1", "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

test("off until the owner turns it on: no board tools, no routes", async () => {
    assert.equal((await call(app.config.ownerToken, "GET", "projects")).status, 404);

    const id = await newSession(app);

    assert.match(await turn(id, "list projects"), /not found|unknown|no tool|not available/i);
});

test("Pi asks once before using a board; its tools refuse until the person says yes", async () => {
    await app.setExtensionEnabled(owner(app), "projects.ts", true);
    await until(() => app.loader.extensionNames().includes("pocket-projects"), "the extension");

    const id = await newSession(app);

    assert.match(await turn(id, "add a task"), /Board mode is off in this session: ask the person first/);
    assert.match(prompt, /ask once with board_mode before using any board tool/);

    // The card: the person says yes, and the board is made with the session on it.
    const { submissionId } = await app.commands.submit(id, owner(app), { text: "ask for the board", requestId: ownRequest(owner(app).id, crypto.randomUUID()) });

    await until(() => app.approvals.forConversation(id).some((each) => each.tool === "board_mode"), "the card");
    const card = app.approvals.forConversation(id).find((each) => each.tool === "board_mode")!;

    assert.equal(card.subject, "Track this on a new board: PP · pi-phone");
    assert.equal(card.reason, "Three parts to build and track");
    assert.ok(await app.answerApproval(card.id, true, owner(app)));
    await (await app.harness.submission(submissionId, context))!.wait(context);
    await app.harness.waitForIdle(context);
    assert.match((await modelTexts(app, id)).at(-1)!, /Board mode is on, with PP/);

    assert.match(await turn(id, "add a task"), /Made PP-1: Write the API/);
    assert.match(prompt, /Board mode is on in this session, with project PP · pi-phone/);
    assert.match(await turn(id, "list projects"), /PP · pi-phone: 1 Inbox; 0 done(\\n|\n)Board mode is on here, with PP/);

    // It works on it here, so it may not approve it here.
    assert.match(await turn(id, "start it"), /PP-1 is In Progress/);
    assert.match(await turn(id, "approve it"), /You worked on PP-1 in this session, so you cannot approve it/);
});

test("a no is kept: Pi does not ask again, and works without the board", async () => {
    const id = await newSession(app);
    const { submissionId } = await app.commands.submit(id, owner(app), { text: "ask for the board", requestId: ownRequest(owner(app).id, crypto.randomUUID()) });

    await until(() => app.approvals.forConversation(id).some((each) => each.tool === "board_mode"), "the card");
    const card = app.approvals.forConversation(id).find((each) => each.tool === "board_mode")!;

    assert.equal(card.subject, "Track this on the board: PP · pi-phone", "PP exists now");
    await app.answerApproval(card.id, false, owner(app));
    await (await app.harness.submission(submissionId, context))!.wait(context);
    await app.harness.waitForIdle(context);
    assert.match((await modelTexts(app, id)).at(-1)!, /said no: work without the board/);

    assert.match(await turn(id, "ask for the board"), /said no to the board in this session: do not ask again/);
    assert.match(await turn(id, "add a task"), /turned board mode off in this session/);
    assert.match(prompt, /said no to a board in this session/);

    // The session's switch turns it on after all.
    const on = await call(app.config.ownerToken, "PUT", `board-mode/${String(id)}`, { on: true });

    assert.deepEqual(await on.json(), { on: true, decided: true, project: "PP" });
    assert.match(await turn(id, "add a task"), /Made PP-2/);
});

test("the board's routes: shared people see and change it, others get nothing, viewers only read", async () => {
    const guest = app.config.addUser("Gina", "guest");
    const viewer = app.config.addUser("Vic", "viewer");
    const invited = app.config.addUser("Ivy", "guest", ["no-such-session"]);

    try {
        const listed = (await (await call(app.config.ownerToken, "GET", "projects")).json()) as { projects: { key: string; counts: Record<string, number> }[] };

        assert.equal(listed.projects[0]!.key, "PP");
        assert.equal(listed.projects[0]!.counts.in_progress, 1);
        assert.deepEqual(((await (await call(guest.token, "GET", "projects")).json()) as { projects: unknown[] }).projects, [], "not shared");
        assert.equal((await call(guest.token, "GET", "projects/PP")).status, 404);
        assert.equal((await call(invited.token, "GET", "projects")).status, 404, "people invited to one session never reach the app's parts");

        await call(app.config.ownerToken, "PUT", "projects/PP/members", { members: [guest.user.id, viewer.user.id] });

        const made = await call(guest.token, "POST", "projects/PP/tasks", { title: "From Gina", type: "bug", priority: 2 });

        assert.equal(made.status, 200);
        assert.equal(((await made.json()) as { ref: string }).ref, "PP-3");
        // Steering routes are not there for viewers at all (the app's web parts), before the store would refuse.
        assert.equal((await call(viewer.token, "POST", "projects/PP/tasks", { title: "x" })).status, 404);
        assert.equal((await call(viewer.token, "GET", "tasks/PP-3")).status, 200);

        const done = await call(guest.token, "PATCH", "tasks/PP-3", { state: "done" });

        assert.equal(done.status, 409);
        assert.match(((await done.json()) as { error: string }).error, /verify the fix first/);

        const board = (await (await call(guest.token, "GET", "projects/PP")).json()) as { tasks: { ref: string; type: string }[] };

        assert.deepEqual(board.tasks.map((task) => task.ref).sort(), ["PP-1", "PP-2", "PP-3"]);
    } finally {
        app.config.removeUser(guest.user.id);
        app.config.removeUser(viewer.user.id);
        app.config.removeUser(invited.user.id);
    }
});
