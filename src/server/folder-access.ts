/**
 * What Changes, diffs, and undoing a change need of a session's folder: git there, a file's size and time, removing a
 * file. On this phone, `git.ts` and `node:fs`; on a machine (`places.ts`), the same through the session's execution
 * environment, so pi-env's daemon runs git there with the same flags and environment.
 */
import { lstat, rm } from "node:fs/promises";
import { devNull } from "node:os";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { GitError, type GitOptions, git } from "./git.ts";

const context = BACKGROUND_CONTEXT;

export interface FolderAccess {
    /** Paths are this phone's: Pi's edits are canonicalized through symbolic links only here. */
    readonly local: boolean;
    /** The null device of that system, for `git diff --no-index`. */
    readonly devNull: string;
    /** Run git in `cwd` and return what it printed to stdout; a failure is a `GitError` with what git said. */
    git(cwd: string, args: string[], options?: GitOptions): Promise<string>;
    /** A file's size and modification time, without following a final link; undefined when it is not there. */
    info(path: string): Promise<{ size: number; mtimeMs: number } | undefined>;
    /** Remove a file; one already gone is fine. */
    remove(path: string): Promise<void>;
}

export const localAccess: FolderAccess = {
    local: true,
    devNull,
    git,
    async info(path) {
        try {
            const found = await lstat(path);

            return { size: found.size, mtimeMs: found.mtimeMs };
        } catch {
            return undefined;
        }
    },
    remove: (path) => rm(path, { force: true }),
};

/** As `git.ts` runs git: no file system monitor, no optional locks, literal paths, English messages. */
const GIT_ENV = { GIT_LITERAL_PATHSPECS: "1", GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" };

/** A folder on a machine, through its environment. */
export function remoteAccess(env: ExecutionEnv): FolderAccess {
    return {
        local: false,
        // The machines are POSIX (DESIGN.md: no Windows daemons are shipped).
        devNull: "/dev/null",
        async git(cwd, args, options = {}) {
            const { allowExit = [], timeoutMs = 60_000, maxBuffer = 16 * 1024 * 1024 } = options;
            let stdout = "";
            let stderr = "";
            let over = false;
            const ran = await env.exec(
                ["git", "-c", "core.fsmonitor=false", ...args],
                {
                    cwd,
                    env: GIT_ENV,
                    inheritEnv: true,
                    timeout: Math.ceil(timeoutMs / 1000),
                    onOutput: (text, _context, info) => {
                        if (info.stream === "stderr") {
                            stderr += text;
                        } else if (stdout.length + text.length > maxBuffer) {
                            over = true;
                        } else {
                            stdout += text;
                        }
                    },
                },
                context,
            );

            if (!ran.ok) {
                throw new GitError(ran.error.message, undefined);
            }

            if (over) {
                throw new GitError(`git ${args[0]} printed more than ${maxBuffer} bytes`, undefined);
            }

            const code = ran.value.exitCode;

            if (code !== 0 && !allowExit.includes(code)) {
                throw new GitError(stderr.trim() || `git ${args[0]} exited ${code}`, code);
            }

            return stdout;
        },
        async info(path) {
            const found = await env.fileInfo(path, context);

            return found.ok ? { size: found.value.size, mtimeMs: found.value.mtimeMs } : undefined;
        },
        async remove(path) {
            const removed = await env.remove(path, { force: true }, context);

            if (!removed.ok) {
                throw new Error(removed.error.message);
            }
        },
    };
}
