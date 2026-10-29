/**
 * The system prompt: who the agent is, how to behave on a phone-sized screen, where pi-phone's code is, the
 * project's AGENTS.md files, Pi's skills, and the working directory. Sections render before every request; only
 * changed sections are sent again, so everything here is stable between requests unless a file on disk changed.
 *
 * Edit freely: saving this file reloads it into the running server.
 */
import { statSync } from "node:fs";
import { join, resolve } from "node:path";
import {
    formatSkillsForPrompt,
    getDocsPath,
    loadProjectContextFiles,
} from "@earendil-works/pi-coding-agent";
import { defineExtension, hook, type PromptInput, section, type ToolExecutionResult, ToolTask } from "@earendil-works/pi-durable";
import { APP_ROOT } from "../config.ts";
import type { PocketHost } from "../host.ts";

/** What every session's preamble ends with. */
const DURABLE = `Your work is durable: if the server restarts, you continue where you left off. A tool call cut off by a restart comes back as an "interrupted" error when it was not safe to repeat; check what actually happened before you retry it.`;

const PREAMBLE = `You are Pi, a coding agent running inside pi-phone: an Android app that runs you on the phone itself, built on Pi Durable. Its owner talks to you from the app's screen. Your shell is a Termux userland inside the app (bash, coreutils, git, gh, ssh, rg, fd, node, npm); there is no package manager.

You work in the conversation's working directory with the tools you are given. ${DURABLE}`;

/**
 * A session on one of the owner's machines: its file and shell tools run there, and everything else of pi-phone works
 * as in any session. Said plainly, since a prompt that only listed limits had Pi there believe the wiki, secrets, and
 * the rest stayed on the phone.
 */
const machinePreamble = (name: string) => `You are Pi, a coding agent running inside pi-phone: an Android app, built on Pi Durable, whose owner talks to you from the app's screen. This session works on the owner's machine "${name}": bash, read, write, and edit run there, over SSH, with its programs and logins.

Everything else of pi-phone works here as in a session on the phone: the wiki (the phone's, one for all sessions), secrets (a command here that names $NAME gets its value on this machine), web search and fetch_content (its GitHub clones and long pages are saved on this machine), file_to_markdown (files on this machine), interview, artifacts and interactive answers, schedules, subagents, and the other sessions. Use them as you would anywhere.

Pi's browser here is a headless Chrome on this machine (the owner watches it in the same panel): it opens this machine's own addresses too (localhost:3000, a dev server), and browser_upload and browser_save_pdf use files on this machine.

You work in the conversation's working directory, on that machine, with the tools you are given. ${DURABLE}`;

const GUIDELINES = `- Keep replies short and easy to read on a small screen. Lead with the answer; use short paragraphs, lists, and small code blocks.
- Use read to look at files instead of cat or sed. Change files only with edit (or write for a new file or a full rewrite); never with scripts, heredocs, or sed -i in bash: those edits show no diff. Use bash to run things.
- Show file paths clearly when you work with files.
- When the person must do something you cannot (make a token, sign in, tap a button, decide), give numbered steps they can follow later without this chat: exact places (links, menus, buttons), values, and what to tell you when done.
- To show the user an image file from where you work (a screenshot, a chart, a picture), embed it in your reply with Markdown: ![short description](/absolute/path.png). Paths relative to the working directory work too. Files the user attaches are saved where you work; their paths are listed in the message.
- Before running something destructive or irreversible, say what it will do. A guard may ask a human to approve risky commands; if a call is blocked, do not try to get around the block.
- Do not commit, push, publish, or deploy unless asked.`;

/** A session on a Windows machine: how its shell (Git Bash) runs Windows programs, and how to write its paths (PP-101). */
export const WINDOWS_SHELL =
    "It runs Windows. bash there is Git Bash: Unix commands work, and Windows programs (.exe, cmd //c, powershell -NoProfile -Command) run from it; write cmd //c, since Git Bash turns a lone /c into the path C:/. Give read, write and edit Windows paths with forward slashes (C:/Users/…); in bash the same folder is also /c/Users/….";

/** What a bash result gets when its command wrote files by script: a reminder, never a refusal. */
export const EDIT_NOTE = "Note: this command wrote files by script, which shows no diff in the app. Change files with edit (or write for a new file) instead; use bash to run things.";

/**
 * Whether a bash command writes files by script rather than through edit or write (PP-100): a program's file writes
 * (writeFileSync, open(…, "w")), sed or perl in place, `cat > file` (a heredoc too), or tee. sed, perl, cat and tee
 * count where a command starts (not as words in a search); output sent to /dev/null or another stream is not a file.
 */
