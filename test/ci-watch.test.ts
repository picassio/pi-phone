// CI watch: watch_ci registers a run, a background task looks at it, and its end comes to Pi as one message.
import {
    type App,
    cleanUp,
    context,
    lastText,
    modelTexts,
    newSession,
    owner,
    openApp,
    root,
    say,
    scriptedModel,
    until,
    work,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { CiWatchesDoc } from "../src/server/docs.ts";
import { timing } from "../src/server/extensions/ci-watch.ts";

/** A `gh` that answers from files: `status` says whether run 101 is still going or failed. */
const fake = join(root, "fake-gh");
const status = join(fake, "status");

function fakeGh(): void {
    mkdirSync(fake, { recursive: true });
    writeFileSync(status, "in_progress");
    writeFileSync(
        join(fake, "gh"),
        `#!/bin/sh
case "$*" in
  "repo view"*)
    case "$PWD" in */project*) echo o/r ;; *) echo "no git remotes found" >&2; exit 1 ;; esac ;;
  "run list"*) echo "$*" > '${join(fake, "listed")}'; echo '[{"databaseId":101,"workflowName":"CI","number":7,"headBranch":"main","url":"https://github.com/o/r/actions/runs/101","status":"in_progress"}]' ;;
  *"--log-failed"*) printf 'test\\tnpm test\\tError: boom\\n' ;;
  "run view 101"*)
    if [ "$(cat '${status}')" = "failed" ]; then
      echo '{"status":"completed","conclusion":"failure","url":"https://github.com/o/r/actions/runs/101","displayTitle":"fix things","workflowName":"CI","headBranch":"main","headSha":"abcdef1234","number":7,"jobs":[{"name":"test","status":"completed","conclusion":"failure","steps":[{"name":"npm test","conclusion":"failure"}]}]}'
    else
      echo '{"status":"in_progress","conclusion":"","url":"https://github.com/o/r/actions/runs/101","displayTitle":"fix things","workflowName":"CI","headBranch":"main","headSha":"abcdef1234","number":7,"jobs":[]}'
    fi ;;
  *) echo "unexpected: $*" >&2; exit 1 ;;
esac
`,
    );
    chmodSync(join(fake, "gh"), 0o755);
}

const call = (name: string, args: Parameters<typeof fauxToolCall>[1]) =>
    fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });

const route: FauxResponseStep = (request) => {
    const { role, text } = lastText(request as never);

    if (role === "user" && text === "watch the push") {
        return call("watch_ci", { action: "start", repo: "o/r", commit: "abcdef1234" });
    }

    if (role === "user" && text === "watch the project") {
        return call("watch_ci", { action: "start", path: "project" });
    }

    if (role === "user" && text === "watch here") {
        return call("watch_ci", { action: "start" });
    }

    if (role === "user" && text === "work slowly") {
        return call("bash", { command: "sleep 3" });
    }

    if (role === "user" && text === "stop watching") {
        return call("watch_ci", { action: "stop" });
    }

    if (role === "user" && text === "what is watched") {
        return call("watch_ci", { action: "list" });
    }

    return fauxAssistantMessage([fauxText(text.startsWith("[ci-watch]") ? "noted" : "ok")]);
};

let app: App;
const path = process.env.PATH;

before(async () => {
    fakeGh();
    process.env.PATH = `${fake}:${path}`;
    Object.assign(timing, { lookMs: 50, findMs: 1000, findEveryMs: 50 });
    app = await openApp(scriptedModel(route));
});

after(async () => {
    process.env.PATH = path;
    await app?.close();
    cleanUp();
});

const watches = async (id: Awaited<ReturnType<typeof newSession>>) =>
    (await app.harness.snapshot(CiWatchesDoc, id, context))?.items ?? {};

test("a watched run that fails comes to Pi once, with its failed steps and the end of their log", async () => {
    writeFileSync(status, "in_progress");
    const id = await newSession(app);

    await say(app, id, "watch the push");
    assert.deepEqual(Object.keys(await watches(id)), ["o/r#101"]);

    await say(app, id, "what is watched");
    assert.ok((await modelTexts(app, id)).some((each) => each.includes("CI #7 on main (o/r, run 101)")));

    writeFileSync(status, "failed");
    await until(
        async () => (await modelTexts(app, id)).some((each) => each.includes("[ci-watch] CI #7 on main: failure")),
        "the report",
    );
    const report = (await modelTexts(app, id)).find((each) => each.includes("[ci-watch] CI #7"))!;

    assert.match(report, /Failed steps: test > npm test/);
    assert.match(report, /<ci-log>[\s\S]*Error: boom[\s\S]*<\/ci-log>/);
    await until(async () => Object.keys(await watches(id)).length === 0, "the watch, ended");

    // Once: no second report however long it waits.
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal((await modelTexts(app, id)).filter((each) => each.includes("[ci-watch] CI #7")).length, 1);
});

