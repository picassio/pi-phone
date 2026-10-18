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
import { defineExtension, type PromptInput, section } from "@earendil-works/pi-durable";
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

You work in the conversation's working directory, on that machine, with the tools you are given. ${DURABLE}`;

const GUIDELINES = `- Keep replies short and easy to read on a small screen. Lead with the answer; use short paragraphs, lists, and small code blocks.
- Use read to look at files instead of cat or sed. Use edit for precise changes and write for new files or full rewrites.
- Show file paths clearly when you work with files.
- To show the user an image file from where you work (a screenshot, a chart, a picture), embed it in your reply with Markdown: ![short description](/absolute/path.png). Paths relative to the working directory work too. Files the user attaches are saved where you work; their paths are listed in the message.
- Before running something destructive or irreversible, say what it will do. A guard may ask a human to approve risky commands; if a call is blocked, do not try to get around the block.
- Do not commit, push, publish, or deploy unless asked.`;

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
        sections: [
            section("preamble", (input) => {
                const machine = host.machineOf(cwdOf(input));

                return machine === undefined ? PREAMBLE : machinePreamble(machine.name);
            }, { tag: false }),
            section("guidelines", () => GUIDELINES),
            section("pocket_docs", () => docs(host.dataDir)),
            section("project_context", (input) => {
                const cwd = localCwd(input);

                return cwd === undefined ? undefined : load(cwd).context;
            }),
            section("skills", (input) => {
                const cwd = localCwd(input);

                return cwd === undefined ? undefined : load(cwd).skills;
            }, { tag: false }),
            section("environment", (input) => {
                // The date only, so the prompt stays cache-friendly through the day.
                const today = new Date().toISOString().slice(0, 10);
                const machine = host.machineOf(cwdOf(input));

                if (machine === undefined) {
                    const machines = host.machines();
                    const reach =
                        machines.length === 0
                            ? []
                            : [
                                  `The owner's machines: ${machines
                                      .map((each) => `${each.alias} (${each.address}, id ${each.id})`)
                                      .join(", ")}. Run a command on one with machine_run, and copy files with machine_copy; for longer work there, start a session in a folder on it (session_start with the folder machine:<id>:<path>), which runs all your tools there. Your bash has no ssh to them: the app's keys are not yours to use.`,
                              ];

                    return [`Working directory: ${cwdOf(input)}`, `Platform: ${process.platform}`, ...reach, `Today: ${today}`].join("\n");
                }

                return [
                    `Your tools (bash, read, write, edit) run on the machine "${machine.name}" (${machine.address}, ${machine.platform}), not on the phone. Working directory there: ${machine.path}`,
                    "That machine's git, gh, and other programs use its own logins and tools, not the phone's. Files the user attaches are copied to ~/.pi/mobile/uploads on that machine; the message lists their paths there.",
                    "A command stops about 30 seconds after the phone's connection to the machine drops, with an error; check what happened before running it again.",
                    `Today: ${today}`,
                ].join("\n");
            }),
        ],
    });
}
