/**
 * Review's comments and checkpoints (PP-358, the owner's mockup of 2026-11-02, after earendil-works/pi-review-loop):
 * a person comments on a diff's lines (new or old side) or on a whole file; Send review puts the comments in the message
 * box as feedback for Pi (not sent) and checkpoints the folder, so "Since last review" shows only what changed after.
 *
 * A checkpoint is a git commit of the whole working folder (untracked files too, ignored ones not), written with a
 * temporary index (`git add -A` into it, `write-tree`, `commit-tree` on HEAD) and kept by a ref of its own
 * (`refs/pi-phone/review/<sha>`), so nothing the person works with (index, stash, branches) changes. "Since last review"
 * diffs it against a snapshot tree made the same way; before the first checkpoint, against HEAD. Git runs where the
 * session works (the phone or a machine). The checkpoint and the unsent comments are kept in `ReviewLoopDoc`, with the
 * session (a fork takes them along).
 */
import { randomUUID } from "node:crypto";
import type { ChangeKind } from "./changes.ts";
import { quote } from "./review.ts";

export type ReviewComment = {
    id: string;
    path: string;
    /** "new": a line of the version now; "old": one of what it is compared with; "file": the whole file. */
    side: "new" | "old" | "file";
    line?: number;
    /** What the old side was: the last review ("since") or the last commit ("head"). */
    mode: "since" | "head";
    body: string;
    at: number;
};

export type ReviewLoopState = { checkpoint?: { sha: string; at: number }; comments: ReviewComment[] };

type Run = (command: string) => Promise<{ code: number; stdout: string; stderr: string }>;

const SHA = /^[0-9a-f]{40}$/;
/** At the repository's top, with a temporary index of its own: what `git add -A` would commit, as a tree. */
const SNAPSHOT =
    'cd "$(git rev-parse --show-toplevel)" && i="$(mktemp)" && rm -f "$i" && { GIT_INDEX_FILE="$i" git read-tree HEAD && GIT_INDEX_FILE="$i" git add -A && GIT_INDEX_FILE="$i" git write-tree; }; s=$?; rm -f "$i"; exit $s';

async function must(run: Run, command: string, what: string): Promise<string> {
    const result = await run(command);

    if (result.code !== 0) {
        throw new Error(`${what}: ${(result.stderr.trim() || result.stdout.trim()).split("\n").slice(-2).join(" ")}`);
    }

    return result.stdout.trim();
}

/** The working folder as a tree (untracked files too, ignored ones not); nothing it works with changes. */
export async function snapshotTree(run: Run): Promise<string> {
    const tree = await must(run, SNAPSHOT, "git could not read the folder");

    if (!SHA.test(tree)) {
        throw new Error(`git wrote no tree: ${tree.slice(0, 80)}`);
    }

    return tree;
}

/** A checkpoint of the working folder: a commit on HEAD, kept by `refs/pi-phone/review/<sha>`. */
export async function makeCheckpoint(run: Run): Promise<string> {
    const tree = await snapshotTree(run);
    const sha = await must(run, `git commit-tree ${tree} -p HEAD -m 'pi-phone review checkpoint'`, "git could not write the checkpoint");

    await must(run, `git update-ref ${quote(`refs/pi-phone/review/${sha}`)} ${sha}`, "git could not keep the checkpoint");

    return sha;
}

const KINDS: Record<string, ChangeKind> = { M: "modified", A: "added", D: "deleted", R: "renamed", T: "modified", C: "added" };

/**
 * What changed from `base` (a checkpoint, or HEAD) to the folder now (`current`, a snapshot tree): each file's path,
 * kind, counts, and its blob as its version.
 */
export async function changedSince(run: Run, base: string, current: string) {
    if (base !== "HEAD" && !SHA.test(base)) {
        throw new Error("Not a checkpoint.");
    }

    const raw = await must(run, `git diff --raw -M --no-abbrev ${base} ${current}`, "git diff failed");
    const counts = await must(run, `git diff --numstat -M ${base} ${current}`, "git diff failed");
    const numbers = new Map<string, { added?: number; removed?: number }>();

    for (const line of counts.split("\n").filter(Boolean)) {
        const [added, removed, ...rest] = line.split("\t");
        const path = rest.at(-1)!.replace(/^.*=> /, "").replace(/[{}]/g, "");

        numbers.set(path, added === "-" ? {} : { added: Number(added), removed: Number(removed) });
    }

    return raw
        .split("\n")
        .filter((line) => line.startsWith(":"))
        .map((line) => {
            const [info, ...paths] = line.split("\t");
            const parts = info!.split(" ");
            const status = parts[4]!.charAt(0);
            const path = paths.at(-1)!;
            const blob = parts[3]!;

            return {
                path,
                kind: KINDS[status] ?? "modified",
                ...numbers.get(path),
                byPi: false,
                ...(status === "D" ? {} : { version: blob }),
            };
        });
}

/** One file's diff from `base` to the snapshot `current`, with three lines around each change (as Review's are). */
export async function diffSince(run: Run, base: string, current: string, path: string): Promise<string> {
    if ((base !== "HEAD" && !SHA.test(base)) || !SHA.test(current)) {
        throw new Error("Not a checkpoint.");
    }

    return must(run, `git diff -M -U3 ${base} ${current} -- ${quote(path)}`, "git diff failed");
}

/** Where a comment is, as the feedback says it: "a.ts:88 (current)", "a.ts:12 (reviewed)", "a.ts:12 (HEAD)", "a.ts". */
export function commentPlace(comment: ReviewComment): string {
    if (comment.side === "file" || comment.line === undefined) {
        return comment.path;
    }

    return `${comment.path}:${comment.line} (${comment.side === "new" ? "current" : comment.mode === "head" ? "HEAD" : "reviewed"})`;
}

/** The comments as feedback for Pi, in pi-review-loop's words; empty with none. */
export function composeFeedback(comments: readonly ReviewComment[]): string {
    const kept = comments.filter((each) => each.body.trim() !== "");

    if (kept.length === 0) {
        return "";
    }

    return [
        "Please address the following review feedback:",
        "",
        ...kept.flatMap((each, index) => [`${index + 1}. ${commentPlace(each)}`, `   ${each.body.trim().replace(/\n/g, "\n   ")}`, ""]),
    ]
        .join("\n")
        .trim();
}

/** A new comment from what a browser sent, checked: undefined when it lacks a path, a side, a line for a line's, or words. */
export function newComment(body: unknown): ReviewComment | undefined {
    const sent = (body ?? {}) as Record<string, unknown>;
    const side = sent.side;
    const mode = sent.mode;

    if (
        typeof sent.path !== "string" ||
        sent.path === "" ||
        sent.path.includes("\0") ||
        (side !== "new" && side !== "old" && side !== "file") ||
        (side !== "file" && !(typeof sent.line === "number" && Number.isInteger(sent.line) && sent.line > 0)) ||
        typeof sent.body !== "string" ||
        sent.body.trim() === ""
    ) {
        return undefined;
    }

    return {
        id: randomUUID(),
        path: sent.path,
        side,
        ...(side === "file" ? {} : { line: sent.line as number }),
        mode: mode === "head" ? "head" : "since",
        body: sent.body.trim().slice(0, 4000),
        at: Date.now(),
    };
}
