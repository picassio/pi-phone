// Code review by a subagent (PP-357): `/review`'s arguments, what each target looks up with git and gh where the
// session works, the reviewer's prompt (pi-review's rubric, the target, REVIEW_GUIDELINES.md, a focus, the output
// format), its review-result block read back, and the review GitHub gets. In an app with a stand-in model and gh:
// `/review` starts a read-only reviewer whose answer comes back as a report with the block; posting it to a pull
// request asks the person first, and posts line comments on the diff's lines only.
import { type App, cleanUp, context, newSession, openApp, owner, root, scriptedModel, until } from "./helpers.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { AgentDoc } from "@earendil-works/pi-durable";
import { SubagentsDoc } from "../src/server/docs.ts";
import {
    diffLines,
    expandReviewCommand,
    githubReview,
    parseReviewArgs,
    parseReviewResult,
    prepareReview,
    REVIEW_RUBRIC,
    reviewPrompt,
    reviewTargets,
} from "../src/server/review.ts";

const repo = join(root, "review-repo");
const bin = join(root, "review-bin");
const posted = join(root, "review-posted.json");
const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
const run = (command: string) => {
    try {
        return Promise.resolve({ code: 0, stdout: execFileSync("sh", ["-c", command], { cwd: repo, encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, stdio: ["ignore", "pipe", "pipe"] }), stderr: "" });
    } catch (error) {
        const failed = error as { status?: number; stdout?: string; stderr?: string };

        return Promise.resolve({ code: failed.status ?? 1, stdout: String(failed.stdout ?? ""), stderr: String(failed.stderr ?? "") });
    }
};

const RESULT = {
    verdict: "needs attention",
    findings: [
        { priority: "P1", title: "Retry never gives up", file: "a.ts", line: 3, body: "A 401 is retried forever.", suggestion: "if (status < 500) throw error;" },
        { priority: "P3", title: "Old helper", file: "a.ts", line: 40, body: "Outside the diff." },
    ],
    callouts: [{ label: "This change introduces a new dependency", text: "p-retry 6.2.1" }],
};
const answer = `Findings: one P1, one P3.\n\n\`\`\`review-result\n${JSON.stringify(RESULT)}\n\`\`\``;

let app: App;

before(() => {
    mkdirSync(repo, { recursive: true });
    git("init", "-q", "-b", "master");
    git("config", "user.email", "t@t");
    git("config", "user.name", "t");
    writeFileSync(join(repo, "a.ts"), "export const a = 1;\n");
    git("add", ".");
    git("commit", "-q", "-m", "first");
    // A stand-in gh: lists one pull request, views #7 (head = this repo's HEAD), and keeps what a review posts.
    mkdirSync(bin, { recursive: true });
    writeFileSync(
        join(bin, "gh"),
        `#!/bin/sh
case "$1 $2" in
  "pr list") echo '[{"number":7,"title":"Add retry","headRefName":"retry","baseRefName":"master","changedFiles":1}]' ;;
  "pr view") echo "{\\"number\\":7,\\"title\\":\\"Add retry\\",\\"baseRefName\\":\\"master\\",\\"headRefOid\\":\\"$(git rev-parse HEAD)\\",\\"url\\":\\"https://github.com/o/r/pull/7\\",\\"changedFiles\\":1}" ;;
  "api --method") cat > ${JSON.stringify(posted)}; echo '{"html_url":"https://github.com/o/r/pull/7#pullrequestreview-1"}' ;;
  *) echo "gh: $*" >&2; exit 1 ;;
esac
`,
    );
    chmodSync(join(bin, "gh"), 0o755);
});

after(async () => {
    await app?.close();
    cleanUp();
});

test("/review's arguments: each target, a link or a number for a pull request, a focus after --extra, and what it refuses", () => {
    assert.deepEqual(parseReviewArgs(""), { target: { kind: "changes" } });
    assert.deepEqual(parseReviewArgs("uncommitted"), { target: { kind: "changes" } });
    assert.deepEqual(parseReviewArgs("branch main --extra \"error handling\""), { target: { kind: "branch", base: "main" }, extra: "error handling" });
    assert.deepEqual(parseReviewArgs("commit abc123"), { target: { kind: "commit", sha: "abc123" } });
    assert.deepEqual(parseReviewArgs("pr #142"), { target: { kind: "pr", pr: "142" } });
    assert.deepEqual(parseReviewArgs("pr https://github.com/o/r/pull/142 --extra perf and leaks"), { target: { kind: "pr", pr: "https://github.com/o/r/pull/142" }, extra: "perf and leaks" });
    assert.deepEqual(parseReviewArgs("folder src \"my docs\""), { target: { kind: "folders", paths: ["src", "my docs"] } });
    assert.match((parseReviewArgs("pr") as { error: string }).error, /needs a pull request/);
    assert.match((parseReviewArgs("pr feature") as { error: string }).error, /number or its github\.com link/);
    assert.match((parseReviewArgs("everything") as { error: string }).error, /Unknown review target/);
    assert.equal(expandReviewCommand("/reviewer"), undefined);
    assert.match(String(expandReviewCommand("/review pr 7")), /^\/review pr 7\n\n<review-request>\n.*"target":"pr","ref":"7".*\n<\/review-request>$/s);
});

