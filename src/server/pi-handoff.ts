/**
 * A session to Pi on a machine and back (DESIGN.md section 4). "Continue in Pi" writes the session's context, as the
 * model has it now, as a Pi session file in the machine's `~/.pi/agent/sessions/`, where `pi -r` lists it; the session
 * keeps a link to it (`SessionMeta.piLink`). What Pi does there later comes back into the same session: only the
 * messages after the last one it knows, when neither side went another way since (the session took no turn, Pi's branch
 * still holds that message). When both did, it comes back as a new session instead, and the two stay apart. Going to Pi
 * again adds the session's new messages to the same file.
 *
 * The file is Pi's own format (version 3): a header, a `custom` entry naming this session (Pi gives custom entries to
 * neither the model nor its list), the model, thinking level and name, then one `message` entry per message. Entries
 * written here are named after the session's entry they come from (`pp<entry>-<n>`), so a compaction of Pi's that keeps
 * one finds it again. System messages stay behind: Pi has its own prompt.
 */
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Message } from "@earendil-works/pi-ai";
import { CURRENT_SESSION_VERSION } from "@earendil-works/pi-coding-agent";
import type { ContextView, ConversationId, EntryId } from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import type { PocketApp } from "./app.ts";
import type { User } from "./config.ts";
import { SessionsDoc } from "./docs.ts";
import { HttpError } from "./errors.ts";
import { formatPlace, parsePlace } from "./places.ts";
import { type PiSession, PiSessionError, readPiSession, writePiSession } from "./pi-sessions.ts";

const context = BACKGROUND_CONTEXT;

/** The largest Pi session file read back. */
const MAX_FILE_BYTES = 32 * 1024 * 1024;
/** The `custom` entry naming the session a file came from. */
export const LINK_TYPE = "pi-phone";
/** A file written this long ago or less may still be written by a running `pi`. */
const SETTLING_MS = 5_000;

/** Where a session went in Pi, and how far the two agree. */
export type PiLink = {
    machineId: string;
    /** The file there, and the folder Pi works in. */
    path: string;
    cwd: string;
    /** Pi's session id (the file's header). */
    piSession: string;
    /** The entry of Pi's of the last message both have. */
    last: string;
    /** The session's last entry with messages for the model that Pi has too. */
    tail: number;
    /** The file's message entries, and its size, when the two last agreed. */
    count: number;
    size: number;
};

/** A link as the session's owner sees it: whether either side went on, and what they can do. */
export type PiLinkStatus = {
    machineId: string;
    machine: string;
    path: string;
    cwd: string;
    piSession: string;
    /** Messages Pi added since; 0: nothing to bring back. */
    added: number;
    /** The session took a turn since it went to Pi. */
    sessionWentOn: boolean;
    /** Pi's branch no longer holds the last message both have (Pi's `/tree`). */
    branchMoved: boolean;
    /** When the file last changed there. */
    modified: number;
    /** Changed in the last seconds: `pi` may still be writing it. */
    settling: boolean;
};

/** The entries of the context, one per message for the model, without system messages: what Pi gets. */
function messagesOf(view: ContextView): { message: Message; entry: EntryId | undefined }[] {
    const owner = new Map<Message, EntryId>();

    view.entries.forEach((entry, index) => {
        for (const message of view.contributions[index] ?? []) {
            owner.set(message, entry.id);
        }
    });

    // A tool call's result the model gets but no entry has (a call that never finished) comes from no entry.
    return view.messages.flatMap((message) =>
        message.role === "system" ? [] : [{ message, entry: owner.get(message) }],
    );
}

/** The last entry of the context with messages for the model. */
function modelTail(view: ContextView): number | undefined {
    for (let index = view.entries.length - 1; index >= 0; index--) {
        if ((view.contributions[index]?.length ?? 0) > 0) {
            return Number(view.entries[index]!.id);
        }
    }

    return undefined;
}

