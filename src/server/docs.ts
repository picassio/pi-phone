/**
 * Pi Pocket's own durable documents. They live next to the transcripts in the same storage and change in the same
 * commits, so a crash never leaves them disagreeing with the conversation.
 *
 * Kinds are part of the stored data: rename one and old sessions lose it.
 */
import type { PiLink } from "./pi-handoff.ts";
import {
    type ConversationId,
    defineDoc,
    defineDocFamily,
    type EntryId,
    type TaskId,
} from "@earendil-works/pi-durable";
import type { Repeat } from "./when.ts";
import type { Worktree } from "./worktrees.ts";

/** A group of sessions: what it is (`project:PP`), what the list calls it, and the session's part in it. */
export type SessionGroup = { id: string; title: string; role: "lead" | "task" };

export type SessionMeta = {
    title?: string;
    cwd: string;
    createdAt: number;
    updatedAt: number;
    createdBy?: string;
    archived?: boolean;
    /** The session this one was forked from, and the last entry it inherited; no entry: forked before the first message. */
    forkedFrom?: { id: number; entryId?: number };
    /** The session that started this one (`linked-sessions.ts`): a link only, which gives no access and owns nothing. */
    linkedFrom?: { id: number };
    /** The most Pi may spend here, in dollars, subagents included. */
    budget?: number;
    /** The git worktree the session works in, when it has one of its own. */
    worktree?: Worktree;
    /** The session of Pi's in the terminal this one continues, and how many messages its file had then. */
    fromPi?: { session: string; count: number };
    /**
     * How many messages and new sessions this session may send other sessions in an hour (`session-control.ts`):
     * a number, or null for no limit. Absent: the owner's setting for all sessions.
     */
    sendLimit?: number | null;
    /** The "Wiki capture" session (`para-capture.ts`): captures of the others run there. */
    wikiCapture?: boolean;
    /** Where the session went in Pi on a machine, and how far the two agree (`pi-handoff.ts`). */
    piLink?: PiLink;
    /**
     * The id of the person whose PiP this is: their assistant, which looks after their other sessions (`pip.ts`). PiP is
     * kept out of the session list; an older Pi Pocket, which does not know this field, lists it as a session.
     */
    pip?: string;
    /**
     * A group the session belongs to, set by an extension (a project's team: its main session and task sessions). The
     * list shows a group's sessions together, folded in Recent, and in a tab of their own.
     */
    group?: SessionGroup;
    /**
     * Settled by hand or by an extension (a task session whose run ended), or kept active by hand (Un-settle), and when.
     * The list settles a session that sat idle for a day on its own; activity after `at` (`updatedAt`) brings it back.
     */
    settle?: { state: "settled" | "active"; at: number; reason?: string };
};

/** The catalogue of user-facing sessions: ownerless conversations created by the app. Subagents are not listed. */
export const SessionsDoc = defineDoc<{ items: Record<string, SessionMeta> }>({
    kind: "pocket.sessions",
    version: 1,
    scope: "session",
    initial: () => ({ items: {} }),
});

/** Favorite working folders in shortcut order, private to each person and shared by their devices. */
export const FolderFavoritesDoc = defineDoc<{ users: Record<string, string[]> }>({
    kind: "pocket.folder-favorites",
    version: 1,
    scope: "session",
    initial: () => ({ users: {} }),
});

/**
 * Who wrote each user message, by entry id. `requesters` holds, for a message no person wrote (a parent's message to
 * its subagent), whose work it is: the person the parent worked for then. `requests` is unused.
 */
export const AuthorsDoc = defineDoc<{
    requests: Record<string, string>;
    entries: Record<string, string>;
    requesters?: Record<string, string>;
}>({
    kind: "pocket.authors",
    version: 1,
    scope: "conversation",
    history: "latest",
    fork: "current",
    initial: () => ({ requests: {}, entries: {} }),
});

