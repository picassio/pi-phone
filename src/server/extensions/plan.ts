/**
 * Plan mode lets Pi read and explore but change nothing, so it proposes a plan for people to approve first. While a
 * session is in plan mode, Pi may read files, run read-only shell commands, publish artifacts, use its browser fully
 * (PP-70: a site is not the work), run codemode scripts (whose calls get the same checks), and call tools their extension marks read-only;
 * everything else is blocked with a note saying why. This keeps Pi to planning; it is not a security boundary: Lancet
 * Guard is. Programs that people configured to run on their own, such as a git diff driver or file system monitor, run
 * as they would for anyone.
 */
import type { ToolAnnotations } from "@earendil-works/pi-coding-agent";
import {
    defineExtension,
    hook,
    section,
    type ToolExecutionApi,
    ToolTask,
} from "@earendil-works/pi-durable";
import { PlanDoc } from "../docs.ts";
import type { PocketHost } from "../host.ts";
import { BUILT_IN_TOOLS } from "../reload.ts";

/** While plan mode is off: when to suggest it (only a person turns it on). */
export const SUGGEST_PLAN = `Plan mode: before a large or risky change (many files, a migration or refactor, deleting data, rewriting history, publishing or deploying), suggest that the person turn on plan mode with the Plan button by the message box, and wait for their answer. You cannot turn it on yourself. Small, clear tasks need no plan mode.`;
const PLANNING = `Plan mode is on. Read and explore, then propose a plan; change nothing yet. You can use read, artifact, screenshot, and bash for simple read-only commands such as ls, cat, grep, find, and git status/log/diff/show, without redirects, globs, variables, or command substitution, and tools marked read-only. Pi's browser works in full (open, click, type, choose, scroll, run): use it to look at the live app or any site; still ask before anything that pays, sends, books, or deletes there. The wiki tools work too: record decisions, findings and open questions as you plan. Writing, editing, other commands, and subagents are blocked until a person approves the plan. End your answer with the plan as a short numbered list. For a long plan (many steps, parts, or files), also publish it as an HTML artifact, following the html-plan skill (read its SKILL.md first): it keeps every commitment and is easier to review on a phone; the numbered list stays in your answer.`;

/** Tools that change nothing, or whose own calls are checked one by one (codemode). */
/**
 * Tools that change nothing in the work: reading files, reading and writing the wiki (knowledge about the work), showing
 * artifacts, scripts (whose calls are each checked), the secrets Pi may use, and asking a person for one (the person's
 * answer, not Pi's change).
 */
const ALWAYS_ALLOWED = new Set([
    "read",
    "artifact",
    "codemode",
    "wiki_query",
    "wiki_read",
    "wiki_summarize",
    // Recording what planning found and decided (PP-27; the owner, 2026-10-20: "plan mode still need wiki tools"): the
    // wiki is knowledge about the work, not the work. Its batch schema migration is not here.
    "wiki_write",
    "wiki_edit",
    "wiki_ingest",
    "wiki_move",
    "wiki_lint",
    "secrets_list",
    "secret_request",
    "interview",
    "web_search",
    "fetch_content",
    "openui_guide",
    // Only reads: the devices signed in.
    "devices",
    // Only reads: the app's settings and their values.
    "settings",
    // Only looks: a picture of a page.
    "screenshot",
    // Only read (PP-36; the owner, 2026-10-21: "plan mode should be able to use all readonly tools"): boards, sessions,
    // and Pi's terminal sessions.
    "project_list",
    "task_list",
    "task_get",
    "task_diff",
    "sessions",
    "session_read",
    "session_wait",
    "pi_sessions",
    // A shared board's project wiki (PP-42), read.
    "project_wiki_search",
    "project_wiki_read",
    // The team server's people, roles and audit log (PP-45), read.
    "team_people",
    "team_roles",
    "team_audit",
    // The team's provider accounts (PP-69), read.
    "team_providers",
    // The team's machines (PP-82), read.
    "team_machines",
    // Folder groups in the session list (PP-76), read.
    "session_groups",
    // People's documents (PP-48), read.
    "doc_search",
    "doc_list",
    "doc_read",
    "doc_history",
    // Shared sessions (PP-60), read.
    "sessions_shared",
]);
/** Tools that only read when asked to list (their other actions change things). */
const LISTS = new Set(["approvals", "schedule", "watch_ci"]);

type ArgsCheck = (args: readonly string[]) => boolean;
const anyArgs: ArgsCheck = () => true;

/**
 * Refuses arguments that turn on any of these options: single letters (also inside `-abc`) or long names. Long names
 * also count shortened, as getopt and git accept them: `--outp` is `--output`.
 */
