/**
 * Idle subagents retired from their session (PP-515, under PP-472; the owner, 2026-11-14: "Dọn đi"). A session kept
 * every subagent it ever spawned (#993: 106, most idle for days), and `subagent status` and the subagents bar listed
 * them all, at a few thousand tokens a status.
 *
 * - `auto`: a subagent idle longer than `subagents.retireAfter` (Menu › Subagents, `config.subagentRetireDays`, 3 days
 *   by default, 0 for never) leaves `SubagentsDoc.agents` for `SubagentsDoc.retired`. It runs when the session next
 *   calls the subagent tool, and for every session at the server's start (`atStart`): no timer per subagent.
 * - `retire`: the same, now, for any idle subagent (the subagents bar's "Retire idle subagents", the app action
 *   `subagents.retire`).
 * - Never retired: one working (`LiveDoc.run`), compacting (`LiveDoc.compactions`, its own summary turn asked or ready,
 *   `SubagentRecord.finishing`), with messages queued (`InboxDoc`), with a reporter still at work for it (work sent
 *   and not reported yet), or with its report waiting to go to Pi (`outbox`, `sending`). One commit checks all of them
 *   and moves the record, so a restart retires it whole or not at all.
 * - Kept: its conversation, its parent (`app.#noteSubagents` reads `retired` too, so `rootOf`, Spend and access stay as
 *   they were), and its name in the list: a later spawn with that name makes a new one, and a send to it says it was
 *   retired (`extensions/subagents.ts`), never waking it.
 */
import type { Context } from "@earendil-works/chord/context";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { type ConversationId, type Cursor, type EntryRecord, InboxDoc, LiveDoc, type Tx } from "@earendil-works/pi-durable";
import type { PocketApp } from "./app.ts";
import { type RetiredSubagent, SelfCompactDoc, type SubagentRecord, SubagentsDoc } from "./docs.ts";
import { describe } from "./errors.ts";

const context = BACKGROUND_CONTEXT;

export const DAY_MS = 86_400_000;
/** Days idle before a subagent is retired, until the owner says otherwise. */
export const DEFAULT_RETIRE_DAYS = 3;
/** The choices of `subagents.retireAfter`, in days; 0: never. */
export const RETIRE_DAYS = [0, 1, 2, 3, 7, 14, 30] as const;
/** `subagent status` without a name lists those working or idle less than this; `status all` lists every one. */
export const RECENT_MS = DAY_MS;
/** A subagent's newest entries read for its last message: a run's tool rounds come after it, so a few dozen do. */
const NEWEST_ENTRIES = 40;
/** The reporter's task (`extensions/subagents.ts`): one at work holds its subagent. */
const REPORTER = "pocket.subagent-reporter";
const AT_WORK = ["pending", "running", "waiting", "sleeping"] as const;

/** When a subagent last did something: asked, answered, or a message in its conversation (a person's own, say). */
export function lastActive(record: Pick<SubagentRecord, "askedAt" | "answeredAt">, newest: readonly EntryRecord[]): number {
    const said = newest.map((entry) => (entry.model?.[0] as { timestamp?: number } | undefined)?.timestamp ?? 0);

    return Math.max(record.askedAt ?? 0, record.answeredAt ?? 0, ...said);
}

/** How long it was idle, as a send to a retired one says it: "4 days", "1 day", "5 h". */
export function idleText(ms: number): string {
    const days = Math.floor(ms / DAY_MS);

    if (days >= 1) {
        return `${days} day${days === 1 ? "" : "s"}`;
    }

    const hours = Math.floor(ms / 3_600_000);

    return hours >= 1 ? `${hours} h` : `${Math.max(1, Math.floor(ms / 60_000))} min`;
}

/** What a send, stop or status of a retired name answers: it is not woken, and a new one is spawned instead. */
export function retiredText(retired: RetiredSubagent): string {
    return `${retired.name} was retired (idle ${idleText(retired.retiredAt - retired.idleSince)}); spawn a new one.`;
}

/** The names with a report on its way to the parent: waiting in the outbox, or in the batch taken. */
function reportingNames(state: { outbox?: readonly { name: string }[]; sending?: { reports: readonly { name: string }[] } }): Set<string> {
    return new Set([...(state.outbox ?? []), ...(state.sending?.reports ?? [])].map((report) => report.name));
}

export class SubagentRetirement {
    readonly #app: PocketApp;

    constructor(app: PocketApp) {
        this.#app = app;
    }

    /** How long a subagent stays idle before it is retired; undefined: never (the setting is 0). */
    afterMs(): number | undefined {
        const days = this.#app.config.subagentRetireDays;

        return days === 0 ? undefined : days * DAY_MS;
    }

