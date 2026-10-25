/**
 * Release notes for a build (the owner's rule of 2026-10-19: every release has them): the changes since the previous
 * release, from their commit messages, grouped as their prefixes say (`feat(scope): …` new, `fix(…): …` fixes, the rest
 * other changes), with a link to the whole comparison. The release job (.github/workflows/build-apk.yml) runs
 *
 *   node scripts/release-notes.ts <owner/repo> <commit> > notes.md
 *
 * in a full clone, after the previous release (GitHub's latest) and before this one exists. Commit messages are written
 * for people (AGENTS.md), so they are the notes. A commit that builds on someone's work credits them with a `Thanks:`
 * trailer (`Thanks: @yichan002, #3`): its line ends "(thanks @yichan002, #3)", which GitHub links.
 */
import { execFileSync } from "node:child_process";

export type Commit = { sha: string; subject: string; thanks?: string };

const GROUPS = [
    { title: "New", match: /^feat\b/ },
    { title: "Fixes", match: /^fix\b/ },
] as const;

/**
 * One line: `**scope:** what changed`, the prefix's type left out and the first letter made capital; with whom it
 * thanks, after it.
 */
function line({ subject, thanks }: Commit): string {
    const match = /^(\w+)(?:\(([^)]*)\))?!?:\s*(.*)$/.exec(subject);
    const credit = thanks === undefined || thanks.trim() === "" ? "" : ` (thanks ${thanks.trim()})`;

    if (match === null) {
        return subject + credit;
    }

    const text = match[3]!.charAt(0).toUpperCase() + match[3]!.slice(1);

    return (match[2] ? `**${match[2]}:** ${text}` : text) + credit;
}

/** The notes, in Markdown, for commits newest first (as `git log` lists them). */
export function releaseNotes(commits: readonly Commit[], options: { repo: string; sha: string; previous?: string }): string {
    const shown = commits.filter((commit) => !/^Merge /.test(commit.subject));
    const sections: string[] = [];
    const placed = new Set<Commit>();

    for (const group of GROUPS) {
        const inIt = shown.filter((commit) => group.match.test(commit.subject));

        inIt.forEach((commit) => placed.add(commit));

        if (inIt.length > 0) {
            sections.push(`## ${group.title}\n\n${inIt.map((commit) => `- ${line(commit)}`).join("\n")}`);
        }
    }

    const other = shown.filter((commit) => !placed.has(commit));

    if (other.length > 0) {
        sections.push(`## Other changes\n\n${other.map((commit) => `- ${line(commit)}`).join("\n")}`);
    }

    const since =
        options.previous === undefined
            ? `Commit ${options.sha}.`
            : `All changes since ${options.previous}: https://github.com/${options.repo}/compare/${options.previous}...${options.sha}`;

    return `${sections.length === 0 ? "No changes since the previous release." : sections.join("\n\n")}\n\n${since}\n`;
}

/** The latest release's tag, or none for the first. */
function previousRelease(repo: string): string | undefined {
    try {
        return execFileSync("gh", ["release", "view", "--repo", repo, "--json", "tagName", "--jq", ".tagName"], {
            encoding: "utf8",
        }).trim() || undefined;
    } catch {
        return undefined;
    }
}

if (import.meta.main) {
    const [repo, sha] = process.argv.slice(2);

    if (repo === undefined || sha === undefined) {
        throw new Error("usage: node scripts/release-notes.ts <owner/repo> <commit>");
    }

    const previous = previousRelease(repo);
    // Without an earlier release, the last 20 commits.
    const range = previous === undefined ? ["-20", sha] : [`${previous}..${sha}`];
    // One commit a line: its hash, its `Thanks:` trailers (joined), its subject.
    const commits = execFileSync("git", ["log", "--format=%H%x09%(trailers:key=Thanks,valueonly,separator=%x2C )%x09%s", ...range], { encoding: "utf8" })
        .split("\n")
        .filter(Boolean)
        .map((row): Commit => {
            const [hash, thanks, ...subject] = row.split("\t");

            return { sha: hash!, subject: subject.join("\t"), ...(thanks ? { thanks } : {}) };
        });

    process.stdout.write(releaseNotes(commits, { repo, sha, ...(previous === undefined ? {} : { previous }) }));
}
