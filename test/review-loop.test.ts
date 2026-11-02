// Review's comments and checkpoints (PP-358): a checkpoint is a commit of the whole folder (untracked files too, ignored
// ones not) kept by a ref of its own, written without touching the index, the stash or a branch; "Since last review"
// shows only what changed after it (HEAD before the first); comments become pi-review-loop's feedback; in the app,
// comments are added, changed and removed, and Send review returns the feedback, checkpoints, and clears them.
import { type App, cleanUp, newSession, openApp, owner, root, scriptedModel } from "./helpers.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { changedSince, composeFeedback, diffSince, makeCheckpoint, newComment, type ReviewComment, snapshotTree } from "../src/server/review-loop.ts";

const repo = join(root, "review-loop-repo");
const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
const run = (command: string) => {
    try {
        return Promise.resolve({ code: 0, stdout: execFileSync("sh", ["-c", command], { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }), stderr: "" });
    } catch (error) {
        const failed = error as { status?: number; stdout?: string; stderr?: string };

        return Promise.resolve({ code: failed.status ?? 1, stdout: String(failed.stdout ?? ""), stderr: String(failed.stderr ?? "") });
    }
};
let app: App;

before(() => {
    mkdirSync(repo, { recursive: true });
    git("init", "-q", "-b", "master");
    git("config", "user.email", "t@t");
    git("config", "user.name", "t");
    writeFileSync(join(repo, "a.ts"), "one\ntwo\nthree\n");
    writeFileSync(join(repo, ".gitignore"), "secret.env\n");
    git("add", ".");
    git("commit", "-q", "-m", "first");
});

after(async () => {
    await app?.close();
    cleanUp();
});

test("a checkpoint keeps the whole folder without touching the index, the stash or a branch; since shows only what came after", async () => {
    writeFileSync(join(repo, "a.ts"), "one\nTWO\nthree\n");
    writeFileSync(join(repo, "b.ts"), "new file\n");
    writeFileSync(join(repo, "secret.env"), "TOKEN=x\n");
    git("add", "a.ts");

    const index = git("diff", "--cached", "--name-only");
    const head = git("rev-parse", "HEAD");

    // Before the first: from HEAD, the untracked file too, the ignored one not.
    const first = await changedSince(run, "HEAD", await snapshotTree(run));

    assert.deepEqual(first.map(({ path, kind, added, removed }) => ({ path, kind, added, removed })), [
        { path: "a.ts", kind: "modified", added: 1, removed: 1 },
        { path: "b.ts", kind: "added", added: 1, removed: 0 },
    ]);

    const sha = await makeCheckpoint(run);

    assert.match(sha, /^[0-9a-f]{40}$/);
    assert.equal(git("rev-parse", `refs/pi-phone/review/${sha}`), sha, "kept by its ref");
    assert.equal(git("rev-parse", "HEAD"), head, "HEAD stays");
    assert.equal(git("diff", "--cached", "--name-only"), index, "the index stays");
    assert.equal(git("stash", "list"), "", "no stash");
    assert.equal(git("status", "--porcelain", "--untracked-files=all"), "M  a.ts\n?? b.ts", "the folder as it was");
    assert.deepEqual(await changedSince(run, sha, await snapshotTree(run)), [], "nothing new since");

    writeFileSync(join(repo, "b.ts"), "new file\nmore\n");

    const current = await snapshotTree(run);
    const since = await changedSince(run, sha, current);

    assert.deepEqual(since.map(({ path, added, removed }) => ({ path, added, removed })), [{ path: "b.ts", added: 1, removed: 0 }], "only what changed after it");
    assert.match(await diffSince(run, sha, current, "b.ts"), /@@ -1 \+1,2 @@\n new file\n\+more/);
    await assert.rejects(diffSince(run, "HEAD; rm -rf /", current, "b.ts"), /Not a checkpoint/);
});

test("comments become pi-review-loop's feedback; a comment without a line, side or words is refused", () => {
    const at = (each: Partial<ReviewComment>) => ({ id: "x", path: "a.ts", side: "new", mode: "since", body: "b", at: 1, ...each }) as ReviewComment;

    assert.equal(
        composeFeedback([at({ line: 88, body: "Stop on 4xx." }), at({ side: "old", line: 12, body: "Why\nremoved?" }), at({ side: "old", line: 3, mode: "head", body: "Old." }), at({ side: "file", path: "t.ts", body: "Name says 3." })]),
        "Please address the following review feedback:\n\n1. a.ts:88 (current)\n   Stop on 4xx.\n\n2. a.ts:12 (reviewed)\n   Why\n   removed?\n\n3. a.ts:3 (HEAD)\n   Old.\n\n4. t.ts\n   Name says 3.",
    );
    assert.equal(composeFeedback([]), "");
    assert.equal(newComment({ path: "a.ts", side: "new", body: "x" }), undefined, "a line's comment needs its line");
    assert.equal(newComment({ path: "a.ts", side: "left", line: 1, body: "x" }), undefined);
    assert.equal(newComment({ path: "a.ts", side: "file", body: "  " }), undefined);
    assert.deepEqual({ ...newComment({ path: "a.ts", side: "file", line: 4, body: " note ", mode: "head" }), id: "", at: 0 }, { id: "", path: "a.ts", side: "file", mode: "head", body: "note", at: 0 });
});

test("in the app: comments are added, changed and removed; Send review gives the feedback, checkpoints, and clears them", async () => {
    app = await openApp(scriptedModel(() => fauxAssistantMessage([fauxText("ok")])), join(root, "review-loop-data"));

    const id = await newSession(app, repo);
    const me = owner(app);
    let comments = await app.reviewComment(id as never, me, { add: { path: "b.ts", side: "new", line: 2, body: "Why more?" } });

    comments = await app.reviewComment(id as never, me, { add: { path: "a.ts", side: "file", body: "Rename it." } });
    comments = await app.reviewComment(id as never, me, { id: comments[0]!.id, body: "Why more lines?" });
    assert.deepEqual(comments.map((each) => each.body), ["Why more lines?", "Rename it."]);
    await assert.rejects(app.reviewComment(id as never, me, { add: { path: "a.ts", side: "new", body: "no line" } }), /needs a file, a side/);

    const state = await app.reviewLoop(id as never, me, true);

    assert.equal("since" in state && state.since.base, "HEAD", "before the first review, from HEAD");

    const sent = await app.sendReview(id as never, me);

    assert.equal(sent.text, "Please address the following review feedback:\n\n1. b.ts:2 (current)\n   Why more lines?\n\n2. a.ts\n   Rename it.");

    const after = await app.reviewLoop(id as never, me, true);

    assert.deepEqual(after.comments, []);
    assert.equal(after.checkpoint?.sha, sent.checkpoint.sha);
    assert.deepEqual("since" in after ? after.since.files : null, [], "nothing changed since the review");
    comments = await app.reviewComment(id as never, me, { add: { path: "a.ts", side: "file", body: "x" } });
    assert.deepEqual((await app.reviewComment(id as never, me, { id: comments[0]!.id, body: null })).length, 0, "removed");
});
