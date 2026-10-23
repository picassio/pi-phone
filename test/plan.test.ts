// Plan mode: Pi reads and proposes, anything that changes something is blocked, and approving turns it off.
import {
    type App,
    cleanUp,
    context,
    lastText,
    modelTexts,
    newSession,
    openApp,
    owner,
    say,
    scriptedModel,
    until,
    work,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { PlanDoc, SubagentsDoc } from "../src/server/docs.ts";
import { blockedInPlanMode, commandWords, readOnlyCommand } from "../src/server/extensions/plan.ts";

test("anything beyond plain words in a command line is refused", () => {
    for (const refused of ["ls > out", 'echo "$(id)"', "echo `id`", "ls *.ts", "ls &"]) {
        const words = commandWords(refused);

        assert.ok(words === undefined || !readOnlyCommand(refused), refused);
    }
});

test("only commands that read pass, with arguments that keep them reading", () => {
    const reads = [
        "ls -la ~/src",
        "cat package.json | head -20",
        "cd src && grep -rn TODO .",
        "find . -name '*.ts' -not -path './node_modules/*'",
        "git status",
        "rg --glob '*.md' pi",
    ];

    for (const command of reads) {
        assert.equal(readOnlyCommand(command), true, command);
    }

    const changes = [
        "rm -rf build",
        "git commit -am x",
        "git -c core.pager=evil log",
        "git diff --output=patch.diff",
        "find . -name x -delete",
        "sort -o out.txt in.txt",
        "rg --pre ./run.sh foo",
        "rg --hostname-bin ./run.sh foo",
        // Long options shortened, as getopt and git accept them.
        "git log --outp=log.txt",
        "sort --compress=sh big.txt",
        // The subscript of a name runs what it substitutes.
        "printf -v 'a[$(touch pwned)]' x",
        "sed -i s/a/b/ f",
        "ls && rm x",
        "",
    ];

    for (const command of changes) {
        assert.equal(readOnlyCommand(command), false, command);
    }
});

test("in plan mode only reading tools pass", () => {
    assert.equal(blockedInPlanMode("read", { path: "a" }), undefined);
    assert.equal(blockedInPlanMode("bash", { command: "git log" }), undefined);
    // The wiki records what planning found and decided (PP-27): its tools work, but not its batch migration.
    for (const tool of ["wiki_write", "wiki_edit", "wiki_ingest", "wiki_move", "wiki_lint", "wiki_query", "wiki_read"]) {
        assert.equal(blockedInPlanMode(tool, {}), undefined, tool);
    }
    assert.match(blockedInPlanMode("wiki_migrate", {}) ?? "", /Plan mode is on/);
    // Boards and sessions, only read (PP-36), and lists of tools whose other actions change things.
    for (const tool of ["project_list", "task_list", "task_get", "task_diff", "sessions", "session_read", "session_wait", "pi_sessions"]) {
        assert.equal(blockedInPlanMode(tool, { task: "PP-1" }), undefined, tool);
    }
    for (const tool of ["approvals", "schedule", "watch_ci"]) {
        assert.equal(blockedInPlanMode(tool, { action: "list" }), undefined, `${tool} list`);
    }
    assert.equal(blockedInPlanMode("board_settings", {}), undefined, "board settings, read");
    // The team server's people, roles, audit log and settings, read (PP-45); changes wait for the plan.
    for (const tool of ["team_people", "team_roles", "team_audit", "team_providers", "team_machines", "project_wiki_search", "project_wiki_read"]) {
        assert.equal(blockedInPlanMode(tool, {}), undefined, tool);
    }
    assert.equal(blockedInPlanMode("team_server", {}), undefined, "team settings, read");
    for (const [tool, args] of [["team_server", { idleMinutes: 5 }], ["team_invite", {}], ["team_person", {}], ["team_role_save", {}], ["team_role_delete", {}], ["team_provider_add", {}], ["team_provider_access", {}], ["team_provider_remove", {}], ["team_machine_add", {}], ["team_machine_access", {}], ["team_machine_remove", {}], ["project_wiki_write", {}]] as const) {
        assert.match(blockedInPlanMode(tool, args) ?? "", /Plan mode is on/, tool);
    }
    assert.match(blockedInPlanMode("board_settings", { closer: "pi" }) ?? "", /Plan mode is on/, "board settings, changed");
    assert.match(blockedInPlanMode("approvals", { action: "deny", id: "x" }) ?? "", /Plan mode is on/);
    assert.match(blockedInPlanMode("schedule", { action: "add", when: "in 1h", message: "x" }) ?? "", /Plan mode is on/);
    assert.match(blockedInPlanMode("watch_ci", { action: "start" }) ?? "", /Plan mode is on/);
    for (const tool of ["task_update", "task_create", "task_comment", "task_run", "session_send", "session_stop", "project_share"]) {
        assert.match(blockedInPlanMode(tool, {}) ?? "", /Plan mode is on/, tool);
    }
    assert.match(
        blockedInPlanMode("write", { path: "a", content: "" }) ?? "",
        /^Plan mode is on: The write tool can change things/,
    );
    assert.match(
        blockedInPlanMode("bash", { command: "npm install" }) ?? "",
        /not a simple read-only one/,
    );
    assert.match(
        blockedInPlanMode("schedule", {}) ?? "",
        /blocked/,
        "tools it does not know are blocked too",
    );
    assert.equal(
        blockedInPlanMode("schedule", {}, true),
        undefined,
        "tools their extension marks read-only pass",
    );
});

/** Whether a request carried the plan mode section of the system prompt. */
let toldPlanMode = false;

/** The scripted model tries to write a file, then lists the folder, then answers with what it learned. */
const route: FauxResponseStep = (request) => {
    const { role, text } = lastText(request as never);
    // System messages are positional: each sets the sections it names, and null removes one.
    let planSection = false;

    for (const message of (
        request as { messages: { role: string; sections?: Record<string, string | null> }[] }
    ).messages) {
        if (
            message.role === "system" &&
            message.sections !== undefined &&
            "plan_mode" in message.sections
        ) {
            planSection = message.sections.plan_mode !== null;
        }
    }

    if (planSection) {
        toldPlanMode = true;
    }

    const call = (name: string, args: Parameters<typeof fauxToolCall>[1]) =>
        fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });

    if (role === "toolResult" && text.startsWith("Plan mode is on")) {
        return call("bash", { command: "ls" });
    }

    if (role === "toolResult") {
        return fauxAssistantMessage([fauxText(`plan: 1. write the file (saw: ${text.trim()})`)]);
    }

    if (text.endsWith("make a plan")) {
        return call("write", { path: "planned.txt", content: "x" });
    }

    if (text.endsWith("start a helper")) {
        return call("subagent", { action: "spawn", name: "helper", message: "hello helper" });
    }

    if (text.endsWith("helper, write")) {
        return call("write", { path: "helper.txt", content: "x" });
    }

    if (text.endsWith("script")) {
        return call("codemode", {
            code: "text(await tools.peek({})); try { await tools.poke({}); } catch (error) { text(error.message); }",
        });
    }

    if (text.endsWith("peek") || text.endsWith("poke")) {
        return call(text.slice(-4), {});
    }

    return fauxAssistantMessage([fauxText(`echo: ${text}`)]);
};

