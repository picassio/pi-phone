/**
 * The hook "Remind to check UI before finishing" (PP-422, Settings › Hooks): when Pi ends a turn having changed UI files
 * after its last look at them, it gets one follow-up that names them and asks it to check them, or say why not. The
 * prompt and the ui-verify skill only ask; this is the app asking at the moment Pi would stop.
 *
 * Read from the turn's own transcript (as Changes reads Pi's edits, `changes.ts`), so nothing new is stored:
 * - UI edits: `write` and `edit` of .html, .htm, .css, .svg, .jsx, .tsx, .vue, .svelte files and of .js files under a
 *   `web/` folder, and, with the artifact check off (`artifactCheck`), artifact publishes; calls a codemode script made
 *   count too;
 * - UI checks: `screenshot`, `redline`, `browser_screenshot`, `browser_redline`, `browser_layout_check`,
 *   `image_compare`.
 * A call whose result is an error did neither. The turn starts at the newest message from a person (or a session, a
 * schedule): the app's own follow-ups (this reminder, a goal's check) do not start one.
 *
 * Throwaway files are not UI anyone looks at (PP-446): edits under the place's temp folders (`/tmp`, `~/tmp`, and on the
 * phone `$TMPDIR` and `os.tmpdir()`; `PocketHost.tempFolders`) or under a fixtures folder at any depth do not count.
 */
import { tmpdir } from "node:os";
import { posix } from "node:path";
import { GOAL_PREFIX } from "./goals.ts";
import type { ClientEntry } from "./projection.ts";

/** How the reminder starts: shown in the transcript as sent by the hook (`web/transcript.js`). */
export const REMINDER_VIA = "hook ui-reminder";
export const REMINDER_PREFIX = `[via ${REMINDER_VIA}] `;
/** The app's follow-ups inside a run: they do not start a turn of their own. */
const APP_FOLLOW_UPS = [REMINDER_PREFIX, GOAL_PREFIX];

export const UI_CHECKS: ReadonlySet<string> = new Set(["screenshot", "redline", "browser_screenshot", "browser_redline", "browser_layout_check", "image_compare"]);
const EDITORS: ReadonlySet<string> = new Set(["write", "edit"]);
const CODEMODE = "codemode";

/** A file whose change shows on a screen: markup, styles, pictures drawn in code, components, and a web folder's scripts. */
export function isUiFile(path: string): boolean {
    const plain = path.replaceAll("\\", "/");

    return /\.(html?|css|svg|jsx|tsx|vue|svelte)$/i.test(plain) || /(^|\/)web\/(.+\/)?[^/]+\.m?js$/i.test(plain);
}

/** Folders of test fixtures, at any depth: files made for tests to load, not for anyone to look at (PP-446). */
const FIXTURE_FOLDERS: ReadonlySet<string> = new Set(["fixtures", "__fixtures__", "test-fixtures"]);

const forwardSlashes = (path: string): string => posix.normalize(path.replaceAll("\\", "/"));

/**
 * A throwaway file (PP-446): under one of `temps` (the place's temp folders), or under a folder named fixtures,
 * __fixtures__ or test-fixtures. `path` is absolute, as the session's place resolves it.
 */
export function isThrowaway(path: string, temps: readonly string[]): boolean {
    const plain = forwardSlashes(path);

    return (
        plain
            .split("/")
            .slice(0, -1)
            .some((folder) => FIXTURE_FOLDERS.has(folder)) ||
        temps.some((temp) => {
            const root = forwardSlashes(temp).replace(/\/+$/, "");

            return root !== "" && plain.startsWith(`${root}/`);
        })
    );
}

/** The phone's temp folders (PP-446): `/tmp`, `~/tmp`, `$TMPDIR` and `os.tmpdir()`. */
export function phoneTempFolders(home: string): string[] {
    const env = process.env.TMPDIR;

    return [...new Set(["/tmp", posix.join(forwardSlashes(home), "tmp"), ...(env === undefined || env === "" ? [] : [env]), tmpdir()])];
}

/** A machine's temp folders (PP-446): `/tmp` and `~/tmp` there. */
export const machineTempFolders = (home: string): string[] => ["/tmp", posix.join(forwardSlashes(home), "tmp")];

