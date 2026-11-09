/**
 * Pi's tools for the owner's library of skills and slash commands (PP-468, epic PP-464; `library.ts` keeps it): Pi
 * drafts, the owner decides. `skill_save` and `command_save` make or edit one, `library_pin` pins it to a session, a
 * board, or every session (or takes the pin away), `library_undo` goes back to a kept version, and `library_delete`
 * deletes one, each only after the owner approves a card that shows what it does: a save the whole content, and the
 * diff for an edit; a pin, an undo or a delete what and where. `library_list` only reads. Nothing changes before
 * Approve, and an item changed while its card waited is not overwritten. The owner's alone: the library is theirs.
 *
 * All six are deferred (`deferred-tools.ts`): a session pays for them only once Pi loads them. The skill-creator skill
 * (`src/skills/skill-creator/`) says how to write a good one, and names them.
 */
import { arr, bool, int, obj, opt, str, union } from "@earendil-works/pi-schema";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { generateUnifiedPatch, parseFrontmatter } from "@earendil-works/pi-coding-agent";
import type { User } from "../config.ts";
import type { LibraryForm, PocketHost } from "../host.ts";
import { type LibraryFiles, libraryFiles, type LibraryKind, libraryNameProblem, libraryPin, type LibraryPin, type PinView } from "../library.ts";
import { literal, record } from "../tool-schema.ts";

export const LIBRARY_TOOLS = ["skill_save", "command_save", "library_pin", "library_list", "library_undo", "library_delete"] as const;

const reply = (text: string, isError = false) => ({ output: [{ type: "text" as const, text }], ...(isError ? { isError: true } : {}) });
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

type Listed = ReturnType<PocketHost["library"]["list"]>[number];
type Call = { conversationId: unknown; taskId: unknown; callId?: string };

/** A pin in Pi's words: `session 42 (SSP review)`, `board PP (pi-phone)`, `every session`; `(gone)` when it is no longer there. */
export function pinWords(pin: PinView): string {
    if (pin.scope === "all") {
        return "every session";
    }

    const named = `${pin.scope} ${pin.target}`;

    return pin.gone === true ? `${named} (gone)` : pin.label === undefined ? named : `${named} (${pin.label})`;
}

const pinsWords = (pins: readonly PinView[]) => (pins.length === 0 ? "pinned nowhere" : `pinned to ${pins.map(pinWords).join(", ")}`);

/** A YAML front matter line whose value is JSON (YAML reads JSON scalars, lists and maps as they are). */
const frontLine = (key: string, value: unknown) => `${/^[A-Za-z0-9_-]+$/.test(key) ? key : JSON.stringify(key)}: ${JSON.stringify(value)}`;

/** A Markdown file with front matter: `first` in its order, then the keys an edit keeps (`kept`), then the text. */
export function withFrontMatter(first: Record<string, string | undefined>, kept: Record<string, unknown>, text: string): string {
    const front = { ...first, ...Object.fromEntries(Object.entries(kept).filter(([key]) => !(key in first))) };
    const lines = Object.entries(front)
        .filter(([, value]) => value !== undefined)
        .map(([key, value]) => frontLine(key, value));

    return `---\n${lines.join("\n")}\n---\n\n${text.replace(/^\s*\n/, "").trimEnd()}\n`;
}

/** The front matter of an item's main file now, to keep what the tool does not set (a skill's `compatibility`). */
function frontOf(text: string | undefined): Record<string, unknown> {
    return text === undefined ? {} : (parseFrontmatter(text) as { frontmatter: Record<string, unknown> }).frontmatter;
}

/** The change from `before` to `after`, file by file, as a unified diff; empty when nothing changed. */
export function libraryDiff(before: LibraryFiles, after: LibraryFiles): string {
    const paths = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();

    return paths
        .filter((path) => before[path] !== after[path])
        .map((path) => generateUnifiedPatch(path, before[path] ?? "", after[path] ?? "", 3))
        .join("");
}

const fileList = (files: LibraryFiles) => Object.entries(files).map(([path, text]) => ({ path, text }));

const KIND = union([literal("skill"), literal("command")], { description: "skill or command; needed only when both have this name" });

