/**
 * Pi's sessions from the terminal, to continue in Pi Pocket. Pi keeps each in a JSONL file in its sessions folder
 * (`~/.pi/agent/sessions/`, a folder per project; or the one folder `PI_CODING_AGENT_SESSION_DIR` or `sessionDir` in
 * Pi's settings names), and finds them all with `SessionManager.listAll`, as `pi -r` lists every folder's. Their files
 * are only read, never written: Pi's own loader mends a file whose last line is cut off, and a `pi` still running may be
 * writing that line.
 *
 * A session continues here as a copy of where Pi left it, its current branch. People get every message of it to read,
 * and Pi gets the context Pi itself builds from the file (`buildSessionProjection`): a compaction becomes Pi Durable's,
 * keeping the same messages, and a context edit edits the same message. Pi's system prompt, its extensions' state, and
 * its model changes stay behind; Pi Pocket's prompt and tools apply. Nothing Pi did runs again: a tool call that never
 * finished gets a result saying so (Pi's says "No result provided"). Where Pi would send a tool result whose call is
 * not there (a stray one, or one whose call a context edit took out), Pi Durable leaves it out, as providers refuse it.
 *
 * Any size continues (PP-486, from pi-pocket #261), and the phone never holds a file whole: a first read goes through
 * the file a line at a time and keeps only each entry's place in the tree (`indexPiSession`), a second reads the
 * current branch's entries again, in order, and they are written in commits of a few megabytes (`PiSessionCopy`). A
 * preview reads only the file's end (`readPiTail`).
 */
