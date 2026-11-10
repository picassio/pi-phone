/**
 * Claude Code's sessions, continued here (PP-496): Claude Code keeps each in `~/.claude/projects/<folder slug>/<id>.jsonl`
 * (on this phone or a machine), a file of its own format. One continues as a Pi session file made from it, written
 * beside Pi's imported ones (`pi-sessions.ts`), which then continues as any Pi session; the original is only read.
 *
 * Claude Code's file: its own records (mode, permission-mode, file-history-snapshot, ai-title, api requests,
 * attachments) and the conversation, each entry with a `uuid` and its `parentUuid`. An answer of the model is written a
 * part at a time, one entry per text, thinking or tool call, all with its `message.id`; parallel tool calls hang off
 * the first one's entry, so the current branch is the walk back from the last entry along `parentUuid` and the entries
 * of the same answer or with tool results next to it. A compaction starts the walk anew: a `compact_boundary` entry
 * without a parent, then the summary as a user entry (`isCompactSummary`), and the messages it keeps
 * (`preservedMessages`) are the ones before it. Subagents' entries (`isSidechain`) stay out.
 *
 * What continues: the branch from its last compaction (its summary, the messages it keeps, and all after it), or all
 * of it when there was none. When that is more than `KEEP_CHARACTERS` of text, its last turns that fit continue, with
 * a summary made here of what came before: Claude Code's summary and the requests left out. The file is read twice, a
 * line at a time (`session-lines.ts`): the first read keeps numbers for each entry, the second reads only what
 * continues, so a session of hundreds of megabytes is not held.
 */
import { readdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path/posix";
import type {
    AssistantMessage,
    ImageContent,
    TextContent,
    ThinkingContent,
    ToolCall,
    ToolResultMessage,
    Usage,
    UserMessage,
} from "@earendil-works/pi-ai";
import { type ByteSource, LineReader, linesOf, localSource, parseLine } from "./session-lines.ts";

/** Where Claude Code keeps its sessions, in a home folder. */
export const CLAUDE_PROJECTS = ".claude/projects";
/** How much of a session's text continues as the model's context at most (about 100,000 tokens). */
export const KEEP_CHARACTERS = 400_000;
/** What an image counts as, against `KEEP_CHARACTERS`: a model reads one as about 1,500 tokens. */
const IMAGE_CHARACTERS = 6_000;
/** How many first lines of a file the list reads, for its id, folder and title. */
export const HEAD_LINES = 40;
const TITLE_LENGTH = 80;
/** In a summary made here: the requests left out, the last ones, each this long at most. */
const LEFT_OUT_REQUESTS = 40;
const REQUEST_CHARACTERS = 200;
/** Claude Code's wrappers of what is not a person's request: commands, their output, reminders, notifications. */
const NOT_A_REQUEST = /^<(command-|local-command-|bash-|task-notification|system-reminder|user-prompt-submit-hook)/;
/** Claude Code's own commands (`/model`, `/clear`), their caveat and output: its business, not the conversation's. */
const LOCAL_COMMAND = /^\s*<(local-command-caveat|command-name|command-message|local-command-stdout|local-command-stderr)>/;

/** A Claude Code session file that cannot continue, and why, in words for people. */
export class ClaudeSessionError extends Error {}

/** A Claude Code file's line, as read: nothing in it is known to be there. */
type ClaudeLine = {
    type?: unknown;
    subtype?: unknown;
    uuid?: unknown;
    parentUuid?: unknown;
    isSidechain?: unknown;
    isMeta?: unknown;
    isCompactSummary?: unknown;
    sessionId?: unknown;
    cwd?: unknown;
    timestamp?: unknown;
    aiTitle?: unknown;
    compactMetadata?: { preTokens?: unknown; preservedMessages?: { uuids?: unknown; allUuids?: unknown } };
    message?: { id?: unknown; role?: unknown; model?: unknown; content?: unknown; usage?: unknown; stop_reason?: unknown };
};

/** A content block of Claude Code's (Anthropic's API format), as read. */
type Block = {
    type?: unknown;
    text?: unknown;
    thinking?: unknown;
    signature?: unknown;
    data?: unknown;
    id?: unknown;
    name?: unknown;
    input?: unknown;
    tool_use_id?: unknown;
    content?: unknown;
    is_error?: unknown;
    source?: { type?: unknown; data?: unknown; media_type?: unknown; url?: unknown };
};

/** What continues of a Claude Code session, as the preview card says it. */
export type ClaudeKept = {
    /** All of it; its last compaction, what it keeps, and what came after; or its last turns, with a summary made here. */
    from: "all" | "compaction" | "turns";
    /** Messages written for Pi (people's, the model's, tool results). */
    messages: number;
    /** Claude Code's conversation entries left in its file, not continued. */
    left: number;
    /** Compactions in the file. */
    compactions: number;
    toolCalls: number;
    thinking: number;
    images: number;
    /** When what continues starts (the compaction, or the first turn kept), ISO. */
    since?: string;
};

/** A Claude Code session as converted: the Pi session's id (Claude Code's), folder, title, and what continues. */
export type ClaudeConverted = { id: string; cwd: string; title: string; kept: ClaudeKept };

/** What continues of a Claude Code session, in words for Pi (the tools' answers). */
export function describeKept(kept: ClaudeKept): string {
    const since = kept.since === undefined ? "" : ` (${kept.since.slice(0, 10)})`;
    const left = `${kept.left} earlier entr${kept.left === 1 ? "y stays" : "ies stay"} in its file`;

    return kept.from === "all"
        ? `From Claude Code: all of it continues, ${kept.messages} messages.`
        : kept.from === "compaction"
          ? `From Claude Code: the summary of its last compaction${since} and the ${kept.messages} messages after it continue; ${left}.`
          : `From Claude Code: its last ${kept.messages} messages${since} continue, after a summary of what came before; ${left}.`;
}

/** A Claude Code session as a list shows it. */
export type ClaudeListing = { path: string; id: string; cwd: string; title: string; modified: number; size: number };

/** Whether a file is one of Claude Code's sessions in the home folder `home`: `~/.claude/projects/<slug>/<id>.jsonl`. */
export function claudeSlug(home: string, path: string): string | undefined {
    const root = `${home.replace(/\/+$/, "")}/${CLAUDE_PROJECTS}/`;

    if (!path.startsWith(root) || !path.endsWith(".jsonl")) {
        return undefined;
    }

    const [slug, name, ...rest] = path.slice(root.length).split("/");

    return rest.length > 0 || slug === undefined || slug === "" || slug === ".." || name === undefined || name.startsWith("agent-") ? undefined : slug;
}

/** A folder's slug as Claude Code names its projects folder after it. */
export const slugOf = (folder: string): string => folder.replace(/[^a-zA-Z0-9]/g, "-");

/**
 * The project's folder: the one the session's folder is in (or is) whose slug names the projects folder. Claude Code
 * starts in it, and its entries' `cwd` follows the shell into folders below.
 */
export function projectFolder(cwd: string, slug: string): string {
    for (let folder = cwd; ; folder = dirname(folder)) {
        if (slugOf(folder) === slug) {
            return folder;
        }

        if (dirname(folder) === folder) {
            return cwd;
        }
    }
}

const text = (value: unknown): string => (typeof value === "string" ? value : "");

/** A user entry's text when it is a person's request: not a tool's result, Claude Code's own, or a command. */
function requestOf(line: ClaudeLine): string | undefined {
    if (line.type !== "user" || line.isMeta === true || line.isCompactSummary === true || line.isSidechain === true) {
        return undefined;
    }

    const content = line.message?.content;
    const blocks: Block[] = Array.isArray(content) ? (content as Block[]) : [];

    if (blocks.some((block) => block.type === "tool_result")) {
        return undefined;
    }

    const said = (typeof content === "string" ? content : blocks.map((block) => (block.type === "text" ? text(block.text) : "")).join("\n")).trim();

    return said === "" || NOT_A_REQUEST.test(said) ? undefined : said;
}

/** A title from a request: its first line, shortened. */
const titleFrom = (request: string): string => request.split("\n")[0]!.slice(0, TITLE_LENGTH).trim();

/**
 * What the first lines of a Claude Code session file say, for the list: its id, the project's folder, and its first
 * request as a title. Undefined when they are not Claude Code's.
 */
export function claudeHead(lines: readonly string[], slug: string): { id: string; cwd: string; title: string } | undefined {
    let id: string | undefined;
    let cwd: string | undefined;
    let title: string | undefined;

    for (const line of lines) {
        const entry = parseLine(line) as ClaudeLine | undefined;

        if (entry === undefined) {
            continue;
        }

        id ??= typeof entry.sessionId === "string" ? entry.sessionId : undefined;
        cwd ??= typeof entry.cwd === "string" ? entry.cwd : undefined;

        const request = requestOf(entry);

        title ??= request === undefined ? undefined : titleFrom(request);
    }

    return id === undefined ? undefined : { id, cwd: cwd === undefined ? "" : projectFolder(cwd, slug), title: title ?? "Claude Code session" };
}

/** A file's first `HEAD_LINES` lines, as text. */
async function headOf(path: string): Promise<string[]> {
    const source = await localSource(path);
    const lines: string[] = [];

    try {
        for await (const line of linesOf(source)) {
            lines.push(line.bytes.toString("utf8"));

            if (lines.length >= HEAD_LINES) {
                break;
            }
        }
    } finally {
        await source.close();
    }

    return lines;
}

/**
 * Claude Code's sessions in the home folder `home` on this phone, newest first, at most `limit`: the `.jsonl` files of
 * each project's folder (subagents' `agent-*.jsonl` left out), each with what its first lines say.
 */
export async function listClaudeHere(home: string, limit: number): Promise<ClaudeListing[]> {
    const root = join(home, CLAUDE_PROJECTS);
    const files: { path: string; slug: string; modified: number; size: number }[] = [];

    for (const slug of await readdir(root).catch(() => [])) {
        for (const name of await readdir(join(root, slug)).catch(() => [])) {
            const path = join(root, slug, name);

            if (claudeSlug(home, path) === undefined) {
                continue;
            }

            const info = await stat(path).catch(() => undefined);

            if (info?.isFile()) {
                files.push({ path, slug, modified: info.mtimeMs, size: info.size });
            }
        }
    }

    files.sort((a, b) => b.modified - a.modified);
    const found: ClaudeListing[] = [];

    for (const file of files.slice(0, limit)) {
        const head = claudeHead(await headOf(file.path).catch(() => []), file.slug);

        if (head !== undefined) {
            found.push({ path: file.path, ...head, modified: file.modified, size: file.size });
        }
    }

    return found;
}

/** How much a message's content counts against `KEEP_CHARACTERS`. */
function weightOf(content: unknown): number {
    if (typeof content === "string") {
        return content.length;
    }

    if (!Array.isArray(content)) {
        return 0;
    }

    let weight = 0;

    for (const block of content as Block[]) {
        weight +=
            block.type === "text"
                ? text(block.text).length
                : block.type === "thinking"
                  ? text(block.thinking).length
                  : block.type === "tool_use"
                    ? JSON.stringify(block.input ?? {}).length
                    : block.type === "tool_result"
                      ? weightOf(block.content)
                      : block.type === "image"
                        ? IMAGE_CHARACTERS
                        : 0;
    }

    return weight;
}

/** What an entry is, for the first read. */
const OTHER = 0;
const USER = 1;
const ASSISTANT = 2;
const BOUNDARY = 3;

/**
 * The first read of a Claude Code file, a line at a time: numbers for each entry of the conversation (where its line
 * is, its parent, what it is, how much it weighs), and the few things the whole file says.
 */
class ClaudeIndex {
    readonly #places = new Map<string, number>();
    readonly parents: number[] = [];
    readonly #later = new Map<number, string>();
    readonly at: number[] = [];
    readonly size: number[] = [];
    readonly kind: number[] = [];
    readonly weight: number[] = [];
    /** An answer's `message.id`, for the entries of the model. */
    readonly answer = new Map<number, string>();
    /** User entries with tool results. */
    readonly results = new Set<number>();
    /** People's requests, by entry, shortened. */
    readonly requests = new Map<number, string>();
    /** Compaction summaries' entries. */
    readonly summaries = new Set<number>();
    /** Each compaction's kept messages, by its boundary entry. */
    readonly preserved = new Map<number, string[]>();
    readonly preTokens = new Map<number, number>();
    readonly timestamps = new Map<number, string>();
    id: string | undefined;
    cwd: string | undefined;
    model: string | undefined;
    started: string | undefined;
    title: string | undefined;
    thinking = false;
    compactions = 0;
    /** Conversation entries of people and the model in the file. */
    messages = 0;

    add(entry: ClaudeLine, at: number, size: number): void {
        this.id ??= typeof entry.sessionId === "string" ? entry.sessionId : undefined;
        this.cwd ??= typeof entry.cwd === "string" ? entry.cwd : undefined;
        this.started ??= typeof entry.timestamp === "string" ? entry.timestamp : undefined;

        // Claude Code's own records, and its subagents' conversations, are not the conversation.
        if (typeof entry.uuid !== "string" || entry.isSidechain === true) {
            return;
        }

        const place = this.at.length;
        const parent = typeof entry.parentUuid === "string" ? this.#places.get(entry.parentUuid) : -1;

        this.#places.set(entry.uuid, place);
        this.at.push(at);
        this.size.push(size);
        this.parents.push(parent ?? -1);

        if (parent === undefined) {
            this.#later.set(place, entry.parentUuid as string);
        }

        if (typeof entry.timestamp === "string") {
            this.timestamps.set(place, entry.timestamp);
        }

        const kind =
            entry.type === "user" ? USER : entry.type === "assistant" ? ASSISTANT : entry.type === "system" && entry.subtype === "compact_boundary" ? BOUNDARY : OTHER;
        const content = entry.message?.content;

        this.kind.push(kind);
        this.weight.push(kind === USER || kind === ASSISTANT ? weightOf(content) : 0);

        if (kind === USER || kind === ASSISTANT) {
            this.messages += 1;
        }

        if (kind === ASSISTANT) {
            if (typeof entry.message?.id === "string") {
                this.answer.set(place, entry.message.id);
            }

            if (typeof entry.message?.model === "string" && entry.message.model !== "<synthetic>") {
                this.model = entry.message.model;
            }

            if (Array.isArray(content) && (content as Block[]).some((block) => block.type === "thinking" || block.type === "redacted_thinking")) {
                this.thinking = true;
            }
        } else if (kind === USER) {
            if (Array.isArray(content) && (content as Block[]).some((block) => block.type === "tool_result")) {
                this.results.add(place);
            }

            if (entry.isCompactSummary === true) {
                this.summaries.add(place);
            }

            const request = requestOf(entry);

            if (request !== undefined) {
                this.requests.set(place, request.slice(0, REQUEST_CHARACTERS));
                this.title ??= titleFrom(request);
            }
        } else if (kind === BOUNDARY) {
            this.compactions += 1;
            const kept = entry.compactMetadata?.preservedMessages;
            const uuids = Array.isArray(kept?.allUuids) ? kept.allUuids : Array.isArray(kept?.uuids) ? kept.uuids : [];

            this.preserved.set(place, uuids.filter((uuid): uuid is string => typeof uuid === "string"));

            if (typeof entry.compactMetadata?.preTokens === "number") {
                this.preTokens.set(place, entry.compactMetadata.preTokens);
            }
        }
    }

    /** Resolve the parents written after their children. */
    finish(): void {
        for (const [place, uuid] of this.#later) {
            this.parents[place] = this.#places.get(uuid) ?? -1;
        }
    }

    placeOf(uuid: string): number | undefined {
        return this.#places.get(uuid);
    }
}

/** What continues, found from the first read: entries in file order, and the compaction or summary before them. */
type Plan = {
    from: ClaudeKept["from"];
    /** The messages a compaction keeps, before its summary. */
    preserved: number[];
    /** The compaction's summary entry, if there is one. */
    summary: number | undefined;
    boundary: number | undefined;
    /** What continues after the summary. */
    messages: number[];
    /** People's requests left out, when only the last turns continue. */
    leftOut: string[];
    left: number;
};

/** The current branch and what of it continues (see the file's comment). */
function planOf(index: ClaudeIndex): Plan {
    const total = index.at.length;
    let leaf = -1;

    for (let place = total - 1; place >= 0; place -= 1) {
        if (index.kind[place] === USER || index.kind[place] === ASSISTANT) {
            leaf = place;
            break;
        }
    }

    if (leaf === -1) {
        throw new ClaudeSessionError("This Claude Code session has no messages to continue.");
    }

    // Back from the last entry to the last compaction, or the first entry.
    const chain = new Uint8Array(total);
    let first = leaf;

    for (let place = leaf, steps = 0; place !== -1; place = index.parents[place]!, steps += 1) {
        if (steps > total) {
            throw new ClaudeSessionError("This Claude Code session file is damaged: its entries lead in a circle.");
        }

        chain[place] = 1;
        first = place;
    }

    // With the entries of the same answer, and tool results, hanging off the branch (parallel tool calls).
    const kept: number[] = [];

    for (let place = first; place < total; place += 1) {
        const parent = index.parents[place]!;
        const onBranch =
            chain[place] === 1 ||
            (parent !== -1 &&
                chain[parent] === 1 &&
                ((index.kind[place] === ASSISTANT && index.answer.get(place) !== undefined && index.answer.get(place) === index.answer.get(parent)) ||
                    (index.kind[place] === USER && index.results.has(place))));

        if (onBranch) {
            chain[place] = 1;
            kept.push(place);
        }
    }

    const summary = kept.findLast((place) => index.summaries.has(place));
    const boundary = index.kind[first] === BOUNDARY ? first : undefined;
    let messages = kept.filter(
        (place) => (index.kind[place] === USER || index.kind[place] === ASSISTANT) && (summary === undefined || place > summary),
    );
    let preserved =
        boundary === undefined || summary === undefined
            ? []
            : (index.preserved.get(boundary) ?? [])
                  .map((uuid) => index.placeOf(uuid))
                  .filter((place): place is number => place !== undefined && chain[place] !== 1 && (index.kind[place] === USER || index.kind[place] === ASSISTANT))
                  .sort((a, b) => a - b);
    const weigh = (places: readonly number[]) => places.reduce((sum, place) => sum + index.weight[place]!, 0);
    let from: ClaudeKept["from"] = summary === undefined ? "all" : "compaction";
    let leftOut: string[] = [];

    if (weigh(preserved) + weigh(messages) + (summary === undefined ? 0 : index.weight[summary]!) > KEEP_CHARACTERS) {
        // Its last turns that fit, from a request on; at least the last turn.
        const before = [...preserved, ...messages];
        let start = -1;
        let weight = 0;

        for (let at = before.length - 1; at >= 0; at -= 1) {
            weight += index.weight[before[at]!]!;

            if (index.requests.has(before[at]!)) {
                if (weight > KEEP_CHARACTERS && start !== -1) {
                    break;
                }

                start = at;
            }
        }

        start = Math.max(start, 0);
        leftOut = before
            .slice(0, start)
            .flatMap((place) => {
                const request = index.requests.get(place);

                return request === undefined ? [] : [request];
            })
            .slice(-LEFT_OUT_REQUESTS);
        messages = before.slice(start);
        preserved = [];
        from = "turns";
    }

    const continued = new Set([...preserved, ...messages, ...(summary === undefined ? [] : [summary])]);
    let left = 0;

    for (let place = 0; place < total; place += 1) {
        if ((index.kind[place] === USER || index.kind[place] === ASSISTANT) && !continued.has(place)) {
            left += 1;
        }
    }

    return { from, preserved, summary, boundary, messages, leftOut, left };
}

const NO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };

/** An answer's usage, as Claude Code wrote it (Anthropic's). */
function usageOf(value: unknown): Usage {
    const usage = (value ?? {}) as Record<string, unknown>;
    const count = (key: string) => (typeof usage[key] === "number" ? (usage[key] as number) : 0);
    const input = count("input_tokens");
    const output = count("output_tokens");
    const cacheRead = count("cache_read_input_tokens");
    const cacheWrite = count("cache_creation_input_tokens");

    return { input, output, cacheRead, cacheWrite, totalTokens: input + output + cacheRead + cacheWrite, cost: { ...NO_COST } };
}

/** An image block as Pi's, or a line saying what it was when it is not in the file (a link). */
function imageOf(block: Block): ImageContent | TextContent {
    return block.source?.type === "base64" && typeof block.source.data === "string" && typeof block.source.media_type === "string"
        ? { type: "image", data: block.source.data, mimeType: block.source.media_type }
        : { type: "text", text: `[image: ${text(block.source?.url) || "not in the session file"}]` };
}

/** Content of a person's message or a tool's result, as Pi's: text and images; other blocks named. */
function partsOf(content: unknown): (TextContent | ImageContent)[] {
    if (typeof content === "string") {
        return content === "" ? [] : [{ type: "text", text: content }];
    }

    if (!Array.isArray(content)) {
        return [];
    }

    return (content as Block[]).flatMap((block): (TextContent | ImageContent)[] =>
        block.type === "text"
            ? [{ type: "text", text: text(block.text) }]
            : block.type === "image"
              ? [imageOf(block)]
              : block.type === "tool_result"
                ? []
                : [{ type: "text", text: `[${text(block.type) || "content"}]` }],
    );
}