/** `openui`: an interactive answer in OpenUI Lang, drawn by the Intelligent UI frame (`http/artifacts.ts`). */
export type ArtifactType = "html" | "markdown" | "svg" | "openui";

export type ArtifactVersion = {
    version: number;
    /** The tool task that wrote it; a replayed call finds its version instead of writing another. */
    taskId: TaskId;
    /**
     * The call within that task. One codemode task makes many calls; versions from before this field match on the task
     * alone.
     */
    callId?: string;
    size: number;
    createdAt: number;
};

export type ArtifactMeta = {
    title: string;
    type: ArtifactType;
    versions: ArtifactVersion[];
};

/** The artifacts of one conversation, newest version last. Bodies live in `ArtifactBodyDoc`. */
export const ArtifactsDoc = defineDoc<{ items: Record<string, ArtifactMeta> }>({
    kind: "pocket.artifacts",
    version: 1,
    scope: "conversation",
    history: "latest",
    fork: "current",
    initial: () => ({ items: {} }),
});

/** One artifact version's content, keyed `<artifactId>@<version>`. */
export const ArtifactBodyDoc = defineDocFamily<{ content: string }, { content: string }>({
    kind: "pocket.artifact-body",
    version: 1,
    family: true,
    scope: "conversation",
    history: "latest",
    fork: "current",
    initial: (seed) => ({ content: seed.content }),
});


export type SubagentRecord = {
    conversationId: ConversationId;
    /** Answers already reported to the parent: several messages can end in one answer, reported once. */
    reported: EntryId[];
    /** What the parent asked it last, the start of it, and when. */
    asked?: string;
    askedAt?: number;
    /**
     * When it last answered, or failed to (`failed`), what the parent asked, or, once it failed, a person's own message to
     * it; and why it failed, or that it was stopped.
     */
    answeredAt?: number;
    failed?: boolean;
    error?: string;
    /**
     * The failure a person dealt with (seen, or dismissed), by its `answeredAt`: it needs nobody now. A later failure has
     * a later time, so it needs them again.
     */
    dealtAt?: number;
};

/** A subagent's report waiting to go to its parent: all those waiting go together, as one message. */
export type PendingReport = { name: string; text: string };

/** A conversation's named background subagents, and the reporter task of each message sent to them. */
export const SubagentsDoc = defineDoc<{
    agents: Record<string, SubagentRecord>;
    reporters: Record<string, TaskId>;
    /** Reports not yet sent to the parent. */
    outbox?: PendingReport[];
    /** The task sending them, while there is one. */
    courier?: TaskId;
    /**
     * The batch taken from the outbox, kept until it has left the parent's queue, with the request id it goes with: a
     * courier that stops before then leaves it to the next, which sends it again under that id, so it goes once.
     */
    sending?: {
        request: string;
        reports: PendingReport[];
        /** A person took it out of the parent's queue (the queue's ×, or Stop): it is gone, not sent again. */
        discarded?: true;
    };
    /** How many batches went so far, for their request ids. */
    batches?: number;
    /**
     * Why the reports wait, while a spend limit holds them back: the parent would start a turn for them that its
     * session, or whoever pays there, may not pay for. They go when the limit is raised.
     */
    held?: string;
    /** An earlier build's names of the batch in the queue: no longer written, and cleared where found. */
    delivering?: string[];
}>({
    kind: "pocket.subagents",
    version: 1,
    scope: "conversation",
    history: "latest",
    // A fork starts without subagents: they belong to the conversation that spawned them.
    fork: "initial",
    initial: () => ({ agents: {}, reporters: {} }),
});

export type ChatMessage = {
    /** Made from the client's request id, so a retried send does not post twice. */
    id: string;
    userId: string;
    /** The sender's name when sent, for people removed since. */
    name: string;
    text: string;
    at: number;
    /** "event": a line of activity ("Alex stopped the run"), not something someone wrote. */
    kind?: "event";
    /** People named with `@Name` in the text. */
    mentions?: string[];
    /** A transcript message this one discusses. */
    quote?: { entryId: number; text: string };
};