test("a stopped watch tells nothing", async () => {
    writeFileSync(status, "in_progress");
    const id = await newSession(app);

    await say(app, id, "watch the push");
    assert.equal(Object.keys(await watches(id)).length, 1);
    await say(app, id, "stop watching");
    assert.equal(Object.keys(await watches(id)).length, 0);

    writeFileSync(status, "failed");
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.equal((await modelTexts(app, id)).some((each) => each.includes("[ci-watch] CI #7")), false);
});

test("a watch survives a restart, and reports after it", async () => {
    writeFileSync(status, "in_progress");
    const id = await newSession(app);

    await say(app, id, "watch the push");
    await app.close();
    writeFileSync(status, "failed");
    app = await openApp(scriptedModel(route));

    await until(
        async () => (await modelTexts(app, id)).some((each) => each.includes("[ci-watch] CI #7 on main: failure")),
        "the report after the restart",
    );
    await until(async () => Object.keys(await watches(id)).length === 0, "the watch, ended");
});

test("the bar's Stop ends a watch through the API", async () => {
    writeFileSync(status, "in_progress");
    const { createServer } = await import("node:http");
    const { createHandler } = await import("../src/server/http.ts");
    const server = createServer(createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }));

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

    try {
        const id = await newSession(app);

        await say(app, id, "watch the push");
        const port = (server.address() as { port: number }).port;
        const response = await fetch(`http://127.0.0.1:${port}/api/c/${String(id)}/ci-watch/stop`, {
            method: "POST",
            headers: {
                authorization: `Bearer ${app.config.ownerToken}`,
                "x-pocket": "1",
                "content-type": "application/json",
            },
            body: JSON.stringify({ repo: "o/r", runId: 101 }),
        });

        assert.equal(response.status, 200);
        assert.equal(Object.keys(await watches(id)).length, 0);
    } finally {
        server.closeAllConnections();
        server.close();
    }
});

test("path names the repository's folder: its repo and HEAD; a folder outside one says so", async () => {
    writeFileSync(status, "in_progress");
    const project = join(work, "project");
    const git = (...args: string[]) =>
        execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: project, encoding: "utf8" }).trim();

    mkdirSync(project, { recursive: true });
    git("init", "-q");
    git("commit", "-q", "--allow-empty", "-m", "one");
    const head = git("rev-parse", "HEAD");
    const id = await newSession(app);

    await say(app, id, "watch here");
    assert.ok(
        (await modelTexts(app, id)).some((each) => each.includes("is not in a GitHub repository") && each.includes("Pass path")),
    );
    assert.equal(Object.keys(await watches(id)).length, 0);

    await say(app, id, "watch the project");
    assert.deepEqual(Object.keys(await watches(id)), ["o/r#101"]);
    assert.match(readFileSync(join(fake, "listed"), "utf8"), new RegExp(`--commit ${head}`));
    await say(app, id, "stop watching");
});

test("a report withdrawn with an aborted run is sent again, and reaches Pi once", async () => {
    writeFileSync(status, "in_progress");
    const id = await newSession(app);

    await say(app, id, "watch the push");
    // A run that works for a while; the report arrives during it and is queued behind it.
    const { submissionId } = await app.commands.submit(id, owner(app), { text: "work slowly", requestId: crypto.randomUUID() });

    await until(() => app.isBusy(id), "the slow run");
    writeFileSync(status, "failed");
    await new Promise((resolve) => setTimeout(resolve, 600));
    // Stopping the run withdraws what was queued behind it, the report too.
    await app.commands.abort(id, owner(app));
    await (await app.harness.submission(submissionId, context))!.wait(context);

    await until(
        async () => (await modelTexts(app, id)).some((each) => each.includes("[ci-watch] CI #7 on main: failure")),
        "the report, sent again",
        15_000,
    );
    await until(async () => Object.keys(await watches(id)).length === 0, "the watch, ended");
    assert.equal((await modelTexts(app, id)).filter((each) => each.includes("[ci-watch] CI #7")).length, 1);
});