/** A Pi session entry of the converted file. */
type PiLine = Record<string, unknown> & { type: string };

/**
 * Turns Claude Code's entries, given in file order, into Pi's messages: an answer's parts into one assistant message,
 * its tool results after it, a person's text and images as a user message. A tool result whose call is not in the
 * answer before it is left out, as providers refuse it.
 */
class Converter {
    readonly #emit: (line: PiLine, timestamp: string) => void;
    #answer: { id: string; message: AssistantMessage; calls: Map<string, string>; results: ToolResultMessage[]; timestamp: string } | undefined;
    messages = 0;
    toolCalls = 0;
    thinking = 0;
    images = 0;

    constructor(emit: (line: PiLine, timestamp: string) => void) {
        this.#emit = emit;
    }

    #message(message: UserMessage | AssistantMessage | ToolResultMessage, timestamp: string): void {
        this.messages += 1;
        this.#emit({ type: "message", message }, timestamp);
    }

    /** The answer so far, and its tool results. */
    flush(): void {
        const answer = this.#answer;

        this.#answer = undefined;

        if (answer === undefined || answer.message.content.length === 0) {
            return;
        }

        this.#message(answer.message, answer.timestamp);

        for (const result of answer.results) {
            this.#message(result, answer.timestamp);
        }
    }

    add(entry: ClaudeLine): void {
        const timestamp = typeof entry.timestamp === "string" ? entry.timestamp : new Date(0).toISOString();
        const at = Date.parse(timestamp) || 0;
        const content = entry.message?.content;

        if (entry.type === "assistant") {
            const model = text(entry.message?.model);

            // Claude Code's own notes in the model's place (an API error, "No response requested").
            if (model === "<synthetic>") {
                return;
            }

            const id = text(entry.message?.id);

            if (this.#answer === undefined || this.#answer.id !== id || id === "") {
                this.flush();
                this.#answer = {
                    id,
                    calls: new Map(),
                    results: [],
                    timestamp,
                    message: {
                        role: "assistant",
                        content: [],
                        api: "anthropic-messages",
                        provider: "anthropic",
                        model,
                        usage: usageOf(undefined),
                        stopReason: "stop",
                        timestamp: at,
                    },
                };
            }

            const answer = this.#answer;

            for (const block of Array.isArray(content) ? (content as Block[]) : []) {
                if (block.type === "text" && text(block.text) !== "") {
                    answer.message.content.push({ type: "text", text: text(block.text) });
                } else if (block.type === "thinking") {
                    const part: ThinkingContent = { type: "thinking", thinking: text(block.thinking) };

                    if (typeof block.signature === "string" && block.signature !== "") {
                        part.thinkingSignature = block.signature;
                    }

                    answer.message.content.push(part);
                    this.thinking += 1;
                } else if (block.type === "redacted_thinking") {
                    answer.message.content.push({ type: "thinking", thinking: "", thinkingSignature: text(block.data), redacted: true });
                    this.thinking += 1;
                } else if (block.type === "tool_use" && typeof block.id === "string") {
                    const call: ToolCall = {
                        type: "toolCall",
                        id: block.id,
                        name: text(block.name),
                        arguments: (block.input !== null && typeof block.input === "object" ? block.input : {}) as ToolCall["arguments"],
                    };

                    answer.message.content.push(call);
                    answer.calls.set(call.id, call.name);
                    this.toolCalls += 1;
                }
                // Server tools' calls and results (web search) were answered by the API itself: nothing to run again.
            }

            answer.message.usage = usageOf(entry.message?.usage);
            answer.message.stopReason =
                answer.calls.size > 0 ? "toolUse" : entry.message?.stop_reason === "max_tokens" ? "length" : "stop";

            return;
        }

        if (entry.type !== "user") {
            return;
        }

        const blocks: Block[] = Array.isArray(content) ? (content as Block[]) : [];

        for (const block of blocks) {
            const call = typeof block.tool_use_id === "string" ? this.#answer?.calls.get(block.tool_use_id) : undefined;

            if (block.type !== "tool_result" || call === undefined) {
                continue;
            }

            const parts = partsOf(block.content);

            this.images += parts.filter((part) => part.type === "image").length;
            this.#answer!.results.push({
                role: "toolResult",
                toolCallId: block.tool_use_id as string,
                toolName: call,
                content: parts,
                isError: block.is_error === true,
                timestamp: at,
            });
        }

        const said = typeof content === "string" ? content : partsOf(blocks.filter((block) => block.type !== "tool_result"));
        const first = typeof said === "string" ? said : said[0]?.type === "text" ? said[0].text : "";

        if (said.length === 0 || LOCAL_COMMAND.test(first)) {
            return;
        }

        this.flush();

        if (typeof said !== "string") {
            this.images += said.filter((part) => part.type === "image").length;
        }

        this.#message({ role: "user", content: said, timestamp: at }, timestamp);
    }
}