test("each target is looked up with git and gh: nothing to review says so; a pull request is fetched, never checked out", async () => {
    await assert.rejects(prepareReview(run, { kind: "changes" }), /no uncommitted changes/);
    writeFileSync(join(repo, "a.ts"), "export const a = 1;\nexport const b = 2;\nretry();\n");

    const changes = await prepareReview(run, { kind: "changes" });

    assert.deepEqual(changes.meta, { kind: "changes", label: "uncommitted changes", files: 1 });
    git("commit", "-qam", "retry");

    const commit = await prepareReview(run, { kind: "commit", sha: "HEAD" });

    assert.match(commit.meta.label, /^commit [0-9a-f]{7} · retry$/);
    assert.match(commit.instructions, /git show [0-9a-f]{40}/);
    await assert.rejects(prepareReview(run, { kind: "folders", paths: ["missing"] }), /missing is not there/);

    // The pull request: an origin that has pull/7/head, as GitHub's does.
    const origin = join(root, "review-origin.git");

    execFileSync("git", ["clone", "-q", "--bare", repo, origin]);
    execFileSync("git", ["-C", origin, "update-ref", "refs/pull/7/head", git("rev-parse", "HEAD")]);
    execFileSync("git", ["-C", origin, "update-ref", "refs/heads/master", git("rev-parse", "HEAD~1")]);
    git("remote", "add", "origin", origin);

    const before = git("rev-parse", "HEAD");
    const pr = await prepareReview(run, { kind: "pr", pr: "7" });

    assert.equal(pr.meta.label, "PR #7 · Add retry");
    assert.deepEqual({ ...pr.meta.pr, mergeBase: pr.meta.pr?.mergeBase.length }, { repo: "o/r", number: 7, title: "Add retry", url: "https://github.com/o/r/pull/7", headSha: before, mergeBase: 40 });
    assert.match(pr.instructions, /not checked out: read its files with `git show [0-9a-f]{40}:<path>`/);
    assert.equal(git("rev-parse", "HEAD"), before, "nothing checked out");

    const targets = await reviewTargets(run);

    assert.deepEqual(targets.prs, [{ number: 7, title: "Add retry", head: "retry", base: "master", files: 1 }]);
    assert.equal(targets.commits[0]?.title, "retry");
    assert.equal(targets.guidelines, false);
});