/** A tool call in the turn, in the order Pi made it: what it did to the UI, if anything. */
type Step = { kind: "edit"; what: string } | { kind: "check" };

/** The `path` of a codemode call's arguments: compact JSON, maybe cut for display; the path comes first. */
function nestedArgs(args: unknown): Record<string, unknown> {
    if (typeof args !== "string") {
        return typeof args === "object" && args !== null ? (args as Record<string, unknown>) : {};
    }

    try {
        return JSON.parse(args) as Record<string, unknown>;
    } catch {
        const path = /^\{"path":"((?:[^"\\]|\\.)*)"/.exec(args);
        const id = /^\{"id":"((?:[^"\\]|\\.)*)"/.exec(args);

        return path !== null ? { path: JSON.parse(`"${path[1]}"`) as string } : id !== null ? { id: JSON.parse(`"${id[1]}"`) as string } : {};
    }
}

function stepOf(name: string, args: Record<string, unknown>, artifactsUnchecked: boolean, skip: (path: string) => boolean): Step | undefined {
    if (UI_CHECKS.has(name)) {
        return { kind: "check" };
    }

    if (EDITORS.has(name) && typeof args.path === "string" && isUiFile(args.path) && !skip(args.path)) {
        return { kind: "edit", what: args.path };
    }

    if (name === "artifact" && artifactsUnchecked && typeof args.id === "string") {
        return { kind: "edit", what: `artifact ${args.id}` };
    }

    return undefined;
}

/** Whether a person's message (or a session's, a schedule's) starts the turn, rather than one of the app's follow-ups. */
export const startsTurn = (entry: ClientEntry): boolean => entry.kind === "user" && !APP_FOLLOW_UPS.some((prefix) => entry.text.startsWith(prefix));

/**
 * The UI files the turn changed after its last check, in the order first changed; empty when there are none. `entries`
 * are the turn's, oldest first (from the message that started it). `skip`: edited paths, as Pi wrote them, that do not
 * count (throwaway files, `isThrowaway`).
 */
export function uncheckedUi(entries: readonly ClientEntry[], artifactsUnchecked: boolean, skip: (path: string) => boolean = () => false): string[] {
    // Once a turn: a turn that got its reminder gets no other, whatever Pi does after it.
    if (entries.some((entry) => entry.kind === "user" && entry.text.startsWith(REMINDER_PREFIX))) {
        return [];
    }

    const failed = new Set(entries.flatMap((entry) => (entry.kind === "toolResult" && entry.isError ? [entry.callId] : [])));
    const steps: Step[] = [];

    for (const entry of entries) {
        if (entry.kind === "assistant") {
            for (const block of entry.blocks) {
                if (block.type === "toolCall" && block.name !== CODEMODE && !failed.has(block.id)) {
                    const step = stepOf(block.name, block.args, artifactsUnchecked, skip);

                    if (step !== undefined) {
                        steps.push(step);
                    }
                }
            }
        } else if (entry.kind === "toolResult" && entry.name === CODEMODE) {
            const calls = (entry.details as { calls?: unknown } | undefined)?.calls;

            for (const call of Array.isArray(calls) ? (calls as { name?: unknown; status?: unknown; args?: unknown }[]) : []) {
                if (typeof call.name === "string" && call.status === "ok") {
                    const step = stepOf(call.name, nestedArgs(call.args), artifactsUnchecked, skip);

                    if (step !== undefined) {
                        steps.push(step);
                    }
                }
            }
        }
    }

    const lastCheck = steps.findLastIndex((step) => step.kind === "check");

    return [...new Set(steps.slice(lastCheck + 1).flatMap((step) => (step.kind === "edit" ? [step.what] : [])))];
}

/** The follow-up Pi gets: the files, and what to do. */
export function reminderText(files: readonly string[]): string {
    const shown = files.length > 12 ? [...files.slice(0, 12), `and ${files.length - 12} more`] : files;

    return `${REMINDER_PREFIX}You changed UI after your last look at it: ${shown.join(", ")}. Check it with screenshot at 390, 1280 and 1920 px (the ui-verify skill: the live app or the page, every state the change touches) and fix what the layout check finds, or say why you do not. This reminder comes once a turn; the owner turns it off in Settings › Hooks.`;
}
