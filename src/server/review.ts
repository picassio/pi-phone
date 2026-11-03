/**
 * Code review by a subagent (PP-357, the owner's mockup of 2026-11-02 after research PP-309): what to review (the
 * session folder's uncommitted changes, its branch against a base, a commit, a GitHub pull request, or folders as they
 * are), the prompt (pi-review's rubric, `third_party/pi-review/REVIEW_RUBRIC.md`, MIT, Earendil Inc.; then the target,
 * the project's REVIEW_GUIDELINES.md, a focus, and pi-phone's output format with its `review-result` block), the result
 * read back from the subagent's answer, and the review GitHub gets when the person posts it.
 *
 * Git and gh run where the session works (the phone, or a machine), through `run`. A pull request is never checked
 * out: its head is fetched (`pull/<n>/head`) and read with `git diff` and `git show`, so the session's files stay.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { APP_ROOT } from "./config.ts";

export type ReviewTarget =
    | { kind: "changes" }
    /** `exact`: against this branch as it is here, not its upstream (a task's run against where it started, PP-359). */
    | { kind: "branch"; base: string; exact?: boolean }
    | { kind: "commit"; sha: string }
    | { kind: "pr"; pr: string }
    | { kind: "folders"; paths: string[] };

/** What a review was of, kept with its subagent: the card's title, and what posting it to GitHub needs. */
export type ReviewMeta = {
    kind: ReviewTarget["kind"];
    label: string;
    files?: number;
    pr?: { repo: string; number: number; title: string; url: string; headSha: string; mergeBase: string };
};

export type ReviewFinding = { priority: "P0" | "P1" | "P2" | "P3"; title: string; file?: string; line?: number; body: string; suggestion?: string };
export type ReviewResult = { verdict: "correct" | "needs attention"; findings: ReviewFinding[]; callouts: { label: string; text: string }[] };

/** The words the command takes for each target. */
const KINDS: Record<string, ReviewTarget["kind"]> = {
    changes: "changes",
    uncommitted: "changes",
    branch: "branch",
    commit: "commit",
    pr: "pr",
    folder: "folders",
    folders: "folders",
};

/** A GitHub pull request's link. */
const PR_LINK = /^https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/\d+\S*$/;