test("the reviewer's prompt: pi-review's rubric as upstream wrote it, the target, a focus, the guidelines, the output format", () => {
    const prompt = reviewPrompt("Review the code changes introduced by commit abc.", "Never log tokens.", "error handling");

    assert.ok(prompt.startsWith(REVIEW_RUBRIC));
    assert.match(REVIEW_RUBRIC, /\[P0\] - Drop everything to fix/);
    assert.match(prompt, /Review the code changes introduced by commit abc\.\n\nAlso focus on: error handling\n\nThis project's review guidelines \(REVIEW_GUIDELINES\.md\):\n\nNever log tokens\./);
    assert.match(prompt, /never edit, commit, check out, stash, or push/);
    assert.match(prompt, /```review-result\n\{"verdict"/);
});

test("the review-result block: the last one, checked; a wrong one is none", () => {
    assert.deepEqual(parseReviewResult(answer), RESULT);
    assert.equal(parseReviewResult("no block"), undefined);
    assert.equal(parseReviewResult("```review-result\n{\"verdict\": \"fine\", \"findings\": []}\n```"), undefined);
    assert.equal(parseReviewResult("```review-result\n{not json}\n```"), undefined);
    assert.equal(parseReviewResult("```review-result\n{\"verdict\": \"correct\", \"findings\": [{\"priority\": \"P9\", \"title\": \"x\", \"body\": \"y\"}]}\n```"), undefined);
});

test("GitHub's review: Request changes with a P1, a line comment where the diff shows the line, the rest in the summary", () => {
    const shown = diffLines("diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1,3 @@\n export const a = 1;\n+export const b = 2;\n+retry();\n");

    assert.deepEqual([...shown.get("a.ts")!], [1, 2, 3]);

    const review = githubReview(parseReviewResult(answer)!, shown);

    assert.equal(review.event, "REQUEST_CHANGES");
    assert.deepEqual(review.comments.map(({ path, line, side }) => ({ path, line, side })), [{ path: "a.ts", line: 3, side: "RIGHT" }]);
    assert.match(review.comments[0]!.body, /\*\*\[P1\] Retry never gives up\*\*[\s\S]*```suggestion\nif \(status < 500\) throw error;\n```/);
    assert.match(review.body, /\*\*needs attention\*\*[\s\S]*Findings outside the diff's lines:[\s\S]*`a\.ts:40` \*\*\[P3\] Old helper\*\*[\s\S]*\*\*This change introduces a new dependency:\*\* p-retry 6\.2\.1/);
    assert.equal(githubReview({ ...RESULT, verdict: "correct", findings: [RESULT.findings[1]!] } as never, shown).event, "COMMENT");
});

test("in the app: /review pr 7 starts a read-only reviewer whose report carries the block; posting asks first and sends line comments", async () => {
    process.env.PATH = `${bin}:${process.env.PATH}`;

    const route: FauxResponseStep = (request) => {
        const messages = (request as { messages: { role: string; content: unknown }[] }).messages;
        const all = JSON.stringify(messages);
        const last = messages.at(-1)!;
        const text = typeof last.content === "string" ? last.content : JSON.stringify(last.content);

        if (/You are the subagent \\"review-pr-7\\"/.test(all)) {
            return fauxAssistantMessage([fauxText(answer)]);
        }

        if (last.role === "user" && text.includes("<review-request>")) {
            const args = JSON.parse(/exactly these arguments: (\{.*?\})\. Then/.exec(text)![1]!) as Record<string, unknown>;

            return fauxAssistantMessage([fauxToolCall("review", args as never)], { stopReason: "toolUse" });
        }

        if (last.role === "user" && text.includes("Post the review review-pr-7")) {
            return fauxAssistantMessage([fauxToolCall("review", { action: "post", name: "review-pr-7" } as never)], { stopReason: "toolUse" });
        }

        return fauxAssistantMessage([fauxText("ok")]);
    };

    app = await openApp(scriptedModel(route), join(root, "review-data"));

    const id = await newSession(app, repo);

    await app.commands.submit(id as never, owner(app), { text: "/review pr 7", requestId: crypto.randomUUID() });

    const registry = async () => (await app.harness.snapshot(SubagentsDoc, id as never, context))?.agents ?? {};

    await until(async () => (await registry())["review-pr-7"]?.answeredAt !== undefined, "the reviewer's answer", 30_000);

    const record = (await registry())["review-pr-7"]!;

    assert.equal(record.review?.label, "PR #7 · Add retry");

    const tools = (await app.harness.snapshot(AgentDoc, record.conversationId, context))?.tools;
    const reviewerTools: string[] = Array.isArray(tools) ? tools : [];
    assert.deepEqual(reviewerTools.filter((name) => ["edit", "write"].includes(name)), [], "the reviewer cannot edit or write");
    assert.ok(reviewerTools.includes("bash") && reviewerTools.includes("read"), reviewerTools.join(", "));

    await app.commands.submit(id as never, owner(app), { text: "Post the review review-pr-7 to GitHub with the review tool (action post, name review-pr-7).", requestId: crypto.randomUUID() });
    await until(() => app.approvals.forConversation(id as never).length > 0, "the card", 20_000);

    const card = app.approvals.forConversation(id as never)[0]!;

    assert.equal(card.subject, "Post this review to PR #7?");
    assert.match(card.reason ?? "", /^o\/r · as you \(gh\) · Request changes · 1 line comment and a summary with the verdict and the callouts\.$/);
    await app.answerApproval(card.id, true, owner(app));
    await until(() => {
        try {
            return readFileSync(posted, "utf8").length > 0;
        } catch {
            return false;
        }
    }, "the posted review", 20_000);

    const sent = JSON.parse(readFileSync(posted, "utf8")) as { commit_id: string; event: string; comments: { path: string; line: number }[] };

    assert.equal(sent.event, "REQUEST_CHANGES");
    assert.equal(sent.commit_id, git("rev-parse", "HEAD"));
    assert.deepEqual(sent.comments.map(({ path, line }) => ({ path, line })), [{ path: "a.ts", line: 3 }]);
});