import { createWriteStream, existsSync, readFileSync } from "node:fs";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { mkdir, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { once } from "node:events";
import { finished } from "node:stream/promises";
import { pipeline } from "node:stream/promises";
import type { Message } from "@earendil-works/pi-ai";
import {
    buildSessionProjection,
    type ContextEditEntry,
    convertToLlm,
    CURRENT_SESSION_VERSION,
    type FileEntry,
    type SessionEntry,
    sessionEntryToContextMessages,
    type SessionInfo,
    getAgentDir,
} from "@earendil-works/pi-coding-agent";
import {
    AssistantEntry,
    CompactionEntry,
    type ContextEdit,
    type ConversationId,
    type EntryId,
    ToolResultEntry,
    type Tx,
    UserEntry,
} from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import type { PocketApp } from "./app.ts";
import type { User } from "./config.ts";
import { FROM_PI_ENTRY, type FromPiData, LINK_TYPE } from "./entry-format.ts";
import { HttpError } from "./errors.ts";
import { formatPlace } from "./places.ts";
import {
    CLAUDE_PROJECTS,
    claudeHead,
    type ClaudeKept,
    type ClaudeListing,
    ClaudeSessionError,
    claudeSlug,
    convertClaude,
    HEAD_LINES,
    listClaudeHere,
} from "./claude-sessions.ts";
import { type ByteSource, CHUNK, envSource, LineReader, linesFromEnd, linesOf, localSource, parseLine } from "./session-lines.ts";

const context = BACKGROUND_CONTEXT;

/** Pi's variable for its sessions folder (`ENV_SESSION_DIR` in its config, which the package does not export). */
const SESSION_DIR_VARIABLE = "PI_CODING_AGENT_SESSION_DIR";
/** Imported session files go here, a folder in Pi's own sessions folder, so Pi's list finds them as any other. */
const IMPORTED = "--imported--";
/** Beside an imported file: where it came from, when a machine (`machines.ts`), so it continues there by default. */
const ORIGIN_SUFFIX = ".origin.json";
/** How many session files a machine's listing reads headers of. */
const MAX_ON_MACHINE = 200;
/** How much of a session one commit writes, at most about: a big one is written in several, so memory stays flat. */
const COMMIT_BYTES = 8 * 1024 * 1024;

export type MachineSession = {
    /** The file on the machine. */
    path: string;
    id: string;
    cwd: string;
    title: string;
    /** The file's modification time there. */
    modified: number;
    size: number;
    /** The session here it went to Pi from (`pi-handoff.ts`), while it is still linked to this file. */
    phoneSession?: number;
    /** A Claude Code session (PP-496): it continues converted. */
    claudeCode?: true;
    /** The newest session here that continues it (a Claude Code session's). */
    continuedIn?: number;
};
/** How long a list of Pi's sessions answers "is this one of them?" for a preview or a continue after it. */
const FOUND_FOR_MS = 5_000;
/** How many sessions a list holds, newest first: a search looks through them all first. */
const MAX_LISTED = 300;
/**
 * How much of a session's text a search looks through, from its start: Pi's own list keeps all of it, which for a
 * session of hundreds of megabytes would be most of the phone's memory.
 */
const MAX_WORDS = 1024 * 1024;
/** How many session files the list reads at once. */
const LIST_READS = 4;
/** How many of its last messages a session's preview shows. */
const PREVIEW_MESSAGES = 6;
const PREVIEW_TEXT = 600;
const TITLE_LENGTH = 80;
/** What a tool call that never finished in Pi gets as its result. */
const NOT_RUN = "Not run: the Pi session ended before this call finished.";

/** A message of the copy, in order: what it is, and the entry of Pi's it comes from (none for a result made here). */
export type PiEntry =
    | { kind: "user" | "assistant" | "toolResult"; from?: string; message: Message }
    /** `head`: the first entry of Pi's the compaction keeps, or null when it keeps none. */
    | { kind: "compaction"; from: string; head: string | null; message: Message };

/** Pi's context edits on the current branch: the entry of Pi's they change, and its messages for Pi (none: left out). */
export type PiEdit = { target: string; messages: Message[] };

/** A Pi session as it continues here. */
export type PiSession = {
    id: string;
    cwd: string;
    title: string;
    /** Message entries in the file, as `pi -r` counts them: more later means Pi went on in the terminal. */
    count: number;
    model: { provider: string; modelId: string } | null;
    thinkingLevel: string;
    entries: PiEntry[];
    edits: PiEdit[];
};

/** One of Pi's sessions as listed: what Pi says of it, and what a search looks through (lower case). */
type PiListed = { info: SessionInfo; words: string };
/** A list's session: one of Pi's, or one of Claude Code's (PP-496). */
type Listed = PiListed | { claude: ClaudeListing; words: string };

/** A session file Pi Pocket cannot continue, and why, in words for people. */
export class PiSessionError extends Error {}

/** A session file's header as read: not yet known to be one. */
type Header = { type?: unknown; id?: unknown; cwd?: unknown; version?: number };

/** Whether a session file's header is one this Pi Pocket reads; why not, in words for people. */
function checkHeader(header: Header | undefined): asserts header is Header & { type: "session"; id: string } {
    if (header?.type !== "session" || typeof header.id !== "string") {
        throw new PiSessionError("This is not a Pi session file.");
    }

    if ((header.version ?? 1) > CURRENT_SESSION_VERSION) {
        throw new PiSessionError("A newer Pi wrote this session. Update pi-phone to continue it.");
    }
}

/**
 * An entry in the current format, as Pi's `migrateSessionEntries` gives it, one at a time: `n` is its place among the
 * file's entries (the header is 0). Files from before entries had ids (version 1) get ids made from their place, so
 * both reads of a file give an entry the same one; Pi makes random ones, which nothing outside one read sees.
 */
function migrateEntry(entry: FileEntry, n: number, version: number): SessionEntry {
    const raw = entry as unknown as Record<string, unknown>;

    if (version < 2) {
        raw.id = `e${n}`;
        raw.parentId = n === 1 ? null : `e${n - 1}`;

        if (raw.type === "compaction" && typeof raw.firstKeptEntryIndex === "number") {
            if (raw.firstKeptEntryIndex >= 1) {
                raw.firstKeptEntryId = `e${raw.firstKeptEntryIndex}`;
            }

            delete raw.firstKeptEntryIndex;
        }
    }

    if (version < 3 && raw.type === "message") {
        const message = raw.message as { role?: unknown } | undefined;

        if (message?.role === "hookMessage") {
            message.role = "custom";
        }
    }

    return entry as SessionEntry;
}

/**
 * What a session file's first read finds: its header, its current branch, and what Pi's context of it is, as Pi's
 * `buildSessionProjection` finds them. The branch is kept as numbers (where each entry is in the file, how long, its
 * place among the entries), so a branch of hundreds of thousands of entries takes a few megabytes.
 */
export type PiIndex = {
    id: string;
    cwd: string;
    version: number;
    /** Message entries in the file, as `pi -r` counts them. */
    count: number;
    /** Its latest name, as `pi -r` shows it. */
    name: string | undefined;
    model: { provider: string; modelId: string } | null;
    thinkingLevel: string;
    /** The current branch, first to last: each entry's line in the file (start, length) and place among the entries. */
    branch: { at: number[]; size: number[]; place: number[] };
    /** Each compaction's first kept entry, by their places on the branch (-1: none there). */
    firstKept: Map<number, number>;
    /** The context edit Pi applies to an entry of its context, by the entry's place on the branch. */
    edits: Map<number, ContextEditEntry>;
};

/**
 * Builds a `PiIndex` from a file's entries, given one at a time in order, keeping of each only numbers and the few
 * entries that change the context (compactions' kept entry, context edits, model and thinking changes).
 */
class PiIndexer {
    // Every entry's place by its id, while the file is read.
    readonly #places = new Map<string, number>();
    // Each entry's parent's place (-1: none), or, for a parent not read yet, its id.
    readonly #parents: number[] = [];
    readonly #later = new Map<number, string>();
    readonly #at: number[] = [];
    readonly #size: number[] = [];
    // The model an entry picks (model changes, and assistant messages, which answer with one), as a number.
    readonly #models: number[] = [];
    readonly #modelList: { provider: string; modelId: string }[] = [];
    readonly #modelNumbers = new Map<string, number>();
    readonly #thinking = new Map<number, string>();
    readonly #compactions = new Map<number, string>();
    readonly #edits = new Map<number, ContextEditEntry>();
    #count = 0;
    #name: string | undefined;

    /** The next entry, migrated, with its line's start and length. */
    add(entry: SessionEntry, at: number, size: number): void {
        const place = this.#at.length;
        const parent = entry.parentId === null ? -1 : this.#places.get(entry.parentId);

        this.#places.set(entry.id, place);
        this.#at.push(at);
        this.#size.push(size);

        if (parent === undefined) {
            this.#parents.push(-1);
            this.#later.set(place, entry.parentId!);
        } else {
            this.#parents.push(parent);
        }

        let model: { provider: string; modelId: string } | undefined;

        if (entry.type === "message") {
            this.#count += 1;

            if (entry.message.role === "assistant") {
                model = { provider: entry.message.provider, modelId: entry.message.model };
            }
        } else if (entry.type === "model_change") {
            model = { provider: entry.provider, modelId: entry.modelId };
        } else if (entry.type === "thinking_level_change") {
            this.#thinking.set(place, entry.thinkingLevel);
        } else if (entry.type === "compaction") {
            this.#compactions.set(place, entry.firstKeptEntryId);
        } else if (entry.type === "context_edit") {
            this.#edits.set(place, entry);
        } else if (entry.type === "session_info") {
            this.#name = entry.name?.trim() || undefined;
        }

        if (model === undefined) {
            this.#models.push(0);
        } else {
            const key = `${model.provider}\n${model.modelId}`;
            let number = this.#modelNumbers.get(key);

            if (number === undefined) {
                this.#modelList.push(model);
                number = this.#modelList.length;
                this.#modelNumbers.set(key, number);
            }

            this.#models.push(number);
        }
    }

    /**
     * The index: the branch from the last entry back along `parentId` (a file whose entries lead back to one already
     * passed is damaged: Pi's own walk along them would never end), and Pi's context of it, as
     * `buildSessionProjection` and `buildContextEntries` find it.
     */
    finish(header: Header & { id: string }): PiIndex {
        const total = this.#at.length;

        for (const [place, id] of this.#later) {
            this.#parents[place] = this.#places.get(id) ?? -1;
        }

        const places: number[] = [];

        for (let place = total - 1; place !== -1; place = this.#parents[place]!) {
            if (places.length >= total) {
                throw new PiSessionError("This Pi session file is damaged: its entries lead in a circle.");
            }

            places.push(place);
        }

        places.reverse();
        // Each entry's place on the branch, -1 off it.
        const onBranch = new Int32Array(total).fill(-1);

        places.forEach((place, index) => {
            onBranch[place] = index;
        });
        const branchOf = (id: string) => {
            const place = this.#places.get(id);

            return place === undefined ? -1 : onBranch[place]!;
        };
        let model: PiIndex["model"] = null;
        let thinkingLevel = "off";
        let latest = -1;
        const firstKept = new Map<number, number>();

        places.forEach((place, index) => {
            const number = this.#models[place]!;

            if (number > 0) {
                model = this.#modelList[number - 1]!;
            }

            thinkingLevel = this.#thinking.get(place) ?? thinkingLevel;
            const kept = this.#compactions.get(place);

            if (kept !== undefined) {
                const start = branchOf(kept);

                firstKept.set(index, start < index ? start : -1);
                latest = index;
            }
        });
        // Pi's context: everything, or the latest compaction, the entries it keeps before it, and all after it.
        const keptFrom = latest === -1 ? 0 : firstKept.get(latest)!;
        const inContext = (index: number) =>
            latest === -1 || index >= latest || (keptFrom !== -1 && index >= keptFrom);
        const edits = new Map<number, ContextEditEntry>();

        // As Pi applies them: the last edit of an entry, both in its context.
        places.forEach((place, index) => {
            const edit = this.#edits.get(place);
            const target = edit === undefined ? -1 : branchOf(edit.targetId);

            if (edit !== undefined && inContext(index) && target !== -1 && inContext(target)) {
                edits.set(target, edit);
            }
        });

        return {
            id: header.id,
            cwd: typeof header.cwd === "string" ? header.cwd : "",
            version: header.version ?? 1,
            count: this.#count,
            name: this.#name,
            model,
            thinkingLevel,
            branch: {
                at: places.map((place) => this.#at[place]!),
                size: places.map((place) => this.#size[place]!),
                place: places,
            },
            firstKept,
            edits,
        };
    }
}

/**
 * A session file's first read, a line at a time: its header checked, and every entry's place, without its messages.
 * A line that is not JSON (a last one cut off while Pi writes it) is left out, as Pi reads it.
 */
export async function indexPiSession(source: ByteSource): Promise<PiIndex> {
    let header: (Header & { id: string }) | undefined;
    const indexer = new PiIndexer();
    let n = 0;

    for await (const line of linesOf(source)) {
        const parsed = parseLine(line.bytes) as FileEntry | undefined;

        if (parsed === undefined) {
            continue;
        }

        if (header === undefined) {
            checkHeader(parsed as Header);
            header = parsed as Header & { id: string };
            continue;
        }

        n += 1;
        indexer.add(migrateEntry(parsed, n, header.version ?? 1), line.at, line.bytes.length);
    }

    checkHeader(header);

    return indexer.finish(header);
}

/** What an entry of Pi's gives the model, as Pi sends it; Pi's system messages stay behind for Pi Pocket's own. */
function forModel(messages: Parameters<typeof convertToLlm>[0]): Message[] {
    return convertToLlm(messages).filter((message) => message.role !== "system");
}

/** The text of a message's text parts; none for a message without content, which old or edited files can have. */
function textOf(message: Message): string {
    if (typeof message.content === "string") {
        return message.content;
    }

    if (!Array.isArray(message.content)) {
        return "";
    }

    return message.content
        .flatMap((part) => (part.type === "text" ? [part.text] : []))
        .join("\n")
        .trim();
}

/**
 * The current branch made into the copy's messages, one entry at a time in order, as `add` is given each whole with
 * its place on the branch: only what later entries need of earlier ones is kept, so a branch of any length goes
 * through in little memory.
 */
class BranchCopy {
    readonly #editsOf: Map<number, ContextEditEntry>;
    // The compactions that keep entries, by where their first kept entry is, in order: each keeps from the first entry
    // there or after it that became a message here, as Pi keeps them up to the compaction.
    readonly #starts: { start: number; compaction: number }[];
    #nextStart = 0;
    #lastCopied = -1;
    // Each such compaction's first kept entry, by the compaction's place on the branch.
    readonly #heads = new Map<number, string>();
    // The entries of Pi's a later entry of the copy refers to (a compaction's head, an edit's target).
    readonly #wanted = new Set<string>();
    // Tool calls of the last assistant message without a result yet.
    readonly #open = new Map<string, { name: string; timestamp: number }>();
    /** Pi's context edits met so far. */
    readonly edits: PiEdit[] = [];
    /** The first line of what the branch first asks, for a title. */
    firstAsked: string | undefined;

    constructor(index: PiIndex) {
        this.#editsOf = index.edits;
        this.#starts = [...index.firstKept]
            .flatMap(([compaction, start]) => (start === -1 ? [] : [{ start, compaction }]))
            .sort((a, b) => a.start - b.start);
    }

    /** Whether a later entry of the copy refers to this entry of Pi's: the conversation's entry for it is kept. */
    wanted(from: string): boolean {
        return this.#wanted.has(from);
    }

    /** The entry at `index` on the branch became a message here: the first kept of the compactions that start by it. */
    #copied(entry: SessionEntry, index: number): void {
        if (this.#lastCopied === index) {
            return;
        }

        this.#lastCopied = index;

        for (; this.#nextStart < this.#starts.length && this.#starts[this.#nextStart]!.start <= index; this.#nextStart += 1) {
            const { compaction } = this.#starts[this.#nextStart]!;

            if (index < compaction) {
                this.#heads.set(compaction, entry.id);
                this.#wanted.add(entry.id);
            }
        }
    }

    /** The copy's messages from the branch's entry at `index`, given whole. */
    add(entry: SessionEntry, index: number): PiEntry[] {
        const out: PiEntry[] = [];

        if (entry.type === "compaction") {
            const summary = forModel(sessionEntryToContextMessages(entry))[0];

            if (summary !== undefined) {
                out.push({ kind: "compaction", from: entry.id, head: this.#heads.get(index) ?? null, message: summary });
            }

            return out;
        }

        if (entry.type !== "message" && entry.type !== "custom_message" && entry.type !== "branch_summary") {
            return out;
        }

        if (this.firstAsked === undefined && entry.type === "message" && entry.message.role === "user") {
            this.firstAsked = textOf(entry.message as Message).split("\n")[0]!;
        }

        const own = forModel(sessionEntryToContextMessages(entry));
        const edit = this.#editsOf.get(index);

        // Where Pi's context of an entry differs from the entry, a context edit changed it: the copy edits it the same
        // way. Pi's own projection of the entry with its edit says how.
        if (edit !== undefined && own.length > 0) {
            const projected = buildSessionProjection(
                [{ ...entry, parentId: null }, { ...edit, parentId: entry.id }],
                edit.id,
            );
            const seen = forModel(projected.entries[0]?.messages ?? []);

            if (JSON.stringify(own) !== JSON.stringify(seen)) {
                this.edits.push({ target: entry.id, messages: seen });
                this.#wanted.add(entry.id);
            }
        }

        for (const message of own) {
            this.#copied(entry, index);

            if (message.role === "toolResult") {
                this.#open.delete(message.toolCallId);
                out.push({ kind: "toolResult", from: entry.id, message });
                continue;
            }

            this.#closeOpen(out);

            if (message.role === "assistant") {
                for (const part of message.content) {
                    if (part.type === "toolCall") {
                        this.#open.set(part.id, { name: part.name, timestamp: message.timestamp });
                    }
                }

                out.push({ kind: "assistant", from: entry.id, message });
            } else if (message.role === "user") {
                out.push({ kind: "user", from: entry.id, message });
            }
        }

        return out;
    }

    /** The results of the last tool calls that never got one. */
    finish(): PiEntry[] {
        const out: PiEntry[] = [];

        this.#closeOpen(out);

        return out;
    }

    #closeOpen(out: PiEntry[]): void {
        for (const [toolCallId, call] of this.#open) {
            out.push({
                kind: "toolResult",
                message: {
                    role: "toolResult",
                    toolCallId,
                    toolName: call.name,
                    content: [{ type: "text", text: NOT_RUN }],
                    isError: true,
                    timestamp: call.timestamp,
                },
            });
        }

        this.#open.clear();
    }
}

/** A session's title as `pi -r` names it: its latest name, or what it was first asked. */
function sessionTitle(name: string | undefined, firstAsked: string | undefined): string {
    return name || (firstAsked ?? "").slice(0, TITLE_LENGTH).trim() || "Pi session";
}

/** A Pi session's file, read whole from its text: the conversation on its current branch, and Pi's context of it. */
export function readPiSession(text: string): PiSession {
    let header: (Header & { id: string }) | undefined;
    const all: SessionEntry[] = [];

    for (const line of text.split("\n")) {
        const parsed = parseLine(line) as FileEntry | undefined;

        if (parsed === undefined) {
            continue;
        }

        if (header === undefined) {
            checkHeader(parsed as Header);
            header = parsed as Header & { id: string };
            continue;
        }

        all.push(migrateEntry(parsed, all.length + 1, header.version ?? 1));
    }

    checkHeader(header);
    const indexer = new PiIndexer();

    for (const entry of all) {
        indexer.add(entry, 0, 0);
    }

    const index = indexer.finish(header);
    const copy = new BranchCopy(index);
    const entries = [...index.branch.place.flatMap((place, at) => copy.add(all[place]!, at)), ...copy.finish()];

    return {
        id: index.id,
        cwd: index.cwd,
        title: sessionTitle(index.name, copy.firstAsked),
        count: index.count,
        model: index.model,
        thinkingLevel: index.thinkingLevel,
        entries,
        edits: copy.edits,
    };
}

/**
 * A Pi session's file, continued a part at a time (`batches`): its index from the first read, then its branch read
 * again from the file, in order. After the batches, `edits` and `title` hold what the whole branch says.
 */
export class PiSessionCopy {
    readonly index: PiIndex;
    readonly #source: ByteSource;
    readonly #copy: BranchCopy;

    constructor(source: ByteSource, index: PiIndex) {
        this.#source = source;
        this.index = index;
        this.#copy = new BranchCopy(index);
    }

    get edits(): PiEdit[] {
        return this.#copy.edits;
    }

    get title(): string {
        return sessionTitle(this.index.name, this.#copy.firstAsked);
    }

    /** Whether a later entry of the copy refers to this entry of Pi's (`BranchCopy.wanted`). */
    wanted(from: string): boolean {
        return this.#copy.wanted(from);
    }

    /** The copy's messages, about `bytes` of the file's lines at a time. */
    async *batches(bytes = COMMIT_BYTES): AsyncGenerator<PiEntry[]> {
        const { branch, version } = this.index;
        const reader = new LineReader(this.#source);
        let batch: PiEntry[] = [];
        let size = 0;

        for (let index = 0; index < branch.place.length; index += 1) {
            const line = await reader.line(branch.at[index]!, branch.size[index]!);
            const entry = line === undefined ? undefined : (parseLine(line) as FileEntry | undefined);

            // Each line was an entry when the file was first read.
            if (entry === undefined) {
                throw new PiSessionError("This Pi session file changed while it was read. Try again.");
            }

            batch.push(...this.#copy.add(migrateEntry(entry, branch.place[index]! + 1, version), index));
            size += branch.size[index]!;

            if (size >= bytes) {
                yield batch;
                batch = [];
                size = 0;
            }
        }

        reader.release();
        batch.push(...this.#copy.finish());

        if (batch.length > 0) {
            yield batch;
        }
    }

    close(): Promise<void> {
        return this.#source.close();
    }
}

/** What a preview shows of a session's current branch: its model, and its last messages with text, in order. */
type Tail = {
    model: { provider: string; modelId: string } | null;
    last: { role: "user" | "assistant"; text: string }[];
};

/** The last messages of people and the agent with text, for a preview. */
function lastTexts(entries: readonly PiEntry[]): Tail["last"] {
    return entries
        .flatMap((entry) => {
            if (entry.kind !== "user" && entry.kind !== "assistant") {
                return [];
            }

            const text = textOf(entry.message);

            return text === "" ? [] : [{ role: entry.kind, text: text.slice(0, PREVIEW_TEXT) }];
        })
        .slice(-PREVIEW_MESSAGES);
}

/** A file's first entry, as Pi reads it: its first line that is JSON. */
async function firstEntry(source: ByteSource): Promise<Header | undefined> {
    for await (const line of linesOf(source)) {
        const parsed = parseLine(line.bytes) as Header | undefined;

        if (parsed !== undefined) {
            return parsed;
        }
    }

    return undefined;
}

/**
 * A session's tail, read from the end of its file: its current branch goes back from the last entry along
 * `parentId`, and a parent is always written before its children, so a walk back through the file finds the branch
 * in order and stops at the last few messages. Files from before entries had ids (version 1) are read through, a part
 * at a time.
 */
export async function readPiTail(source: ByteSource): Promise<Tail> {
    const header = await firstEntry(source);

    checkHeader(header);

    if ((header.version ?? 1) < 2) {
        const copy = new PiSessionCopy(source, await indexPiSession(source));
        let last: Tail["last"] = [];

        for await (const batch of copy.batches()) {
            last = [...last, ...lastTexts(batch)].slice(-PREVIEW_MESSAGES);
        }

        return { model: copy.index.model, last };
    }

    let want: string | undefined;
    let model: Tail["model"] = null;
    const last: Tail["last"] = [];

    for await (const line of linesFromEnd(source)) {
        const entry = parseLine(line) as SessionEntry | { type: "session" } | undefined;

        // A line cut off, as a `pi` still writing it leaves it: as Pi reads it, it is not there.
        if (entry === undefined) {
            continue;
        }

        if (entry.type === "session") {
            break;
        }

        want ??= entry.id;

        if (entry.id !== want) {
            continue;
        }

        if (model === null && entry.type === "model_change") {
            model = { provider: entry.provider, modelId: entry.modelId };
        } else if (model === null && entry.type === "message" && entry.message.role === "assistant") {
            model = { provider: entry.message.provider, modelId: entry.message.model };
        }

        if (
            last.length < PREVIEW_MESSAGES &&
            (entry.type === "message" || entry.type === "custom_message" || entry.type === "branch_summary")
        ) {
            const texts = lastTexts(
                forModel(sessionEntryToContextMessages(entry)).map((message) => ({
                    kind: message.role as PiEntry["kind"],
                    message,
                })) as PiEntry[],
            );

            last.unshift(...texts.slice(-(PREVIEW_MESSAGES - last.length)));
        }

        if ((last.length >= PREVIEW_MESSAGES && model !== null) || entry.parentId === null) {
            break;
        }

        want = entry.parentId;
    }

    return { model, last };
}

/**
 * Write messages of a Pi session's copy into a conversation, after what it has: `made` gets, and finds, the
 * conversation's entry for each of Pi's entries written that `keep` says a later one refers to; `known` finds one
 * written before (`pi-handoff.ts`), which a compaction may keep. Answers the last entry written.
 */
export async function writePiEntries(
    tx: Tx,
    id: ConversationId,
    entries: readonly PiEntry[],
    made: Map<string, EntryId>,
    { known = () => undefined, keep = () => true }: { known?: (from: string) => EntryId | undefined; keep?: (from: string) => boolean } = {},
): Promise<EntryId | undefined> {
    let last: EntryId | undefined;

    for (const entry of entries) {
        const head = entry.kind === "compaction" && entry.head !== null ? (made.get(entry.head) ?? known(entry.head)) : undefined;

        if (entry.kind === "compaction" && entry.head !== null && head === undefined) {
            throw new PiSessionError("Pi's compaction keeps a message this session does not have.");
        }

        const written =
            entry.kind === "compaction"
                ? await tx.appendEntry(CompactionEntry, id, {
                      model: [entry.message],
                      // A kept entry is written before its compaction, as Pi keeps them.
                      head: head ?? "self",
                      data: { reason: "threshold" },
                  })
                : entry.kind === "toolResult"
                  ? await tx.appendEntry(ToolResultEntry, id, {
                        model: [entry.message],
                        data: { diagnostics: [] },
                    })
                  : await tx.appendEntry(entry.kind === "user" ? UserEntry : AssistantEntry, id, {
                        model: [entry.message],
                    });

        if (entry.from !== undefined && !made.has(entry.from) && keep(entry.from)) {
            made.set(entry.from, written.id);
        }

        last = written.id;
    }

    return last;
}

/** Where a copy came from, after every entry it edits: Pi's context edits, made on the entries written for them. */
export async function writeFromPi(
    tx: Tx,
    id: ConversationId,
    edits: readonly PiEdit[],
    data: FromPiData,
    find: (from: string) => EntryId | undefined,
): Promise<void> {
    const made: ContextEdit[] = edits.flatMap(({ target, messages }) => {
        const entry = find(target);

        if (entry === undefined) {
            return [];
        }

        return [
            messages.length === 0
                ? { target: entry, action: "omit" as const }
                : { target: entry, action: "replace" as const, messages },
        ];
    });

    // Last, after every entry it edits; it adds nothing for Pi itself.
    await tx.appendEntry(id, {
        kind: FROM_PI_ENTRY,
        data,
        ...(made.length === 0 ? {} : { edits: made }),
    });
}

/**
 * Write a Pi session's copy, read whole, into a conversation: its messages, then where it came from. Or, to bring back
 * what Pi did after a session went to Pi (`pi-handoff.ts`), only `entries`, after what the conversation has: `known`
 * then finds the conversation's entry for an entry of Pi's written before, which a compaction may keep or an edit
 * change. Answers the last entry written with messages for the model.
 */
export async function writePiSession(
    tx: Tx,
    id: ConversationId,
    session: PiSession,
    data: FromPiData,
    { entries = session.entries, known = () => undefined }: { entries?: readonly PiEntry[]; known?: (from: string) => EntryId | undefined } = {},
): Promise<EntryId | undefined> {
    const made = new Map<string, EntryId>();
    const last = await writePiEntries(tx, id, entries, made, { known });

    await writeFromPi(tx, id, session.edits, data, (from) => made.get(from) ?? known(from));

    return last;
}

/** A message's text as Pi's list reads it: its text parts, joined by spaces. */
function listedText(message: { content?: unknown }): string {
    const content = message.content;

    if (typeof content === "string") {
        return content;
    }

    return Array.isArray(content)
        ? content.flatMap((part: { type?: unknown; text?: unknown }) => (part.type === "text" && typeof part.text === "string" ? [part.text] : [])).join(" ")
        : "";
}

/**
 * What Pi's list (`SessionManager.listAll`) says of a session file, read a line at a time as Pi reads it, with the
 * words a search looks through: its name, folder and first message, and its messages' text up to `MAX_WORDS`.
 * Undefined for a file that is not a Pi session, or cannot be read.
 */
async function listedInfo(path: string, mtime: Date): Promise<PiListed | undefined> {
    let source: ByteSource;

    try {
        source = await localSource(path);
    } catch {
        return undefined;
    }

    try {
        let header: (Header & { timestamp?: unknown; parentSession?: unknown }) | undefined;
        let name: string | undefined;
        let count = 0;
        let firstMessage = "";
        let lastActivity: number | undefined;
        const texts: string[] = [];
        let textLength = 0;

        for await (const line of linesOf(source)) {
            const entry = parseLine(line.bytes) as
                | { type?: unknown; name?: unknown; timestamp?: unknown; message?: { role?: unknown; content?: unknown; timestamp?: unknown } }
                | undefined;

            if (entry === undefined) {
                continue;
            }

            if (header === undefined) {
                if (entry.type !== "session") {
                    return undefined;
                }

                header = entry as Header & { timestamp?: unknown; parentSession?: unknown };
                continue;
            }

            if (entry.type === "session_info") {
                name = (typeof entry.name === "string" ? entry.name.trim() : "") || undefined;
            }

            const message = entry.message;

            if (entry.type !== "message" || message === undefined) {
                continue;
            }

            count += 1;

            if (typeof message.role !== "string" || !("content" in message) || (message.role !== "user" && message.role !== "assistant")) {
                continue;
            }

            const at = typeof message.timestamp === "number" ? message.timestamp : new Date(String(entry.timestamp)).getTime();

            if (!Number.isNaN(at)) {
                lastActivity = Math.max(lastActivity ?? 0, at);
            }

            const text = listedText(message);

            if (text === "") {
                continue;
            }

            if (firstMessage === "" && message.role === "user") {
                firstMessage = text;
            }

            if (textLength < MAX_WORDS) {
                texts.push(text.slice(0, MAX_WORDS - textLength));
                textLength += text.length;
            }
        }

        if (header === undefined) {
            return undefined;
        }

        const cwd = typeof header.cwd === "string" ? header.cwd : "";
        const started = new Date(String(header.timestamp));
        const info: SessionInfo = {
            path,
            id: String(header.id),
            cwd,
            ...(name === undefined ? {} : { name }),
            ...(typeof header.parentSession === "string" ? { parentSessionPath: header.parentSession } : {}),
            created: started,
            modified:
                lastActivity !== undefined && lastActivity > 0
                    ? new Date(lastActivity)
                    : Number.isNaN(started.getTime())
                      ? mtime
                      : started,
            messageCount: count,
            firstMessage: firstMessage || "(no messages)",
            allMessagesText: "",
        };

        return { info, words: [name ?? "", cwd, firstMessage, texts.join(" ")].join("\n").toLowerCase() };
    } catch {
        return undefined;
    } finally {
        await source.close();
    }
}

/**
 * Pi's sessions as `SessionManager.listAll` finds them, newest first: the `.jsonl` files of `custom`, or of every
 * folder in Pi's sessions folder. Read a few at a time, each a line at a time (`listedInfo`).
 */
async function listPiSessions(custom: string | undefined): Promise<PiListed[]> {
    let folders: string[];

    if (custom !== undefined) {
        folders = [custom];
    } else {
        const root = join(getAgentDir(), "sessions");

        folders = (await readdir(root, { withFileTypes: true }).catch(() => []))
            .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
            .map((entry) => join(root, entry.name));
    }

    const files: { path: string; mtime: Date }[] = [];

    for (const folder of folders) {
        for (const name of await readdir(folder).catch(() => [])) {
            if (name.endsWith(".jsonl")) {
                const path = join(folder, name);
                const info = await stat(path).catch(() => undefined);

                if (info?.isFile()) {
                    files.push({ path, mtime: info.mtime });
                }
            }
        }
    }

    const found: PiListed[] = [];
    let next = 0;
    const reader = async () => {
        while (next < files.length) {
            const file = files[next++]!;
            const listed = await listedInfo(file.path, file.mtime);

            if (listed !== undefined) {
                found.push(listed);
            }
        }
    };

    await Promise.all(Array.from({ length: LIST_READS }, reader));

    return found.sort((a, b) => b.info.modified.getTime() - a.info.modified.getTime());
}

/** A session's title as `pi -r` shows it: its name, or the first line of what it was first asked. */
function titleOf(info: SessionInfo): string {
    const first = info.firstMessage.split("\n")[0]!.slice(0, TITLE_LENGTH).trim();

    return info.name ?? (first || "Pi session");
}

/** A Pi session as the list shows it, or a Claude Code one (PP-496). */
export type PiSessionSummary = {
    path: string;
    title: string;
    cwd: string;
    modified: number;
    /** A Pi session's messages. */
    messages?: number;
    /** A Claude Code session (`claude-sessions.ts`): its file's size. It continues converted (`importClaude`). */
    claudeCode?: { size: number };
    /** A Pi session converted from a Claude Code one. */
    fromClaudeCode?: true;
    /** The newest session here that continues it, and whether Pi went on in the terminal since. */
    pocket?: { id: number; behind: boolean };
};

/** Finding Pi's sessions, and reading one, for the owner. */
export class PiSessions {
    readonly #app: PocketApp;

    constructor(app: PocketApp) {
        this.#app = app;
    }

    /**
     * The last list, for a few seconds: reading every session's file again for each look, or each letter of a search,
     * is slow with many. It holds the words of every session, so it is let go when its time is up.
     */
    #found: { at: number; list: Promise<Listed[]> } | undefined;

    /**
     * Pi's sessions, newest first, as `pi -r` lists them all, each with what a search looks through, in lower case:
     * made once per list, not for every letter typed. `fresh` reads them again. Pi's own `SessionManager.listAll` is
     * not used: it keeps every session's whole text (PP-486).
     */
    #find(fresh = true): Promise<Listed[]> {
        if (!fresh && this.#found !== undefined && Date.now() - this.#found.at < FOUND_FOR_MS) {
            return this.#found.list;
        }

        const list = Promise.all([listPiSessions(this.#customFolder()), listClaudeHere(this.#app.home, MAX_LISTED)]).then(
            ([pi, claude]): Listed[] => [
                ...pi,
                ...claude.map((each) => ({ claude: each, words: `${each.title}\n${each.cwd}`.toLowerCase() })),
            ],
        );
        const found = { at: Date.now(), list };

        this.#found = found;
        setTimeout(() => {
            if (this.#found === found) {
                this.#found = undefined;
            }
        }, FOUND_FOR_MS).unref();
        // A list that failed is not kept.
        list.catch(() => {
            if (this.#found === found) {
                this.#found = undefined;
            }
        });

        return list;
    }

    /** The newest session here that continues each of Pi's, by its id. */
    #continued(): Map<string, { id: number; count: number }> {
        const found = new Map<string, { id: number; count: number }>();

        // Newest first: the first one seen of each is the one to open.
        for (const session of this.#app.sessions()) {
            const from = this.#app.sessionMeta(session.id as unknown as ConversationId)?.fromPi;

            if (from !== undefined && !found.has(from.session)) {
                found.set(from.session, { id: session.id, count: from.count });
            }
        }

        return found;
    }

    /**
     * A sessions folder of the owner's choosing (`PI_CODING_AGENT_SESSION_DIR`, or Pi's setting), whose files Pi lists
     * as they are; undefined for Pi's own, `sessions/` in its agent folder, whose folders (one per working folder) Pi
     * lists.
     */
    #customFolder(): string | undefined {
        let configured: string | undefined;

        try {
            configured = this.#app.settings.getSessionDir();
        } catch {
            // Unreadable settings: Pi's own folder.
        }

        return process.env[SESSION_DIR_VARIABLE] || configured || undefined;
    }

    /**
     * Keep a session file with Pi's sessions, where the list finds it, under `name` (a file of the same name is
     * replaced): `write` writes it to a file beside it first, whose header is checked as Pi would read it; the rest is
     * checked as it continues. Answers its path.
     */
    async #keep(name: string, write: (path: string) => Promise<void>): Promise<{ path: string }> {
        const file = basename(name).replace(/[^\w.-]/g, "_");

        if (!file.endsWith(".jsonl")) {
            throw new HttpError(400, "A Pi session file ends in .jsonl.");
        }

        const folder = this.#customFolder() ?? join(getAgentDir(), "sessions", IMPORTED);
        const path = join(folder, file);
        // Not a .jsonl: Pi's list does not see it while it is written.
        const part = `${path}.part`;

        await mkdir(folder, { recursive: true });

        try {
            await write(part);
            const source = await localSource(part);

            try {
                checkHeader(await firstEntry(source));
            } finally {
                await source.close();
            }

            await rename(part, path);
        } catch (error) {
            await rm(part, { force: true });

            if (error instanceof PiSessionError) {
                throw new HttpError(400, `This is not a Pi session file: ${error.message}`);
            }

            throw error;
        }

        this.#found = undefined;

        return { path };
    }

    /**
     * A Pi session file brought from elsewhere (another machine, Termux): its bytes, or a stream of them (an upload),
     * written as they come, never held whole. Answers its path.
     */
    async import(user: User, name: string, data: Buffer | AsyncIterable<Buffer>): Promise<{ path: string }> {
        this.#requireOwner(user);

        return this.#keep(name, (path) =>
            Buffer.isBuffer(data)
                ? writeFile(path, data, { mode: 0o600 })
                : pipeline(data, createWriteStream(path, { mode: 0o600 })),
        );
    }

    /**
     * Pi's sessions on a machine (`places.ts`): the `.jsonl` files under its `~/.pi/agent/sessions`, each with what its
     * first line says (id, folder) and, when found quickly, its first message as a title. Read through the machine's
     * environment, no pi needed there.
     */
    async listOnMachine(user: User, machineId: string): Promise<{ sessions: MachineSession[] }> {
        this.#requireOwner(user);
        const machine = this.#app.machines.ready(machineId);
        const home = machine.remote!.home;
        const env = this.#app.places.env(formatPlace({ machineId, path: home }));
        const failure = (what: string, error: { message: string }) =>
            new HttpError(502, `Could not read Pi's sessions on ${machine.name} (${what}): ${error.message}`);
        // Every folder's files, newest first by mtime, headers read for the first MAX_ON_MACHINE.
        const files = await filesBelow(env, `${home}/.pi/agent/sessions`, failure);
        // Claude Code's too (PP-496), its subagents' left out.
        const claude = (await filesBelow(env, `${home}/${CLAUDE_PROJECTS}`, failure)).filter((file) => claudeSlug(home, file.path) !== undefined);

        files.sort((a, b) => b.modified - a.modified);
        claude.sort((a, b) => b.modified - a.modified);
        const sessions: MachineSession[] = [];

        for (const file of files.slice(0, MAX_ON_MACHINE)) {
            // The header, and the first message for a title: the first lines only, not the whole file.
            const lines = await env.readTextLines(file.path, { maxLines: 8 }, context);

            if (!lines.ok || lines.value.length === 0) {
                continue;
            }

            let header: { type?: unknown; id?: unknown; cwd?: unknown };

            try {
                header = JSON.parse(lines.value[0]!) as typeof header;
            } catch {
                continue;
            }

            if (header.type !== "session" || typeof header.id !== "string" || typeof header.cwd !== "string") {
                continue;
            }

            let title = "Pi session";
            let phoneSession: number | undefined;

            for (const line of lines.value.slice(1)) {
                try {
                    const entry = JSON.parse(line) as {
                        type?: unknown;
                        customType?: unknown;
                        data?: { session?: unknown };
                        message?: { role?: unknown; content?: unknown };
                    };

                    // Written by Continue in Pi: the session's, while that session still points at this file.
                    if (entry.type === "custom" && entry.customType === LINK_TYPE && typeof entry.data?.session === "number") {
                        const linked = this.#app.sessionMeta(entry.data.session as unknown as ConversationId)?.piLink;

                        if (linked?.machineId === machineId && linked.path === file.path) {
                            phoneSession = entry.data.session;
                        }

                        continue;
                    }

                    if (entry.type === "message" && entry.message?.role === "user") {
                        const content = entry.message.content;
                        const text =
                            typeof content === "string"
                                ? content
                                : Array.isArray(content)
                                  ? (content.find((part) => (part as { type?: unknown }).type === "text") as { text?: string } | undefined)?.text ?? ""
                                  : "";
                        const first = text.split("\n")[0]!.slice(0, TITLE_LENGTH).trim();

                        if (first !== "") {
                            title = first;
                        }

                        break;
                    }
                } catch {
                    // A line that is not JSON: no title from it.
                }
            }

            sessions.push({
                path: file.path,
                id: header.id,
                cwd: header.cwd,
                title,
                modified: file.modified,
                size: file.size,
                ...(phoneSession === undefined ? {} : { phoneSession }),
            });
        }

        const continued = this.#continued();

        for (const file of claude.slice(0, MAX_ON_MACHINE)) {
            // Its id, folder and first request: the first lines only.
            const lines = await env.readTextLines(file.path, { maxLines: HEAD_LINES }, context);
            const head = lines.ok ? claudeHead(lines.value, claudeSlug(home, file.path)!) : undefined;

            if (head === undefined) {
                continue;
            }

            const here = continued.get(head.id);

            sessions.push({
                path: file.path,
                ...head,
                modified: file.modified,
                size: file.size,
                claudeCode: true,
                ...(here === undefined ? {} : { continuedIn: here.id }),
            });
        }

        return { sessions: sessions.sort((a, b) => b.modified - a.modified) };
    }

    /**
     * Copy a session file from a machine into the imported folder, a megabyte at a time, with where it came from beside
     * it, so continuing it defaults to its folder on that machine. Answers the path here.
     */
    async importFromMachine(user: User, machineId: string, path: unknown): Promise<{ path: string }> {
        this.#requireOwner(user);
        const machine = this.#app.machines.ready(machineId);

        if (typeof path !== "string" || !path.endsWith(".jsonl")) {
            throw new HttpError(400, "Choose one of the machine's session files.");
        }

        const env = this.#app.places.env(formatPlace({ machineId, path: machine.remote!.home }));
        const failed = (message: string) => new HttpError(502, `Could not read ${path} on ${machine.name}: ${message}`);
        const source = await envSource(env, path, context, failed);
        const slug = claudeSlug(machine.remote!.home, path);
        let imported: { path: string };

        try {
            // A Claude Code session is read where it is, and only its Pi session comes here (PP-496).
            if (slug !== undefined) {
                return await this.#convertClaude(source, slug, `claude-${machine.name}-${basename(path)}`, { machineId, path });
            }

            imported = await this.#keep(`${machine.name}-${basename(path)}`, (part) => copyOut(source, part));
        } finally {
            await source.close();
        }

        await writeFile(
            `${imported.path}${ORIGIN_SUFFIX}`,
            `${JSON.stringify({ machineId, path }, null, 2)}\n`,
            { mode: 0o600 },
        );

        return imported;
    }

    /**
     * A Claude Code session on this phone (`~/.claude/projects/<slug>/<id>.jsonl`), converted into a Pi session in the
     * imported folder, to continue as one. Answers its path.
     */
    async importClaude(user: User, path: unknown): Promise<{ path: string }> {
        this.#requireOwner(user);
        const file = typeof path === "string" ? resolve(path) : "";
        const slug = claudeSlug(this.#app.home, file);

        if (slug === undefined || file !== path) {
            throw new HttpError(400, "Choose one of Claude Code's sessions in ~/.claude/projects.");
        }

        const source = await this.#reading(() => localSource(file));

        try {
            return await this.#convertClaude(source, slug, `claude-phone-${basename(file)}`, { path: file });
        } finally {
            await source.close();
        }
    }

    /** Convert a Claude Code session into a Pi session kept as `name`, with where it came from and what continues. */
    async #convertClaude(
        source: ByteSource,
        slug: string,
        name: string,
        origin: { machineId?: string; path: string },
    ): Promise<{ path: string }> {
        let kept: ClaudeKept | undefined;
        const made = await this.#keep(name, async (part) => {
            const out = createWriteStream(part, { mode: 0o600 });
            const done = finished(out);

            try {
                kept = (
                    await convertClaude(source, slug, async (line) => {
                        if (!out.write(`${line}\n`)) {
                            await once(out, "drain");
                        }
                    })
                ).kept;
            } catch (error) {
                out.destroy();
                await done.catch(() => {});

                if (error instanceof ClaudeSessionError) {
                    throw new HttpError(400, error.message);
                }

                throw error;
            }

            out.end();
            await done;
        });

        await writeFile(`${made.path}${ORIGIN_SUFFIX}`, `${JSON.stringify({ ...origin, claudeCode: kept }, null, 2)}\n`, { mode: 0o600 });

        return made;
    }

    /** Where an imported file came from: a machine, and for one converted from Claude Code, what continues of it. */
    #originOf(path: string): { machineId?: string; path: string; claudeCode?: ClaudeKept } | undefined {
        const file = `${path}${ORIGIN_SUFFIX}`;

        if (!existsSync(file)) {
            return undefined;
        }

        return JSON.parse(readFileSync(file, "utf8")) as { machineId?: string; path: string; claudeCode?: ClaudeKept };
    }

    /** What continues of a Pi session converted from Claude Code's (`importClaude`), when it is one. */
    claudeKept(path: string): ClaudeKept | undefined {
        return this.#originOf(path)?.claudeCode;
    }

    #requireOwner(user: User): void {
        if (user.role !== "owner") {
            throw new HttpError(403, "Only the owner can continue Pi's sessions here.");
        }
    }

    /**
     * Pi's sessions on this machine, and Claude Code's (PP-496), newest first; with `query`, those whose title, folder,
     * or words have it.
     */
    async list(user: User, query = ""): Promise<{ sessions: PiSessionSummary[] }> {
        this.#requireOwner(user);
        const continued = this.#continued();
        const needle = query.trim().toLowerCase();
        const imported = resolve(this.#customFolder() ?? join(getAgentDir(), "sessions", IMPORTED));
        // Opening the list reads it again; a search narrows the one just read.
        const found = (await this.#find(needle === "")).filter((each) => needle === "" || each.words.includes(needle));
        const sessions = found.map((each): PiSessionSummary => {
            if ("claude" in each) {
                const { claude } = each;
                const pocket = continued.get(claude.id);

                return {
                    path: claude.path,
                    title: claude.title,
                    cwd: claude.cwd,
                    modified: claude.modified,
                    claudeCode: { size: claude.size },
                    ...(pocket === undefined ? {} : { pocket: { id: pocket.id, behind: false } }),
                };
            }

            const { info } = each;
            const pocket = continued.get(info.id);
            const fromClaudeCode = dirname(info.path) === imported && this.#originOf(info.path)?.claudeCode !== undefined;

            return {
                path: info.path,
                title: titleOf(info),
                cwd: info.cwd,
                modified: info.modified.getTime(),
                messages: info.messageCount,
                ...(fromClaudeCode ? { fromClaudeCode: true } : {}),
                ...(pocket === undefined
                    ? {}
                    : { pocket: { id: pocket.id, behind: !fromClaudeCode && info.messageCount > pocket.count } }),
            };
        });

        return { sessions: sessions.sort((a, b) => b.modified - a.modified).slice(0, MAX_LISTED) };
    }

    /** What Pi lists of one of its sessions: only a file Pi lists is read, so nothing else can be read through this. */
    async #listed(user: User, path: string): Promise<SessionInfo> {
        this.#requireOwner(user);

        const find = async (fresh: boolean) =>
            (await this.#find(fresh)).flatMap((each) => ("info" in each && each.info.path === path ? [each.info] : []))[0];
        // The list the sheet just showed, or, for a session new since, the list as it is now.
        const info = (await find(false)) ?? (await find(true));

        if (info === undefined) {
            throw new HttpError(404, "Pi has no such session. It may have been deleted.");
        }

        return info;
    }

    /** Read one of Pi's listed sessions with `read`, in words for people when it cannot be. */
    async #reading<T>(read: () => Promise<T>): Promise<T> {
        try {
            return await read();
        } catch (error) {
            // Gone since the list was read (it is kept a few seconds): as Pi not having it.
            if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
                throw new HttpError(404, "Pi has no such session. It may have been deleted.");
            }

            if (error instanceof PiSessionError) {
                throw new HttpError(400, error.message);
            }

            throw error;
        }
    }

    /**
     * Whether a file is where Pi's list looks (`listPiSessions`): a `.jsonl` in the owner's sessions folder, or in a
     * folder of Pi's own. Its header is checked as it is read, as the list checks it, so continuing a big session
     * does not read every session for the list first.
     */
    #requirePiFolder(user: User, path: string): void {
        this.#requireOwner(user);
        const custom = this.#customFolder();
        const file = resolve(path);
        const inFolder =
            custom === undefined
                ? dirname(dirname(file)) === resolve(getAgentDir(), "sessions")
                : dirname(file) === resolve(custom);

        if (file !== path || !inFolder || !file.endsWith(".jsonl")) {
            throw new HttpError(404, "Pi has no such session. It may have been deleted.");
        }
    }

    /**
     * One of Pi's sessions, to continue it: its first read done (the file checked, its branch found), its messages
     * read again as the copy goes. Close it after.
     */
    async open(user: User, path: string): Promise<PiSessionCopy> {
        this.#requirePiFolder(user, path);

        return this.#reading(async () => {
            const source = await localSource(path);

            try {
                return new PiSessionCopy(source, await indexPiSession(source));
            } catch (error) {
                await source.close();
                throw error;
            }
        });
    }

    /**
     * One of Pi's sessions, to decide whether to continue it: where it worked, and its last messages. Quick for a big
     * one: what Pi lists of it, and its file's end.
     */
    async preview(user: User, path: string) {
        const info = await this.#listed(user, path);
        const { model, last } = await this.#reading(async () => {
            const source = await localSource(path);

            try {
                return await readPiTail(source);
            } finally {
                await source.close();
            }
        });
        const pocket = this.#continued().get(info.id);
        // A session from a machine continues in its folder on that machine, when it is still there.
        const origin = this.#originOf(path);
        const machine = origin === undefined ? undefined : this.#app.machines.list().find((each) => each.id === origin.machineId);
        const place = machine === undefined ? info.cwd : formatPlace({ machineId: machine.id, path: info.cwd });
        let cwdExists = true;

        try {
            await this.#app.workspace.checkPlace(place);
        } catch {
            cwdExists = false;
        }

        const modelHere =
            model !== null &&
            this.#app.models
                .getAvailableSnapshot()
                .some((each) => each.provider === model.provider && each.id === model.modelId);

        return {
            path,
            title: titleOf(info),
            cwd: place,
            cwdExists,
            ...(machine === undefined ? {} : { machine: { id: machine.id, name: machine.name } }),
            messages: info.messageCount,
            model: model === null ? null : `${model.provider}/${model.modelId}`,
            modelHere,
            last,
            // Converted from Claude Code: what continues of it, for the card to say.
            ...(origin?.claudeCode === undefined ? {} : { claudeCode: origin.claudeCode }),
            ...(pocket === undefined
                ? {}
                : { pocket: { id: pocket.id, behind: origin?.claudeCode === undefined && info.messageCount > pocket.count } }),
        };
    }
}