/** A command line's words: spaces split them, and "double" or 'single' quotes keep spaces in one. */
function words(text: string): string[] {
    return [...text.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((match) => match[1] ?? match[2] ?? match[3]!);
}

/**
 * `/review`'s arguments: a target and its value (`pr 142`, `pr https://github.com/o/r/pull/142`, `branch master`,
 * `commit abc123`, `folder src web`, `changes`), then `--extra` and a focus (quoted, or the rest of the line).
 * Nothing at all is the uncommitted changes.
 */
export function parseReviewArgs(text: string): { target: ReviewTarget; extra?: string } | { error: string } {
    const at = text.search(/(^|\s)--extra(\s|$)/);
    const head = at === -1 ? text : text.slice(0, at);
    const tail = at === -1 ? "" : text.slice(at).replace(/^\s*--extra\s*/, "");
    const extraWords = words(tail);
    const extra = extraWords.join(" ").trim();
    const [first, ...others] = words(head);
    // A pull request's link alone is its review: `/review https://github.com/o/r/pull/11`.
    const linkAlone = first !== undefined && PR_LINK.test(first);
    const word = linkAlone ? "pr" : first;
    const rest = linkAlone ? [first!, ...others] : others;
    const kind = word === undefined ? "changes" : KINDS[word.toLowerCase()];
    const withExtra = (target: ReviewTarget) => (extra === "" ? { target } : { target, extra });

    if (kind === undefined) {
        return { error: `Unknown review target "${word}": use changes, branch <base>, commit <sha>, pr <number or link>, or folder <paths>.` };
    }

    // `changes` takes nothing after it: a link or a word there was meant for another target, never dropped (the
    // owner's `/review changes <a pull request's link>` reviewed this folder's changes instead, 2026-11-02).
    if (kind === "changes" && rest.length > 0) {
        return { error: `changes takes nothing after it; for a pull request use pr ${rest[0]}.` };
    }

    if (kind === "changes") {
        return withExtra({ kind });
    }

    if (rest.length === 0) {
        return { error: `${word} needs ${kind === "branch" ? "a base branch" : kind === "commit" ? "a commit" : kind === "pr" ? "a pull request's number or link" : "one or more paths"}.` };
    }

    if (kind === "folders") {
        return withExtra({ kind, paths: rest });
    }

    if (rest.length > 1) {
        return { error: `${word} takes one value; a focus goes after --extra.` };
    }

    const value = rest[0]!;

    if (kind === "pr" && !/^#?\d+$/.test(value) && !PR_LINK.test(value)) {
        return { error: `pr takes a pull request's number or its github.com link, not "${value}".` };
    }

    return withExtra(kind === "branch" ? { kind, base: value } : kind === "commit" ? { kind, sha: value } : { kind, pr: value.replace(/^#/, "") });
}

/**
 * `/review …` as Pi gets it: the command as typed (what the transcript shows), then what to do, in a
 * `<review-request>` the transcript hides. Undefined when the text is not one; an error when its target is not right.
 */
export function expandReviewCommand(text: string): string | { error: string } | undefined {
    const match = /^\/review(?:\s+([\s\S]*))?$/.exec(text);

    if (match === null) {
        return undefined;
    }

    const parsed = parseReviewArgs((match[1] ?? "").trim());

    if ("error" in parsed) {
        return parsed;
    }

    const { target, extra } = parsed;
    const args = {
        action: "start",
        target: target.kind,
        ...(target.kind === "branch" ? { ref: target.base } : target.kind === "commit" ? { ref: target.sha } : target.kind === "pr" ? { ref: target.pr } : {}),
        ...(target.kind === "folders" ? { paths: target.paths } : {}),
        ...(extra === undefined ? {} : { extra }),
    };

    return `${text}\n\n<review-request>\nStart this code review now with the review tool, with exactly these arguments: ${JSON.stringify(args)}. Then say in one line that it started.\n</review-request>`;
}

/** `value` as one word for sh. */
export const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

type Run = (command: string) => Promise<{ code: number; stdout: string; stderr: string }>;

/** What a failed command said, for the person: its error, else its output. */
const said = (result: { stdout: string; stderr: string }) => (result.stderr.trim() || result.stdout.trim()).split("\n").slice(-3).join(" ");

async function must(run: Run, command: string, what: string): Promise<string> {
    const result = await run(command);

    if (result.code !== 0) {
        throw new Error(`${what}: ${said(result)}`);
    }

    return result.stdout.trim();
}

/** The number of files `command` names, one a line. */
async function countFiles(run: Run, command: string, what: string): Promise<number> {
    return (await must(run, command, what)).split("\n").filter((line) => line.trim() !== "").length;
}

/**
 * Look the target up where the session works: what it is (the card's label, how many files), and the instructions for
 * the reviewer. Fails with the reason when there is nothing to review, git or gh says no, or a path is not there.
 */
export async function prepareReview(run: Run, target: ReviewTarget): Promise<{ meta: ReviewMeta; instructions: string }> {
    await must(run, "git rev-parse --show-toplevel", "Not a git repository here");

    if (target.kind === "changes") {
        const files = await countFiles(run, "git status --porcelain", "git status failed");

        if (files === 0) {
            throw new Error("There are no uncommitted changes to review.");
        }

        return {
            meta: { kind: "changes", label: "uncommitted changes", files },
            instructions:
                "Review the current code changes (staged, unstaged, and untracked files) and provide prioritized findings. See them with `git status`, `git diff HEAD`, and read the untracked files.",
        };
    }

    if (target.kind === "branch") {
        const base = target.base;
        const upstream = target.exact === true ? undefined : await run(`git rev-parse --abbrev-ref ${quote(`${base}@{upstream}`)}`);
        const against = upstream !== undefined && upstream.code === 0 && upstream.stdout.trim() !== "" ? upstream.stdout.trim() : base;
        const mergeBase = await must(run, `git merge-base HEAD ${quote(against)}`, `No merge base with ${against}`);
        const files = await countFiles(run, `git diff --name-only ${quote(mergeBase)}`, "git diff failed");

        return {
            meta: { kind: "branch", label: `changes against ${base}`, files },
            instructions: `Review the code changes against the base branch '${base}'. The merge base commit for this comparison is ${mergeBase}. Run \`git diff ${mergeBase}\` to inspect the changes relative to ${base}. Provide prioritized, actionable findings.`,
        };
    }

    if (target.kind === "commit") {
        const sha = await must(run, `git rev-parse --verify ${quote(`${target.sha}^{commit}`)}`, `No commit ${target.sha}`);
        const title = await must(run, `git log -1 --format=%s ${quote(sha)}`, "git log failed");
        const files = await countFiles(run, `git show --name-only --format= ${quote(sha)}`, "git show failed");

        return {
            meta: { kind: "commit", label: `commit ${sha.slice(0, 7)} · ${title}`, files },
            instructions: `Review the code changes introduced by commit ${sha} ("${title}"). See them with \`git show ${sha}\`. Provide prioritized, actionable findings.`,
        };
    }

    if (target.kind === "pr") {
        const view = await must(run, `gh pr view ${quote(target.pr)} --json number,title,baseRefName,headRefOid,url,changedFiles`, "gh could not read the pull request (is gh signed in where this session works?)");
        const pr = JSON.parse(view) as { number: number; title: string; baseRefName: string; headRefOid: string; url: string; changedFiles: number };
        const repo = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\//.exec(pr.url)?.[1];

        if (repo === undefined) {
            throw new Error(`Not a github.com pull request: ${pr.url}`);
        }

        // Its head and base, fetched so git can diff them; nothing is checked out.
        await must(run, `git fetch -q origin ${quote(`pull/${pr.number}/head`)} ${quote(pr.baseRefName)}`, "git fetch of the pull request failed");
        const mergeBase = await must(run, `git merge-base ${quote(`origin/${pr.baseRefName}`)} ${quote(pr.headRefOid)}`, `No merge base with origin/${pr.baseRefName}`);

        return {
            meta: {
                kind: "pr",
                label: `PR #${pr.number} · ${pr.title}`,
                files: pr.changedFiles,
                pr: { repo, number: pr.number, title: pr.title, url: pr.url, headSha: pr.headRefOid, mergeBase },
            },
            instructions: `Review pull request #${pr.number} ("${pr.title}", ${pr.url}) against the base branch '${pr.baseRefName}'. The merge base commit is ${mergeBase} and the pull request's head is ${pr.headRefOid}. Run \`git diff ${mergeBase} ${pr.headRefOid}\` to inspect the changes that would be merged. The pull request is not checked out: read its files with \`git show ${pr.headRefOid}:<path>\`, never from the working folder, which holds another branch. Provide prioritized, actionable findings.`,
        };
    }

    for (const path of target.paths) {
        await must(run, `test -e ${quote(path)}`, `${path} is not there`);
    }

    return {
        meta: { kind: "folders", label: target.paths.join(", ") },
        instructions: `Review the code in the following paths: ${target.paths.join(", ")}. This is a snapshot review (not a diff). Read the files directly in these paths and provide prioritized, actionable findings.`,
    };
}

/**
 * What `/review`'s sheet offers: the repository's open pull requests (or why gh could not list them), its last commits,
 * and whether it has review guidelines.
 */
export async function reviewTargets(run: Run): Promise<{
    prs: { number: number; title: string; head: string; base: string; files: number }[];
    prsError?: string;
    commits: { sha: string; title: string }[];
    guidelines: boolean;
}> {
    await must(run, "git rev-parse --show-toplevel", "Not a git repository here");

    const listed = await run("gh pr list --state open --limit 30 --json number,title,headRefName,baseRefName,changedFiles");
    const log = await must(run, "git log -15 --format=%h%x09%s", "git log failed");
    const prs =
        listed.code === 0
            ? (JSON.parse(listed.stdout) as { number: number; title: string; headRefName: string; baseRefName: string; changedFiles: number }[]).map((pr) => ({
                  number: pr.number,
                  title: pr.title,
                  head: pr.headRefName,
                  base: pr.baseRefName,
                  files: pr.changedFiles,
              }))
            : [];

    return {
        prs,
        ...(listed.code === 0 ? {} : { prsError: said(listed) }),
        commits: log
            .split("\n")
            .filter((line) => line.includes("\t"))
            .map((line) => ({ sha: line.slice(0, line.indexOf("\t")), title: line.slice(line.indexOf("\t") + 1) })),
        guidelines: (await reviewGuidelines(run)) !== undefined,
    };
}

/** The project's REVIEW_GUIDELINES.md (at the repository's top), or undefined when it has none. */
export async function reviewGuidelines(run: Run): Promise<string | undefined> {
    const result = await run('cat "$(git rev-parse --show-toplevel)/REVIEW_GUIDELINES.md"');
    const text = result.code === 0 ? result.stdout.trim() : "";

    return text === "" ? undefined : text;
}

/** pi-review's rubric, as upstream wrote it. */
export const REVIEW_RUBRIC = readFileSync(join(APP_ROOT, "third_party", "pi-review", "REVIEW_RUBRIC.md"), "utf8").trim();

/** How the reviewer ends its answer, so the app can draw the findings as a card. */
const OUTPUT = `## In pi-phone

You review on your own, and read only: inspect with git and read files; never edit, commit, check out, stash, or push.
A finding names the file (its path from the repository's top) and the line in the new version, where the diff has it.

End your answer with your findings as written above, then this block, exactly once, as the very last thing:

\`\`\`review-result
{"verdict": "correct", "findings": [{"priority": "P1", "title": "Short title", "file": "src/a.ts", "line": 88, "body": "One paragraph: what is wrong, when, and why it matters.", "suggestion": "replacement code, only when you have it"}], "callouts": [{"label": "This change introduces a new dependency", "text": "p-retry 6.2.1"}]}
\`\`\`

verdict is "correct" or "needs attention"; priority is P0, P1, P2 or P3; file, line and suggestion may be left out;
findings and callouts may be empty lists. The block is JSON: no comments, no trailing commas.`;

/** The subagent's whole message: the rubric, the target, the project's guidelines, a focus, and the output format. */
export function reviewPrompt(instructions: string, guidelines: string | undefined, extra: string | undefined): string {
    return [
        REVIEW_RUBRIC,
        "---",
        `Please perform a code review with the following focus:\n\n${instructions}`,
        ...(extra === undefined ? [] : [`Also focus on: ${extra}`]),
        ...(guidelines === undefined ? [] : [`This project's review guidelines (REVIEW_GUIDELINES.md):\n\n${guidelines}`]),
        OUTPUT,
    ].join("\n\n");
}

const PRIORITIES = new Set(["P0", "P1", "P2", "P3"]);

/** The `review-result` block at the end of a reviewer's answer, checked; undefined when there is none or it is not right. */
export function parseReviewResult(text: string): ReviewResult | undefined {
    const blocks = [...text.matchAll(/```review-result\s*\n([\s\S]*?)\n```/g)];
    const last = blocks.at(-1)?.[1];

    if (last === undefined) {
        return undefined;
    }

    let value: unknown;

    try {
        value = JSON.parse(last);
    } catch {
        return undefined;
    }

    const result = value as { verdict?: unknown; findings?: unknown; callouts?: unknown };

    if ((result.verdict !== "correct" && result.verdict !== "needs attention") || !Array.isArray(result.findings) || !Array.isArray(result.callouts ?? [])) {
        return undefined;
    }

    const findings: ReviewFinding[] = [];

    for (const each of result.findings as Record<string, unknown>[]) {
        if (typeof each !== "object" || each === null || !PRIORITIES.has(each.priority as string) || typeof each.title !== "string" || typeof each.body !== "string") {
            return undefined;
        }

        findings.push({
            priority: each.priority as ReviewFinding["priority"],
            title: each.title,
            body: each.body,
            ...(typeof each.file === "string" && each.file !== "" ? { file: each.file } : {}),
            ...(typeof each.line === "number" && Number.isInteger(each.line) && each.line > 0 ? { line: each.line } : {}),
            ...(typeof each.suggestion === "string" && each.suggestion.trim() !== "" ? { suggestion: each.suggestion } : {}),
        });
    }

    const callouts = ((result.callouts ?? []) as Record<string, unknown>[]).filter(
        (each): each is { label: string; text: string } => typeof each?.label === "string" && typeof each.text === "string",
    );

    return { verdict: result.verdict, findings, callouts };
}

/** The lines of the new side each file's diff shows (`git diff` with its context): those GitHub takes comments on. */
export function diffLines(diff: string): Map<string, Set<number>> {
    const lines = new Map<string, Set<number>>();
    let file: string | undefined;
    let next = 0;
    let left = 0;

    for (const line of diff.split("\n")) {
        const named = /^\+\+\+ b\/(.*)$/.exec(line);

        if (named) {
            file = named[1]!;
            lines.set(file, new Set());
            continue;
        }

        const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);

        if (hunk) {
            next = Number(hunk[1]);
            left = hunk[2] === undefined ? 1 : Number(hunk[2]);
            continue;
        }

        if (file === undefined || left <= 0 || line.startsWith("-") || line.startsWith("\\")) {
            continue;
        }

        if (line.startsWith("+") || line.startsWith(" ")) {
            lines.get(file)!.add(next);
            next += 1;
            left -= 1;
        }
    }

    return lines;
}

const finding = (each: ReviewFinding) =>
    `**[${each.priority}] ${each.title}**\n\n${each.body}${each.suggestion === undefined ? "" : `\n\n\`\`\`suggestion\n${each.suggestion}\n\`\`\``}`;

/**
 * The review GitHub gets: "Request changes" with a P0 or P1 finding, else "Comment" (never "Approve"); a comment on
 * each finding's line where the diff shows it, and the others, the verdict and the callouts in its summary.
 */
export function githubReview(result: ReviewResult, shown: Map<string, Set<number>>) {
    const inDiff = (each: ReviewFinding) => each.file !== undefined && each.line !== undefined && shown.get(each.file)?.has(each.line) === true;
    const comments = result.findings.filter(inDiff).map((each) => ({ path: each.file!, line: each.line!, side: "RIGHT", body: finding(each) }));
    const others = result.findings.filter((each) => !inDiff(each));
    const body = [
        `Review by Pi (pi-phone): **${result.verdict}**.`,
        ...(others.length === 0
            ? []
            : ["Findings outside the diff's lines:", ...others.map((each) => `${each.file === undefined ? "" : `\`${each.file}${each.line === undefined ? "" : `:${each.line}`}\` `}${finding(each)}`)]),
        ...(result.callouts.length === 0 ? [] : ["For a person to check:", ...result.callouts.map((each) => `- **${each.label}:** ${each.text}`)]),
    ].join("\n\n");

    return {
        event: result.findings.some((each) => each.priority === "P0" || each.priority === "P1") ? "REQUEST_CHANGES" : "COMMENT",
        body,
        comments,
    };
}