    /** When `id`, a subagent with `record`, last did something, read outside a commit (`subagent status`). */
    async lastActive(id: ConversationId, record: SubagentRecord, at: Context = context): Promise<number> {
        const page = await (await this.#app.conversation(id)).entries({ order: "descending" }, NEWEST_ENTRIES, undefined, at);

        return lastActive(record, page.items);
    }

    /**
     * Whether `subagent status` without a name lists `id`, a subagent with `record`: working, compacting, or idle less
     * than a day. Its report on its way is the caller's to check.
     */
    async recent(id: ConversationId, record: SubagentRecord, at: Context = context): Promise<boolean> {
        const live = await this.#app.harness.snapshot(LiveDoc, id, at);
        const now = this.#app.now();

        if (record.finishing !== undefined || live?.run !== undefined || live?.compactions !== undefined) {
            return true;
        }

        // By the times on its record first: only one old there has its conversation read.
        return now - Math.max(record.askedAt ?? 0, record.answeredAt ?? 0) < RECENT_MS || now - (await this.lastActive(id, record, at)) < RECENT_MS;
    }

    /** Retire `parent`'s subagents idle longer than the setting, if it is on: those retired. */
    async auto(parent: ConversationId, at: Context = context): Promise<RetiredSubagent[]> {
        const after = this.afterMs();

        return after === undefined ? [] : this.retire(parent, after, at);
    }

    /** At the server's start, before work resumes: every session's subagents idle longer than the setting. */
    async atStart(parents: readonly ConversationId[]): Promise<void> {
        for (const parent of parents) {
            try {
                const retired = await this.auto(parent);

                if (retired.length > 0) {
                    this.#app.log(`retired ${retired.length} idle subagent${retired.length === 1 ? "" : "s"} of ${String(parent)}: ${retired.map((each) => each.name).join(", ")}`);
                }
            } catch (error) {
                // One session's trouble leaves the others' to retire; this one's go at its next subagent call.
                this.#app.log(`retiring ${String(parent)}'s idle subagents: ${describe(error)}`);
            }
        }
    }

    /**
     * Retire `parent`'s subagents idle for `idleMs` or longer (0: every idle one), in one commit: those retired, oldest
     * first. One at work, compacting, with messages queued, a reporter at work, or a report on its way stays.
     */
    async retire(parent: ConversationId, idleMs: number, at: Context = context): Promise<RetiredSubagent[]> {
        const now = this.#app.now();

        return this.#app.harness.commit(async (tx) => {
            const state = await tx.doc(SubagentsDoc, parent);
            const reporting = reportingNames(state);
            // By the times on its record first: only those old enough there are read further.
            const old = Object.entries(state.agents).filter(
                ([name, record]) => record.finishing === undefined && !reporting.has(name) && now - Math.max(record.askedAt ?? 0, record.answeredAt ?? 0) >= idleMs,
            );

            if (old.length === 0) {
                return [];
            }

            // Reads first: a commit reads the tables only before it writes one.
            const held = await this.#reporting(tx, parent);
            const since = new Map<string, number>();

            for (const [name, record] of old) {
                if (!held.has(name)) {
                    const page = await tx.scanEntries({ conversationId: record.conversationId, order: "descending" }, NEWEST_ENTRIES);

                    since.set(name, lastActive(record, page.items));
                }
            }

            const retired: RetiredSubagent[] = [];

            for (const [name, record] of old) {
                const idleSince = since.get(name);

                if (idleSince === undefined || now - idleSince < idleMs || !(await this.#idle(tx, record.conversationId))) {
                    continue;
                }

                retired.push({ name, conversationId: record.conversationId, retiredAt: now, idleSince, ...(record.asked === undefined ? {} : { asked: record.asked }) });
            }

            for (const each of retired) {
                delete state.agents[each.name];
            }

            if (retired.length > 0) {
                // Assigned whole: a document keeps its own copy of what is assigned to it.
                state.retired = [...(state.retired ?? []), ...retired];
            }

            return retired;
        }, at);
    }

    /** The names a reporter of `parent`'s is still at work for: work sent, not yet answered, reported, or compacted. */
    async #reporting(tx: Tx, parent: ConversationId): Promise<Set<string>> {
        const names = new Set<string>();

        for (const status of AT_WORK) {
            let cursor: Cursor | undefined;

            do {
                const page = await tx.scanTasks({ conversationId: parent, kind: REPORTER, status }, 100, cursor);

                for (const task of page.items) {
                    names.add((task.input as { name: string }).name);
                }

                cursor = page.next;
            } while (cursor !== undefined);
        }

        return names;
    }

    /** Whether `id` is idle: no run, no compaction, nothing queued, no summary turn of its own asked or written. */
    async #idle(tx: Tx, id: ConversationId): Promise<boolean> {
        const live = await tx.doc(LiveDoc, id);
        const inbox = await tx.doc(InboxDoc, id);
        const own = await tx.doc(SelfCompactDoc, id);

        return live.run === undefined && live.compactions === undefined && inbox.items.length === 0 && own.asked === undefined && own.ready === undefined;
    }
}