/**
 * The files in the folders of `root` (not deeper) in an environment, a machine's: `.jsonl` files with their time and
 * size. None when `root` is not there.
 */
async function filesBelow(
    env: ExecutionEnv,
    root: string,
    failure: (what: string, error: { message: string }) => Error,
): Promise<{ path: string; modified: number; size: number }[]> {
    const exists = await env.exists(root, context);

    if (!exists.ok) {
        throw failure(root, exists.error);
    }

    if (!exists.value) {
        return [];
    }

    const files: { path: string; modified: number; size: number }[] = [];
    const folders = await env.openDirReader(root, context);

    if (!folders.ok) {
        throw failure(root, folders.error);
    }

    try {
        for (;;) {
            const page = await folders.value.next(500, context);

            if (!page.ok) {
                throw failure(root, page.error);
            }

            for (const folder of page.value.entries) {
                if (folder.kind !== "directory") {
                    continue;
                }

                const inside = await env.openDirReader(folder.path, context);

                if (!inside.ok) {
                    continue;
                }

                try {
                    for (;;) {
                        const filesPage = await inside.value.next(500, context);

                        if (!filesPage.ok) {
                            break;
                        }

                        for (const file of filesPage.value.entries) {
                            if (file.kind === "file" && file.name.endsWith(".jsonl")) {
                                files.push({ path: file.path, modified: file.mtimeMs, size: file.size });
                            }
                        }

                        if (filesPage.value.done) {
                            break;
                        }
                    }
                } finally {
                    await inside.value.close(context);
                }
            }

            if (page.value.done) {
                break;
            }
        }
    } finally {
        await folders.value.close(context);
    }

    return files;
}

/** Copy a file out of `source` to `path` here, a chunk at a time. */
async function copyOut(source: ByteSource, path: string): Promise<void> {
    async function* chunks(): AsyncGenerator<Buffer> {
        for (let at = 0; at < source.size; ) {
            const chunk = await source.read(at, Math.min(CHUNK, source.size - at));

            if (chunk.length === 0) {
                break;
            }

            yield chunk;
            at += chunk.length;
        }
    }

    await pipeline(chunks(), createWriteStream(path, { mode: 0o600 }));
}