function refuses(letters: string, ...long: string[]): ArgsCheck {
    return (args) =>
        !args.some((arg) => {
            if (arg.startsWith("--")) {
                const name = arg.split("=", 1)[0]!;

                return name.length > 2 && long.some((refused) => refused.startsWith(name));
            }

            return /^-./.test(arg) && [...letters].some((letter) => arg.slice(1).includes(letter));
        });
}

const GIT_READS = new Set([
    "status",
    "log",
    "diff",
    "show",
    "blame",
    "ls-files",
    "ls-tree",
    "rev-parse",
    "describe",
    "shortlog",
    "grep",
]);

/** Git commands that only read, without options that write a file or run a program (a pager, an external diff). */
const gitReads: ArgsCheck = (args) => {
    let at = 0;

    while (args[at] === "--no-pager") {
        at++;
    }

    if (!GIT_READS.has(args[at] ?? "")) {
        return false;
    }

    return refuses("O", "--output", "--ext-diff", "--open-files-in-pager")(args.slice(at + 1));
};

/** `find` actions that delete, write, or run something. */
const FIND_ACTIONS = new Set([
    "-exec",
    "-execdir",
    "-ok",
    "-okdir",
    "-delete",
    "-fprint",
    "-fprint0",
    "-fprintf",
    "-fls",
]);

/** Commands that only read, each with a check of the arguments that would make it write or run something else. */
const READERS: Readonly<Record<string, ArgsCheck>> = {
    cat: anyArgs,
    cd: anyArgs,
    cmp: anyArgs,
    column: anyArgs,
    cut: anyArgs,
    df: anyArgs,
    diff: anyArgs,
    dirname: anyArgs,
    basename: anyArgs,
    du: anyArgs,
    echo: anyArgs,
    false: anyArgs,
    fd: refuses("xX", "--exec", "--exec-batch"),
    // Compiling a magic file writes one.
    file: refuses("C", "--compile"),
    find: (args) => !args.some((arg) => FIND_ACTIONS.has(arg)),
    git: gitReads,
    grep: anyArgs,
    head: anyArgs,
    id: anyArgs,
    jq: anyArgs,
    ls: anyArgs,
    md5sum: anyArgs,
    nl: anyArgs,
    printenv: anyArgs,
    // `printf -v name` and `test -v name` evaluate a subscript in the name, which can run a command: `a[$(…)]`.
    printf: (args) => !(args[0] ?? "").startsWith("-v"),
    pwd: anyArgs,
    readlink: anyArgs,
    realpath: anyArgs,
    // A hostname program runs to fill in hyperlinks.
    rg: refuses("", "--pre", "--hostname-bin"),
    sha1sum: anyArgs,
    sha256sum: anyArgs,
    // A compress program runs when sort spills to temporary files.
    sort: refuses("o", "--output", "--compress-program"),
    stat: anyArgs,
    tail: anyArgs,
    test: (args) => !args.includes("-v"),
    tr: anyArgs,
    // With -H, -R writes an HTML file into each folder.
    tree: refuses("oR"),
    true: anyArgs,
    uname: anyArgs,
    // A second file name is where uniq writes; `-` names standard input.
    uniq: (args) => args.filter((arg) => arg === "-" || !arg.startsWith("-")).length <= 1,
    wc: anyArgs,
    which: anyArgs,
    whoami: anyArgs,
};

/**
 * The simple commands of a command line, as words: split at `|`, `||`, `&&`, `;`, and new lines, with quotes and
 * backslashes resolved the way bash does. Undefined for anything that is more than plain words: redirects,
 * substitutions, variables, globs, subshells, background jobs, line continuations, or an unfinished quote.
 */