export function writesByScript(command: string): boolean {
    const start = String.raw`(?:^|[|;&(])\s*(?:sudo\s+)?`;

    return [
        /\b(?:writeFileSync|appendFileSync|writeFile)\s*\(/,
        /\bopen\s*\([^)]*,\s*['"](?:w|a|x)b?\+?['"]/,
        new RegExp(String.raw`${start}(?:sed|perl)\b[^|;&\n]*\s-[a-zA-Z]*i`, "m"),
        new RegExp(String.raw`${start}cat\b[^|;&\n]*?(?<![0-9&])>>?\s*(?!&|\/dev\/null\b)[^\s|;&]`, "m"),
        new RegExp(String.raw`${start}tee\b(?!\s+\/dev\/null\b)`, "m"),
    ].some((pattern) => pattern.test(command));
}

/** Where a command starts: the start of the text or a line, or after a pipe, `;`, `&` or `(`; `sudo` before it too. */
const COMMAND_START = String.raw`(?:^|[|;&(])\s*(?:sudo\s+)?`;

/** A shell word without its quotes. */
const unquote = (word: string) => word.replace(/^(['"])(.*)\1$/s, "$2");

/** A command's words as the shell splits them (quotes kept whole), for the few commands read here. */
function words(text: string): string[] {
    return text.match(/'[^']*'|"(?:\\.|[^"\\])*"|[^\s'"]+(?:(?:'[^']*'|"(?:\\.|[^"\\])*")[^\s'"]*)*/g) ?? [];
}

/** The files sed -i or perl -i edits: its words after the script (the first word that is not an option, or -e's). */
function inPlaceFiles(args: string): string[] | undefined {
    const files: string[] = [];
    let script = false;
    let takesNext = false;

    for (const word of words(args)) {
        if (takesNext) {
            takesNext = false;
            script = true;
        } else if (word.startsWith("-") && word.length > 1) {
            // -e and -f (sed), or a perl cluster ending in e (-pe, -pie): the next word is the script.
            takesNext = /^-(?:[a-zA-Z]*e|f)$/.test(word) || word === "--expression" || word === "--file";
        } else if (!script) {
            script = true;
        } else {
            files.push(unquote(word));
        }
    }

    return files.length > 0 ? files : undefined;
}

/**
 * The files a bash command writes by script, as it names them (PP-206): `cat > file`, tee's files, sed or perl -i's,
 * and a program's writeFileSync / open(…, "w") with a quoted name. `unknown`: one of its writes names no file this can
 * read (a variable, a path built in the program).
 */
export function scriptTargets(command: string): { files: string[]; unknown: boolean } {
    const files: string[] = [];
    let unknown = false;

    for (const match of command.matchAll(new RegExp(String.raw`${COMMAND_START}cat\b[^|;&\n]*?(?<![0-9&])>>?\s*(?!&|\/dev\/null\b)('[^']*'|"[^"]*"|[^\s|;&<>]+)`, "gm"))) {
        files.push(unquote(match[1]!));
    }

    for (const match of command.matchAll(new RegExp(String.raw`${COMMAND_START}tee\b([^|;&\n]*)`, "gm"))) {
        const named = words(match[1]!.split(/\s[0-9]?>/)[0]!).filter((word) => !word.startsWith("-") && word !== "/dev/null");

        files.push(...named.map(unquote));
    }

    for (const match of command.matchAll(new RegExp(String.raw`${COMMAND_START}(?:sed|perl)\b([^|;&\n]*)`, "gm"))) {
        if (!/(?:^|\s)-[a-zA-Z]*i/.test(match[1]!)) {
            continue;
        }

        const named = inPlaceFiles(match[1]!);

        if (named === undefined) {
            unknown = true;
        } else {
            files.push(...named);
        }
    }

    for (const match of command.matchAll(/\b(?:writeFileSync|appendFileSync|writeFile)\s*\(\s*(?:(['"`])([^'"`]+)\1)?/g)) {
        if (match[2] === undefined) {
            unknown = true;
        } else {
            files.push(match[2]);
        }
    }

    for (const match of command.matchAll(/\bopen\s*\(([^)]*),\s*['"](?:w|a|x)b?\+?['"]/g)) {
        const name = /^\s*(['"])([^'"]+)\1\s*$/.exec(match[1]!);

        if (name === null) {
            unknown = true;
        } else {
            files.push(name[2]!);
        }
    }

    return { files, unknown };
}

/**
 * A scratch file the reminder is not about (PP-206): under /tmp or $TMPDIR (as written, or the server's TMPDIR), or a
 * name with `.local.` in it (a person's own copy, as `settings.local.json`).
 */
export function scratchFile(path: string, tmpdir = process.env.TMPDIR): boolean {
    const name = path.split("/").at(-1) ?? path;

    return (
        name.includes(".local.") ||
        /^(?:\/tmp|\$TMPDIR|\$\{TMPDIR\})(?:\/|$)/.test(path) ||
        (tmpdir !== undefined && tmpdir !== "" && (path === tmpdir || path.startsWith(`${tmpdir.replace(/\/$/, "")}/`)))
    );
}

/**
 * Whether a bash command writes project files by script, so its result gets the reminder (PP-100, PP-206): a script
 * write, unless every file it names is a scratch file or one git ignores in the command's folder (`ignored`, asked only
 * when needed: the files git ignores of those given). A write that names no file keeps the reminder.
 */
export async function writesProjectFiles(command: string, ignored: (files: string[]) => Promise<ReadonlySet<string>>): Promise<boolean> {
    if (!writesByScript(command)) {
        return false;
    }

    const { files, unknown } = scriptTargets(command);

    if (unknown || files.length === 0) {
        return true;
    }

    const left = files.filter((file) => !scratchFile(file));

    if (left.length === 0) {
        return false;
    }

    const skipped = await ignored(left);

    return left.some((file) => !skipped.has(file));
}

/** A word for the shell, quoted. */
const quoted = (word: string) => `'${word.replace(/'/g, `'\\''`)}'`;

/** Where pi-phone's code and Pi's documentation are, as Pi's prompt says where Pi's is: to read only when needed. */
function docs(dataDir: string): string {
    const code = resolve(APP_ROOT);

    return `pi-phone itself (read only when someone asks about the app: how it works or changing it):
- Its running code is in ${code}, replaced by every app update; ${join(code, "DESIGN.md")} explains it. Changes to the app are made in a git clone of its repository and ship as a new APK, not by editing ${code}.
- Its data (settings, sessions) is in ${dataDir}. Change the data through the app, never by editing its files.
- Pi's own documentation (skills, prompt templates, models, providers, settings): ${getDocsPath()}`;
}

const STALE_MS = 30_000;

type Resources = {
    at: number;
    trust: number;
    context: string | undefined;
    skills: string | undefined;
};

export default function createPrompt(host: PocketHost) {
    // Context files and skills load once per directory, and again when the copy is older than STALE_MS, or Pi's trust
    // store changed since: a project trusted now has skills it did not have, from the next request on. Only answers to
    // "trust this project?" show at once; other changes (a new skill, Pi's defaultProjectTrust) wait for STALE_MS, or
    // a request more (the app reads Pi's settings again in the background as often).
    const resources = new Map<string, Resources>();

    const trustChanged = () => {
        try {
            return statSync(join(host.agentDir, "trust.json")).mtimeMs;
        } catch {
            return 0;
        }
    };

    const load = (cwd: string): Resources => {
        const cached = resources.get(cwd);
        const trust = trustChanged();

        if (cached !== undefined && Date.now() - cached.at < STALE_MS && cached.trust === trust) {
            return cached;
        }

        let context: string | undefined;
        let skills: string | undefined;

        try {
            const files = loadProjectContextFiles({ cwd, agentDir: host.agentDir });

            if (files.length > 0) {
                context = files
                    .map((file) => `<file path="${file.path}">\n${file.content.trim()}\n</file>`)
                    .join("\n\n");
            }
        } catch (error) {
            host.notice("warning", `Could not load AGENTS.md files for ${cwd}: ${String(error)}`);
        }

        try {
            const text = formatSkillsForPrompt(host.skills(cwd), "read").trim();

            skills = text === "" ? undefined : text;
        } catch (error) {
            host.notice("warning", `Could not load skills for ${cwd}: ${String(error)}`);
        }

        const fresh = { at: Date.now(), trust, context, skills };

        resources.set(cwd, fresh);

        return fresh;
    };

    // The agent's cwd, which names a machine for a session there (`places.ts`); the env's cwd is the path alone.
    const cwdOf = (input: PromptInput) => input.agent.cwd ?? input.env?.cwd ?? process.cwd();
    // On a machine, AGENTS.md files and skills would come from the phone's files: none are read.
    const localCwd = (input: PromptInput) => (host.machineOf(cwdOf(input)) === undefined ? cwdOf(input) : undefined);

    return defineExtension({
        name: "pocket-prompt",
        hooks: [
            // Edits made by scripts in bash show no diff: the result says so, and the command still ran (PP-100).
            // Not for scratch files: under /tmp or $TMPDIR, named *.local.*, or ignored by git there (PP-206).
            hook(ToolTask, {
                afterTool: async (call, result, api): Promise<ToolExecutionResult | undefined> => {
                    const command = (call.arguments as { command?: unknown }).command;

                    if (call.name !== "bash" || typeof command !== "string") {
                        return undefined;
                    }

                    const cwd = host.cwdOf(api.conversationId);
                    // git check-ignore prints the files it ignores; it exits 1 for none, and 128 outside a repository. A
                    // folder it cannot run in ignores none: the reminder stays, as for a project file.
                    const ignored = async (files: string[]) => {
                        const answer = await host.run(cwd, `git check-ignore -- ${files.map(quoted).join(" ")}`, 20).catch(() => undefined);

                        return new Set(answer?.code === 0 ? answer.stdout.split("\n").filter((line) => line !== "") : []);
                    };

                    if (!(await writesProjectFiles(command, ignored))) {
                        return undefined;
                    }

                    return { ...result, output: [...(result.output ?? []), { type: "text", text: `\n${EDIT_NOTE}` }] };
                },
            }),
        ],
        sections: [
            section("preamble", (input) => {
                const machine = host.machineOf(cwdOf(input));

                return machine === undefined ? PREAMBLE : machinePreamble(machine.name);
            }, { tag: false }),
            section("guidelines", () => GUIDELINES),
            // The app's language for the person Pi works for (PP-81): Pi starts in it, even after a short first message.
            section("language", (input) => {
                const id = host.requesterOf(input.conversationId);
                const language = id === undefined ? undefined : host.person(id).language;

                if (language === "zh-CN") {
                    return "The person's app is in Simplified Chinese (简体中文): write to them in Chinese unless they write to you in another language.";
                }

                return language === "vi" ? "The person's app is in Vietnamese (Tiếng Việt): write to them in Vietnamese unless they write to you in another language." : undefined;
            }),
            section("pocket_docs", () => docs(host.dataDir)),
            section("project_context", (input) => {
                const cwd = localCwd(input);

                return cwd === undefined ? undefined : load(cwd).context;
            }),
            section("skills", (input) => {
                const cwd = localCwd(input);

                // On a machine: the skills of tools pi-phone installed there (OfficeCLI's), at their paths there.
                return cwd === undefined ? host.machineSkills(cwdOf(input)) : load(cwd).skills;
            }, { tag: false }),
            // The person's default design system (PP-241, Menu › Design system): on the phone, where its files are.
            section("design_system", (input) => (localCwd(input) === undefined ? undefined : host.designSystem())),
            section("environment", (input) => {
                // The date only, so the prompt stays cache-friendly through the day.
                const today = new Date().toISOString().slice(0, 10);
                const machine = host.machineOf(cwdOf(input));

                if (machine === undefined) {
                    const machines = host.machines();
                    // A new machine: Pi adds it with machine_add, on one approval card (PP-139).
                    const adding = "To add a computer to pi-phone (one you set up, or the owner names), use machine_add: the owner approves it on one card.";
                    const reach =
                        machines.length === 0
                            ? [adding]
                            : [
                                  `The owner's machines: ${machines
                                      .map((each) => `${each.alias} (${each.address}, id ${each.id})`)
                                      .join(", ")}. Run a command on one with machine_run, and copy files with machine_copy; for longer work there, start a session in a folder on it (session_start with the folder machine:<id>:<path>), which runs all your tools there. For what needs ssh itself, use pi-ssh, ssh with these machines by name through the app's agent: pi-ssh <name> 'cmd', rsync -e pi-ssh, scp -S pi-ssh, pi-ssh -N -L <port>:localhost:<port> <name>. The keys stay the app's: you can use them, never read them. Plain ssh uses the owner's own ~/.ssh, for other hosts. ${adding}`,
                              ];

                    return [`Working directory: ${cwdOf(input)}`, `Platform: ${process.platform}`, ...reach, `Today: ${today}`].join("\n");
                }

                return [
                    `Your tools (bash, read, write, edit) run on the machine "${machine.name}" (${machine.address}, ${machine.platform}), not on the phone. Working directory there: ${machine.path}`,
                    "That machine's git, gh, and other programs use its own logins and tools, not the phone's. Files the user attaches are copied to ~/.pi/mobile/uploads on that machine; the message lists their paths there.",
                    ...(machine.platform.startsWith("windows")
                        ? [
                              WINDOWS_SHELL,
                          ]
                        : []),
                    "A command stops about 30 seconds after the phone's connection to the machine drops, with an error; check what happened before running it again.",
                    ...(Object.keys(machine.tools).length === 0
                        ? []
                        : [
                              `pi-phone installed these tools there, first on bash's PATH (~/.pi/mobile/tools/bin): ${Object.entries(machine.tools)
                                  .map(([tool, version]) => `${tool} ${version}`)
                                  .join(", ")}.${machine.tools.officecli === undefined ? "" : " officecli never installs or updates itself: never run its installers or officecli install."}`,
                          ]),
                    `Today: ${today}`,
                ].join("\n");
            }),
        ],
    });
}