/** A compaction summary's text from its entry: Claude Code writes it as a person's message. */
function summaryText(entry: ClaudeLine): string {
    const content = entry.message?.content;

    return (typeof content === "string" ? content : partsOf(content).map((part) => (part.type === "text" ? part.text : "")).join("\n")).trim();
}

/**
 * Convert a Claude Code session file (`source`; its projects folder named `slug`) into a Pi session file, a line at a
 * time through `write`. Answers what it is and what continues.
 */
export async function convertClaude(
    source: ByteSource,
    slug: string,
    write: (line: string) => Promise<void>,
): Promise<ClaudeConverted> {
    const index = new ClaudeIndex();

    for await (const line of linesOf(source)) {
        const entry = parseLine(line.bytes) as ClaudeLine | undefined;

        if (entry !== undefined && typeof entry === "object") {
            index.add(entry, line.at, line.bytes.length);
        }
    }

    index.finish();

    if (index.id === undefined) {
        throw new ClaudeSessionError("This is not a Claude Code session file.");
    }

    const plan = planOf(index);
    const reader = new LineReader(source);
    const read = async (place: number) => {
        const line = await reader.line(index.at[place]!, index.size[place]!);
        const entry = line === undefined ? undefined : (parseLine(line) as ClaudeLine | undefined);

        // Each line was an entry when the file was first read.
        if (entry === undefined) {
            throw new ClaudeSessionError("This Claude Code session file changed while it was read. Try again.");
        }

        return entry;
    };
    const cwd = index.cwd === undefined ? "" : projectFolder(index.cwd, slug);
    const title = index.title ?? "Claude Code session";
    let count = 0;
    let parent: string | null = null;
    const lines: string[] = [];
    // Pi's entries are written as they are made; a converter's entries come in the order they are given.
    const emit = (line: PiLine, timestamp: string) => {
        const id = `c${(count += 1).toString(36)}`;
        const { type, ...rest } = line;

        lines.push(JSON.stringify({ type, id, parentId: parent, timestamp, ...rest }));
        parent = id;
    };
    const flushLines = async () => {
        for (const line of lines.splice(0)) {
            await write(line);
        }
    };

    await write(JSON.stringify({ type: "session", version: 3, id: index.id, timestamp: index.started ?? new Date(0).toISOString(), cwd }));
    emit({ type: "session_info", name: title }, index.started ?? new Date(0).toISOString());

    if (index.model !== undefined) {
        emit({ type: "model_change", provider: "anthropic", modelId: index.model }, index.started ?? new Date(0).toISOString());
    }

    // Claude Code thought before answering: Pi's medium thinking continues it.
    if (index.thinking) {
        emit({ type: "thinking_level_change", thinkingLevel: "medium" }, index.started ?? new Date(0).toISOString());
    }

    await flushLines();
    const converter = new Converter(emit);
    const beforeKept = count;

    for (const place of plan.preserved) {
        converter.add(await read(place));
        await flushLines();
    }

    converter.flush();
    await flushLines();
    // The compaction keeps the messages before it from the first of these.
    const firstKept = count > beforeKept ? `c${(beforeKept + 1).toString(36)}` : undefined;
    let since: string | undefined;

    if (plan.summary !== undefined || plan.from === "turns") {
        const claudeSummary = plan.summary === undefined ? "" : summaryText(await read(plan.summary));
        const leftOut =
            plan.leftOut.length === 0
                ? ""
                : `Earlier in this Claude Code session, left out when it continued in pi-phone, the person asked (the last ${plan.leftOut.length} requests, oldest first):\n${plan.leftOut.map((request) => `- ${request.replace(/\s+/g, " ")}`).join("\n")}`;
        const at = plan.summary ?? plan.messages[0];

        since = at === undefined ? undefined : index.timestamps.get(at);
        const id = `c${(count + 1).toString(36)}`;

        emit(
            {
                type: "compaction",
                summary: [claudeSummary, leftOut].filter((part) => part !== "").join("\n\n"),
                firstKeptEntryId: plan.from === "compaction" && firstKept !== undefined ? firstKept : id,
                tokensBefore: plan.boundary === undefined ? 0 : (index.preTokens.get(plan.boundary) ?? 0),
            },
            since ?? new Date(0).toISOString(),
        );
        await flushLines();
    }

    for (const place of plan.messages) {
        converter.add(await read(place));
        await flushLines();
    }

    converter.flush();
    await flushLines();
    reader.release();

    return {
        id: index.id,
        cwd,
        title,
        kept: {
            from: plan.from,
            messages: converter.messages,
            left: plan.left,
            compactions: index.compactions,
            toolCalls: converter.toolCalls,
            thinking: converter.thinking,
            images: converter.images,
            ...(since === undefined ? {} : { since }),
        },
    };
}
