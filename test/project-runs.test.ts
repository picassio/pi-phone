// A project's agent team (project-runs.ts): its main session leads; a task given to Pi runs in a task session of its
// own, in a git worktree on task/<ref>, at the project's place with room; the session's end is reported to the main
// session (done, stopped, or needs the person); the person sees the branch's diff and merges it. The phone does not hear
// task and main sessions finish (the board says it).
import { type App, cleanUp, context, lastText, modelTexts, openApp, owner, root, scriptedModel, until } from "./helpers.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createHandler } from "../src/server/http.ts";

const repo = join(root, "team-repo");
const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();

// Task sessions finish RT-2 (to Review); the main session asks to run what it is told was given to Pi.
const route: FauxResponseStep = (request) => {
    const { role, text } = lastText(request as never);

    if (role === "user" && text.includes("Work on RT-2 ")) {
        return fauxAssistantMessage([fauxToolCall("task_update", { task: "RT-2", state: "review" })], { stopReason: "toolUse" });
    }

    // The main session reviews what it hears is done: a comment, which links it to the task as leading it.
    const done = /Done: (RT-\d+) /.exec(text);

    if (role === "user" && done) {
        return fauxAssistantMessage([fauxToolCall("task_comment", { task: done[1]!, text: "Reviewed: looks right." })], { stopReason: "toolUse" });
    }

    const given = /(RT-\d+) \([^)]*\) was given to Pi/.exec(text);

    if (role === "user" && given) {
        return fauxAssistantMessage([fauxToolCall("task_run", { task: given[1]! })], { stopReason: "toolUse" });
    }

    return fauxAssistantMessage([fauxText(role === "toolResult" ? `tool said: ${text}` : `heard: ${text.slice(0, 80)}`)]);
};

let app: App;
let server: Server;
let base: string;