export default function createLibrary(host: PocketHost) {
    /** The owner, when Pi works for them here; else why not. Asked before any card. */
    const ownerOf = (conversationId: unknown): User => {
        const id = host.requesterOf(Number(conversationId) as never);

        if (id === undefined) {
            throw new Error("No one Pi works for here is signed in to pi-phone.");
        }

        const person = host.person(id);

        if (person.role !== "owner") {
            throw new Error("The library of skills and commands is the owner's: only they change it, and Pi only when it works for them.");
        }

        return person;
    };

    /** The item of this name (of `kind`, when given), or undefined; two of one name need the kind. */
    const find = (user: User, name: string, kind?: LibraryKind): Listed | undefined => {
        const found = host.library.list(user).filter((item) => item.name === name && (kind === undefined || item.kind === kind));

        if (found.length > 1) {
            throw new Error(`The library has a skill and a command named ${name}: give the kind.`);
        }

        return found[0];
    };
    const need = (user: User, name: string, kind?: LibraryKind): Listed => {
        const item = find(user, name, kind);

        if (item === undefined) {
            throw new Error(`The library has no ${kind ?? "skill or command"} named ${name}. See what it has with library_list.`);
        }

        return item;
    };

    /** Ask the owner on the library's card; its answer. */
    const ask = (call: Call, context: unknown, tool: string, subject: string, reason: string, form: LibraryForm) =>
        host.approvals.request(
            {
                id: `library-${String(call.taskId)}-${String(call.callId)}`,
                conversationId: Number(call.conversationId) as never,
                taskId: call.taskId as never,
                ...(call.callId === undefined ? {} : { callId: call.callId }),
                tool,
                subject,
                reason,
                form,
                createdAt: Date.now(),
            },
            context as never,
        );
    const declined = (by: string, what: string) => reply(`${by === "superseded" ? "The request was replaced" : `${by} declined`}: ${what}`, true);

    /** An item changed while its card waited (the owner edited it on the page): nothing is done over it. */
    const unchanged = (user: User, item: Listed) => {
        const now = find(user, item.name, item.kind);

        if (now === undefined || now.version !== item.version) {
            throw new Error(`${item.name} changed while the card waited (now ${now === undefined ? "deleted" : `at version ${now.version}`}): nothing was done. Read it again with library_list.`);
        }
    };

    /** A save's card and, on Approve, the save: the files as they will be, and for an edit the diff. */
    const save = async (call: Call, context: unknown, user: User, kind: LibraryKind, name: string, given: { files?: LibraryFiles; content?: string }, note: string | undefined) => {
        const files = libraryFiles(kind, name, given);
        const item = find(user, name, kind);
        const before = item === undefined ? undefined : host.library.files(user, kind, name, item.version);
        const diff = before === undefined ? undefined : libraryDiff(before, files);

        if (diff === "") {
            throw new Error(`${name} is already like this: nothing to save.`);
        }

        const pins = item?.pins ?? [];
        const answer = await ask(
            call,
            context,
            kind === "skill" ? "skill_save" : "command_save",
            item === undefined ? `Save the new ${kind} ${name}` : `Save the ${kind} ${name}: version ${item.version} → a new version`,
            item === undefined ? `A new ${kind}, pinned nowhere until it is pinned.` : `An edit, ${pinsWords(pins)}; the old version is kept.`,
            {
                type: "library",
                action: "save",
                kind,
                name,
                files: fileList(files),
                ...(diff === undefined ? {} : { diff }),
                ...(item === undefined ? {} : { from: item.version }),
                pins,
                ...(note === undefined || note.trim() === "" ? {} : { note: note.trim() }),
            },
        );

        if (!answer.allow) {
            return declined(answer.by, "nothing was saved. The draft is only in this call: change it as they say and save again.");
        }

        if (item !== undefined) {
            unchanged(user, item);
        } else if (find(user, name, kind) !== undefined) {
            throw new Error(`A ${kind} named ${name} was made while the card waited: nothing was saved. Read it with library_list.`);
        }

        const saved = host.library.save(user, kind, name, given, note ?? "");

        return reply(
            `Saved the ${kind} ${name} as version ${saved.version} (${saved.path}), ${pinsWords(pins)}.${pins.length === 0 ? " Pin it where it should be used with library_pin." : ""}${kind === "command" ? ` Typed as /${name} in a session it is pinned to.` : ""}`,
        );
    };

    const tools = [
        defineTool({
            name: "skill_save",
            description:
                "Save one of the owner's library skills, new or an edit (the same name), after the owner approves a card with the whole SKILL.md and files, and the diff for an edit. Nothing is saved before; every save keeps a version. Follow the skill-creator skill. A new skill is pinned nowhere: library_pin.",
            parameters: obj(
                {
                    name: str({ description: "Lowercase letters, digits and hyphens, like ssp-review; the same name edits it" }),
                    description: str({ description: "What it is for, then Use when … in the owner's words; under 300 characters" }),
                    body: str({ description: "SKILL.md after its front matter: the instructions" }),
                    files: opt(record(str(), { description: "Other files by path below its folder (references/x.md, scripts/check.ts) and their text; an edit keeps those not named" })),
                    remove: opt(arr(str(), { description: "An edit: paths of files to take away" })),
                    note: opt(str({ description: "What changed, in a few words: kept with the version" })),
                },
                { open: true },
            ),
            execute: async (args, api, context) => {
                try {
                    const user = ownerOf(api.conversationId);
                    const problem = libraryNameProblem(args.name);

                    if (problem !== undefined) {
                        throw new Error(problem);
                    }

                    if ("SKILL.md" in (args.files ?? {})) {
                        throw new Error("SKILL.md is made from name, description and body: give its instructions as body, not in files.");
                    }

                    const item = find(user, args.name, "skill");
                    const current = item === undefined ? {} : host.library.files(user, "skill", args.name, item.version);
                    const gone = new Set(args.remove ?? []);
                    const missing = [...gone].filter((path) => current[path] === undefined || path === "SKILL.md");

                    if (missing.length > 0) {
                        throw new Error(`${missing.join(", ")}: not a file it has that can be taken away.`);
                    }

                    const others = Object.fromEntries(Object.entries({ ...current, ...args.files }).filter(([path]) => path !== "SKILL.md" && !gone.has(path)));
                    const skill = withFrontMatter({ name: args.name, description: args.description.trim() }, frontOf(current["SKILL.md"]), args.body);

                    return await save(api, context, user, "skill", args.name, { files: { "SKILL.md": skill, ...others } }, args.note);
                } catch (error) {
                    return reply(message(error), true);
                }
            },
        }),
        defineTool({
            name: "command_save",
            description:
                "Save one of the owner's library slash commands (a prompt template: /name fills it into the message box), new or an edit, after the owner approves a card with the whole text, and the diff for an edit. Every save keeps a version. A new one is pinned nowhere: library_pin.",
            parameters: obj(
                {
                    name: str({ description: "What follows the slash: lowercase letters, digits and hyphens, like ssp-review" }),
                    description: str({ description: "One line the owner reads in the / list: what it does" }),
                    template: str({ description: "The prompt: $ARGUMENTS for all the arguments, $1 and $2 for one, ${1:-default} for one with a default" }),
                    argument_hint: opt(str({ description: "What to type after it: <required> [optional]" })),
                    note: opt(str({ description: "What changed, in a few words: kept with the version" })),
                },
                { open: true },
            ),
            execute: async (args, api, context) => {
                try {
                    const user = ownerOf(api.conversationId);
                    const problem = libraryNameProblem(args.name);

                    if (problem !== undefined) {
                        throw new Error(problem);
                    }

                    const item = find(user, args.name, "command");
                    const current = item === undefined ? undefined : host.library.files(user, "command", args.name, item.version)[`${args.name}.md`];
                    const hint = args.argument_hint?.trim();
                    const content = withFrontMatter({ description: args.description.trim(), "argument-hint": hint === "" ? undefined : hint }, frontOf(current), args.template);

                    return await save(api, context, user, "command", args.name, { content }, args.note);
                } catch (error) {
                    return reply(message(error), true);
                }
            },
        }),
        defineTool({
            name: "library_pin",
            description:
                "Pin one of the owner's library skills or commands to a session (and its subagents), a board (its sessions), or every session, or take a pin away, after the owner approves a card. Only sessions it is pinned to have it.",
            parameters: obj(
                {
                    name: str({ description: "The skill's or command's name" }),
                    kind: opt(KIND),
                    scope: union([literal("session"), literal("board"), literal("all")], { description: "session, board, or all (every session)" }),
                    target: opt(str({ description: "session: its number (default this session); board: its key, like PP" })),
                    pinned: opt(bool({ description: "false takes the pin away (default true)" })),
                },
                { open: true },
            ),
            execute: async (args, api, context) => {
                try {
                    const user = ownerOf(api.conversationId);
                    const item = need(user, args.name, args.kind);
                    const pinned = args.pinned ?? true;
                    const target = args.scope === "session" && (args.target === undefined || args.target.trim() === "") ? String(host.rootOf(Number(api.conversationId))) : args.target;
                    const pin: LibraryPin = libraryPin(args.scope, target);
                    const view = host.library.pinView(pin);
                    const has = item.pins.some((each) => each.scope === pin.scope && each.target === pin.target);

                    if (has === pinned) {
                        throw new Error(`The ${item.kind} ${item.name} is ${pinned ? "already" : "not"} pinned to ${pinWords(view)}: nothing to change.`);
                    }

                    if (pinned && view.gone === true) {
                        throw new Error(pin.scope === "session" ? `There is no session ${pin.target}.` : `There is no board ${pin.target}.`);
                    }

                    const answer = await ask(
                        api,
                        context,
                        "library_pin",
                        `${pinned ? "Pin" : "Unpin"} the ${item.kind} ${item.name} ${pinned ? "to" : "from"} ${pinWords(view)}`,
                        pinned ? `Sessions there get it from their next message.` : `Sessions there no longer get it from their next message.`,
                        { type: "library", action: "pin", kind: item.kind, name: item.name, pin: { ...view, pinned }, pins: item.pins },
                    );

                    if (!answer.allow) {
                        return declined(answer.by, "the pins stay as they were.");
                    }

                    const pins = host.library.setPin(user, item.kind, item.name, pin, pinned);

                    return reply(`${pinned ? "Pinned" : "Unpinned"} the ${item.kind} ${item.name}: now ${pinsWords(pins)}.`);
                } catch (error) {
                    return reply(message(error), true);
                }
            },
        }),
        defineTool({
            name: "library_list",
            description:
                "The owner's library of skills and slash commands: each item, where it is pinned, and its versions. With a name, its files now (or a kept version's), and its versions. Only reads.",
            parameters: obj(
                {
                    name: opt(str({ description: "One item: its files and versions" })),
                    kind: opt(KIND),
                    version: opt(int({ description: "With name: a kept version's files instead of the current ones" })),
                },
                { open: true },
            ),
            replay: "safe",
            execute: async (args, api) => {
                try {
                    const user = ownerOf(api.conversationId);

                    if (args.name === undefined) {
                        const items = host.library.list(user).filter((item) => args.kind === undefined || item.kind === args.kind);

                        if (items.length === 0) {
                            return reply(`The library has no ${args.kind === undefined ? "skills or commands" : `${args.kind}s`} yet. Make one with skill_save or command_save.`);
                        }

                        return reply(
                            items
                                .map((item) => {
                                    const kept = host.library.versions(user, item.kind, item.name).versions.length;

                                    return `- ${item.kind} ${item.kind === "command" ? "/" : ""}${item.name} (version ${item.version}, ${kept} kept), ${pinsWords(item.pins)}: ${item.description}`;
                                })
                                .join("\n"),
                        );
                    }

                    const item = need(user, args.name, args.kind);
                    const { versions } = host.library.versions(user, item.kind, item.name);
                    const shown = args.version ?? item.version;
                    const files = host.library.files(user, item.kind, item.name, shown);

                    return reply(
                        [
                            `${item.kind} ${item.name}, at version ${item.version}, ${pinsWords(item.pins)}. ${item.path}`,
                            `Versions (newest first): ${versions.map((version) => `${version.n}${version.n === item.version ? " (current)" : ""} ${new Date(version.at).toISOString().slice(0, 16).replace("T", " ")}${version.note === "" ? "" : ` ${version.note}`}`).join("; ")}`,
                            "",
                            `Files of version ${shown}:`,
                            ...Object.entries(files).map(([path, text]) => `=== ${path}\n${text}`),
                        ].join("\n"),
                    );
                } catch (error) {
                    return reply(message(error), true);
                }
            },
        }),
        defineTool({
            name: "library_undo",
            description:
                "Take one of the owner's library skills or commands back to the version before the current one, or to a kept version, after the owner approves a card with the change. The current version stays kept.",
            parameters: obj(
                {
                    name: str({ description: "The skill's or command's name" }),
                    kind: opt(KIND),
                    version: opt(int({ description: "A kept version to go back to (library_list shows them); default the one before the current" })),
                },
                { open: true },
            ),
            execute: async (args, api, context) => {
                try {
                    const user = ownerOf(api.conversationId);
                    const item = need(user, args.name, args.kind);
                    const { versions } = host.library.versions(user, item.kind, item.name);
                    const to = args.version ?? versions.find((version) => version.n < item.version)?.n;

                    if (to === undefined) {
                        throw new Error(`${item.name} is at its first kept version: there is nothing to undo.`);
                    }

                    if (to === item.version) {
                        throw new Error(`${item.name} is at version ${to} already.`);
                    }

                    if (!versions.some((version) => version.n === to)) {
                        throw new Error(`${item.name} has no version ${to}: it has ${versions.map((version) => version.n).join(", ")}.`);
                    }

                    const diff = libraryDiff(host.library.files(user, item.kind, item.name, item.version), host.library.files(user, item.kind, item.name, to));
                    const answer = await ask(
                        api,
                        context,
                        "library_undo",
                        `Take the ${item.kind} ${item.name} back: version ${item.version} → ${to}`,
                        `${pinsWords(item.pins)}; version ${item.version} stays kept.`.replace(/^./, (first) => first.toUpperCase()),
                        { type: "library", action: "undo", kind: item.kind, name: item.name, from: item.version, to, diff, pins: item.pins },
                    );

                    if (!answer.allow) {
                        return declined(answer.by, `${item.name} stays at version ${item.version}.`);
                    }

                    unchanged(user, item);
                    host.library.restore(user, item.kind, item.name, to);

                    return reply(`The ${item.kind} ${item.name} is back at version ${to}; version ${item.version} is kept.`);
                } catch (error) {
                    return reply(message(error), true);
                }
            },
        }),
        defineTool({
            name: "library_delete",
            description: "Delete one of the owner's library skills or commands, with its versions and pins, after the owner approves a card. It cannot be undone.",
            parameters: obj({ name: str({ description: "The skill's or command's name" }), kind: opt(KIND) }, { open: true }),
            execute: async (args, api, context) => {
                try {
                    const user = ownerOf(api.conversationId);
                    const item = need(user, args.name, args.kind);
                    const kept = host.library.versions(user, item.kind, item.name).versions.length;
                    const answer = await ask(
                        api,
                        context,
                        "library_delete",
                        `Delete the ${item.kind} ${item.name} and its ${kept} kept version${kept === 1 ? "" : "s"}`,
                        `It is ${pinsWords(item.pins)}. It cannot be undone.`,
                        { type: "library", action: "delete", kind: item.kind, name: item.name, versions: kept, pins: item.pins },
                    );

                    if (!answer.allow) {
                        return declined(answer.by, `the ${item.kind} ${item.name} stays.`);
                    }

                    unchanged(user, item);
                    host.library.remove(user, item.kind, item.name);

                    return reply(`Deleted the ${item.kind} ${item.name}, its ${kept} version${kept === 1 ? "" : "s"} and its pins.`);
                } catch (error) {
                    return reply(message(error), true);
                }
            },
        }),
    ];

    return defineExtension({ name: "pocket-library", tools });
}