/** Pi's folder of sessions for a folder, as Pi names it (`getDefaultSessionDir`). */
function sessionFolder(home: string, cwd: string): string {
    return `${home}/.pi/agent/sessions/--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

const line = (value: object) => `${JSON.stringify(value)}\n`;

/** Pi's message entries, after `parentId`, with ids after the session's entries. */
function messageLines(
    messages: readonly { message: Message; entry: EntryId | undefined }[],
    parentId: string | null,
    seen: Map<string, number>,
): { text: string; last: string | null } {
    let parent = parentId;
    let text = "";

    for (const { message, entry } of messages) {
        const base = entry === undefined ? `${String(parent)}r` : `pp${String(entry)}`;
        const n = seen.get(base) ?? 0;
        const id = `${base}-${n}`;

        seen.set(base, n + 1);
        text += line({
            type: "message",
            id,
            parentId: parent,
            timestamp: new Date(message.timestamp ?? Date.now()).toISOString(),
            message,
        });
        parent = id;
    }

    return { text, last: parent };
}

/** The id of the file's last entry: the leaf Pi continues from. */
function leafOf(text: string): string | null {
    const lines = text.trimEnd().split("\n");
    const last = JSON.parse(lines.at(-1)!) as { type?: unknown; id?: unknown };

    return last.type === "session" || typeof last.id !== "string" ? null : last.id;
}

export class PiHandoff {
    readonly #app: PocketApp;

    constructor(app: PocketApp) {
        this.#app = app;
    }

    #check(user: User, id: ConversationId): { link: PiLink | undefined; cwd: string } {
        if (user.role !== "owner") {
            throw new HttpError(403, "Only the owner can continue sessions in Pi.");
        }

        const meta = this.#app.sessionMeta(id);

        if (meta === undefined) {
            throw new HttpError(404, "There is no such session.");
        }

        return { link: meta.piLink, cwd: meta.cwd };
    }

    #idle(id: ConversationId): void {
        if (this.#app.isBusy(id)) {
            throw new HttpError(409, "The agent is working in this session. Wait for it to finish, or stop it.");
        }
    }

    async #view(id: ConversationId): Promise<ContextView> {
        const conversation = await this.#app.harness.conversation(id, context);

        if (conversation === undefined) {
            throw new HttpError(404, "There is no such session.");
        }

        return conversation.context(context);
    }

    #env(machineId: string): { env: ExecutionEnv; home: string; name: string } {
        const machine = this.#app.machines.ready(machineId);
        const home = machine.remote!.home;

        return { env: this.#app.places.env(formatPlace({ machineId, path: home })), home, name: machine.name };
    }

    async #save(id: ConversationId, link: PiLink): Promise<void> {
        await this.#app.harness.commit(async (tx) => {
            const meta = (await tx.doc(SessionsDoc)).items[String(id)];

            if (meta !== undefined) {
                meta.piLink = link;
            }
        }, context);
    }

    /** The linked file there, read: its text, and Pi's session from it. */
    async #read(link: PiLink): Promise<{ text: string; session: PiSession; size: number; modified: number }> {
        const { env, name } = this.#env(link.machineId);
        const info = await env.fileInfo(link.path, context);

        if (!info.ok) {
            throw new HttpError(502, `Could not read ${link.path} on ${name}: ${info.error.message}`);
        }

        if (info.value.size > MAX_FILE_BYTES) {
            throw new HttpError(413, "This Pi session is too large to bring back.");
        }

        const text = await env.readTextFile(link.path, context);

        if (!text.ok) {
            throw new HttpError(502, `Could not read ${link.path} on ${name}: ${text.error.message}`);
        }

        try {
            return { text: text.value, session: readPiSession(text.value), size: info.value.size, modified: info.value.mtimeMs };
        } catch (error) {
            if (error instanceof PiSessionError) {
                throw new HttpError(400, error.message);
            }

            throw error;
        }
    }

    /** Where the session is in Pi, if it went there; reads the file only when it changed. */
    async status(user: User, id: ConversationId): Promise<{ link: PiLinkStatus | null }> {
        const { link } = this.#check(user, id);

        if (link === undefined) {
            return { link: null };
        }

        const { env, name } = this.#env(link.machineId);
        const info = await env.fileInfo(link.path, context);

        if (!info.ok) {
            throw new HttpError(502, `Could not read ${link.path} on ${name}: ${info.error.message}`);
        }

        const view = await this.#view(id);
        let added = 0;
        let branchMoved = false;

        if (info.value.size !== link.size) {
            const { session } = await this.#read(link);
            const at = session.entries.findLastIndex((entry) => entry.from === link.last);

            branchMoved = at === -1;
            added = branchMoved ? Math.max(0, session.count - link.count) : session.entries.length - at - 1;
        }

        return {
            link: {
                machineId: link.machineId,
                machine: name,
                path: link.path,
                cwd: link.cwd,
                piSession: link.piSession,
                added,
                sessionWentOn: modelTail(view) !== link.tail,
                branchMoved,
                modified: info.value.mtimeMs,
                settling: Date.now() - info.value.mtimeMs < SETTLING_MS,
            },
        };
    }

    /**
     * Continue the session in Pi: at `place` (a folder on a machine), a new file; without, the linked file, with the
     * session's messages since. Answers the file there.
     */
    async continueInPi(user: User, id: ConversationId, place?: string): Promise<{ machine: string; path: string; cwd: string }> {
        const { link } = this.#check(user, id);

        this.#idle(id);
        const view = await this.#view(id);
        const messages = messagesOf(view);
        const tail = modelTail(view);

        if (tail === undefined) {
            throw new HttpError(400, "This session has no messages yet.");
        }

        if (place === undefined) {
            if (link === undefined) {
                throw new HttpError(400, "Choose a folder on a machine for Pi.");
            }

            return this.#append(id, link, view, messages, tail);
        }

        const { machineId, path: cwd } = parsePlace(place);

        if (machineId === undefined) {
            throw new HttpError(400, "Choose a folder on a machine: Pi runs there.");
        }

        await this.#app.workspace.checkPlace(place);
        const { env, home, name } = this.#env(machineId);
        const agent = await (await this.#app.harness.conversation(id, context))!.agent(context);
        const title = this.#app.sessionMeta(id)?.title ?? "pi-phone session";
        const piSession = crypto.randomUUID();
        const now = new Date().toISOString();
        const folder = sessionFolder(home, cwd);
        const path = `${folder}/${now.replace(/[:.]/g, "-")}_${piSession}.jsonl`;
        let text =
            line({ type: "session", version: CURRENT_SESSION_VERSION, id: piSession, timestamp: now, cwd }) +
            line({ type: "custom", id: "pp-link", parentId: null, timestamp: now, customType: LINK_TYPE, data: { session: Number(id), title } });
        let parent = "pp-link";

        if (agent.model !== undefined) {
            text += line({ type: "model_change", id: "pp-model", parentId: parent, timestamp: now, provider: agent.model.provider, modelId: agent.model.modelId });
            parent = "pp-model";
        }

        text += line({ type: "thinking_level_change", id: "pp-thinking", parentId: parent, timestamp: now, thinkingLevel: agent.thinkingLevel });
        text += line({ type: "session_info", id: "pp-name", parentId: "pp-thinking", timestamp: now, name: title });
        const written = messageLines(messages, "pp-name", new Map());

        text += written.text;
        const made = await env.createDir(folder, { recursive: true }, context);

        if (!made.ok) {
            throw new HttpError(502, `Could not make ${folder} on ${name}: ${made.error.message}`);
        }

        const saved = await env.writeFile(path, text, context);

        if (!saved.ok) {
            throw new HttpError(502, `Could not write ${path} on ${name}: ${saved.error.message}`);
        }

        await this.#save(id, {
            machineId,
            path,
            cwd,
            piSession,
            last: written.last!,
            tail,
            count: messages.length,
            size: Buffer.byteLength(text),
        });

        return { machine: name, path, cwd };
    }

    /** The session's messages since Pi last had it, added to the linked file. */
    async #append(
        id: ConversationId,
        link: PiLink,
        view: ContextView,
        messages: ReturnType<typeof messagesOf>,
        tail: number,
    ): Promise<{ machine: string; path: string; cwd: string }> {
        const { env, name } = this.#env(link.machineId);
        const file = await this.#read(link);

        if (file.size !== link.size) {
            throw new HttpError(409, `Pi went on with this session on ${name}. Bring that back first.`);
        }

        const at = view.entries.findIndex((entry) => Number(entry.id) === link.tail);

        if (at === -1) {
            throw new HttpError(
                409,
                "This session was compacted since it went to Pi, so Pi's file cannot take what follows. Continue it in Pi as a new session.",
            );
        }

        const after = new Set(view.entries.slice(at + 1).map((entry) => entry.id));
        // From the first message of an entry after the tail; a result no entry has follows its call.
        const first = messages.findIndex(({ entry }) => entry !== undefined && after.has(entry));
        const added = first === -1 ? [] : messages.slice(first);

        if (added.length > 0) {
            const written = messageLines(added, leafOf(file.text), new Map());
            const appended = await env.appendFile(link.path, written.text, context);

            if (!appended.ok) {
                throw new HttpError(502, `Could not write ${link.path} on ${name}: ${appended.error.message}`);
            }

            await this.#save(id, {
                ...link,
                last: written.last!,
                tail,
                count: link.count + added.length,
                size: file.size + Buffer.byteLength(written.text),
            });
        }

        return { machine: name, path: link.path, cwd: link.cwd };
    }

    /**
     * What Pi did since, into this session: its messages after the last one both have. When either went another way,
     * `asNew` brings it back as a new session instead (the Pi sessions route); without it, a 409 says so.
     */
    async bringBack(user: User, id: ConversationId, asNew = false): Promise<{ id: number; added: number }> {
        const { link } = this.#check(user, id);

        if (link === undefined) {
            throw new HttpError(400, "This session did not go to Pi.");
        }

        this.#idle(id);
        const { name } = this.#env(link.machineId);
        const file = await this.#read(link);
        const view = await this.#view(id);
        const at = file.session.entries.findLastIndex((entry) => entry.from === link.last);

        if (asNew) {
            const imported = await this.#app.piSessions.importFromMachine(user, link.machineId, link.path);
            const made = await this.#app.commands.continuePiSession(
                user,
                imported.path,
                formatPlace({ machineId: link.machineId, path: file.session.cwd }),
            );

            return { id: Number(made.id), added: file.session.entries.length };
        }

        if (at === -1) {
            throw new HttpError(409, `Pi on ${name} went back to an earlier message, so this session cannot take what follows. Bring it back as a new session.`);
        }

        if (modelTail(view) !== link.tail) {
            throw new HttpError(409, `This session went on here too since it went to Pi. Bring Pi's back as a new session.`);
        }

        const entries = file.session.entries.slice(at + 1);

        if (entries.length === 0) {
            return { id: Number(id), added: 0 };
        }

        // The session's entries for Pi's earlier ones: those written here (named after them), and those brought back
        // before, found by their messages, which Pi keeps as they were.
        const byMessage = new Map<string, EntryId>();

        view.entries.forEach((entry, index) => {
            for (const message of view.contributions[index] ?? []) {
                byMessage.set(JSON.stringify(message), entry.id);
            }
        });

        const piMessages = new Map(file.session.entries.flatMap((entry) => (entry.from === undefined ? [] : [[entry.from, entry.message] as const])));
        const known = (from: string): EntryId | undefined => {
            const named = /^pp(\d+)-\d+$/.exec(from);

            if (named !== null) {
                return Number(named[1]) as unknown as EntryId;
            }

            const message = piMessages.get(from);

            return message === undefined ? undefined : byMessage.get(JSON.stringify(message));
        };
        // Pi's edits of messages the session has as edited already stay out.
        const current = new Map(view.entries.map((entry, index) => [entry.id, JSON.stringify(view.contributions[index] ?? [])]));
        const edits = file.session.edits.filter(({ target, messages }) => {
            const entry = known(target);

            return entry === undefined || current.get(entry) !== JSON.stringify(messages);
        });
        const lastFrom = entries.findLast((entry) => entry.from !== undefined)?.from ?? link.last;
        let tail: EntryId | undefined;

        try {
            const conversation = (await this.#app.harness.conversation(id, context))!;

            await conversation.commit(async (tx) => {
                tail = await writePiSession(
                    tx,
                    id,
                    { ...file.session, edits },
                    { session: link.piSession, title: `${file.session.title} (from Pi on ${name})`, file: `${name}:${link.path}` },
                    { entries, known },
                );
                const meta = (await tx.doc(SessionsDoc)).items[String(id)];

                if (meta !== undefined) {
                    meta.piLink = { ...link, last: lastFrom, tail: Number(tail), count: file.session.count, size: file.size };
                    meta.updatedAt = Date.now();
                }
            }, context);
        } catch (error) {
            if (error instanceof PiSessionError) {
                throw new HttpError(409, `${error.message} Bring it back as a new session.`);
            }

            throw error;
        }

        return { id: Number(id), added: entries.length };
    }
}