before(async () => {
    mkdirSync(repo, { recursive: true });
    execFileSync("git", ["init", "-q", "-b", "main", repo]);
    git("config", "user.email", "t@example.com");
    git("config", "user.name", "Test");
    writeFileSync(join(repo, "README.md"), "hello\n");
    git("add", "README.md");
    git("commit", "-q", "-m", "first");

    app = await openApp(scriptedModel(route), join(root, "team-app"));
    // New sessions start on the model the owner picked last.
    app.config.lastModel = { provider: "faux", modelId: "faux-1", thinkingLevel: "off" };
    server = createServer(createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    await app.setExtensionEnabled(owner(app), "projects.ts", true);
    await until(() => app.loader.extensionNames().includes("pocket-projects"), "the extension");
});

after(async () => {
    server?.closeAllConnections();
    server?.close();
    await app?.close();
    cleanUp();
});

const call = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${base}/api/x/projects/${path}`, {
        method,
        headers: { authorization: `Bearer ${app.config.ownerToken}`, "x-pocket": "1", "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const json = (await response.json()) as Record<string, unknown>;

    if (!response.ok) {
        throw new Error(`${path}: ${JSON.stringify(json)}`);
    }

    return json;
};
const board = async () => (await call("GET", "projects/RT")) as { tasks: { ref: string; state: string; run: { state: string; conversationId: string | null; branch: string | null } | null }[]; lead: { session: number } | null };
const taskOf = async (ref: string) => (await board()).tasks.find((task) => task.ref === ref)!;
const said = async (session: number) => (await modelTexts(app, session as never)).join("\n");
let lead = 0;

test("a project's main session starts in its folder, leading its board", async () => {
    await call("POST", "projects", { key: "RT", name: "run test", folder: repo });
    lead = (await call("POST", "projects/RT/team", {})).session as number;

    assert.equal((await board()).lead?.session, lead);
    await until(async () => /You are the main session of project RT[\s\S]*heard:/.test(await said(lead)), "its first turn");
    await assert.rejects(call("POST", "projects/RT/team", {}), /has a main session already/);
});

test("with automatic runs on, a task given to Pi runs in a worktree on task/<ref>; a session that stops early is reported", async () => {
    await call("PATCH", "projects/RT", { autoRuns: true });
    await call("POST", "projects/RT/tasks", { title: "Say hello", assignee: "pi" });

    await until(async () => (await taskOf("RT-1")).run?.state === "stopped", "the run to end", 20_000);

    const task = await taskOf("RT-1");

    assert.equal(task.state, "in_progress", "the run moved it on as it started; nothing more");
    assert.equal(task.run?.branch, "task/RT-1");
    assert.ok(existsSync(join(repo, ".worktrees", "RT-1", "README.md")), "a worktree of the repository");
    assert.match(git("branch", "--list", "task/RT-1"), /task\/RT-1/);
    assert.equal(git("status", "--porcelain"), "", "the worktrees folder stays out of the repository's status");

    const session = Number(task.run!.conversationId);

    assert.match(await said(session), /Work on RT-1 of project RT · run test: Say hello/);
    await until(async () => /Stopped: RT-1 \(Say hello\) is still In Progress/.test(await said(lead)), "the report");
});

test("a task session that finishes moves its task to Review, and the main session hears it is done", async () => {
    await call("POST", "projects/RT/tasks", { title: "Add a file", assignee: "pi" });
    await until(async () => (await taskOf("RT-2")).run?.state === "done", "the run to finish", 20_000);

    assert.equal((await taskOf("RT-2")).state, "review");
    await until(async () => /Done: RT-2 \(Add a file\) is in Review/.test(await said(lead)), "the report");

    // The task lists both: the session that worked on it, and the main session that reviewed it.
    await until(async () => {
        const detail = (await call("GET", "tasks/RT-2")) as { sessions: { conversationId: string; role: string }[] };

        return detail.sessions.some((each) => each.conversationId === String(lead) && each.role === "main");
    }, "the main session linked");

    // The phone heard neither session finish: the board says it.
    const { events } = await app.phoneEvents.after(0, new AbortController().signal);
    const quiet = [lead, Number((await taskOf("RT-2")).run!.conversationId)];

    assert.ok(!events.some((event) => event.kind === "done" && quiet.includes(event.session)));
});

test("the person sees the branch's diff and merges it; the task is done and its worktree goes", async () => {
    const worktree = join(repo, ".worktrees", "RT-2");

    writeFileSync(join(worktree, "hello.txt"), "hi\n");
    execFileSync("git", ["-C", worktree, "add", "hello.txt"]);
    execFileSync("git", ["-C", worktree, "commit", "-q", "-m", "add hello"]);

    const diff = (await call("GET", "tasks/RT-2/diff")) as { diff: string; base: string };

    assert.equal(diff.base, "main");
    assert.match(diff.diff, /hello\.txt/);

    await call("POST", "tasks/RT-2/merge", {});
    assert.ok(existsSync(join(repo, "hello.txt")), "merged into main");
    assert.ok(!existsSync(worktree), "its worktree removed");
    assert.equal((await taskOf("RT-2")).state, "done");
});

test("with automatic runs off, the main session asks the person before a task runs", async () => {
    await call("PATCH", "projects/RT", { autoRuns: false });
    await call("POST", "projects/RT/tasks", { title: "Wait for a yes", assignee: "pi" });

    await until(() => app.approvals.forConversation(lead as never).some((each) => each.tool === "task_run"), "the question", 20_000);
    assert.equal((await taskOf("RT-3")).run, null, "nothing runs before the yes");

    const card = app.approvals.forConversation(lead as never).find((each) => each.tool === "task_run")!;

    assert.equal(card.subject, "RT-3 · Wait for a yes");
    await app.answerApproval(card.id, true, owner(app));
    await until(async () => (await taskOf("RT-3")).run !== null, "the run", 20_000);
    await app.harness.waitForIdle(context);
});