export function commandWords(command: string): string[][] | undefined {
    const commands: string[][] = [[]];
    let word: string | undefined;
    let quote: "'" | '"' | undefined;

    const add = (text: string) => {
        word = (word ?? "") + text;
    };

    const endWord = () => {
        if (word !== undefined) {
            commands.at(-1)!.push(word);
        }

        word = undefined;
    };

    const endCommand = () => {
        endWord();
        commands.push([]);
    };

    for (let at = 0; at < command.length; at++) {
        const char = command[at]!;
        const next = command[at + 1];

        if (quote === "'") {
            if (char === "'") {
                quote = undefined;
            } else {
                add(char);
            }
        } else if (quote === '"') {
            if (char === '"') {
                quote = undefined;
            } else if (char === "$" || char === "`") {
                return undefined;
            } else if (char !== "\\") {
                add(char);
            }
            // Inside double quotes a backslash escapes only a quote or another backslash; before anything else it stays.
            else if (next === '"' || next === "\\") {
                add(command[++at]!);
            } else if (next === "\n") {
                return undefined;
            } else {
                add(char);
            }
        } else if (char === "'" || char === '"') {
            quote = char;
            add("");
        } else if (char === "\\") {
            if (next === undefined || next === "\n") {
                return undefined;
            }

            add(command[++at]!);
        } else if (char === "\n" || char === ";") {
            endCommand();
        } else if (char === "|" || char === "&") {
            // A single `&` sends a job to the background.
            if (char === "&" && next !== "&") {
                return undefined;
            }

            if (next === char) {
                at++;
            }

            endCommand();
        } else if (/\s/.test(char)) {
            endWord();
        } else if ("<>()`${}*?[]!#".includes(char)) {
            return undefined;
        } else {
            add(char);
        }
    }

    if (quote !== undefined) {
        return undefined;
    }

    endWord();

    return commands.filter((words) => words.length > 0);
}

/** Whether a shell command only reads: every command in it is a known reader, with arguments that keep it one. */
export function readOnlyCommand(command: string): boolean {
    const commands = commandWords(command);

    if (commands === undefined || commands.length === 0) {
        return false;
    }

    return commands.every(
        ([name = "", ...args]) => Object.hasOwn(READERS, name) && READERS[name]!(args),
    );
}

/**
 * Why a call may not run in plan mode, or undefined when it may. `readOnly`: the tool's extension marks it read-only
 * (`annotations: { readOnlyHint: true }`, as in Pi's tool definitions).
 */
export function blockedInPlanMode(
    tool: string,
    args: Record<string, unknown>,
    readOnly = false,
): string | undefined {
    if (ALWAYS_ALLOWED.has(tool) || readOnly) {
        return undefined;
    }

    // Pi's browser, in full (the owner, 2026-10-22, PP-70): looking at the live app or a site often takes clicks and
    // typing, and a site is not the work. What pays, sends, books or deletes there Pi asks about first, as always.
    if (tool === "browser" || tool.startsWith("browser_")) {
        return undefined;
    }

    if (LISTS.has(tool) && args.action === "list") {
        return undefined;
    }

    // The team server's settings, asked with nothing to change: only read.
    if (tool === "team_server" && args.idleMinutes === undefined) {
        return undefined;
    }

    // Board mode's settings, asked with nothing to change: only read.
    if (tool === "board_settings" && args.closer === undefined && args.rules === undefined) {
        return undefined;
    }

    // Asking how a subagent does, or stopping it, changes nothing.
    if (tool === "subagent" && (args.action === "status" || args.action === "stop")) {
        return undefined;
    }

    if (tool === "bash" && typeof args.command === "string" && readOnlyCommand(args.command)) {
        return undefined;
    }

    const what =
        tool === "bash"
            ? "This command is not a simple read-only one"
            : `The ${tool} tool can change things`;

    return `Plan mode is on: ${what}, so it is blocked. Keep exploring with read and read-only commands, then propose your plan; a person approves it before anything changes.`;
}

export default function createPlan(_host: PocketHost) {
    return defineExtension({
        name: "pocket-plan",
        sections: [
            section("plan_mode", async (input, context) =>
                (await input.read.snapshot(PlanDoc, input.conversationId, context))?.on
                    ? PLANNING
                    : SUGGEST_PLAN,
            ),
        ],
        hooks: [
            hook(ToolTask, {
                beforeTool: async (call, api, context) => {
                    if ((await api.snapshot(PlanDoc, api.conversationId, context))?.on !== true) {
                        return undefined;
                    }

                    // HookApi omits agent, but ToolTask supplies its phase runtime and codemode preserves it.
                    // Use that same resolved snapshot, not the live registry: wrappers and reloads can differ.
                    const runtime = api as typeof api & Partial<Pick<ToolExecutionApi, "agent">>;
                    const tool = (await runtime.agent?.(context))?.tools.find(
                        (tool) => tool.name === call.name,
                    ) as { annotations?: ToolAnnotations } | undefined;
                    // A built-in tool's hint can only come from a wrap, which the owner never sees as read-only.
                    const reason = blockedInPlanMode(
                        call.name,
                        call.arguments as Record<string, unknown>,
                        !BUILT_IN_TOOLS.has(call.name) && tool?.annotations?.readOnlyHint === true,
                    );

                    return reason === undefined ? undefined : { block: reason };
                },
            }),
        ],
    });
}