/** The people's side chat in one conversation, oldest first, with activity lines. Pi does not see it. */
export const ChatDoc = defineDoc<{ messages: ChatMessage[] }>({
    kind: "pocket.chat",
    version: 1,
    scope: "conversation",
    history: "latest",
    fork: "current",
    initial: () => ({ messages: [] }),
});

/** Messages a chat keeps; older ones drop off. */
export const CHAT_LIMIT = 500;

/** Emoji reactions to transcript entries: entry id → emoji → user ids. */
export const ReactionsDoc = defineDoc<{ entries: Record<string, Record<string, string[]>> }>({
    kind: "pocket.reactions",
    version: 1,
    scope: "conversation",
    history: "latest",
    fork: "current",
    initial: () => ({ entries: {} }),
});

export type Pin = {
    /** `e<entryId>` or `c<chatId>`: pinning the same thing again unpins it. */
    id: string;
    entryId?: number;
    chatId?: string;
    /** A snippet of what was pinned, taken when pinned. */
    text: string;
    /** Who wrote the pinned message: a person's name or "Pi". */
    author: string;
    by: string;
    at: number;
};

/** Pinned messages of one conversation, newest last. */
export const PinsDoc = defineDoc<{ items: Pin[] }>({
    kind: "pocket.pins",
    version: 1,
    scope: "conversation",
    history: "latest",
    fork: "current",
    initial: () => ({ items: [] }),
});

export type Notes = { text: string; rev: number; by?: string; at?: number };

/** One shared notes page per conversation. `rev` rises with every save, so two editors cannot overwrite each other unseen. */
export const NotesDoc = defineDoc<Notes>({
    kind: "pocket.notes",
    version: 1,
    scope: "conversation",
    history: "latest",
    fork: "current",
    initial: () => ({ text: "", rev: 0 }),
});

export type Turns = { on: boolean; driver?: string; asks: string[] };

/** Take turns: while on, only the driver sends to Pi or changes its settings. */
export const TurnsDoc = defineDoc<Turns>({
    kind: "pocket.turns",
    version: 1,
    scope: "conversation",
    history: "latest",
    fork: "initial",
    initial: () => ({ on: false, asks: [] }),
});

export type Decision = { allow: boolean; by: string; userId: string; at: number };

/** Who allowed or denied each tool call Lancet Guard asked about, by tool call id. */
export const DecisionsDoc = defineDoc<{ calls: Record<string, Decision> }>({
    kind: "pocket.decisions",
    version: 1,
    scope: "conversation",
    history: "latest",
    fork: "current",
    initial: () => ({ calls: {} }),
});

/** The text a subagent report starts with; the UI renders these as report cards. */
export const REPORT_PREFIX = "[subagent ";

/** Why a subagent that was stopped did not answer, in its report and its record. */
export const STOPPED = "stopped before it answered";

/** Plan mode: while on, Pi reads and proposes, and anything that would change something is blocked. */
export const PlanDoc = defineDoc<{ on: boolean; by?: string; at?: number }>({
    kind: "pocket.plan",
    version: 1,
    scope: "conversation",
    history: "latest",
    fork: "current",
    initial: () => ({ on: false }),
});

/** What the wiki's remote embeddings cost so far: dollars, tokens, requests, and since when it was counted. */
export type WikiSpend = { cost: number; tokens: number; requests: number; since: number };

/**
 * What Pi spent for each person, in dollars: the work goes to whoever asked for it. `counted` is how much of each
 * conversation's spend is in `people` already, so every dollar is counted once, also across restarts.
 */