let app: App;

before(async () => {
    app = await openApp(scriptedModel(route));
});

after(async () => {
    await app?.close();
    cleanUp();
});

test("a session in plan mode is told so, cannot write, still reads, and approving the plan turns it off", async () => {
    const id = await newSession(app);

    await app.commands.setPlan(id, owner(app), true);
    await say(app, id, "make a plan");
    assert.equal(toldPlanMode, true, "the system prompt says plan mode is on");
    assert.equal(existsSync(join(work, "planned.txt")), false, "the write was blocked");
    const said = (await modelTexts(app, id)).join("\n");

    assert.match(said, /Plan mode is on: The write tool can change things/);
    assert.match(said, /plan: 1\. write the file/, "read-only bash ran and Pi answered");

    await app.commands.approvePlan(id, owner(app));
    assert.equal((await app.harness.snapshot(PlanDoc, id, context))?.on, false);
    const viewer = app.config.addUser("Vee", "viewer").user;

    await assert.rejects(app.commands.setPlan(id, viewer, true), { status: 403 });
});

test("plan mode reaches the subagents already at work", async () => {
    const id = await newSession(app);

    await say(app, id, "start a helper");
    await until(
        async () =>
            (await modelTexts(app, id)).some((text) => text.includes("[subagent helper answered")),
        "the helper to report",
    );
    const helper = (await app.harness.snapshot(SubagentsDoc, id, context))!.agents.helper!
        .conversationId;

    await app.commands.setPlan(id, owner(app), true);
    assert.equal((await app.harness.snapshot(PlanDoc, helper, context))?.on, true);

    await say(app, helper, "helper, write");
    assert.equal(existsSync(join(work, "helper.txt")), false, "the helper's write was blocked");
    assert.match(
        (await modelTexts(app, helper)).join("\n"),
        /Plan mode is on: The write tool can change things/,
    );
    await app.commands.approvePlan(id, owner(app));
    assert.equal(
        (await app.harness.snapshot(PlanDoc, helper, context))?.on,
        false,
        "approving lets the helper work again",
    );
});