export const SpendDoc = defineDoc<{
    people: Record<string, number>;
    counted: Record<string, number>;
    /** The wiki's search by meaning: its remote embeddings (indexing pages, and queries), nobody's in particular. */
    wiki?: WikiSpend;
}>({
    kind: "pocket.spend",
    version: 1,
    scope: "session",
    initial: () => ({ people: {}, counted: {} }),
});

/**
 * The extensions' commands one person ran here, keyed by the person's id: each request id with its task, oldest first.
 * A request sent again, also after a restart, finds its task. A fork starts without them.
 */
export const CommandRequestsDoc = defineDocFamily<{ items: Record<string, number> }, null>({
    kind: "pocket.extension-command-request",
    version: 1,
    family: true,
    scope: "conversation",
    history: "latest",
    fork: "initial",
    initial: () => ({ items: {} }),
});

/**
 * The `!` commands people started here, by request id (`user:request`), oldest first: a request sent again after its
 * reply was lost runs its command once, also across a restart. A fork starts without them.
 */
export const ShellRequestsDoc = defineDoc<{ items: Record<string, number> }>({
    kind: "pocket.shell-requests",
    version: 1,
    scope: "conversation",
    history: "latest",
    fork: "initial",
    initial: () => ({ items: {} }),
});

export type Schedule = {
    /** Short and stable: what people and Pi use to cancel it. */
    id: string;
    /** What was asked for, as shown in the list. */
    text: string;
    /** What Pi gets: the text marked as scheduled, with who set it when several people use this server. */
    content: string;
    /** When it goes out next. */
    next: number;
    every?: Repeat;
    /** The time zone its clock times are in. */
    zone: string;
    /** Who set it; absent when Pi did. */
    by?: string;
    /** For one Pi set up: whom Pi worked for then. It goes out as Pi's, but as their work. */
    requestedBy?: string;
    createdAt: number;
    /** How many times it went out: each time sends with its own request id, so a restart never sends one twice. */
    runs: number;
    /** The durable task that sends it. */
    taskId: TaskId;
    /** Set by the same call already, when a tool call is replayed: its `taskId:callId`. */
    key?: string;
};

/** Messages that go to Pi later, or on repeat. A fork starts without them: they belong to who set them up. */
export const ScheduleDoc = defineDoc<{ items: Record<string, Schedule> }>({
    kind: "pocket.schedules",
    version: 1,
    scope: "conversation",
    history: "latest",
    fork: "initial",
    initial: () => ({ items: {} }),
});

/** The last check of a goal: whether it passed, its exit code, and the end of its output. */
export type GoalCheck = { passed: boolean; code: number; at: number; tail: string };

/**
 * "Done when": Pi keeps working until a check command passes, up to `max` checks. `counted` holds the generation
 * tasks whose answer was checked already, so an answer replayed after a restart is not counted twice.
 */
export type Goal = {
    command: string;
    by: string;
    max: number;
    tries: number;
    status: "working" | "met" | "gave-up";
    last?: GoalCheck;
    counted: string[];
};

export const GoalDoc = defineDoc<{ goal?: Goal }>({
    kind: "pocket.goal",
    version: 1,
    scope: "conversation",
    history: "latest",
    fork: "initial",
    initial: () => ({}),
});


/** A GitHub Actions run a conversation watches (`extensions/ci-watch.ts`): the task that looks at it, and what it is. */
export type CiWatch = {
    taskId: number;
    repo: string;
    runId: number;
    /** The workflow, its run number, and the branch: `Build APK #42 on master`. */
    label: string;
    workflow: string;
    number: number;
    branch: string;
    url: string;
    startedAt: number;
};

/** The runs a conversation watches, by `repo#runId`. Removing one stops its task at its next look. Forks start empty. */
export const CiWatchesDoc = defineDoc<{ items: Record<string, CiWatch> }>({
    kind: "phone.ci-watches",
    version: 1,
    scope: "conversation",
    history: "latest",
    fork: "initial",
    initial: () => ({ items: {} }),
});
